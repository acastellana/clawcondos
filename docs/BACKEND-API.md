# Sharp Backend API

Sharp communicates with its backend via WebSocket using a simple JSON-RPC-style protocol. This document specifies the required API that any compatible backend must implement.

## Connection

Sharp connects to the WebSocket endpoint at the configured `gatewayWsUrl` (default: same origin with `/` path).

### Authentication

Authentication can be provided via:
- Query parameter: `?password=xxx` or `?token=xxx`
- The `connect` message (recommended)

## Message Format

All messages are JSON objects with the following structure:

### Request
```json
{
  "type": "req",
  "id": "r1",
  "method": "method.name",
  "params": { ... }
}
```

### Response
```json
{
  "type": "res",
  "id": "r1",
  "ok": true,
  "payload": { ... }
}
```

### Error Response
```json
{
  "type": "res",
  "id": "r1",
  "ok": false,
  "error": {
    "message": "Error description"
  }
}
```

### Event (server → client)
```json
{
  "type": "event",
  "event": "event.name",
  "payload": { ... }
}
```

## Required Methods

### `connect`

Authenticate and establish session. Called automatically on WebSocket open.

**Request:**
```json
{
  "type": "req",
  "id": "r1",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "sharp-dashboard",
      "displayName": "Sharp Dashboard",
      "version": "1.0.0",
      "platform": "web",
      "mode": "ui"
    }
  }
}
```

**Response:**
```json
{
  "type": "res",
  "id": "r1",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 3,
    "serverVersion": "1.0.0"
  }
}
```

---

### `chat.send`

Send a message to an agent session and wait for the response.

**Request:**
```json
{
  "type": "req",
  "id": "r2",
  "method": "chat.send",
  "params": {
    "sessionKey": "agent:main:main",
    "message": "Hello, agent!"
  }
}
```

**Response:**
```json
{
  "type": "res",
  "id": "r2",
  "ok": true,
  "payload": {
    "reply": "Hello! How can I help you today?",
    "sessionKey": "agent:main:main"
  }
}
```

**Notes:**
- This is a blocking call that waits for the agent to complete its response
- Timeout handling is recommended (default: 120s)
- The agent may take time to process, especially for complex requests

---

### `chat.history`

Retrieve message history for a session.

**Request:**
```json
{
  "type": "req",
  "id": "r3",
  "method": "chat.history",
  "params": {
    "sessionKey": "agent:main:main",
    "limit": 50
  }
}
```

**Response:**
```json
{
  "type": "res",
  "id": "r3",
  "ok": true,
  "payload": {
    "messages": [
      {
        "role": "user",
        "content": "Hello"
      },
      {
        "role": "assistant",
        "content": "Hi there! How can I help?"
      }
    ]
  }
}
```

**Message Content Format:**

Messages can have content in two formats:

1. **String** (simple):
   ```json
   { "role": "user", "content": "Hello" }
   ```

2. **Array** (multimodal):
   ```json
   {
     "role": "assistant",
     "content": [
       { "type": "text", "text": "Here's my response" },
       { "type": "toolCall", "name": "search", "arguments": {...} }
     ]
   }
   ```

---

### `chat.abort`

Cancel an in-progress agent run.

**Request:**
```json
{
  "type": "req",
  "id": "r4",
  "method": "chat.abort",
  "params": {
    "sessionKey": "agent:main:main"
  }
}
```

**Response:**
```json
{
  "type": "res",
  "id": "r4",
  "ok": true,
  "payload": {
    "aborted": true
  }
}
```

---

### `sessions.list`

List available sessions with metadata.

**Request:**
```json
{
  "type": "req",
  "id": "r5",
  "method": "sessions.list",
  "params": {
    "limit": 50
  }
}
```

**Response:**
```json
{
  "type": "res",
  "id": "r5",
  "ok": true,
  "payload": {
    "sessions": [
      {
        "key": "agent:main:main",
        "displayName": "Main Agent",
        "model": "claude-3-5-sonnet",
        "totalTokens": 12500,
        "updatedAt": 1704067200000,
        "messages": [
          {
            "role": "assistant",
            "content": "Last message preview..."
          }
        ]
      }
    ]
  }
}
```

**Session Object Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | Unique session identifier |
| `displayName` | string | Human-readable name |
| `model` | string | AI model being used |
| `totalTokens` | number | Total tokens used in session |
| `updatedAt` | number | Unix timestamp (ms) of last activity |
| `label` | string | Optional label (for sub-agents) |
| `messages` | array | Recent messages (if `messageLimit > 0`) |

---

## Optional Methods

### `health`

Health check endpoint.

**Request:**
```json
{
  "type": "req",
  "id": "r6",
  "method": "health",
  "params": {}
}
```

**Response:**
```json
{
  "type": "res",
  "id": "r6",
  "ok": true,
  "payload": {
    "status": "ok",
    "uptime": 3600
  }
}
```

---

## Events

The server may push events to connected clients:

### `agent`
Notifies about agent run status changes.

```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "sessionKey": "agent:main:main",
    "status": "running" | "completed" | "error"
  }
}
```

### `chat`
Notifies about new messages in sessions.

```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "sessionKey": "agent:main:main",
    "message": { ... }
  }
}
```

---

## Session Key Format

Sharp uses hierarchical session keys:

| Pattern | Description |
|---------|-------------|
| `agent:main:main` | Primary agent session |
| `agent:app-assistant:app:<appId>` | App-specific assistant |
| `agent:main:subagent:<taskId>` | Background sub-agent task |
| `cron:<jobId>` | Scheduled job session |

---

## Reference Implementation

The reference implementation is [Clawdbot Gateway](https://github.com/clawdbot/clawdbot), which provides:
- Full WebSocket chat protocol
- Multi-agent session management
- App assistant integration
- Sub-agent spawning

See the Clawdbot documentation for deployment instructions.
