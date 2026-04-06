# openclaw-mask-proxy

A lightweight reverse proxy that masks OpenClaw identity fingerprints in Anthropic Messages API requests.

## Background

As of April 4, 2026, Anthropic blocks third-party tools from using Claude models via subscription accounts. The detection is based on:

1. **System prompt content** - specific strings like "personal assistant running inside OpenClaw"
2. **Tool name combinations** - distinctive tool names like `sessions_spawn`, `agents_list`, `canvas`, `tts` etc.
3. **Tool description content** - references to OpenClaw in tool descriptions and schemas

This proxy sits between OpenClaw and your upstream Anthropic-compatible API service, masking these fingerprints in requests and reversing tool name changes in responses.

## What it masks

- **System prompt**: Replaces OpenClaw brand references (OpenClaw, Claw, HEARTBEAT_OK, etc.)
- **Tool names**: Renames distinctive OpenClaw tool names (e.g. `sessions_spawn` -> `conv_spawn`)
- **Tool descriptions**: Replaces brand references in tool description text and input schemas
- **Response tool calls**: Reverses tool name renames so OpenClaw can match them

## What it does NOT mask

- **User/assistant messages**: Content stays as-is, so conversations about "OpenClaw" work naturally
- **Non-messages endpoints**: Other API calls are passed through unchanged

## Setup

```bash
git clone https://github.com/chenyqthu/openclaw-mask-proxy.git
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
| `UPSTREAM_API_KEY` | (empty) | Override API key sent to upstream (empty = passthrough) |

## OpenClaw integration

In `openclaw.json`, point your provider to the proxy:

```json
{
  "models": {
    "providers": {
      "claude": {
        "baseUrl": "http://127.0.0.1:8081",
        "apiKey": "your-upstream-api-key",
        "api": "anthropic-messages",
        "models": [
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

## Architecture

```
OpenClaw Gateway (:18789)
    |
    v
mask-proxy (:8081)          -- masks system prompt, tool names/descriptions
    |
    v
upstream API (:8080)        -- sub2api, CRS, or any Anthropic-compatible service
    |
    v
Anthropic API               -- sees clean request, no OpenClaw fingerprints
```

## Running as a service (macOS)

```bash
# Create launchd plist
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

# Load the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw-mask-proxy.plist
```

## License

MIT
