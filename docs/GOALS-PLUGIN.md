# ClawCondos Goals Plugin (`clawcondos-goals`)

An OpenClaw plugin that manages goals, tasks, condos, and session-goal mappings for the ClawCondos dashboard. Replaces the previous HTTP-based goals routes in `serve.js` with native gateway RPC methods, lifecycle hooks, and an agent tool.

## Architecture

```
┌──────────────────────────┐
│  ClawCondos Frontend     │
│  (index.html)            │
│  WebSocket RPC calls     │
└──────────┬───────────────┘
           │ goals.*, condos.*
           ▼
┌──────────────────────────┐
│  OpenClaw Gateway        │
│  (port 18789)            │
│                          │
│  ┌────────────────────┐  │
│  │ clawcondos-goals   │  │
│  │ plugin             │  │
│  │                    │  │
│  │  20 RPC methods    │  │
│  │  2 lifecycle hooks │  │
│  │  1 agent tool      │  │
│  └────────┬───────────┘  │
│           │               │
│  ┌────────▼───────────┐  │
│  │  goals.json        │  │
│  │  (file-backed)     │  │
│  └────────────────────┘  │
└──────────────────────────┘
```

### Data Model

All data lives in a single JSON file (`clawcondos/condo-management/.data/goals.json`). The store schema:

```json
{
  "version": 2,
  "goals": [],
  "condos": [],
  "sessionIndex": {},
  "sessionCondoIndex": {}
}
```

**Goals** are the primary entity. Each goal has:
- `id`, `title`, `description`, `notes`, `status` (`active`/`done`), `completed` (boolean, synced with status)
- `condoId` (nullable reference to a condo)
- `priority`, `deadline` (optional metadata)
- `tasks[]` (embedded task objects)
- `sessions[]` (assigned session keys)
- `createdAtMs`, `updatedAtMs`

**Tasks** are embedded in goals. Each task has:
- `id`, `text`, `description`, `status` (`pending`/`in-progress`/`blocked`/`done`), `done` (boolean, synced with status)
- `sessionKey` (the subagent session assigned to this task, set by `spawnTaskSession`)
- `priority`, `dependsOn[]`, `summary`
- `createdAtMs`, `updatedAtMs`

**Condos** group goals. Each condo has:
- `id`, `name`, `description`, `color`
- `createdAtMs`, `updatedAtMs`

**Indexes** provide fast lookups:
- `sessionIndex`: `{ [sessionKey]: { goalId } }` — maps sessions to their goal
- `sessionCondoIndex`: `{ [sessionKey]: condoId }` — maps sessions to their condo

### File Structure

```
clawcondos/condo-management/
  index.js                  # Plugin entry point (registers everything)
  openclaw.plugin.json      # Plugin manifest
  package.json              # Node.js package metadata
  migrate.js                # Migration from .registry/goals.json
  lib/
    goals-store.js          # File-backed JSON store with atomic writes
    goals-handlers.js       # Goals + tasks + sessions RPC handlers
    condos-handlers.js      # Condos RPC handlers
    context-builder.js      # Builds goal context for agent prompt injection
    goal-update-tool.js     # Agent tool executor for reporting task status
    task-spawn.js           # Spawn subagent session for a task
  .data/
    goals.json              # Data file (gitignored)
```

## Gateway RPC Methods

All methods follow the standard OpenClaw JSON-RPC protocol over WebSocket.

### Goals CRUD

| Method | Params | Returns | Notes |
|--------|--------|---------|-------|
| `goals.list` | — | `{ goals }` | All goals |
| `goals.create` | `title`, `condoId?`, `description?`, `status?`, `priority?`, `deadline?`, `notes?` | `{ goal }` | Tasks always start empty (use `addTask`) |
| `goals.get` | `id` | `{ goal }` | |
| `goals.update` | `id`, plus any of: `title`, `description`, `status`, `completed`, `condoId`, `priority`, `deadline`, `notes`, `tasks` | `{ goal }` | Whitelist prevents overwriting `id`, `sessions`, `createdAtMs`. Title validated. Status/completed synced. |
| `goals.delete` | `id` | `{ ok }` | Cleans up sessionIndex entries |

### Session Management

| Method | Params | Returns | Notes |
|--------|--------|---------|-------|
| `goals.addSession` | `id`, `sessionKey` | `{ ok, goal }` | Move semantics: removes session from any prior goal first |
| `goals.removeSession` | `id`, `sessionKey` | `{ ok, goal }` | Validates sessionKey, cleans up sessionIndex |
| `goals.sessionLookup` | `sessionKey` | `{ goalId }` | Returns `null` if not assigned |

### Session-Condo Mapping

| Method | Params | Returns | Notes |
|--------|--------|---------|-------|
| `goals.setSessionCondo` | `sessionKey`, `condoId` | `{ ok }` | |
| `goals.getSessionCondo` | `sessionKey` | `{ condoId }` | |
| `goals.listSessionCondos` | — | `{ sessionCondoIndex }` | |

### Task CRUD

| Method | Params | Returns | Notes |
|--------|--------|---------|-------|
| `goals.addTask` | `goalId`, `text`, `description?`, `priority?`, `dependsOn?` | `{ task }` | Generates ID, validates text |
| `goals.updateTask` | `goalId`, `taskId`, plus any of: `text`, `description`, `status`, `done`, `priority`, `dependsOn`, `summary` | `{ task }` | Whitelist prevents overwriting `id`, `sessionKey`, `createdAtMs`. Status/done synced. |
| `goals.deleteTask` | `goalId`, `taskId` | `{ ok }` | |

### Task Spawning

| Method | Params | Returns | Notes |
|--------|--------|---------|-------|
| `goals.spawnTaskSession` | `goalId`, `taskId`, `agentId?`, `model?` | `{ sessionKey, taskContext, agentId, model, goalId, taskId }` | Generates session key, links to goal, builds context, guards against re-spawning |

## Lifecycle Hooks

### `before_agent_start`

Fires before an agent processes a message. If the session is assigned to a goal, injects goal/task context into the agent's prompt via `prependContext`.

The injected context includes:
- Goal title, description, status, priority, deadline
- Task checklist with completion markers (`[x]` / `[ ]`)
- Session assignments (marks tasks as "you", "assigned: <key>", or "unassigned")
- Completed task summaries
- Reminder to use `goal_update` tool when tasks remain

### `agent_end`

Fires after a successful agent response. Updates `goal.updatedAtMs` to track last activity.

## Agent Tool: `goal_update`

Agents call this tool to report task progress. Only available to sessions assigned to a goal.

**Parameters:**
- `taskId` (string, optional) — task to update
- `status` (required: `done` | `in-progress` | `blocked`)
- `summary` (string, optional) — what was accomplished or what's blocking

**Behavior:** Sets both `task.done` and `task.status` to stay in sync. Updates `goal.updatedAtMs`.

## Storage Layer

`goals-store.js` provides a simple file-backed JSON store:

- **Atomic writes**: Writes to a `.tmp` file then renames (prevents corruption on crash)
- **V2 migration**: Normalizes v1 data (adds `condoId`, `completed`, `sessions`, `tasks` defaults)
- **Safety**: Refuses to save if the store was loaded with parse errors (`_loadError` flag)
- **ID generation**: `newId(prefix)` returns `<prefix>_<24 hex chars>` using `crypto.randomBytes`

### Concurrency

The store is designed for single-process use. Concurrent writes from multiple processes would race. This is fine for OpenClaw's architecture where the gateway is a single process.

## Validation Patterns

All handlers follow consistent validation:

1. **Required fields**: Checked with `if (!field)` at handler start, returns error before loading data
2. **Title/name validation**: `typeof x !== 'string' || !x.trim()` — rejects empty, whitespace-only, and non-string values
3. **Whitelist pattern**: Update handlers iterate over allowed field names, preventing writes to internal fields (`id`, `createdAtMs`, `sessions`, `sessionKey`)
4. **Trim on save**: String fields are trimmed after whitelist application
5. **Status sync**: `status` and `done`/`completed` booleans are kept in sync bidirectionally

## Testing

181 tests across 10 test files. Run with `npm test`.

| Test File | Coverage |
|-----------|----------|
| `goals-handlers.test.js` | Goals CRUD, session management, task CRUD, validation |
| `condos-handlers.test.js` | Condos CRUD, goalCount enrichment, cascade delete, sessionCondoIndex cleanup |
| `goal-update-tool.test.js` | Status sync (done/in-progress/blocked), goal-level update, error cases |
| `task-spawn.test.js` | Spawn config, session linking, validation, re-spawn guard |
| `context-builder.test.js` | Context generation, session awareness, auto-completion prompt, null safety |
| `goals-store.test.js` | Load/save, atomic writes, v2 migration, ID generation, condos array |
| `plugin-index.test.js` | Plugin registration, hook integration, tool factory |
| `config.test.js` | Config loader (not plugin-specific) |
| `message-shaping.test.js` | Message formatting (not plugin-specific) |
| `serve-helpers.test.js` | Server helpers (not plugin-specific) |

## Installation

The plugin lives in the ClawCondos repo and is symlinked into OpenClaw's extensions directory:

```bash
ln -sf /path/to/clawcondos/clawcondos/condo-management ~/.openclaw/extensions/clawcondos-goals
```

Configure in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "clawcondos-goals": {
        "enabled": true
      }
    }
  }
}
```

Optional: set `dataDir` in plugin config to override the default `.data/` directory.
