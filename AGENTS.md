# AGENTS.md - ClawCondos Dashboard

## Project Overview

ClawCondos is the **unified control panel** for the Clawdbot ecosystem:
- Agent session management (chat, monitor, control)
- Real-time WebSocket connection to gateway
- App embedding with assistant panels

## Architecture

```
clawcondos/
├── index.html           # Main dashboard (vanilla JS, all-in-one)
├── app.html             # App viewer with assistant panel
├── serve.js             # Node.js HTTP/WebSocket server
├── styles/main.css      # Extracted CSS (referenced by index.html)
├── lib/config.js        # Configuration loader
├── js/                  # Browser JS modules (media upload, voice)
├── .registry/
│   └── apps.json        # App registry (user-specific, gitignored)
├── docs/                # Documentation
└── tests/               # Unit tests (vitest)
```

## How to Run

### Quick Start
```bash
cd ~/clawd/projects/clawcondos

# Option 1: Python
python3 -m http.server 9000

# Option 2: Node
npx serve -p 9000

# Open: http://localhost:9000
```

### Production
Use Caddy (see `Caddyfile.example`):
- WebSocket proxy to gateway
- App routes
- HTTPS via Tailscale

## Configuration

Copy `config.example.json` to `config.json`:
```json
{
  "gatewayWsUrl": "wss://your-host/ws",
  "gatewayHttpUrl": "https://your-host"
}
```

## Key Features

- **Session list** with search, pin, archive
- **Channel filters** (Telegram, Discord, Signal, etc.)
- **Status filters** (Running, Unread, Error, Recent, Idle)
- **Real-time chat** with streaming responses
- **Tool activity** indicator
- **Auto-archive** inactive sessions
- **AI-generated titles** via OpenAI proxy
- **Export chat** as Markdown

## Development

No build step. Edit `index.html` and refresh.

### Tests
```bash
npm test           # Run tests
npm run test:watch # Watch mode
```

### Code Style
- Vanilla JS (ES6+)
- CSS variables for theming
- Single-file architecture (index.html)

## Files

| File | Purpose |
|------|---------|
| `index.html` | Main dashboard (~3000 lines) |
| `app.html` | App viewer with assistant panel |
| `styles/main.css` | CSS (loaded by index.html) |
| `lib/config.js` | Config loader script |
| `serve.js` | Optional Node.js server |

## Links

- [Backend API](docs/BACKEND-API.md)
- [Setup Guide](docs/SETUP.md)
