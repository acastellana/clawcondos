<p align="center">
  <img src="media/clawcondos-logo.png" alt="ClawCondos" width="200">
</p>

<h1 align="center">ClawCondos</h1>

<p align="center">
  A goals-first multi-agent dashboard with an embedded apps platform
</p>

<p align="center">
  <a href="LICENSE">MIT License</a> &middot;
  <a href="docs/SETUP.md">Setup Guide</a> &middot;
  <a href="docs/BUILDING-APPS.md">Build Apps</a> &middot;
  <a href="docs/BACKEND-API.md">API Reference</a>
</p>

---

ClawCondos is a web dashboard for managing AI agent sessions organized into "Condos" (goals). It connects to any WebSocket backend implementing the [Clawdbot protocol](docs/BACKEND-API.md), and provides a platform for embedding your own web apps with AI assistant sidebars.

No build step. No framework. Vanilla HTML/JS/CSS. Edit and refresh.

## Features

- **Goals-First Organization** - Group agent sessions into high-level goals/projects ("Condos")
- **Real-time Chat** - WebSocket-based streaming responses, tool activity indicators, message queue
- **Embedded Apps Platform** - Register any web app and get it embedded with an AI assistant sidebar
- **Smart Filters** - Filter sessions by channel (Telegram, Discord, etc.) and status (Running, Unread, Error)
- **Session Management** - Pin, archive, rename, auto-archive inactive sessions
- **Mobile-Responsive** - Works on phones, tablets, and desktops
- **Dark Theme** - Clean dark color scheme with CSS variable theming
- **Organize Wizard** - AI-assisted session triage and goal assignment
- **Voice & Media** - Voice recording with Whisper transcription, image uploads

## Quick Start

```bash
git clone https://github.com/acastellana/clawcondos.git
cd clawcondos
npm install
cp config.example.json config.json   # edit with your gateway URL
node serve.js                         # http://localhost:9000
```

The development server handles static files, WebSocket proxying, and app routing. See [docs/SETUP.md](docs/SETUP.md) for production deployment with Caddy, nginx, or Docker.

## Configuration

Copy `config.example.json` to `config.json`:

```json
{
  "gatewayWsUrl": "wss://your-gateway/ws",
  "gatewayHttpUrl": "https://your-gateway"
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `gatewayWsUrl` | Auto-detect | WebSocket URL for backend |
| `gatewayHttpUrl` | Auto-detect | HTTP URL for REST API |
| `branding.name` | `"ClawCondos"` | Dashboard title |
| `branding.logo` | `"🏙️"` | Logo emoji or image URL |
| `features.showApps` | `true` | Show apps section |
| `features.showSubagents` | `true` | Show sub-agents section |

See [docs/SETUP.md](docs/SETUP.md) for all options and environment variables.

## Apps Platform

ClawCondos can embed any web application - Node.js, Python, React, anything that runs on a port. Each app gets:

- An **iframe** in the dashboard with a dedicated page
- An **AI assistant sidebar** that knows about your app's code, logs, and stack
- **Automatic proxy routing** through the ClawCondos server

Register apps in `.registry/apps.json`:

```json
{
  "apps": [
    {
      "id": "my-app",
      "name": "My App",
      "description": "What it does",
      "port": 8080,
      "path": "/path/to/my-app",
      "startCommand": "npm start",
      "icon": "🚀",
      "stack": "Node.js, Express"
    }
  ]
}
```

See [docs/BUILDING-APPS.md](docs/BUILDING-APPS.md) for the full guide including schema reference, assistant integration, and example apps.

## Project Structure

```
clawcondos/
├── index.html              # Main dashboard (all HTML/CSS/JS inline)
├── app.html                # App viewer with assistant panel
├── serve.js                # Node.js dev server (static files, WS proxy, app proxy)
├── lib/
│   ├── config.js           # Configuration loader (browser + server)
│   ├── message-shaping.js  # Message formatting (browser)
│   └── serve-helpers.js    # Server utilities
├── js/
│   ├── media-upload.js     # Image/file upload handler
│   └── voice-recorder.js   # Voice recording via MediaRecorder
├── styles/
│   ├── main.css            # All theming and CSS variables
│   ├── agents.css          # Agent-specific styles
│   ├── media-upload.css    # Upload UI styles
│   └── voice-recorder.css  # Recorder UI styles
├── .registry/
│   ├── apps.json           # Your registered apps (gitignored)
│   └── apps.example.json   # Example app registry
├── docs/
│   ├── SETUP.md            # Deployment guide
│   ├── BUILDING-APPS.md    # App development guide
│   └── BACKEND-API.md      # WebSocket protocol spec
├── tests/                  # Vitest tests
├── config.example.json     # Example configuration
├── Caddyfile.example       # Example Caddy reverse proxy config
└── start.example.sh        # Example startup script
```

## Backend API

ClawCondos connects via WebSocket to a backend implementing JSON-RPC style messaging:

| Method | Description |
|--------|-------------|
| `connect` | Authenticate and start session |
| `chat.send` | Send message to agent |
| `chat.history` | Get message history |
| `chat.abort` | Cancel a running agent |
| `sessions.list` | List all sessions |
| `sessions.update` | Update session metadata |

See [docs/BACKEND-API.md](docs/BACKEND-API.md) for the full protocol specification.

## Development

No build step. Edit files and refresh the browser.

```bash
npm test              # Run tests (Vitest)
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

Tests are in `tests/` and use Vitest with browser API mocks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) &copy; 2024-2026 Albert Castellana
