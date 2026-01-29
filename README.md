# Sharp 🎯

**A unified multi-agent dashboard for AI assistants**

Sharp is a sleek, mobile-responsive web dashboard for managing multiple AI agent sessions. Built as part of the [Clawdbot](https://github.com/clawdbot) ecosystem, it provides a unified interface for chatting with agents, embedding apps, and monitoring background tasks.

![Screenshot](docs/screenshot.png)
*Screenshot placeholder - add your own!*

## Features

- **📱 Sessions Sidebar** — View and switch between multiple agent sessions with real-time status indicators
- **🚀 App Embedding** — Embed web apps with integrated AI assistant panels
- **💬 Chat Interface** — Full-featured chat with streaming responses, code highlighting, and message history
- **📲 Mobile-Responsive** — Works beautifully on phones, tablets, foldables, and desktops
- **🌙 Dark Theme** — Easy on the eyes with a GitHub-inspired dark color scheme
- **⚡ Real-time Updates** — WebSocket-based communication with live status updates

## Quick Start

Sharp is a static HTML/JS application that connects to a compatible WebSocket backend.

1. **Serve the files** with any static file server:
   ```bash
   # Using Python
   python -m http.server 9000
   
   # Using Node.js
   npx serve -p 9000
   
   # Using Caddy (recommended)
   caddy file-server --listen :9000
   ```

2. **Configure your backend** — Sharp expects a WebSocket endpoint that implements the [Backend API](docs/BACKEND-API.md).

3. **Open your browser** at `http://localhost:9000`

## Configuration

Sharp auto-detects its WebSocket backend based on the page origin. To customize:

```javascript
// In browser console or modify index.html
state.gatewayUrl = 'wss://your-gateway.example.com';
state.token = 'your-auth-token';
localStorage.setItem('sharp_gateway', state.gatewayUrl);
localStorage.setItem('sharp_token', state.token);
```

### Environment Options

| Setting | Default | Description |
|---------|---------|-------------|
| `gatewayUrl` | Auto-detected | WebSocket URL for the backend |
| `token` | None | Authentication password/token |

## Backend API Requirements

Sharp communicates with its backend via WebSocket using a simple RPC protocol. Your backend must implement these methods:

| Method | Description |
|--------|-------------|
| `connect` | Authenticate and establish session |
| `chat.send` | Send a message to an agent |
| `chat.history` | Retrieve message history for a session |
| `chat.abort` | Cancel an in-progress agent run |
| `sessions.list` | List available sessions with metadata |

See [Backend API Documentation](docs/BACKEND-API.md) for the full protocol specification.

## Project Structure

```
apps/
├── index.html          # Main dashboard
├── shell.html          # App embedding shell
├── app.html            # Legacy app shell
├── lib/
│   └── gateway-ws.js   # WebSocket client library
├── .registry/
│   └── apps.json       # App registry
└── docs/
    ├── BACKEND-API.md  # Protocol documentation
    └── SETUP.md        # Deployment guide
```

## Origin: Clawdbot

Sharp was originally built as the control UI for [Clawdbot](https://github.com/clawdbot), a personal AI assistant platform. It's designed to work seamlessly with Clawdbot's gateway but can be adapted for any compatible backend.

The name "Sharp" comes from the 🎯 emoji — precise, focused, on-target.

## Development

No build step required! Sharp is vanilla HTML, CSS, and JavaScript. Just edit and refresh.

For local development with a backend:

1. Start your backend gateway
2. Update `gatewayUrl` in `index.html` or use the login modal
3. Serve the files and connect

## License

[MIT](LICENSE) © 2024-2025 Albert Castellana

---

Made with 💙 for the Clawdbot ecosystem
