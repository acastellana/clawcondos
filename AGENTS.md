# AGENTS.md - Sharp Dashboard

## Project Overview

Sharp is the **unified control panel** for the Clawdbot ecosystem:
- Agent session management (chat, monitor, control)
- App embedding with assistant panels
- Knowledge base (via next-app)

## Architecture

```
sharp/
├── index.html           # Main dashboard (vanilla JS)
├── app.html             # App viewer with assistant panel
├── .registry/
│   └── apps.json        # App registry (defines embedded apps)
├── apps/                # Self-contained apps
│   └── prediction-market/
├── next-app/            # Next.js migration (sessions, KB, etc.)
├── js/                  # Modular JS (partial extraction)
├── lib/                 # Shared libraries
├── styles/              # CSS
└── docs/                # Documentation
```

## How to Run Sharp

### Quick Start (Development)
```bash
cd ~/clawd/projects/sharp

# Serve the main dashboard
python3 -m http.server 9000
# Or: npx serve -p 9000

# Open: http://localhost:9000
```

### With Apps (Full Setup)
```bash
# Terminal 1: Main dashboard
cd ~/clawd/projects/sharp
python3 -m http.server 9000

# Terminal 2: Next.js app (KB, sessions)
cd ~/clawd/projects/sharp/next-app
pnpm dev --port 3001
```

Access:
- **Main dashboard:** http://localhost:9000
- **Knowledge Base:** http://localhost:3001/kb
- **KB via app viewer:** http://localhost:9000/app.html?id=kb

## Apps System

### How Apps Work
1. Apps are registered in `.registry/apps.json`
2. Each app runs as a separate service (own port)
3. `app.html` embeds apps in an iframe with an assistant panel
4. Caddy/nginx proxies app routes in production

### App Registry (`.registry/apps.json`)
```json
{
  "apps": [
    {
      "id": "kb",
      "name": "Knowledge Base",
      "port": 3001,
      "path": "next-app",
      "startCommand": "pnpm dev --port 3001",
      "icon": "📚"
    }
  ]
}
```

### Adding a New App
1. Create app in `apps/` directory (or use existing service)
2. Add entry to `.registry/apps.json`
3. Add proxy rule in Caddyfile (for production)
4. Access via: `http://localhost:9000/app.html?id=your-app-id`

### Current Apps
| ID | Name | Port | Path |
|----|------|------|------|
| `kb` | Knowledge Base | 3001 | `next-app` |
| `prediction-market` | Prediction Market | 8765 | `apps/prediction-market` |

## Key Files

| File | Purpose |
|------|---------|
| `index.html` | Main dashboard (3000+ lines, monolithic) |
| `app.html` | App viewer with embedded assistant |
| `.registry/apps.json` | App registry |
| `next-app/` | Next.js migration target |
| `MIGRATION-NOTES.md` | Detailed migration documentation |

## Migration Status

Sharp is being migrated from vanilla JS to Next.js:
- **Current:** `index.html` (working, monolithic)
- **Target:** `next-app/` (in progress)

The `next-app` already has:
- [x] Sessions page (basic)
- [x] Knowledge Base (`/kb`)
- [ ] Chat interface
- [ ] WebSocket integration
- [ ] Full feature parity

## Development

No build step for vanilla JS. Just edit and refresh.

For next-app:
```bash
cd next-app
pnpm dev      # Development
pnpm build    # Production build
pnpm lint     # Linting
```

## Production Deployment

See `docs/SETUP.md` and `Caddyfile.example` for:
- Reverse proxy configuration
- WebSocket proxying
- App embedding
- Authentication

## Links

- [Backend API](docs/BACKEND-API.md)
- [Setup Guide](docs/SETUP.md)
- [Migration Notes](MIGRATION-NOTES.md)
