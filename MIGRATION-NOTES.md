# Sharp Dashboard - Migration Notes

**Review Date:** 2025-01-27
**Codebase:** Monolithic vanilla JS app in `index.html` + modular ES6 files in `js/`

---

## Executive Summary

Sharp is a WebSocket-based dashboard for Clawdbot agent sessions. The current codebase has two implementations:
1. **Monolithic version** - `index.html` with 3000+ lines of inline JS
2. **Modular version** - Started refactor with ES6 modules (`js/*.js`)

The modular version is incomplete—`index.html` contains the complete, working implementation while the `js/` files are partial extracts. **Migration should use `index.html` as the authoritative source.**

---

## Key Functionality to Preserve

### 1. WebSocket Connection & Auth
- Challenge-based authentication flow
- Auto-reconnection with exponential backoff (1s, 2s, 5s, 10s, 30s)
- Keepalive pings every 25s
- Stale connection detection (60s timeout)
- Protocol version: 3

### 2. Session Management
- List sessions via RPC `sessions.list`
- Pin/unpin sessions (localStorage persist)
- Archive/unarchive sessions (localStorage persist)
- Custom session names (localStorage persist)
- AI-generated titles via OpenAI API proxy
- Session grouping (Telegram topics nested under groups)
- Unread tracking with last-viewed timestamps
- Auto-archive after configurable inactivity (15m to 7d)

### 3. Chat Functionality
- Load history via `chat.history` RPC
- Send messages via `chat.send` RPC
- Stop agent via `/stop` command
- Message queue when agent is busy
- Streaming responses with cursor animation
- Typing indicator (bouncing dots)
- Tool activity indicator (compact pills)
- Export chat as Markdown

### 4. Real-time Updates
- Agent lifecycle events (start/end)
- Chat events (delta/final/error)
- Tool call tracking
- Persisted active runs (survives refresh)

### 5. Multi-select Mode
- Bulk archive sessions
- Bulk pin sessions
- Select all toggle

---

## Current State Management Approach

### Global State Object
```javascript
const state = {
  // Data
  sessions: [],
  apps: [],
  agents: [],
  
  // UI State
  currentView: 'overview' | 'chat' | 'agent',
  currentSession: null,
  chatHistory: [],
  isThinking: false,
  messageQueue: [],
  
  // Per-session status
  sessionStatus: {},  // { key: 'idle' | 'thinking' | 'error' | 'offline' }
  
  // Multi-select
  multiSelectMode: false,
  selectedSessions: new Set(),
  
  // Auth
  token: string,
  gatewayUrl: string,
  
  // WebSocket internals
  ws: WebSocket,
  connected: boolean,
  rpcPending: Map,
  
  // Streaming
  activeRuns: Map,  // sessionKey -> runId
  activeRunsStore: {},  // Persisted to localStorage
  sessionInputReady: Map,
  
  // UI preferences (localStorage)
  pinnedSessions: [],
  archivedSessions: [],
  sessionNames: {},
  lastViewedAt: {},
  expandedGroups: {},
  sessionStatus: {},  // Brief status text
  autoArchiveDays: string
};
```

### State Persistence (localStorage keys)
| Key | Purpose |
|-----|---------|
| `sharp_token` | Gateway auth password |
| `sharp_gateway` | Gateway WebSocket URL |
| `sharp_pinned_sessions` | Array of pinned session keys |
| `sharp_archived_sessions` | Array of archived session keys |
| `sharp_session_names` | Object of custom session names |
| `sharp_last_viewed` | Object of session → timestamp |
| `sharp_expanded_groups` | Object of group → expanded boolean |
| `sharp_session_status` | Object of session → brief status |
| `sharp_auto_archive_days` | Days or 'never' |
| `sharp_current_session` | Last open session key |
| `sharp_active_runs` | Persisted active runs for recovery |

### Modular State (`js/state.js`)
Started reactive proxy pattern:
```javascript
const state = new Proxy(api, {
  get(target, prop) { ... },
  set(target, prop, value) { ... }  // Calls notify(prop)
});
```
**Status:** Pattern defined but not fully wired up.

---

## WebSocket Message Formats

### Outgoing (Client → Gateway)

#### Connect Request
```json
{
  "type": "req",
  "id": "1",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "clawdbot-control-ui",
      "displayName": "Sharp Dashboard",
      "mode": "ui",
      "version": "2.0.0",
      "platform": "browser"
    },
    "auth": { "password": "..." }
  }
}
```

#### RPC Request
```json
{
  "type": "req",
  "id": "2",
  "method": "chat.send",
  "params": {
    "sessionKey": "agent:main:telegram:...",
    "message": "Hello",
    "idempotencyKey": "msg-...-timestamp"
  }
}
```

### Incoming (Gateway → Client)

#### Challenge Event
```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "..." }
}
```

#### RPC Response
```json
{
  "type": "res",
  "id": "2",
  "ok": true,
  "payload": { ... }
}
```

#### Chat Event
```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "sessionKey": "...",
    "runId": "...",
    "state": "delta" | "final" | "error" | "aborted",
    "message": { "content": [...] }
  }
}
```

#### Agent Event
```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "sessionKey": "...",
    "runId": "...",
    "stream": "lifecycle" | "tool",
    "data": {
      "phase": "start" | "end",
      "name": "...",  // for tools
      "toolCallId": "..."
    }
  }
}
```

### RPC Methods Used
| Method | Purpose |
|--------|---------|
| `connect` | Authenticate |
| `status` | Keepalive/health |
| `sessions.list` | Get all sessions |
| `sessions.archive` | Archive session |
| `sessions.pin` | Pin session |
| `chat.history` | Get session messages |
| `chat.send` | Send message to agent |
| `chat.activeRuns` | Get currently running agents |
| `agents.list` | List configured agents |

---

## CSS Class Naming Patterns

### Component Structure
```
.component                 # Base component
.component-header          # Header section
.component-content         # Content area
.component-footer          # Footer section
.component-item            # List item
.component-action          # Action button
```

### State Modifiers
```
.active                    # Currently selected/active
.open                      # Sidebar open state
.visible                   # Shown (display flex/block)
.hidden                    # Hidden (display none)
.expanded                  # Expandable content open
.collapsed                 # Expandable content closed
.checked                   # Checkbox selected
.disabled                  # Disabled state
.generating                # AI generating content
.streaming                 # Streaming response
.unread                    # Has unread content
.queued                    # Queued message
```

### Naming Conventions
- BEM-lite: `.session-card`, `.card-top`, `.card-icon`
- State classes: `.idle`, `.thinking`, `.error`, `.offline`
- Semantic: `.message.user`, `.message.assistant`

### CSS Variables (Custom Properties)
```css
/* Colors */
--bg, --bg-elevated, --bg-panel, --bg-hover, --bg-active
--border, --border-subtle, --border-hover
--text, --text-secondary, --text-dim, --text-muted
--accent, --accent-hover, --accent-muted, --accent-glow
--green, --yellow, --red, --purple (with -dim variants)

/* Typography */
--font-sans: 'Plus Jakarta Sans', ...
--font-mono: 'JetBrains Mono', ...

/* Spacing */
--space-xs: 4px
--space-sm: 8px
--space-md: 12px
--space-lg: 16px
--space-xl: 24px
--space-2xl: 32px

/* Radius */
--radius-sm: 6px
--radius-md: 10px
--radius-lg: 14px
--radius-xl: 18px

/* Transitions */
--transition-fast: 0.15s ease
--transition-normal: 0.2s ease
--transition-smooth: 0.3s cubic-bezier(0.4, 0, 0.2, 1)
```

---

## Mobile Breakpoints

| Breakpoint | Target |
|------------|--------|
| `≤1024px` | Tablets - narrower sidebar, smaller padding |
| `≤768px` | Mobile - slide-out sidebar, mobile header, stacked layout |
| `≤400px` | Small phones - wider sidebar, larger touch targets |
| `≤400px + height≥700px + 9:19 aspect` | Foldable phones |
| `600-900px + 3:4-4:3 aspect` | Tablet landscape/portrait |
| `≤500px height + landscape` | Landscape mobile |

### Mobile-specific Features
- Fixed mobile header with back button
- Slide-out sidebar with overlay
- Touch-optimized tap targets (44px min)
- Safe area insets for notches/home indicators
- Disabled hover effects on touch devices

---

## Potential Issues & Tech Debt

### 1. **Duplicate Implementation**
The `js/` modules are incomplete copies of the inline code. Need to pick one approach and complete it.

### 2. **Hardcoded Token**
```javascript
token: localStorage.getItem('sharp_token') || 
       (window.location.port === '9000' ? 'REDACTED' : null)
```
Fallback password is hardcoded for port 9000. Should be config-only.

### 3. **Large Monolithic File**
`index.html` is 3000+ lines. All JS is inline, making it hard to maintain and test.

### 4. **No Build Process**
No bundler, minifier, or tree-shaking. Large CSS file loaded in full.

### 5. **Mixed State Mutation**
State is mutated directly without reactive updates in most places. The Proxy pattern in `js/state.js` isn't connected.

### 6. **No Type Safety**
All JavaScript, no TypeScript. Easy to break things.

### 7. **Inline Event Handlers**
Heavy use of `onclick="..."` instead of addEventListener. Makes CSP harder.

### 8. **No Error Boundaries**
Errors in rendering can break the entire UI.

### 9. **LocalStorage Overload**
9+ localStorage keys for various state. Could consolidate.

### 10. **Stale Run Detection**
Uses 5-minute timeout (`ACTIVE_RUN_STALE_MS`). May need tuning.

### 11. **OpenAI API Calls**
Title generation uses `/api/openai/v1/chat/completions` proxy. Relies on server-side key injection.

---

## Features Currently Implemented

### Core
- [x] WebSocket connection with auth
- [x] Auto-reconnection with backoff
- [x] Session list with real-time updates
- [x] Chat history loading
- [x] Message sending/receiving
- [x] Streaming response display
- [x] Stop agent command

### Session Management
- [x] Pin/unpin sessions
- [x] Archive/unarchive sessions
- [x] Custom session names
- [x] AI-generated titles
- [x] Session grouping (Telegram topics)
- [x] Group expansion/collapse
- [x] Unread indicators
- [x] Mark read/unread
- [x] Mark all read
- [x] Session search (Cmd+K)
- [x] Auto-archive after inactivity

### Chat Features
- [x] Message queue when busy
- [x] Typing indicator
- [x] Tool activity indicator
- [x] Streaming cursor animation
- [x] Export as Markdown
- [x] Agent status (idle/thinking/error/offline)

### Multi-select
- [x] Enter/exit select mode
- [x] Individual selection
- [x] Select all
- [x] Bulk archive
- [x] Bulk pin

### UI/UX
- [x] Overview dashboard (cards grid)
- [x] Session detail view (chat)
- [x] Agent list view
- [x] Apps list with status checks
- [x] Mobile responsive design
- [x] Dark theme
- [x] Toast notifications
- [x] Login modal
- [x] Reconnection overlay
- [x] Keyboard shortcuts (Cmd+K, Escape)

### Persistence
- [x] Session restore on refresh
- [x] Active run recovery
- [x] UI preferences (pins, names, archive)

---

## Improvement Opportunities

### High Priority
1. **Complete modularization** - Finish extracting to ES6 modules
2. **Add TypeScript** - Prevent runtime errors
3. **Reactive state** - Connect the Proxy pattern or use a store
4. **Remove hardcoded credentials** - Config-only auth

### Medium Priority
1. **Add bundler** - Vite/esbuild for dev experience
2. **Component extraction** - Break up 3000-line file
3. **Add tests** - Unit tests for utils, integration for WS
4. **Consolidate localStorage** - Single settings object

### Low Priority
1. **PWA support** - Offline capability, install prompt
2. **Virtualized lists** - For large session counts
3. **Theme toggle** - Light mode option
4. **Keyboard navigation** - Full a11y support

---

## Migration Strategy Recommendation

1. **Use `index.html` as source of truth**
2. **Extract incrementally:**
   - `utils.js` - timeAgo, escapeHtml, formatMessage
   - `state.js` - Complete the reactive store
   - `websocket.js` - Connection, RPC, event handling
   - `sessions.js` - All session logic
   - `chat.js` - Chat UI and message handling
   - `components/` - Sidebar, Header, Cards, Modal
3. **Add Vite** for HMR and bundling
4. **Add TypeScript** after modularization
5. **Test each module** before moving to next
