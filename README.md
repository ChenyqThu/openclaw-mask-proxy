# openclaw-mask-proxy

A lightweight reverse proxy that masks OpenClaw identity fingerprints in Anthropic Messages API requests, with per-request custom identity support.

## Background

As of April 4, 2026, Anthropic blocks third-party tools from using Claude models via subscription accounts. The detection is based on:

1. **System prompt content** - specific strings like "personal assistant running inside OpenClaw"
2. **Tool name combinations** - distinctive tool names like `sessions_spawn`, `agents_list`, `canvas`, `tts` etc.
3. **Tool description content** - references to OpenClaw in tool descriptions and schemas

This proxy sits between OpenClaw and your upstream Anthropic-compatible API service, masking these fingerprints in requests and reversing changes in responses.

## What it masks

### Text masking (identity-dependent)

The "mask word" replaces all occurrences of "Claw" and its compounds:

| Original | Masked (e.g. `@Jarvis`) | Masked (default `Code`) |
|----------|------------------------|------------------------|
| `OpenClaw` | `OpenJarvis` | `OpenCode` |
| `Clawflow` | `Jarvisflow` | `Codeflow` |
| `Clawhub` | `Jarvishub` | `Codehub` |
| `ClawBot` | `JarvisBot` | `CodeBot` |
| `Claw` / `claw` | `Jarvis` / `jarvis` | `Code` / `code` |
| `HEARTBEAT_OK` | `PING_ACK` | `PING_ACK` |

Applied to: system prompt, tool descriptions, tool input schemas.

### Tool name renames (fingerprint evasion, identity-independent)

| Original | Renamed |
|----------|---------|
| `sessions_spawn` | `conv_spawn` |
| `sessions_list` | `conv_list` |
| `agents_list` | `agent_list` |
| `gateway` | `server` |
| `canvas` | `board` |
| `tts` | `speak` |
| `memory_search` | `recall_search` |
| `web_search` | `search` |
| ... | (see `TOOL_RENAMES` in index.js) |

### Response unmasking

- **Tool names**: reversed exactly via `TOOL_UNRENAMES`
- **Text**: only compound words are reversed (e.g. `OpenJarvis` → `OpenClaw`). Bare mask words (e.g. `Jarvis`) are NOT reversed to avoid false positives in natural text.

## What it does NOT mask

- **User/assistant messages**: Content stays as-is, so conversations work naturally
- **Non-messages endpoints**: Other API calls are passed through unchanged

## Custom identity via model ID

Append `@MaskWord` to the model ID to set a per-request identity:

```
claude-opus-4-6           → default mask word ("Code")
claude-opus-4-6@Jarvis    → mask word is "Jarvis"
claude-sonnet-4-6@Nova    → mask word is "Nova"
```

The proxy strips the `@MaskWord` suffix before forwarding to upstream. The real model ID (`claude-opus-4-6`) is sent to the API.

## Setup

```bash
git clone https://github.com/ChenyqThu/openclaw-mask-proxy.git
cd openclaw-mask-proxy
cp .env.example .env
# Edit .env with your upstream config
node index.js
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `PORT` | `8081` | Proxy listen port |
| `UPSTREAM_HOST` | `127.0.0.1` | Upstream API host |
| `UPSTREAM_PORT` | `8080` | Upstream API port |
| `DEFAULT_MASK_WORD` | `Code` | Default mask word when model ID has no `@` suffix |

## API key passthrough

The proxy does **not** hold its own API key. It transparently passes through the `x-api-key` header from each incoming request, making it suitable for multi-user deployments where each user provides their own key.

## OpenClaw integration

In `openclaw.json`, point your provider to the proxy and define models with `@MaskWord`:

```json
{
  "models": {
    "providers": {
      "claude": {
        "baseUrl": "http://127.0.0.1:8081",
        "apiKey": {
          "source": "env",
          "provider": "default",
          "id": "YOUR_API_KEY_ENV_VAR"
        },
        "api": "anthropic-messages",
        "models": [
          {
            "id": "claude-opus-4-6@Jarvis",
            "name": "Opus 4.6 (Jarvis)",
            "reasoning": true,
            "input": ["text", "image"],
            "contextWindow": 1000000,
            "maxTokens": 65536
          },
          {
            "id": "claude-opus-4-6",
            "name": "Claude Opus 4.6",
            "reasoning": true,
            "input": ["text", "image"],
            "contextWindow": 1000000,
            "maxTokens": 65536
          }
        ]
      }
    }
  }
}
```

Then in agent config, reference the `@MaskWord` model:

```json
{
  "id": "jarvis",
  "model": {
    "primary": "claude/claude-opus-4-6@Jarvis",
    "fallbacks": ["claude/claude-sonnet-4-6@Jarvis"]
  }
}
```

## Architecture

```
OpenClaw Gateway (:18789)
    |
    v
mask-proxy (:8081)          -- masks system prompt, tool names/descriptions
    |                       -- per-request identity via model@MaskWord
    |                       -- passthrough x-api-key
    v
upstream API (:8080)        -- sub2api, CRS, or any Anthropic-compatible service
    |
    v
Anthropic API               -- sees clean request, no OpenClaw fingerprints
```

## Running as a service (macOS)

```bash
cat > ~/Library/LaunchAgents/com.openclaw-mask-proxy.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openclaw-mask-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOU/Projects/openclaw-mask-proxy/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>8081</string>
    <key>UPSTREAM_HOST</key>
    <string>127.0.0.1</string>
    <key>UPSTREAM_PORT</key>
    <string>8080</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/openclaw-mask-proxy.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/openclaw-mask-proxy.err.log</string>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw-mask-proxy.plist
```

## License

MIT
