# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClawCondos is a goals-first multi-agent dashboard for the Clawdbot ecosystem. It's a web UI for managing AI agent sessions organized into "Condos" (goals), connecting to an OpenClaw gateway via WebSocket.

## Commands

### Quick start
```bash
npm install
cp config.example.json config.json   # edit with your gateway URL
node serve.js                         # http://localhost:9000
```

See `docs/SETUP.md` for full setup instructions (Caddy, Tailscale, etc.).

### Development
```bash
# Run development server (default port 9000)
node serve.js [port]

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run a single test file
npx vitest run tests/config.test.js
```

## Architecture

### No build step
The frontend is vanilla JS with no framework and no build pipeline. Edit files and refresh the browser.

### Key files

- **`index.html`** - Main dashboard UI. Single-file monolith (~5500 lines) containing all dashboard HTML, CSS, and JS inline. This is the primary file you'll edit for UI changes.
- **`app.html`** - Separate page for the app viewer with assistant panel.
- **`serve.js`** - Node.js HTTP/WebSocket server. Serves static files, proxies WebSocket and HTTP requests to the OpenClaw gateway (with auth injection), handles media upload, agent introspection, and the apps registry.
- **`clawcondos/condo-management/`** - OpenClaw plugin for goals/tasks/condos management (see below).
- **`lib/config.js`** - Configuration loader used by both browser and server. Priority: `window.CLAWCONDOS_CONFIG` > `/config.json` > auto-detect from hostname.
- **`lib/message-shaping.js`** - Message formatting and reply tag extraction (frontend only, loaded via `<script>` tag).
- **`js/media-upload.js`** - Browser file upload handler (images/audio).
- **`js/voice-recorder.js`** - In-browser voice recording via MediaRecorder API.
- **`styles/`** - CSS files: `main.css` (5300+ lines, all theming/variables), `agents.css`, `media-upload.css`, `voice-recorder.css`.
- **`public/`** - Built/compiled copies of app assets served in production.

### Data flow

```
Browser (index.html)
  -> WebSocket -> serve.js -> WebSocket proxy (auth injected) -> OpenClaw Gateway (port 18789)
  -> HTTP      -> serve.js -> /api/gateway/* proxy            -> OpenClaw Gateway
```

The server injects `GATEWAY_AUTH` bearer tokens into proxied requests so credentials stay server-side.

### WebSocket RPC protocol

All communication uses JSON-RPC-style messages over WebSocket:
- Requests: `{"type":"req", "id":"r1", "method":"sessions.list", "params":{...}}`
- Responses: `{"type":"res", "id":"r1", "ok":true, "payload":{...}}`
- Events (server-push): `{"type":"event", "event":"chat", "payload":{...}}`

See `docs/BACKEND-API.md` for the full protocol spec.

### Session key format

Sessions are identified by structured keys:
- `agent:main:main` - Primary agent
- `agent:app-assistant:app:<appId>` - App assistant
- `agent:main:subagent:<taskId>` - Background task
- `cron:<jobId>` - Scheduled job

### State management

The frontend uses a single global `state` object. WebSocket events drive UI updates. No reactive framework - DOM manipulation is direct via `getElementById` and innerHTML.

### OpenClaw Plugin (clawcondos-goals)

Goals, tasks, and session-goal mappings are managed by an OpenClaw plugin at `clawcondos/condo-management/`. The plugin registers gateway RPC methods that the frontend calls over WebSocket.

**Plugin files:**
- `clawcondos/condo-management/index.js` - Plugin entry point, registers 21 gateway methods + 2 hooks + 5 tools
- `clawcondos/condo-management/lib/goals-store.js` - File-backed JSON storage for goals and condos
- `clawcondos/condo-management/lib/goals-handlers.js` - Gateway method handlers for goals CRUD, tasks, and sessions
- `clawcondos/condo-management/lib/condos-handlers.js` - Gateway method handlers for condos CRUD
- `clawcondos/condo-management/lib/context-builder.js` - Builds goal/condo context for agent prompt injection
- `clawcondos/condo-management/lib/goal-update-tool.js` - Agent tool for reporting task status
- `clawcondos/condo-management/lib/condo-tools.js` - Agent tools for condo binding, goal creation, task management, and subagent spawning
- `clawcondos/condo-management/lib/task-spawn.js` - Spawns subagent sessions for task execution
- `clawcondos/condo-management/migrate.js` - Migration script from `.registry/goals.json`

**Gateway methods (21):**
- Goals: `goals.list`, `goals.create`, `goals.get`, `goals.update`, `goals.delete`
- Sessions: `goals.addSession`, `goals.removeSession`, `goals.sessionLookup`
- Session-condo mapping: `goals.setSessionCondo`, `goals.getSessionCondo`, `goals.listSessionCondos`, `goals.removeSessionCondo`
- Tasks: `goals.addTask`, `goals.updateTask`, `goals.deleteTask`
- Condos: `condos.create`, `condos.list`, `condos.get`, `condos.update`, `condos.delete`
- Spawning: `goals.spawnTaskSession`

**Plugin hooks:**
- `before_agent_start` - Injects goal/condo context when a session belongs to a goal or condo
- `agent_end` - Tracks session activity timestamps on goals and condos

**Plugin tools:**
- `goal_update` - Agents report task status, create tasks, set next task, mark goals done
- `condo_bind` - Agents bind their session to a condo (or create a new one)
- `condo_create_goal` - Agents create goals in the bound condo with optional initial tasks
- `condo_add_task` - Agents add tasks to goals in the bound condo
- `condo_spawn_task` - Agents spawn subagent sessions for tasks in the bound condo

### File-backed storage

App registrations persist in `.registry/` (gitignored):
- `.registry/apps.json` - Registered embedded applications

Goals data lives in the plugin:
- `clawcondos/condo-management/.data/goals.json` - Goals storage (gitignored)

## Testing

Tests use **Vitest 2.0** in Node environment. Test files live in `tests/` and match `tests/**/*.test.js`.

`tests/setup.js` provides browser API mocks (MockWebSocket, localStorage, document, fetch) since tests run in Node. `lib/` modules and `clawcondos/condo-management/lib/` modules have test coverage.

## Code Conventions

- **Vanilla JS (ES6+)** - No frameworks. Server uses ES modules (`import`/`export`); browser code uses IIFEs and globals (no module bundler).
- **`escapeHtml()`** - Must be used for all user-generated content rendered as HTML to prevent XSS. Defined in `js/media-upload.js` and `app.html`; `index.html` handles escaping inline.
- **CSS variables** - Theming via custom properties defined in `styles/main.css`.
- **Inline event handlers** - The dashboard uses `onclick=`, `onkeypress=` patterns in generated HTML.
- **Naming** - Functions: camelCase. CSS classes/IDs: kebab-case.

## Environment Variables (serve.js)

- `GATEWAY_HTTP_HOST` / `GATEWAY_HTTP_PORT` - Gateway location (default: localhost:18789)
- `GATEWAY_AUTH` - Bearer token injected into proxied requests
- `GATEWAY_WS_URL` - Custom WebSocket URL for gateway
- `MEDIA_UPLOAD_HOST` / `MEDIA_UPLOAD_PORT` - Media upload service
- `CLAWCONDOS_DEV_CORS` - Set to `1` to enable CORS for local development
- `ENABLE_MEDIA_UPLOAD_PROXY` - Set to `1` to enable legacy proxy to external media-upload service
- `CLAWCONDOS_WHISPER_MODEL` - Whisper model name (default: `base`)
- `CLAWCONDOS_WHISPER_DEVICE` - Whisper device (default: `cpu`)
- `CLAWCONDOS_WHISPER_TIMEOUT_MS` - Whisper transcription timeout in ms (default: `120000`)

## Reference Files

- `config.example.json` - Example config (copy to `config.json`)
- `start.example.sh` - Example startup script with Caddy
- `Caddyfile.example` - Example reverse proxy config
- `docs/SETUP.md` - Full setup guide
- `docs/BUILDING-APPS.md` - Guide for building embedded apps
- `docs/BACKEND-API.md` - Gateway WebSocket/HTTP protocol spec
