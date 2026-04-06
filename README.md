# openclaw-mask-proxy

[English](#english) | **中文**

轻量级反向代理，用于混淆 OpenClaw 在 Anthropic Messages API 请求中的身份指纹，支持按请求自定义身份。

## 背景

自 2026 年 4 月 4 日起，Anthropic 开始封锁第三方工具通过订阅账号使用 Claude 模型。检测依据包括：

1. **系统提示词内容** — 如 "personal assistant running inside OpenClaw" 等特征字符串
2. **工具名组合** — 如 `sessions_spawn`、`agents_list`、`canvas`、`tts` 等特征工具名
3. **工具描述内容** — 工具描述和 schema 中对 OpenClaw 的引用

本代理位于 OpenClaw 与上游 Anthropic 兼容 API 服务之间，在请求中混淆这些指纹，并在响应中还原。

## 混淆内容

### 文本混淆（与身份相关）

"mask word" 会替换所有 "Claw" 及其复合词：

| 原文 | 混淆后（如 `@Jarvis`） | 混淆后（默认 `Code`） |
|------|----------------------|---------------------|
| `OpenClaw` | `OpenJarvis` | `OpenCode` |
| `Clawflow` | `Jarvisflow` | `Codeflow` |
| `Clawhub` | `Jarvishub` | `Codehub` |
| `ClawBot` | `JarvisBot` | `CodeBot` |
| `Claw` / `claw` | `Jarvis` / `jarvis` | `Code` / `code` |
| `HEARTBEAT_OK` | `PING_ACK` | `PING_ACK` |

作用范围：系统提示词、工具描述、工具 input schema。

### 工具名重命名（指纹规避，与身份无关）

| 原名 | 重命名 |
|------|--------|
| `sessions_spawn` | `conv_spawn` |
| `sessions_list` | `conv_list` |
| `agents_list` | `agent_list` |
| `gateway` | `server` |
| `canvas` | `board` |
| `tts` | `speak` |
| `memory_search` | `recall_search` |
| `web_search` | `search` |
| ... | （完整映射见 index.js 中的 `TOOL_RENAMES`） |

### 响应还原

- **工具名**：通过 `TOOL_UNRENAMES` 精确还原
- **文本**：仅还原复合词（如 `OpenJarvis` → `OpenClaw`）。裸 mask word（如 `Jarvis`）**不会还原**，避免误伤正常文本

### 不混淆的内容

- **用户/助手消息**：内容保持原样
- **非 messages 端点**：其他 API 调用直接透传

## 通过 Model ID 自定义身份

在 model ID 后追加 `@MaskWord` 即可设置按请求的自定义身份：

```
claude-opus-4-6           → 使用默认 mask word（"Code"）
claude-opus-4-6@Jarvis    → mask word 为 "Jarvis"
claude-sonnet-4-6@Nova    → mask word 为 "Nova"
```

代理会剥离 `@MaskWord` 后缀，将真实 model ID（`claude-opus-4-6`）转发到上游。

## 安装

```bash
git clone https://github.com/ChenyqThu/openclaw-mask-proxy.git
cd openclaw-mask-proxy
cp .env.example .env
# 编辑 .env 配置上游地址
node index.js
```

## 配置项

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PORT` | `8081` | 代理监听端口 |
| `UPSTREAM_HOST` | `127.0.0.1` | 上游 API 地址 |
| `UPSTREAM_PORT` | `8080` | 上游 API 端口 |
| `DEFAULT_MASK_WORD` | `Code` | model ID 无 `@` 后缀时的默认 mask word |

## API Key 透传

代理**不持有自己的 API key**。每个请求的 `x-api-key` header 原样透传到上游，适用于多用户部署场景。

## OpenClaw 集成

在 `openclaw.json` 中，将 provider 指向代理，并定义带 `@MaskWord` 的模型：

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

Agent 配置中引用带 `@MaskWord` 的模型：

```json
{
  "id": "jarvis",
  "model": {
    "primary": "claude/claude-opus-4-6@Jarvis",
    "fallbacks": ["claude/claude-sonnet-4-6@Jarvis"]
  }
}
```

## 架构

```
OpenClaw Gateway (:18789)
    |
    v
mask-proxy (:8081)          -- 混淆系统提示词、工具名/描述
    |                       -- 按请求身份 via model@MaskWord
    |                       -- 透传 x-api-key
    v
upstream API (:8080)        -- sub2api、CRS 或任何 Anthropic 兼容服务
    |
    v
Anthropic API               -- 收到干净请求，无 OpenClaw 指纹
```

## macOS 服务化运行

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

---

<a id="english"></a>

# English

[中文](#openclaw-mask-proxy) | **English**

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
