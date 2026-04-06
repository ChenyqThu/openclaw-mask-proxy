const http = require('http')

// --- Config ---
const LISTEN_PORT = parseInt(process.env.PORT || '8081')
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || '127.0.0.1'
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '8080')
const DEFAULT_MASK_WORD = process.env.DEFAULT_MASK_WORD || 'Code'

// --- Dynamic text masking rules (based on mask word) ---
function buildTextRules(mw) {
  const lo = mw.toLowerCase()
  const up = mw.toUpperCase()
  return [
    ['OpenClaw', 'Open' + mw], ['openClaw', 'open' + mw],
    ['openclaw', 'open' + lo], ['OPENCLAW', 'OPEN' + up],
    ['Clawflow', mw + 'flow'], ['clawflow', lo + 'flow'],
    ['Clawhub', mw + 'hub'], ['clawhub', lo + 'hub'],
    ['ClawBot', mw + 'Bot'], ['clawbot', lo + 'bot'],
    ['Clawd', mw + 'd'], ['clawd', lo + 'd'],
    ['Claw', mw], ['claw', lo], ['CLAW', up],
    ['HEARTBEAT_OK', 'PING_ACK'], ['Heartbeat', 'Keepalive'], ['heartbeat', 'keepalive'],
  ]
}

// Reverse rules for response unmasking — only compound words to avoid false positives
function buildReverseTextRules(mw) {
  const lo = mw.toLowerCase()
  const up = mw.toUpperCase()
  return [
    ['Open' + mw, 'OpenClaw'], ['open' + mw, 'openClaw'],
    ['open' + lo, 'openclaw'], ['OPEN' + up, 'OPENCLAW'],
    [mw + 'flow', 'Clawflow'], [lo + 'flow', 'clawflow'],
    [mw + 'hub', 'Clawhub'], [lo + 'hub', 'clawhub'],
    [mw + 'Bot', 'ClawBot'], [lo + 'bot', 'clawbot'],
    ['PING_ACK', 'HEARTBEAT_OK'], ['Keepalive', 'Heartbeat'], ['keepalive', 'heartbeat'],
    // Bare maskWord and {mw}d are intentionally NOT reversed — too generic
  ]
}

// --- Tool name renames (fingerprint evasion, identity-independent) ---
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

function applyRules(text, rules) {
  let result = text
  for (const [pattern, replacement] of rules) {
    result = result.replaceAll(pattern, replacement)
  }
  return result
}

// Parse model field: "claude-opus-4-6@Jarvis" → { model: "claude-opus-4-6", maskWord: "Jarvis" }
function parseModel(model) {
  if (!model || typeof model !== 'string') return { model, maskWord: DEFAULT_MASK_WORD }
  const atIdx = model.lastIndexOf('@')
  if (atIdx === -1) return { model, maskWord: DEFAULT_MASK_WORD }
  return { model: model.slice(0, atIdx), maskWord: model.slice(atIdx + 1) }
}

function maskRequestBody(body) {
  try {
    const data = JSON.parse(body)

    // Extract mask word from model field
    const { model: realModel, maskWord } = parseModel(data.model)
    data.model = realModel
    const textRules = buildTextRules(maskWord)

    // 1. Mask system prompt
    if (typeof data.system === 'string') {
      data.system = applyRules(data.system, textRules)
    } else if (Array.isArray(data.system)) {
      data.system = data.system.map(block => {
        if (typeof block === 'string') return applyRules(block, textRules)
        if (block && typeof block.text === 'string') {
          return { ...block, text: applyRules(block.text, textRules) }
        }
        return block
      })
    }

    // 2. Mask tool names and descriptions
    if (Array.isArray(data.tools)) {
      data.tools = data.tools.map(t => {
        const newName = TOOL_RENAMES[t.name] || t.name
        const newDesc = typeof t.description === 'string' ? applyRules(t.description, textRules) : t.description
        let schema = t.input_schema
        if (schema) {
          const schemaStr = JSON.stringify(schema)
          const maskedSchema = applyRules(schemaStr, textRules)
          if (schemaStr !== maskedSchema) {
            schema = JSON.parse(maskedSchema)
          }
        }
        return { ...t, name: newName, description: newDesc, input_schema: schema }
      })
    }

    // Messages are NOT modified — user/assistant content stays as-is
    return { body: JSON.stringify(data), maskWord }
  } catch {
    return { body, maskWord: DEFAULT_MASK_WORD }
  }
}

function unmaskResponseBody(body, reverseRules) {
  try {
    const data = JSON.parse(body)
    // Unmask tool names
    if (data.content && Array.isArray(data.content)) {
      data.content = data.content.map(block => {
        if (block.type === 'tool_use' && TOOL_UNRENAMES[block.name]) {
          return { ...block, name: TOOL_UNRENAMES[block.name] }
        }
        return block
      })
    }
    // Reverse text masking in assistant text blocks
    let result = JSON.stringify(data)
    result = applyRules(result, reverseRules)
    return result
  } catch {
    // Streaming chunks may not be valid JSON — do string replacement
    let result = body
    for (const [masked, original] of Object.entries(TOOL_UNRENAMES)) {
      result = result.replaceAll(`"name":"${masked}"`, `"name":"${original}"`)
      result = result.replaceAll(`"name": "${masked}"`, `"name": "${original}"`)
    }
    result = applyRules(result, reverseRules)
    return result
  }
}

function maskHeaders(headers) {
  const masked = { ...headers }
  delete masked['content-length']
  // passthrough original x-api-key — proxy does not hold its own key
  return masked
}

const server = http.createServer((clientReq, clientRes) => {
  const chunks = []
  const isMessages = clientReq.url?.includes('/v1/messages')

  clientReq.on('data', chunk => chunks.push(chunk))
  clientReq.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf-8')

    let maskedBody = rawBody
    let reverseRules = buildReverseTextRules(DEFAULT_MASK_WORD)

    if (clientReq.method !== 'GET' && isMessages) {
      const result = maskRequestBody(rawBody)
      maskedBody = result.body
      reverseRules = buildReverseTextRules(result.maskWord)
    }

    const maskedHeaders = maskHeaders(clientReq.headers)
    maskedHeaders.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`

    if (isMessages) {
      // Extract mask word for logging
      let logMw = DEFAULT_MASK_WORD
      try { const d = JSON.parse(rawBody); logMw = parseModel(d.model).maskWord } catch {}
      console.log(`[proxy] ${clientReq.method} ${clientReq.url} mask=${logMw} (${rawBody.length} -> ${maskedBody.length} bytes)`)
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
            clientRes.write(unmaskResponseBody(chunk.toString('utf-8'), reverseRules))
          })
          proxyRes.on('end', () => clientRes.end())
        } else {
          const resChunks = []
          proxyRes.on('data', c => resChunks.push(c))
          proxyRes.on('end', () => {
            let resBody = Buffer.concat(resChunks).toString('utf-8')
            resBody = unmaskResponseBody(resBody, reverseRules)
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
  console.log(`[mask-proxy] default mask word: ${DEFAULT_MASK_WORD}`)
  console.log(`[mask-proxy] model format: {model}@{maskWord} (e.g. claude-opus-4-6@Jarvis)`)
})
