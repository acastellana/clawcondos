# ClawCondos Goals Plugin (`clawcondos-goals`)

An OpenClaw plugin that manages goals, tasks, condos, and session-goal mappings for the ClawCondos dashboard. Provides native gateway RPC methods, lifecycle hooks, and agent tools for autonomous goal-driven orchestration.

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
│  │  21 RPC methods    │  │
│  │  2 lifecycle hooks │  │
│  │  5 agent tools     │  │
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
    condo-tools.js          # Agent tools for condo binding, goal creation, task management
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

## Agent Tools

### `goal_update`

Agents call this tool to report task progress. Available to any session with a `sessionKey`.

**Parameters:**
- `goalId` (string, optional) — explicit goal to update (required for condo-bound sessions updating non-own goals)
- `taskId` (string, optional) — task to update
- `status` (`done` | `in-progress` | `blocked`) — required when `taskId` is set
- `summary` (string, optional) — what was accomplished or what's blocking
- `addTasks` (array, optional) — new tasks to create on the goal
- `nextTask` (string, optional) — set the goal's next task hint
- `goalStatus` (`done` | `active`, optional) — mark goal as done or reactivate
- `notes` (string, optional) — append notes to the goal

**Cross-goal boundaries:** Sessions bound to a condo can update sibling goals, but only `addTasks` and `notes` are allowed cross-goal. Task status updates, `goalStatus`, and `nextTask` are restricted to the session's own goal.

### `condo_bind`

Binds the current session to a condo. Available when the session is not yet bound.

**Parameters:**
- `condoId` (string, optional) — bind to existing condo
- `name` (string, optional) — create a new condo and bind to it
- `description` (string, optional) — description for new condo

### `condo_create_goal`

Creates a goal in the bound condo. Available when session is bound to a condo.

**Parameters:**
- `title` (string, required) — goal title
- `description` (string, optional) — goal description
- `priority` (string, optional) — priority level
- `tasks` (array, optional) — initial tasks (strings or `{text, description, priority}` objects)

### `condo_add_task`

Adds a task to a goal in the bound condo.

**Parameters:**
- `goalId` (string, required) — goal to add the task to
- `text` (string, required) — task description
- `description` (string, optional) — detailed description
- `priority` (string, optional) — priority level

### `condo_spawn_task`

Spawns a subagent session for a task in the bound condo.

**Parameters:**
- `goalId` (string, required) — goal containing the task
- `taskId` (string, required) — task to spawn for
- `agentId` (string, optional) — agent to use (default: `main`)
- `model` (string, optional) — model override

## Storage Layer

`goals-store.js` provides a simple file-backed JSON store:

- **Atomic writes**: Writes to a `.tmp` file then renames (prevents corruption on crash)
- **Data migration**: Normalizes legacy data (adds `condoId`, `completed`, `sessions`, `tasks` defaults)
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

283 tests across 11 test files. Run with `npm test`.

| Test File | Coverage |
|-----------|----------|
| `goals-handlers.test.js` | Goals CRUD, session management, task CRUD, validation |
| `condos-handlers.test.js` | Condos CRUD, goalCount enrichment, cascade delete, sessionCondoIndex cleanup |
| `goal-update-tool.test.js` | Status sync, cross-goal boundaries, goal-level update, error cases |
| `condo-tools.test.js` | condo_bind, condo_create_goal, condo_add_task, condo_spawn_task |
| `task-spawn.test.js` | Spawn config, session linking, project summary, re-spawn guard |
| `context-builder.test.js` | Goal context, project summary, condo context, null safety |
| `goals-store.test.js` | Load/save, atomic writes, data migration, ID generation, condos array |
| `plugin-index.test.js` | Plugin registration, hook integration, tool factory |
| `config.test.js` | Config loader (not plugin-specific) |
| `message-shaping.test.js` | Message formatting (not plugin-specific) |
| `serve-helpers.test.js` | Server helpers (not plugin-specific) |

## Installation

The plugin lives in the ClawCondos repo at `clawcondos/condo-management/`. Install it into OpenClaw using the link flag (recommended for development — edits take effect on gateway restart):

```bash
cd /path/to/clawcondos
openclaw plugins install -l ./clawcondos/condo-management
```

This registers the plugin, creates the config entries, and symlinks to the source directory. Restart the gateway to load it.

Optional: set `dataDir` in plugin config to override the default `.data/` directory.
