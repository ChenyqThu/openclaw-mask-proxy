const http = require('http')

// --- Config ---
const LISTEN_PORT = parseInt(process.env.PORT || '8081')
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || '127.0.0.1'
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '8080')
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || ''

// --- Text masking rules (applied to system prompt and tool descriptions) ---
const TEXT_RULES = [
  ['OpenClaw', 'OpenCode'], ['openClaw', 'openCode'], ['openclaw', 'opencode'], ['OPENCLAW', 'OPENCODE'],
  ['Clawflow', 'Codeflow'], ['clawflow', 'codeflow'], ['Clawhub', 'Codehub'], ['clawhub', 'codehub'],
  ['ClawBot', 'CodeBot'], ['clawbot', 'codebot'], ['Clawd', 'Coded'], ['clawd', 'coded'],
  ['Claw', 'Code'], ['claw', 'code'], ['CLAW', 'CODE'],
  ['HEARTBEAT_OK', 'PING_ACK'], ['Heartbeat', 'Keepalive'], ['heartbeat', 'keepalive'],
]

// --- Tool name renames (fingerprint evasion) ---
const TOOL_RENAMES = {
  'sessions_list': 'conv_list', 'sessions_spawn': 'conv_spawn', 'sessions_send': 'conv_send',
  'sessions_kill': 'conv_kill', 'sessions_history': 'chat_history', 'sessions_yield': 'chat_yield',
  'session_status': 'chat_status', 'agents_list': 'agent_list',
  'subagents': 'helpers', 'subagent': 'helper',
  'gateway': 'server', 'canvas': 'board', 'nodes': 'peers', 'tts': 'speak', 'cron': 'scheduler',
  'memory_search': 'recall_search', 'memory_get': 'recall_get',
  'lcm_grep': 'local_grep', 'lcm_describe': 'local_describe',
  'lcm_expand': 'local_expand', 'lcm_expand_query': 'local_expand_query',
  'web_search': 'search', 'web_fetch': 'fetch',
}
const TOOL_UNRENAMES = Object.fromEntries(Object.entries(TOOL_RENAMES).map(([k, v]) => [v, k]))

function applyTextRules(text) {
  let result = text
  for (const [pattern, replacement] of TEXT_RULES) {
    result = result.replaceAll(pattern, replacement)
  }
  return result
}

function maskRequestBody(body) {
  try {
    const data = JSON.parse(body)

    // 1. Mask system prompt
    if (typeof data.system === 'string') {
      data.system = applyTextRules(data.system)
    } else if (Array.isArray(data.system)) {
      data.system = data.system.map(block => {
        if (typeof block === 'string') return applyTextRules(block)
        if (block && typeof block.text === 'string') {
          return { ...block, text: applyTextRules(block.text) }
        }
        return block
      })
    }

    // 2. Mask tool names and descriptions
    if (Array.isArray(data.tools)) {
      data.tools = data.tools.map(t => {
        const newName = TOOL_RENAMES[t.name] || t.name
        const newDesc = typeof t.description === 'string' ? applyTextRules(t.description) : t.description
        let schema = t.input_schema
        if (schema) {
          const schemaStr = JSON.stringify(schema)
          const maskedSchema = applyTextRules(schemaStr)
          if (schemaStr !== maskedSchema) {
            schema = JSON.parse(maskedSchema)
          }
        }
        return { ...t, name: newName, description: newDesc, input_schema: schema }
      })
    }

    // Messages are NOT modified - user/assistant content stays as-is
    return JSON.stringify(data)
  } catch {
    return body
  }
}

function unmaskResponseBody(body) {
  try {
    const data = JSON.parse(body)
    if (data.content && Array.isArray(data.content)) {
      data.content = data.content.map(block => {
        if (block.type === 'tool_use' && TOOL_UNRENAMES[block.name]) {
          return { ...block, name: TOOL_UNRENAMES[block.name] }
        }
        return block
      })
    }
    return JSON.stringify(data)
  } catch {
    // Streaming chunks may not be valid JSON - do string replacement
    let result = body
    for (const [masked, original] of Object.entries(TOOL_UNRENAMES)) {
      result = result.replaceAll(`"name":"${masked}"`, `"name":"${original}"`)
      result = result.replaceAll(`"name": "${masked}"`, `"name": "${original}"`)
    }
    return result
  }
}

function maskHeaders(headers) {
  const masked = { ...headers }
  delete masked['content-length']
  if (UPSTREAM_API_KEY && (masked['x-api-key'] || headers['x-api-key'])) {
    masked['x-api-key'] = UPSTREAM_API_KEY
  }
  return masked
}

const server = http.createServer((clientReq, clientRes) => {
  const chunks = []
  const isMessages = clientReq.url?.includes('/v1/messages')

  clientReq.on('data', chunk => chunks.push(chunk))
  clientReq.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf-8')
    const maskedBody = clientReq.method !== 'GET' && isMessages ? maskRequestBody(rawBody) : rawBody
    const maskedHeaders = maskHeaders(clientReq.headers)
    maskedHeaders.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`

    if (isMessages) {
      console.log(`[proxy] ${clientReq.method} ${clientReq.url} (${rawBody.length} -> ${maskedBody.length} bytes)`)
    }

    const proxyReq = http.request(
      {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: clientReq.url,
        method: clientReq.method,
        headers: { ...maskedHeaders, 'content-length': Buffer.byteLength(maskedBody) }
      },
      proxyRes => {
        if (isMessages) {
          console.log(`[proxy] <- ${proxyRes.statusCode}`)
        }

        const isStreaming = (proxyRes.headers['content-type'] || '').includes('text/event-stream')

        if (!isMessages) {
          clientRes.writeHead(proxyRes.statusCode, proxyRes.headers)
          proxyRes.pipe(clientRes)
        } else if (isStreaming) {
          clientRes.writeHead(proxyRes.statusCode, proxyRes.headers)
          proxyRes.on('data', chunk => {
            clientRes.write(unmaskResponseBody(chunk.toString('utf-8')))
          })
          proxyRes.on('end', () => clientRes.end())
        } else {
          const resChunks = []
          proxyRes.on('data', c => resChunks.push(c))
          proxyRes.on('end', () => {
            let resBody = Buffer.concat(resChunks).toString('utf-8')
            resBody = unmaskResponseBody(resBody)
            const headers = { ...proxyRes.headers }
            headers['content-length'] = Buffer.byteLength(resBody)
            clientRes.writeHead(proxyRes.statusCode, headers)
            clientRes.end(resBody)
          })
        }
      }
    )

    proxyReq.on('error', err => {
      console.error(`[proxy] upstream error: ${err.message}`)
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' })
      }
      clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }))
    })

    proxyReq.write(maskedBody)
    proxyReq.end()
  })
})

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`[mask-proxy] listening on 127.0.0.1:${LISTEN_PORT}`)
  console.log(`[mask-proxy] upstream: ${UPSTREAM_HOST}:${UPSTREAM_PORT}`)
  console.log(`[mask-proxy] masks: system prompt + tool names/descriptions (messages untouched)`)
})
