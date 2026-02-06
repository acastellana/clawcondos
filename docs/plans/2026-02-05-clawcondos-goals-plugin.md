# ClawCondos Goals Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the goals/tasks/condos data layer from ClawCondos' serve.js into an OpenClaw plugin, enabling native gateway RPC methods, automatic agent context injection, and structured agent goal reporting.

**Architecture:** A new OpenClaw plugin (`clawcondos-goals`) registers gateway methods (`goals.list`, `goals.create`, etc.), lifecycle hooks (`before_agent_start`, `agent_end`), and an agent tool (`goal_update`). ClawCondos' frontend migrates from HTTP REST calls to WebSocket RPC. The plugin owns all goals data with file-backed JSON storage, eliminating the current split-brain between ClawCondos' `.registry/goals.json` and OpenClaw's session store.

**Tech Stack:** OpenClaw plugin SDK (JS), file-backed JSON storage, Vitest for tests

**Key References:**
- OpenClaw plugin SDK types: `/home/albert/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/index.d.ts`
- Current goals code: `/home/albert/clawd/projects/clawcondos/serve.js:55-108` (storage), `:597-801` (routes)
- Current frontend goals: `/home/albert/clawd/projects/clawcondos/index.html:2134-3358`
- Plugin loading: `~/.openclaw/extensions/` or `plugins.load.paths` in `~/.openclaw/openclaw.json`
- Gateway method registration: `api.registerGatewayMethod(method, handler)`
- Hook registration: `api.on("before_agent_start", handler)`
- Tool registration: `api.registerTool(tool, opts)`

**Plugin location (source):** `/home/albert/clawd/projects/clawcondos/clawcondos/condo-management/`
**Plugin install (symlink):** `~/.openclaw/extensions/clawcondos-goals` -> source

---

## Task 1: Plugin Scaffold

Create the minimal plugin structure that OpenClaw can load successfully.

**Files:**
- Create: `clawcondos/condo-management/openclaw.plugin.json`
- Create: `clawcondos/condo-management/index.js`
- Modify: `~/.openclaw/openclaw.json` (add plugin config)

**Step 1: Create plugin manifest**

Create `clawcondos/condo-management/openclaw.plugin.json`:
```json
{
  "id": "clawcondos-goals",
  "name": "ClawCondos Goals",
  "description": "Goals, tasks, and condos management for ClawCondos",
  "version": "0.1.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "dataDir": {
        "type": "string",
        "description": "Directory for goals data storage (default: .registry in plugin dir)"
      }
    }
  }
}
```

**Step 2: Create empty plugin entry point**

Create `clawcondos/condo-management/index.js`:
```javascript
export default function register(api) {
  api.logger.info('clawcondos-goals plugin loaded');
}
```

**Step 3: Symlink plugin into OpenClaw extensions**

```bash
ln -sf /home/albert/clawd/projects/clawcondos/clawcondos/condo-management \
       /home/albert/.openclaw/extensions/clawcondos-goals
```

**Step 4: Enable plugin in OpenClaw config**

Add to `~/.openclaw/openclaw.json` under `plugins`:
```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "clawcondos-goals": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

**Step 5: Verify plugin loads**

Restart the OpenClaw gateway and check logs for `clawcondos-goals plugin loaded`. If using the CLI:
```bash
openclaw --version
# Check gateway logs for plugin load confirmation
```

**Step 6: Commit**

```bash
git add clawcondos/condo-management/
git commit -m "feat: scaffold clawcondos-goals OpenClaw plugin"
```

---

## Task 2: Goals Data Store Module

Port the file-backed goals storage from `serve.js` into a standalone module the plugin can use. Test it independently.

**Files:**
- Create: `clawcondos/condo-management/lib/goals-store.js`
- Create: `tests/goals-store.test.js`

**Step 1: Write failing tests for the goals store**

Create `tests/goals-store.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createGoalsStore } from '../clawcondos/condo-management/lib/goals-store.js';

const TEST_DIR = join(import.meta.dirname, '__fixtures__', 'goals-store-test');

describe('GoalsStore', () => {
  let store;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('load/save', () => {
    it('returns empty store when no file exists', () => {
      const data = store.load();
      expect(data.version).toBe(2);
      expect(data.goals).toEqual([]);
      expect(data.sessionIndex).toEqual({});
    });

    it('round-trips data through save and load', () => {
      const goal = {
        id: 'goal_test1',
        title: 'Test Goal',
        description: '',
        status: 'active',
        completed: false,
        condoId: null,
        priority: null,
        deadline: null,
        notes: '',
        tasks: [],
        sessions: [],
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };
      const data = store.load();
      data.goals.push(goal);
      store.save(data);

      const loaded = store.load();
      expect(loaded.goals).toHaveLength(1);
      expect(loaded.goals[0].title).toBe('Test Goal');
    });

    it('uses atomic writes (temp file + rename)', () => {
      const data = store.load();
      data.goals.push({ id: 'goal_x', title: 'X', sessions: [], tasks: [] });
      store.save(data);
      // No .tmp file should remain
      expect(existsSync(join(TEST_DIR, 'goals.json.tmp'))).toBe(false);
      expect(existsSync(join(TEST_DIR, 'goals.json'))).toBe(true);
    });

    it('refuses to save if loaded with errors', () => {
      const broken = store.load();
      broken._loadError = true;
      expect(() => store.save(broken)).toThrow(/refusing to save/i);
    });
  });

  describe('v2 migration', () => {
    it('normalizes v1 goals to v2 format', () => {
      const { writeFileSync } = await import('fs');
      writeFileSync(join(TEST_DIR, 'goals.json'), JSON.stringify({
        goals: [{ id: 'g1', title: 'Old', status: 'done', notes: 'some notes' }]
      }));
      const data = store.load();
      expect(data.goals[0].completed).toBe(true);
      expect(data.goals[0].description).toBe('some notes');
      expect(data.goals[0].sessions).toEqual([]);
      expect(data.goals[0].condoId).toBeNull();
    });
  });

  describe('newId', () => {
    it('generates prefixed random IDs', () => {
      const id = store.newId('goal');
      expect(id).toMatch(/^goal_[a-f0-9]{24}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => store.newId('goal')));
      expect(ids.size).toBe(100);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/goals-store.test.js
```
Expected: FAIL (module not found)

**Step 3: Implement the goals store**

Create `clawcondos/condo-management/lib/goals-store.js`:
```javascript
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

export function createGoalsStore(dataDir) {
  const filePath = join(dataDir, 'goals.json');

  function newId(prefix = 'goal') {
    return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
  }

  function load() {
    if (!existsSync(filePath)) {
      return { version: 2, goals: [], sessionIndex: {}, sessionCondoIndex: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      const rawGoals = Array.isArray(parsed.goals) ? parsed.goals : [];
      const goals = rawGoals.map(g => {
        const completed = g?.completed === true || g?.status === 'done';
        return {
          ...g,
          condoId: g?.condoId ?? null,
          completed,
          description: g?.description ?? g?.notes ?? '',
          sessions: Array.isArray(g?.sessions) ? g.sessions : [],
          tasks: Array.isArray(g?.tasks) ? g.tasks : [],
        };
      });
      return {
        version: parsed.version ?? 2,
        goals,
        sessionIndex: parsed.sessionIndex && typeof parsed.sessionIndex === 'object' ? parsed.sessionIndex : {},
        sessionCondoIndex: parsed.sessionCondoIndex && typeof parsed.sessionCondoIndex === 'object' ? parsed.sessionCondoIndex : {},
      };
    } catch (err) {
      return { version: 2, goals: [], sessionIndex: {}, sessionCondoIndex: {}, _loadError: true };
    }
  }

  function save(data) {
    if (data._loadError) {
      throw new Error('Refusing to save — store was loaded with errors (would destroy data)');
    }
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, filePath);
  }

  return { load, save, newId, filePath };
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/goals-store.test.js
```
Expected: PASS

**Step 5: Commit**

```bash
git add clawcondos/condo-management/lib/goals-store.js tests/goals-store.test.js
git commit -m "feat: goals data store module with tests"
```

---

## Task 3: Goals CRUD Gateway Methods

Register `goals.list`, `goals.create`, `goals.get`, `goals.update`, `goals.delete` as gateway RPC methods.

**Files:**
- Modify: `clawcondos/condo-management/index.js`
- Create: `clawcondos/condo-management/lib/goals-handlers.js`
- Create: `tests/goals-handlers.test.js`

**Step 1: Write failing tests for goal handlers**

Create `tests/goals-handlers.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createGoalsStore } from '../clawcondos/condo-management/lib/goals-store.js';
import { createGoalHandlers } from '../clawcondos/condo-management/lib/goals-handlers.js';

const TEST_DIR = join(import.meta.dirname, '__fixtures__', 'goals-handlers-test');

function makeResponder() {
  let result = null;
  const respond = (ok, payload, error) => { result = { ok, payload, error }; };
  return { respond, getResult: () => result };
}

describe('GoalHandlers', () => {
  let store, handlers;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
    handlers = createGoalHandlers(store);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('goals.create', () => {
    it('creates a goal with required fields', () => {
      const { respond, getResult } = makeResponder();
      handlers['goals.create']({ params: { title: 'Ship v2' }, respond });
      const r = getResult();
      expect(r.ok).toBe(true);
      expect(r.payload.goal.title).toBe('Ship v2');
      expect(r.payload.goal.id).toMatch(/^goal_/);
      expect(r.payload.goal.status).toBe('active');
      expect(r.payload.goal.sessions).toEqual([]);
      expect(r.payload.goal.tasks).toEqual([]);
    });

    it('rejects missing title', () => {
      const { respond, getResult } = makeResponder();
      handlers['goals.create']({ params: {}, respond });
      expect(getResult().ok).toBe(false);
    });

    it('accepts optional fields', () => {
      const { respond, getResult } = makeResponder();
      handlers['goals.create']({
        params: { title: 'G', condoId: 'condo:test', priority: 'P0', deadline: '2026-03-01' },
        respond,
      });
      const goal = getResult().payload.goal;
      expect(goal.condoId).toBe('condo:test');
      expect(goal.priority).toBe('P0');
      expect(goal.deadline).toBe('2026-03-01');
    });
  });

  describe('goals.list', () => {
    it('returns empty list initially', () => {
      const { respond, getResult } = makeResponder();
      handlers['goals.list']({ params: {}, respond });
      expect(getResult().payload.goals).toEqual([]);
    });

    it('returns created goals', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'A' }, respond: r1.respond });
      handlers['goals.create']({ params: { title: 'B' }, respond: makeResponder().respond });

      const r2 = makeResponder();
      handlers['goals.list']({ params: {}, respond: r2.respond });
      expect(r2.getResult().payload.goals).toHaveLength(2);
    });
  });

  describe('goals.get', () => {
    it('returns a goal by id', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'Find me' }, respond: r1.respond });
      const id = r1.getResult().payload.goal.id;

      const r2 = makeResponder();
      handlers['goals.get']({ params: { id }, respond: r2.respond });
      expect(r2.getResult().payload.goal.title).toBe('Find me');
    });

    it('returns error for missing goal', () => {
      const { respond, getResult } = makeResponder();
      handlers['goals.get']({ params: { id: 'goal_nonexistent' }, respond });
      expect(getResult().ok).toBe(false);
    });
  });

  describe('goals.update', () => {
    it('patches goal fields', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'Original' }, respond: r1.respond });
      const id = r1.getResult().payload.goal.id;

      const r2 = makeResponder();
      handlers['goals.update']({
        params: { id, title: 'Updated', priority: 'P1' },
        respond: r2.respond,
      });
      const updated = r2.getResult().payload.goal;
      expect(updated.title).toBe('Updated');
      expect(updated.priority).toBe('P1');
      expect(updated.updatedAtMs).toBeGreaterThan(updated.createdAtMs);
    });

    it('syncs completed and status fields', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const id = r1.getResult().payload.goal.id;

      const r2 = makeResponder();
      handlers['goals.update']({ params: { id, status: 'done' }, respond: r2.respond });
      expect(r2.getResult().payload.goal.completed).toBe(true);
    });
  });

  describe('goals.delete', () => {
    it('deletes a goal and cleans up session index', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'Doomed' }, respond: r1.respond });
      const id = r1.getResult().payload.goal.id;

      // Assign a session first
      handlers['goals.addSession']({
        params: { id, sessionKey: 'agent:main:main' },
        respond: makeResponder().respond,
      });

      const r2 = makeResponder();
      handlers['goals.delete']({ params: { id }, respond: r2.respond });
      expect(r2.getResult().ok).toBe(true);

      // Session index should be cleaned up
      const r3 = makeResponder();
      handlers['goals.list']({ params: {}, respond: r3.respond });
      expect(r3.getResult().payload.goals).toHaveLength(0);
    });
  });

  describe('goals.addSession', () => {
    it('assigns a session to a goal', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const id = r1.getResult().payload.goal.id;

      const r2 = makeResponder();
      handlers['goals.addSession']({
        params: { id, sessionKey: 'agent:main:main' },
        respond: r2.respond,
      });
      expect(r2.getResult().ok).toBe(true);
      expect(r2.getResult().payload.goal.sessions).toContain('agent:main:main');
    });

    it('enforces 1-session-to-1-goal invariant (moves session)', () => {
      const r1 = makeResponder();
      const r2 = makeResponder();
      handlers['goals.create']({ params: { title: 'A' }, respond: r1.respond });
      handlers['goals.create']({ params: { title: 'B' }, respond: r2.respond });
      const idA = r1.getResult().payload.goal.id;
      const idB = r2.getResult().payload.goal.id;

      // Assign to A
      handlers['goals.addSession']({
        params: { id: idA, sessionKey: 'agent:main:main' },
        respond: makeResponder().respond,
      });
      // Move to B
      handlers['goals.addSession']({
        params: { id: idB, sessionKey: 'agent:main:main' },
        respond: makeResponder().respond,
      });

      // A should no longer have the session
      const r3 = makeResponder();
      handlers['goals.get']({ params: { id: idA }, respond: r3.respond });
      expect(r3.getResult().payload.goal.sessions).not.toContain('agent:main:main');

      // B should have it
      const r4 = makeResponder();
      handlers['goals.get']({ params: { id: idB }, respond: r4.respond });
      expect(r4.getResult().payload.goal.sessions).toContain('agent:main:main');
    });
  });

  describe('goals.sessionLookup', () => {
    it('returns goal for a session', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const id = r1.getResult().payload.goal.id;
      handlers['goals.addSession']({
        params: { id, sessionKey: 'agent:main:main' },
        respond: makeResponder().respond,
      });

      const r2 = makeResponder();
      handlers['goals.sessionLookup']({
        params: { sessionKey: 'agent:main:main' },
        respond: r2.respond,
      });
      expect(r2.getResult().payload.goalId).toBe(id);
    });

    it('returns null for unassigned session', () => {
      const { respond, getResult } = makeResponder();
      handlers['goals.sessionLookup']({
        params: { sessionKey: 'agent:orphan:main' },
        respond,
      });
      expect(getResult().payload.goalId).toBeNull();
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/goals-handlers.test.js
```
Expected: FAIL (module not found)

**Step 3: Implement goal handlers**

Create `clawcondos/condo-management/lib/goals-handlers.js`:
```javascript
export function createGoalHandlers(store) {
  function loadData() { return store.load(); }
  function saveData(data) { store.save(data); }

  return {
    'goals.list': ({ params, respond }) => {
      try {
        const data = loadData();
        respond(true, { goals: data.goals });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.create': ({ params, respond }) => {
      try {
        const { title, condoId, description, completed, status, priority, deadline, notes, tasks } = params;
        if (!title || typeof title !== 'string' || !title.trim()) {
          respond(false, undefined, { message: 'title is required' });
          return;
        }
        const data = loadData();
        const now = Date.now();
        const isCompleted = completed === true || status === 'done';
        const goal = {
          id: store.newId('goal'),
          title: title.trim(),
          description: description || notes || '',
          notes: notes || '',
          status: isCompleted ? 'done' : 'active',
          completed: isCompleted,
          condoId: condoId || null,
          priority: priority || null,
          deadline: deadline || null,
          tasks: Array.isArray(tasks) ? tasks : [],
          sessions: [],
          createdAtMs: now,
          updatedAtMs: now,
        };
        data.goals.unshift(goal);
        saveData(data);
        respond(true, { goal });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.get': ({ params, respond }) => {
      try {
        const data = loadData();
        const goal = data.goals.find(g => g.id === params.id);
        if (!goal) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        respond(true, { goal });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.update': ({ params, respond }) => {
      try {
        const data = loadData();
        const idx = data.goals.findIndex(g => g.id === params.id);
        if (idx === -1) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        const goal = data.goals[idx];
        const patch = { ...params };
        delete patch.id;

        // Merge patch
        Object.assign(goal, patch);
        goal.updatedAtMs = Date.now();

        // Sync completed/status
        if ('status' in patch) {
          goal.completed = goal.status === 'done';
        } else if ('completed' in patch) {
          goal.status = goal.completed ? 'done' : 'active';
        }

        saveData(data);
        respond(true, { goal });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.delete': ({ params, respond }) => {
      try {
        const data = loadData();
        const idx = data.goals.findIndex(g => g.id === params.id);
        if (idx === -1) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        // Clean up session index entries pointing to this goal
        for (const [key, val] of Object.entries(data.sessionIndex)) {
          if (val.goalId === params.id) delete data.sessionIndex[key];
        }
        data.goals.splice(idx, 1);
        saveData(data);
        respond(true, { ok: true });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.addSession': ({ params, respond }) => {
      try {
        const { id, sessionKey } = params;
        if (!sessionKey) {
          respond(false, undefined, { message: 'sessionKey is required' });
          return;
        }
        const data = loadData();
        const goal = data.goals.find(g => g.id === id);
        if (!goal) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        // Remove session from any other goal (move semantics)
        for (const g of data.goals) {
          const sIdx = (g.sessions || []).indexOf(sessionKey);
          if (sIdx !== -1) {
            g.sessions.splice(sIdx, 1);
            g.updatedAtMs = Date.now();
          }
        }
        // Add to target goal
        if (!goal.sessions.includes(sessionKey)) {
          goal.sessions.unshift(sessionKey);
        }
        goal.updatedAtMs = Date.now();
        data.sessionIndex[sessionKey] = { goalId: id };
        saveData(data);
        respond(true, { ok: true, goal });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.removeSession': ({ params, respond }) => {
      try {
        const { id, sessionKey } = params;
        const data = loadData();
        const goal = data.goals.find(g => g.id === id);
        if (!goal) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        goal.sessions = (goal.sessions || []).filter(s => s !== sessionKey);
        goal.updatedAtMs = Date.now();
        delete data.sessionIndex[sessionKey];
        saveData(data);
        respond(true, { ok: true, goal });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.sessionLookup': ({ params, respond }) => {
      try {
        const data = loadData();
        const entry = data.sessionIndex[params.sessionKey];
        respond(true, { goalId: entry?.goalId ?? null });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/goals-handlers.test.js
```
Expected: PASS

**Step 5: Wire handlers into plugin**

Update `clawcondos/condo-management/index.js`:
```javascript
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createGoalsStore } from './lib/goals-store.js';
import { createGoalHandlers } from './lib/goals-handlers.js';

export default function register(api) {
  const dataDir = api.pluginConfig?.dataDir
    || join(dirname(fileURLToPath(import.meta.url)), '.data');
  const store = createGoalsStore(dataDir);
  const handlers = createGoalHandlers(store);

  for (const [method, handler] of Object.entries(handlers)) {
    api.registerGatewayMethod(method, handler);
  }

  api.logger.info(`clawcondos-goals: registered ${Object.keys(handlers).length} gateway methods, data at ${dataDir}`);
}
```

**Step 6: Verify plugin loads with gateway methods**

Restart OpenClaw gateway. Test via WebSocket or the ClawCondos browser console:
```javascript
// In browser console (ClawCondos)
rpcCall('goals.list', {}).then(r => console.log(r));
// Should return: { goals: [] }
```

**Step 7: Commit**

```bash
git add clawcondos/condo-management/ tests/goals-handlers.test.js
git commit -m "feat: goals CRUD + session assignment gateway methods"
```

---

## Task 4: Condo-Session Mapping Methods

Add the session-condo index methods (parallel to session-goal, but for Telegram topic mapping).

**Files:**
- Modify: `clawcondos/condo-management/lib/goals-handlers.js`
- Modify: `tests/goals-handlers.test.js`

**Step 1: Add tests for condo methods**

Append to `tests/goals-handlers.test.js`:
```javascript
describe('goals.setSessionCondo', () => {
  it('maps a session to a condo', () => {
    const { respond, getResult } = makeResponder();
    handlers['goals.setSessionCondo']({
      params: { sessionKey: 'agent:main:main', condoId: 'condo:genlayer' },
      respond,
    });
    expect(getResult().ok).toBe(true);
  });
});

describe('goals.getSessionCondo', () => {
  it('returns condo for a mapped session', () => {
    handlers['goals.setSessionCondo']({
      params: { sessionKey: 'agent:main:main', condoId: 'condo:test' },
      respond: makeResponder().respond,
    });
    const { respond, getResult } = makeResponder();
    handlers['goals.getSessionCondo']({
      params: { sessionKey: 'agent:main:main' },
      respond,
    });
    expect(getResult().payload.condoId).toBe('condo:test');
  });

  it('returns null for unmapped session', () => {
    const { respond, getResult } = makeResponder();
    handlers['goals.getSessionCondo']({
      params: { sessionKey: 'agent:nobody:main' },
      respond,
    });
    expect(getResult().payload.condoId).toBeNull();
  });
});

describe('goals.listSessionCondos', () => {
  it('returns all session-condo mappings', () => {
    handlers['goals.setSessionCondo']({
      params: { sessionKey: 'a', condoId: 'c1' },
      respond: makeResponder().respond,
    });
    handlers['goals.setSessionCondo']({
      params: { sessionKey: 'b', condoId: 'c2' },
      respond: makeResponder().respond,
    });
    const { respond, getResult } = makeResponder();
    handlers['goals.listSessionCondos']({ params: {}, respond });
    expect(Object.keys(getResult().payload.sessionCondoIndex)).toHaveLength(2);
  });
});
```

**Step 2: Run tests, verify new ones fail**

```bash
npx vitest run tests/goals-handlers.test.js
```

**Step 3: Add condo handlers to goals-handlers.js**

Add these entries to the returned object in `createGoalHandlers`:
```javascript
'goals.setSessionCondo': ({ params, respond }) => {
  try {
    const { sessionKey, condoId } = params;
    if (!sessionKey || !condoId) {
      respond(false, undefined, { message: 'sessionKey and condoId are required' });
      return;
    }
    const data = loadData();
    data.sessionCondoIndex[sessionKey] = condoId;
    saveData(data);
    respond(true, { ok: true, sessionKey, condoId });
  } catch (err) {
    respond(false, undefined, { message: String(err) });
  }
},

'goals.getSessionCondo': ({ params, respond }) => {
  try {
    const data = loadData();
    respond(true, { condoId: data.sessionCondoIndex[params.sessionKey] ?? null });
  } catch (err) {
    respond(false, undefined, { message: String(err) });
  }
},

'goals.listSessionCondos': ({ params, respond }) => {
  try {
    const data = loadData();
    respond(true, { sessionCondoIndex: data.sessionCondoIndex });
  } catch (err) {
    respond(false, undefined, { message: String(err) });
  }
},
```

**Step 4: Run tests, verify pass**

```bash
npx vitest run tests/goals-handlers.test.js
```

**Step 5: Commit**

```bash
git add clawcondos/condo-management/lib/goals-handlers.js tests/goals-handlers.test.js
git commit -m "feat: session-condo mapping gateway methods"
```

---

## Task 5: Agent Context Injection Hook

Register a `before_agent_start` hook that injects goal/task context into the agent's prompt when the session belongs to a goal.

**Files:**
- Create: `clawcondos/condo-management/lib/context-builder.js`
- Create: `tests/context-builder.test.js`
- Modify: `clawcondos/condo-management/index.js`

**Step 1: Write tests for context builder**

Create `tests/context-builder.test.js`:
```javascript
import { describe, it, expect } from 'vitest';
import { buildGoalContext } from '../clawcondos/condo-management/lib/context-builder.js';

describe('buildGoalContext', () => {
  const baseGoal = {
    id: 'goal_1',
    title: 'Ship v2',
    description: 'Launch the v2 release',
    status: 'active',
    priority: 'P0',
    deadline: '2026-02-15',
    tasks: [
      { id: 't1', text: 'Build API endpoints', done: true },
      { id: 't2', text: 'Wire up frontend', done: false },
      { id: 't3', text: 'Write tests', done: false },
    ],
    sessions: ['agent:main:main', 'agent:main:subagent:abc'],
    condoId: 'condo:clawcondos',
  };

  it('returns null if no goal provided', () => {
    expect(buildGoalContext(null)).toBeNull();
  });

  it('includes goal title and description', () => {
    const ctx = buildGoalContext(baseGoal);
    expect(ctx).toContain('Ship v2');
    expect(ctx).toContain('Launch the v2 release');
  });

  it('includes task list with completion markers', () => {
    const ctx = buildGoalContext(baseGoal);
    expect(ctx).toContain('[x] Build API endpoints');
    expect(ctx).toContain('[ ] Wire up frontend');
  });

  it('includes priority and deadline', () => {
    const ctx = buildGoalContext(baseGoal);
    expect(ctx).toContain('P0');
    expect(ctx).toContain('2026-02-15');
  });

  it('includes session count', () => {
    const ctx = buildGoalContext(baseGoal);
    expect(ctx).toContain('2');
  });
});
```

**Step 2: Run tests, verify fail**

```bash
npx vitest run tests/context-builder.test.js
```

**Step 3: Implement context builder**

Create `clawcondos/condo-management/lib/context-builder.js`:
```javascript
export function buildGoalContext(goal) {
  if (!goal) return null;

  const lines = [
    `# Goal: ${goal.title}`,
  ];

  if (goal.description) lines.push(``, goal.description);

  const meta = [];
  if (goal.status) meta.push(`Status: ${goal.status}`);
  if (goal.priority) meta.push(`Priority: ${goal.priority}`);
  if (goal.deadline) meta.push(`Deadline: ${goal.deadline}`);
  if (goal.sessions?.length) meta.push(`Sessions: ${goal.sessions.length}`);
  if (meta.length) lines.push(``, meta.join(' | '));

  if (goal.tasks?.length) {
    lines.push(``, `## Tasks`);
    for (const t of goal.tasks) {
      lines.push(`- [${t.done ? 'x' : ' '}] ${t.text}`);
    }
  }

  return lines.join('\n');
}
```

**Step 4: Run tests, verify pass**

```bash
npx vitest run tests/context-builder.test.js
```

**Step 5: Wire the hook into plugin**

Add to `clawcondos/condo-management/index.js` inside the `register` function:
```javascript
import { buildGoalContext } from './lib/context-builder.js';

// ... after registering gateway methods ...

api.on('before_agent_start', async (event, ctx) => {
  if (!ctx.sessionKey) return;
  const data = store.load();
  const entry = data.sessionIndex[ctx.sessionKey];
  if (!entry) return;
  const goal = data.goals.find(g => g.id === entry.goalId);
  if (!goal) return;
  const context = buildGoalContext(goal);
  if (!context) return;
  return { prependContext: context };
}, { priority: 5 });

api.logger.info('clawcondos-goals: registered before_agent_start hook for goal context injection');
```

**Step 6: Verify hook fires**

Restart gateway. Assign a session to a goal via browser console:
```javascript
rpcCall('goals.create', { title: 'Test goal' }).then(r => {
  const goalId = r.payload.goal.id;
  rpcCall('goals.addSession', { id: goalId, sessionKey: 'agent:main:main' });
});
```
Then send a message to the main agent. The agent should now see goal context prepended to the message.

**Step 7: Commit**

```bash
git add clawcondos/condo-management/lib/context-builder.js tests/context-builder.test.js clawcondos/condo-management/index.js
git commit -m "feat: before_agent_start hook injects goal context into agent prompts"
```

---

## Task 6: Agent Completion Hook

Register an `agent_end` hook that observes when sessions complete, for future auto-detection of task completion.

**Files:**
- Modify: `clawcondos/condo-management/index.js`

**Step 1: Add agent_end hook to plugin**

Add to `clawcondos/condo-management/index.js`:
```javascript
api.on('agent_end', async (event, ctx) => {
  if (!ctx.sessionKey || !event.success) return;
  const data = store.load();
  const entry = data.sessionIndex[ctx.sessionKey];
  if (!entry) return;
  const goal = data.goals.find(g => g.id === entry.goalId);
  if (!goal) return;

  // Update goal's updatedAtMs to reflect activity
  goal.updatedAtMs = Date.now();
  store.save(data);

  api.logger.info(`clawcondos-goals: agent_end for session ${ctx.sessionKey} (goal: ${goal.title})`);
});
```

This is a lightweight hook for now. It updates the goal's timestamp on any session activity. Task completion detection (parsing agent output) will be added later as an enhancement.

**Step 2: Commit**

```bash
git add clawcondos/condo-management/index.js
git commit -m "feat: agent_end hook tracks session activity on goals"
```

---

## Task 7: goal_update Agent Tool

Register a tool that agents can use to report task status updates.

**Files:**
- Create: `clawcondos/condo-management/lib/goal-update-tool.js`
- Create: `tests/goal-update-tool.test.js`
- Modify: `clawcondos/condo-management/index.js`

**Step 1: Write tests for the tool handler logic**

Create `tests/goal-update-tool.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createGoalsStore } from '../clawcondos/condo-management/lib/goals-store.js';
import { createGoalUpdateExecutor } from '../clawcondos/condo-management/lib/goal-update-tool.js';

const TEST_DIR = join(import.meta.dirname, '__fixtures__', 'goal-update-test');

describe('goal_update tool', () => {
  let store, execute;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
    execute = createGoalUpdateExecutor(store);

    // Seed a goal with tasks
    const data = store.load();
    data.goals.push({
      id: 'goal_1', title: 'Ship v2', status: 'active', completed: false,
      sessions: ['agent:main:main'], tasks: [
        { id: 'task_1', text: 'Build API', done: false },
        { id: 'task_2', text: 'Write tests', done: false },
      ],
      condoId: null, priority: null, deadline: null, description: '', notes: '',
      createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    data.sessionIndex['agent:main:main'] = { goalId: 'goal_1' };
    store.save(data);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('marks a task as done', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_1',
      status: 'done',
      summary: 'Built all endpoints',
    });
    expect(result.content[0].text).toContain('updated');

    const data = store.load();
    const task = data.goals[0].tasks.find(t => t.id === 'task_1');
    expect(task.done).toBe(true);
  });

  it('returns error for unknown session', async () => {
    const result = await execute('call2', {
      sessionKey: 'agent:unknown:main',
      taskId: 'task_1',
      status: 'done',
    });
    expect(result.content[0].text).toContain('not assigned');
  });
});
```

**Step 2: Run tests, verify fail**

```bash
npx vitest run tests/goal-update-tool.test.js
```

**Step 3: Implement the tool executor**

Create `clawcondos/condo-management/lib/goal-update-tool.js`:
```javascript
export function createGoalUpdateExecutor(store) {
  return async function execute(toolCallId, params) {
    const { sessionKey, taskId, status, summary } = params;

    const data = store.load();
    const entry = data.sessionIndex[sessionKey];
    if (!entry) {
      return { content: [{ type: 'text', text: 'Error: session not assigned to any goal.' }] };
    }

    const goal = data.goals.find(g => g.id === entry.goalId);
    if (!goal) {
      return { content: [{ type: 'text', text: 'Error: goal not found.' }] };
    }

    if (taskId) {
      const task = (goal.tasks || []).find(t => t.id === taskId);
      if (!task) {
        return { content: [{ type: 'text', text: `Error: task ${taskId} not found in goal.` }] };
      }
      task.done = status === 'done';
      if (summary) task.summary = summary;
    }

    goal.updatedAtMs = Date.now();
    store.save(data);

    const taskLabel = taskId ? `task ${taskId}` : 'goal';
    return {
      content: [{ type: 'text', text: `Goal "${goal.title}" updated: ${taskLabel} marked ${status}.` }],
    };
  };
}
```

**Step 4: Run tests, verify pass**

```bash
npx vitest run tests/goal-update-tool.test.js
```

**Step 5: Register tool in plugin**

Add to `clawcondos/condo-management/index.js`:
```javascript
import { createGoalUpdateExecutor } from './lib/goal-update-tool.js';

// ... inside register() ...

const goalUpdateExecute = createGoalUpdateExecutor(store);

api.registerTool(
  (ctx) => {
    // Only provide tool if session belongs to a goal
    if (!ctx.sessionKey) return null;
    const data = store.load();
    const entry = data.sessionIndex[ctx.sessionKey];
    if (!entry) return null;

    return {
      name: 'goal_update',
      label: 'Update Goal/Task Status',
      description: 'Report progress on a task within your assigned goal. Use when you complete a task or encounter a blocker.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'ID of the task to update (from goal context)' },
          status: { type: 'string', enum: ['done', 'in-progress', 'blocked'], description: 'New status' },
          summary: { type: 'string', description: 'Brief summary of what was accomplished or what is blocking' },
        },
        required: ['status'],
      },
      async execute(toolCallId, params) {
        return goalUpdateExecute(toolCallId, { ...params, sessionKey: ctx.sessionKey });
      },
    };
  },
  { optional: false, names: ['goal_update'] }
);

api.logger.info('clawcondos-goals: registered goal_update agent tool');
```

**Step 6: Commit**

```bash
git add clawcondos/condo-management/lib/goal-update-tool.js tests/goal-update-tool.test.js clawcondos/condo-management/index.js
git commit -m "feat: goal_update agent tool for structured task status reporting"
```

---

## Task 8: Data Migration Script

Create a script that migrates existing `.registry/goals.json` data from ClawCondos into the plugin's data directory.

**Files:**
- Create: `clawcondos/condo-management/migrate.js`

**Step 1: Write the migration script**

Create `clawcondos/condo-management/migrate.js`:
```javascript
#!/usr/bin/env node
/**
 * Migrate goals data from ClawCondos .registry/goals.json to plugin data dir.
 * Usage: node clawcondos/condo-management/migrate.js [source] [dest]
 *   source: path to .registry/goals.json (default: .registry/goals.json)
 *   dest: path to plugin data dir (default: clawcondos/condo-management/.data)
 */
import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';

const src = resolve(process.argv[2] || '.registry/goals.json');
const destDir = resolve(process.argv[3] || 'clawcondos/condo-management/.data');
const dest = join(destDir, 'goals.json');

if (!existsSync(src)) {
  console.log(`No source file at ${src} — nothing to migrate.`);
  process.exit(0);
}

if (existsSync(dest)) {
  console.log(`Destination ${dest} already exists. Aborting to avoid overwrite.`);
  console.log('Delete the destination file first if you want to re-migrate.');
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

// Verify
const data = JSON.parse(readFileSync(dest, 'utf-8'));
const goalCount = Array.isArray(data.goals) ? data.goals.length : 0;
const sessionCount = data.sessionIndex ? Object.keys(data.sessionIndex).length : 0;

console.log(`Migrated successfully:`);
console.log(`  ${goalCount} goals`);
console.log(`  ${sessionCount} session mappings`);
console.log(`  Source: ${src}`);
console.log(`  Dest:   ${dest}`);
```

**Step 2: Test migration with existing data**

```bash
node clawcondos/condo-management/migrate.js
```
Expected: Success message with goal/session counts, or "nothing to migrate" if no existing data.

**Step 3: Commit**

```bash
git add clawcondos/condo-management/migrate.js
git commit -m "feat: data migration script for goals.json"
```

---

## Task 9: Frontend Migration — Goals Loading

Migrate the frontend from HTTP REST calls (`fetch('/api/goals')`) to WebSocket RPC calls (`rpcCall('goals.list', {})`). Start with the data loading functions.

**Files:**
- Modify: `index.html`

**Step 1: Migrate loadGoals()**

In `index.html`, find `loadGoals()` (around line 2134). Replace the `fetch('/api/goals')` call with an `rpcCall`:

Old code (approximately):
```javascript
async function loadGoals() {
  try {
    const res = await fetch('/api/goals');
    const data = await res.json();
    state.goals = data.goals || [];
  } catch (e) { /* ... */ }
  renderGoals();
  renderGoalsGrid();
  updateUncategorizedCount();
}
```

New code:
```javascript
async function loadGoals() {
  try {
    const res = await rpcCall('goals.list', {});
    state.goals = res?.payload?.goals || res?.goals || [];
  } catch (e) {
    console.warn('loadGoals failed:', e);
  }
  renderGoals();
  renderGoalsGrid();
  updateUncategorizedCount();
}
```

**Step 2: Test in browser**

Refresh the ClawCondos dashboard. The sidebar should load goals from the plugin's gateway method instead of the HTTP endpoint.

**Step 3: Commit**

```bash
git add index.html
git commit -m "refactor: loadGoals uses goals.list RPC instead of HTTP"
```

---

## Task 10: Frontend Migration — Goal CRUD

Migrate `createGoal()`, `updateGoal()`, `promptDeleteGoal()` to use RPC.

**Files:**
- Modify: `index.html`

**Step 1: Migrate createGoal()**

Find `createGoal()` (around line 3334). Replace `fetch('/api/goals', { method: 'POST' })` with:
```javascript
const res = await rpcCall('goals.create', { title, deadline: deadline || undefined });
const goal = res?.payload?.goal || res?.goal;
```

**Step 2: Migrate updateGoal()**

Find `updateGoal()` (around line 2386). Replace `fetch('/api/goals/' + goalId, { method: 'PUT' })` with:
```javascript
const res = await rpcCall('goals.update', { id: goalId, ...patch });
const updatedGoal = res?.payload?.goal || res?.goal;
```

**Step 3: Migrate promptDeleteGoal()**

Find `promptDeleteGoal()` (around line 2463). Replace `fetch('/api/goals/' + goalId, { method: 'DELETE' })` with:
```javascript
await rpcCall('goals.delete', { id: state.currentGoalOpenId });
```

**Step 4: Test in browser**

- Create a new goal from the UI
- Edit the goal title, priority, deadline
- Delete the goal
- Verify all operations work

**Step 5: Commit**

```bash
git add index.html
git commit -m "refactor: goal CRUD uses RPC instead of HTTP"
```

---

## Task 11: Frontend Migration — Session Assignment

Migrate `confirmAttachSession()` and session lookup functions.

**Files:**
- Modify: `index.html`

**Step 1: Migrate confirmAttachSession()**

Find `confirmAttachSession()` (around line 2516). Replace `fetch('/api/goals/' + goalId + '/sessions')` with:
```javascript
await rpcCall('goals.addSession', { id: goalId, sessionKey });
```

**Step 2: Migrate getGoalForSession() to use local state**

This function already uses local `state.goals` — no HTTP call to migrate. Keep it as-is.

**Step 3: Migrate assignSessionToGoal()**

Find `assignSessionToGoal()` (around line 2809). Same pattern:
```javascript
await rpcCall('goals.addSession', { id: goalId, sessionKey: state.suggestingSessionKey });
```

**Step 4: Migrate createAndAssignGoal()**

Find `createAndAssignGoal()` (around line 2754):
```javascript
const res = await rpcCall('goals.create', { title });
const newGoal = res?.payload?.goal || res?.goal;
if (newGoal) {
  await rpcCall('goals.addSession', { id: newGoal.id, sessionKey: state.suggestingSessionKey });
}
```

**Step 5: Test session assignment**

- Open a session's context menu
- Assign it to a goal
- Verify it appears under the goal
- Move it to a different goal
- Verify it moved correctly

**Step 6: Commit**

```bash
git add index.html
git commit -m "refactor: session-goal assignment uses RPC instead of HTTP"
```

---

## Task 12: Frontend Migration — Condo Session Mapping

Migrate session-condo calls.

**Files:**
- Modify: `index.html`

**Step 1: Find and migrate all session-condo fetch calls**

Search `index.html` for `/api/session-condo`. Replace each:

- `fetch('/api/session-condo?sessionKey=...')` -> `rpcCall('goals.getSessionCondo', { sessionKey })`
- `fetch('/api/session-condos')` -> `rpcCall('goals.listSessionCondos', {})`
- `fetch('/api/session-condo', { method: 'POST' })` -> `rpcCall('goals.setSessionCondo', { sessionKey, condoId })`

**Step 2: Test condo mapping in browser**

**Step 3: Commit**

```bash
git add index.html
git commit -m "refactor: session-condo mapping uses RPC instead of HTTP"
```

---

## Task 13: Remove Goals Routes from serve.js

Now that the frontend uses RPC, remove the HTTP goals routes and storage code from serve.js.

**Files:**
- Modify: `serve.js`

**Step 1: Remove goals storage functions**

Remove these sections from `serve.js`:
- `goalsFilePath()` (lines 58-60)
- `loadGoalsStore()` (lines 62-93)
- `saveGoalsStore()` (lines 95-108)
- `newId()` (lines 261-263) — if only used by goals

**Step 2: Remove goals API route handlers**

Remove all handlers from `serve.js` that match these patterns:
- `GET /api/goals` (lines 597-602)
- `POST /api/goals` (lines 603-632)
- `GET /api/goals/:id` (lines 645-647)
- `PUT /api/goals/:id` (lines 659-687)
- `DELETE /api/goals/:id` (lines 649-657)
- `POST /api/goals/:id/sessions` (lines 693-747)
- `GET /api/session-goal` (lines 750-756)
- `GET /api/session-condos` (lines 759-763)
- `GET /api/session-condo` (lines 766-772)
- `POST /api/session-condo` (lines 775-801)

**Step 3: Run existing tests to verify nothing else broke**

```bash
npm test
```

**Step 4: Verify dashboard works end-to-end**

Open ClawCondos in browser. Verify:
- Goals load in sidebar
- Goal CRUD works
- Session assignment works
- Chat still works

**Step 5: Commit**

```bash
git add serve.js
git commit -m "refactor: remove goals HTTP routes from serve.js (migrated to plugin)"
```

---

## Task 14: Update CLAUDE.md and Documentation

Update project documentation to reflect the new architecture.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/SETUP.md`

**Step 1: Update CLAUDE.md**

Add to the Architecture section:
```markdown
### OpenClaw Plugin (clawcondos-goals)

Goals, tasks, and session-goal mappings are managed by an OpenClaw plugin at `clawcondos/condo-management/`. The plugin registers gateway RPC methods (`goals.list`, `goals.create`, etc.) that the frontend calls over WebSocket.

**Plugin files:**
- `clawcondos/condo-management/index.js` - Plugin entry point, registers gateway methods + hooks + tools
- `clawcondos/condo-management/lib/goals-store.js` - File-backed JSON storage for goals
- `clawcondos/condo-management/lib/goals-handlers.js` - Gateway method handlers for goals CRUD
- `clawcondos/condo-management/lib/context-builder.js` - Builds goal context for agent prompt injection
- `clawcondos/condo-management/lib/goal-update-tool.js` - Agent tool for reporting task status

**Plugin hooks:**
- `before_agent_start` - Injects goal/task context when a session belongs to a goal
- `agent_end` - Tracks session activity timestamps on goals

**Plugin tools:**
- `goal_update` - Agents can report task status (done/in-progress/blocked) and summaries

**Plugin data:**
- `clawcondos/condo-management/.data/goals.json` - Goals storage (migrated from `.registry/goals.json`)
```

Update the Data flow section:
```markdown
### Goals data flow

```
Browser (index.html)
  -> WebSocket RPC -> OpenClaw Gateway -> clawcondos-goals plugin
                                            -> goals.json (file-backed)
                                            -> before_agent_start hook (context injection)
                                            -> goal_update tool (agent reporting)
```
```

**Step 2: Update docs/SETUP.md**

Add plugin setup instructions:
```markdown
### Plugin Setup

The ClawCondos goals system runs as an OpenClaw plugin. To install:

1. Symlink the plugin: `ln -sf /path/to/clawcondos/clawcondos/condo-management ~/.openclaw/extensions/clawcondos-goals`
2. Enable in `~/.openclaw/openclaw.json`:
   ```json
   { "plugins": { "entries": { "clawcondos-goals": { "enabled": true } } } }
   ```
3. Restart OpenClaw gateway
4. (Optional) Migrate existing data: `node clawcondos/condo-management/migrate.js .registry/goals.json clawcondos/condo-management/.data`
```

**Step 3: Commit**

```bash
git add CLAUDE.md docs/SETUP.md
git commit -m "docs: update architecture docs for plugin-based goals system"
```

---

## Summary

| Task | What | Tests |
|------|------|-------|
| 1 | Plugin scaffold | Manual (gateway loads) |
| 2 | Goals data store module | `tests/goals-store.test.js` |
| 3 | Goals CRUD gateway methods | `tests/goals-handlers.test.js` |
| 4 | Condo-session mapping methods | `tests/goals-handlers.test.js` |
| 5 | `before_agent_start` context injection | `tests/context-builder.test.js` + manual |
| 6 | `agent_end` completion tracking | Manual (check logs) |
| 7 | `goal_update` agent tool | `tests/goal-update-tool.test.js` |
| 8 | Data migration script | Manual |
| 9 | Frontend: loadGoals RPC | Manual (browser) |
| 10 | Frontend: goal CRUD RPC | Manual (browser) |
| 11 | Frontend: session assignment RPC | Manual (browser) |
| 12 | Frontend: condo mapping RPC | Manual (browser) |
| 13 | Remove old serve.js routes | `npm test` + manual |
| 14 | Documentation | N/A |

---

# Phase 2: Extended Features

Phase 2 builds on the plugin foundation from Phase 1 to add condos as first-class entities, rich task schemas, task-to-session spawning, and inter-agent coordination.

---

## Task 15: Condos CRUD Gateway Methods

Add first-class condo (project/topic) management. Condos are manual organizational containers that group goals.

**Files:**
- Modify: `clawcondos/condo-management/lib/goals-store.js` (add condos array to store schema)
- Create: `clawcondos/condo-management/lib/condos-handlers.js`
- Create: `tests/condos-handlers.test.js`
- Modify: `clawcondos/condo-management/index.js`

**Step 1: Update store schema for condos**

Modify `goals-store.js` `load()` to initialize condos:
```javascript
// In the load() return, add:
condos: Array.isArray(parsed.condos) ? parsed.condos : [],
```

And in the empty-store return:
```javascript
return { version: 2, goals: [], condos: [], sessionIndex: {}, sessionCondoIndex: {} };
```

**Step 2: Write failing tests for condo handlers**

Create `tests/condos-handlers.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createGoalsStore } from '../clawcondos/condo-management/lib/goals-store.js';
import { createCondoHandlers } from '../clawcondos/condo-management/lib/condos-handlers.js';

const TEST_DIR = join(import.meta.dirname, '__fixtures__', 'condos-handlers-test');

function makeResponder() {
  let result = null;
  const respond = (ok, payload, error) => { result = { ok, payload, error }; };
  return { respond, getResult: () => result };
}

describe('CondoHandlers', () => {
  let store, handlers;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
    handlers = createCondoHandlers(store);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('condos.create', () => {
    it('creates a condo with required fields', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.create']({ params: { name: 'ClawCondos Rebuild' }, respond });
      const r = getResult();
      expect(r.ok).toBe(true);
      expect(r.payload.condo.name).toBe('ClawCondos Rebuild');
      expect(r.payload.condo.id).toMatch(/^condo_/);
    });

    it('rejects missing name', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.create']({ params: {}, respond });
      expect(getResult().ok).toBe(false);
    });
  });

  describe('condos.list', () => {
    it('returns empty list initially', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.list']({ params: {}, respond });
      expect(getResult().payload.condos).toEqual([]);
    });

    it('returns created condos with goal counts', () => {
      // Create a condo
      const r1 = makeResponder();
      handlers['condos.create']({ params: { name: 'Project A' }, respond: r1.respond });
      const condoId = r1.getResult().payload.condo.id;

      // Seed a goal linked to this condo
      const data = store.load();
      data.goals.push({
        id: 'goal_1', title: 'G1', condoId, status: 'active',
        completed: false, tasks: [], sessions: [],
        description: '', priority: null, deadline: null, notes: '',
        createdAtMs: Date.now(), updatedAtMs: Date.now(),
      });
      store.save(data);

      const r2 = makeResponder();
      handlers['condos.list']({ params: {}, respond: r2.respond });
      const condos = r2.getResult().payload.condos;
      expect(condos).toHaveLength(1);
      expect(condos[0].goalCount).toBe(1);
    });
  });

  describe('condos.update', () => {
    it('patches condo name', () => {
      const r1 = makeResponder();
      handlers['condos.create']({ params: { name: 'Old' }, respond: r1.respond });
      const id = r1.getResult().payload.condo.id;

      const r2 = makeResponder();
      handlers['condos.update']({ params: { id, name: 'New' }, respond: r2.respond });
      expect(r2.getResult().payload.condo.name).toBe('New');
    });
  });

  describe('condos.delete', () => {
    it('deletes a condo and nullifies goal references', () => {
      const r1 = makeResponder();
      handlers['condos.create']({ params: { name: 'Doomed' }, respond: r1.respond });
      const condoId = r1.getResult().payload.condo.id;

      // Link a goal
      const data = store.load();
      data.goals.push({
        id: 'goal_x', title: 'G', condoId, status: 'active',
        completed: false, tasks: [], sessions: [],
        description: '', priority: null, deadline: null, notes: '',
        createdAtMs: Date.now(), updatedAtMs: Date.now(),
      });
      store.save(data);

      const r2 = makeResponder();
      handlers['condos.delete']({ params: { id: condoId }, respond: r2.respond });
      expect(r2.getResult().ok).toBe(true);

      // Goal should have condoId cleared
      const updated = store.load();
      expect(updated.goals[0].condoId).toBeNull();
    });
  });
});
```

**Step 3: Run tests, verify fail**

```bash
npx vitest run tests/condos-handlers.test.js
```

**Step 4: Implement condo handlers**

Create `clawcondos/condo-management/lib/condos-handlers.js`:
```javascript
export function createCondoHandlers(store) {
  function loadData() { return store.load(); }
  function saveData(data) { store.save(data); }

  return {
    'condos.create': ({ params, respond }) => {
      try {
        const { name, description, color } = params;
        if (!name || typeof name !== 'string' || !name.trim()) {
          respond(false, undefined, { message: 'name is required' });
          return;
        }
        const data = loadData();
        const now = Date.now();
        const condo = {
          id: store.newId('condo'),
          name: name.trim(),
          description: description || '',
          color: color || null,
          createdAtMs: now,
          updatedAtMs: now,
        };
        data.condos.unshift(condo);
        saveData(data);
        respond(true, { condo });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'condos.list': ({ params, respond }) => {
      try {
        const data = loadData();
        const condos = (data.condos || []).map(c => ({
          ...c,
          goalCount: data.goals.filter(g => g.condoId === c.id).length,
        }));
        respond(true, { condos });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'condos.get': ({ params, respond }) => {
      try {
        const data = loadData();
        const condo = (data.condos || []).find(c => c.id === params.id);
        if (!condo) {
          respond(false, undefined, { message: 'Condo not found' });
          return;
        }
        const goals = data.goals.filter(g => g.condoId === condo.id);
        respond(true, { condo, goals });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'condos.update': ({ params, respond }) => {
      try {
        const data = loadData();
        const condo = (data.condos || []).find(c => c.id === params.id);
        if (!condo) {
          respond(false, undefined, { message: 'Condo not found' });
          return;
        }
        const patch = { ...params };
        delete patch.id;
        Object.assign(condo, patch);
        condo.updatedAtMs = Date.now();
        saveData(data);
        respond(true, { condo });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'condos.delete': ({ params, respond }) => {
      try {
        const data = loadData();
        const idx = (data.condos || []).findIndex(c => c.id === params.id);
        if (idx === -1) {
          respond(false, undefined, { message: 'Condo not found' });
          return;
        }
        // Nullify condoId on linked goals
        for (const g of data.goals) {
          if (g.condoId === params.id) g.condoId = null;
        }
        data.condos.splice(idx, 1);
        saveData(data);
        respond(true, { ok: true });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },
  };
}
```

**Step 5: Run tests, verify pass**

```bash
npx vitest run tests/condos-handlers.test.js
```

**Step 6: Wire into plugin index.js**

Add to `clawcondos/condo-management/index.js`:
```javascript
import { createCondoHandlers } from './lib/condos-handlers.js';

// Inside register():
const condoHandlers = createCondoHandlers(store);
for (const [method, handler] of Object.entries(condoHandlers)) {
  api.registerGatewayMethod(method, handler);
}
```

**Step 7: Commit**

```bash
git add clawcondos/condo-management/lib/condos-handlers.js tests/condos-handlers.test.js clawcondos/condo-management/lib/goals-store.js clawcondos/condo-management/index.js
git commit -m "feat: condos CRUD gateway methods"
```

---

## Task 16: Extended Task Schema

Upgrade tasks from simple `{id, text, done}` to a richer schema with status, sessionKey, dependencies, and metadata.

**Files:**
- Modify: `clawcondos/condo-management/lib/goals-handlers.js` (add `goals.addTask`, `goals.updateTask`)
- Modify: `tests/goals-handlers.test.js`

**Step 1: Write failing tests for task management**

Add to `tests/goals-handlers.test.js`:
```javascript
describe('goals.addTask', () => {
  it('adds a task with extended schema', () => {
    const r1 = makeResponder();
    handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
    const goalId = r1.getResult().payload.goal.id;

    const r2 = makeResponder();
    handlers['goals.addTask']({
      params: {
        goalId,
        text: 'Build the API',
        description: 'REST endpoints for user management',
        priority: 'P1',
      },
      respond: r2.respond,
    });
    const task = r2.getResult().payload.task;
    expect(task.id).toMatch(/^task_/);
    expect(task.text).toBe('Build the API');
    expect(task.status).toBe('pending');
    expect(task.sessionKey).toBeNull();
    expect(task.done).toBe(false);
  });
});

describe('goals.updateTask', () => {
  it('updates task fields', () => {
    const r1 = makeResponder();
    handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
    const goalId = r1.getResult().payload.goal.id;

    const r2 = makeResponder();
    handlers['goals.addTask']({
      params: { goalId, text: 'Do thing' },
      respond: r2.respond,
    });
    const taskId = r2.getResult().payload.task.id;

    const r3 = makeResponder();
    handlers['goals.updateTask']({
      params: { goalId, taskId, status: 'in-progress', sessionKey: 'agent:main:main' },
      respond: r3.respond,
    });
    const updated = r3.getResult().payload.task;
    expect(updated.status).toBe('in-progress');
    expect(updated.sessionKey).toBe('agent:main:main');
  });

  it('syncs done flag with status', () => {
    const r1 = makeResponder();
    handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
    const goalId = r1.getResult().payload.goal.id;

    const r2 = makeResponder();
    handlers['goals.addTask']({
      params: { goalId, text: 'Task' },
      respond: r2.respond,
    });
    const taskId = r2.getResult().payload.task.id;

    const r3 = makeResponder();
    handlers['goals.updateTask']({
      params: { goalId, taskId, status: 'done' },
      respond: r3.respond,
    });
    expect(r3.getResult().payload.task.done).toBe(true);
  });
});
```

**Step 2: Run tests, verify fail**

```bash
npx vitest run tests/goals-handlers.test.js
```

**Step 3: Implement task handlers**

Add to the returned object in `createGoalHandlers` in `goals-handlers.js`:
```javascript
'goals.addTask': ({ params, respond }) => {
  try {
    const { goalId, text, description, priority, dependsOn } = params;
    if (!goalId || !text) {
      respond(false, undefined, { message: 'goalId and text are required' });
      return;
    }
    const data = loadData();
    const goal = data.goals.find(g => g.id === goalId);
    if (!goal) {
      respond(false, undefined, { message: 'Goal not found' });
      return;
    }
    const now = Date.now();
    const task = {
      id: store.newId('task'),
      text: text.trim(),
      description: description || '',
      status: 'pending',
      done: false,
      priority: priority || null,
      sessionKey: null,
      dependsOn: Array.isArray(dependsOn) ? dependsOn : [],
      summary: '',
      createdAtMs: now,
      updatedAtMs: now,
    };
    goal.tasks.push(task);
    goal.updatedAtMs = now;
    saveData(data);
    respond(true, { task });
  } catch (err) {
    respond(false, undefined, { message: String(err) });
  }
},

'goals.updateTask': ({ params, respond }) => {
  try {
    const { goalId, taskId } = params;
    if (!goalId || !taskId) {
      respond(false, undefined, { message: 'goalId and taskId are required' });
      return;
    }
    const data = loadData();
    const goal = data.goals.find(g => g.id === goalId);
    if (!goal) {
      respond(false, undefined, { message: 'Goal not found' });
      return;
    }
    const task = (goal.tasks || []).find(t => t.id === taskId);
    if (!task) {
      respond(false, undefined, { message: 'Task not found' });
      return;
    }
    const patch = { ...params };
    delete patch.goalId;
    delete patch.taskId;
    Object.assign(task, patch);
    task.updatedAtMs = Date.now();

    // Sync done/status
    if ('status' in patch) {
      task.done = task.status === 'done';
    } else if ('done' in patch) {
      task.status = task.done ? 'done' : 'pending';
    }

    goal.updatedAtMs = Date.now();
    saveData(data);
    respond(true, { task });
  } catch (err) {
    respond(false, undefined, { message: String(err) });
  }
},

'goals.deleteTask': ({ params, respond }) => {
  try {
    const { goalId, taskId } = params;
    const data = loadData();
    const goal = data.goals.find(g => g.id === goalId);
    if (!goal) {
      respond(false, undefined, { message: 'Goal not found' });
      return;
    }
    const idx = (goal.tasks || []).findIndex(t => t.id === taskId);
    if (idx === -1) {
      respond(false, undefined, { message: 'Task not found' });
      return;
    }
    goal.tasks.splice(idx, 1);
    goal.updatedAtMs = Date.now();
    saveData(data);
    respond(true, { ok: true });
  } catch (err) {
    respond(false, undefined, { message: String(err) });
  }
},
```

**Step 4: Run tests, verify pass**

```bash
npx vitest run tests/goals-handlers.test.js
```

**Step 5: Commit**

```bash
git add clawcondos/condo-management/lib/goals-handlers.js tests/goals-handlers.test.js
git commit -m "feat: extended task schema with status, sessionKey, dependencies"
```

---

## Task 17: Task-to-Session Spawning Gateway Method

Add a `goals.spawnTaskSession` method that prepares context for spawning a new agent session tied to a task.

**Files:**
- Create: `clawcondos/condo-management/lib/task-spawn.js`
- Create: `tests/task-spawn.test.js`
- Modify: `clawcondos/condo-management/index.js`

**Step 1: Write failing tests**

Create `tests/task-spawn.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createGoalsStore } from '../clawcondos/condo-management/lib/goals-store.js';
import { createTaskSpawnHandler } from '../clawcondos/condo-management/lib/task-spawn.js';

const TEST_DIR = join(import.meta.dirname, '__fixtures__', 'task-spawn-test');

function makeResponder() {
  let result = null;
  const respond = (ok, payload, error) => { result = { ok, payload, error }; };
  return { respond, getResult: () => result };
}

describe('goals.spawnTaskSession', () => {
  let store, handler;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);

    // Seed data
    const data = store.load();
    data.goals.push({
      id: 'goal_1', title: 'Ship v2', description: 'Launch v2',
      status: 'active', completed: false, condoId: null,
      priority: 'P0', deadline: '2026-03-01',
      tasks: [
        { id: 'task_1', text: 'Build API', description: 'REST endpoints', status: 'pending', done: false, sessionKey: null },
        { id: 'task_2', text: 'Write tests', description: '', status: 'pending', done: false, sessionKey: null },
      ],
      sessions: [], notes: '',
      createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    store.save(data);

    handler = createTaskSpawnHandler(store);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns spawn config with task context', () => {
    const { respond, getResult } = makeResponder();
    handler({
      params: { goalId: 'goal_1', taskId: 'task_1', agentId: 'main', model: 'claude-sonnet-4-5-20250929' },
      respond,
    });
    const r = getResult();
    expect(r.ok).toBe(true);
    expect(r.payload.sessionKey).toMatch(/^agent:main:subagent:/);
    expect(r.payload.taskContext).toContain('Build API');
    expect(r.payload.taskContext).toContain('Ship v2');
    expect(r.payload.agentId).toBe('main');
    expect(r.payload.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('links session to goal and updates task', () => {
    const { respond, getResult } = makeResponder();
    handler({
      params: { goalId: 'goal_1', taskId: 'task_1', agentId: 'main' },
      respond,
    });
    const sessionKey = getResult().payload.sessionKey;

    const data = store.load();
    expect(data.goals[0].sessions).toContain(sessionKey);
    expect(data.goals[0].tasks[0].sessionKey).toBe(sessionKey);
    expect(data.goals[0].tasks[0].status).toBe('in-progress');
    expect(data.sessionIndex[sessionKey]).toEqual({ goalId: 'goal_1' });
  });

  it('rejects unknown goal', () => {
    const { respond, getResult } = makeResponder();
    handler({
      params: { goalId: 'goal_nope', taskId: 'task_1', agentId: 'main' },
      respond,
    });
    expect(getResult().ok).toBe(false);
  });

  it('rejects unknown task', () => {
    const { respond, getResult } = makeResponder();
    handler({
      params: { goalId: 'goal_1', taskId: 'task_nope', agentId: 'main' },
      respond,
    });
    expect(getResult().ok).toBe(false);
  });
});
```

**Step 2: Run tests, verify fail**

```bash
npx vitest run tests/task-spawn.test.js
```

**Step 3: Implement task spawn handler**

Create `clawcondos/condo-management/lib/task-spawn.js`:
```javascript
import { buildGoalContext } from './context-builder.js';

export function createTaskSpawnHandler(store) {
  return function handler({ params, respond }) {
    try {
      const { goalId, taskId, agentId, model } = params;
      if (!goalId || !taskId) {
        respond(false, undefined, { message: 'goalId and taskId are required' });
        return;
      }

      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);
      if (!goal) {
        respond(false, undefined, { message: 'Goal not found' });
        return;
      }
      const task = (goal.tasks || []).find(t => t.id === taskId);
      if (!task) {
        respond(false, undefined, { message: 'Task not found in goal' });
        return;
      }

      // Generate a session key for the spawned subagent
      const suffix = store.newId('spawn').replace('spawn_', '');
      const agent = agentId || 'main';
      const sessionKey = `agent:${agent}:subagent:${suffix}`;

      // Build task-specific context
      const goalContext = buildGoalContext(goal);
      const taskContext = [
        goalContext,
        '',
        '---',
        `## Your Assignment: ${task.text}`,
        task.description ? `\n${task.description}` : '',
        '',
        'When you complete this task, use the goal_update tool to mark it done.',
      ].filter(Boolean).join('\n');

      // Link session to goal and update task
      task.sessionKey = sessionKey;
      task.status = 'in-progress';
      task.updatedAtMs = Date.now();
      goal.sessions.push(sessionKey);
      goal.updatedAtMs = Date.now();
      data.sessionIndex[sessionKey] = { goalId };
      store.save(data);

      respond(true, {
        sessionKey,
        taskContext,
        agentId: agent,
        model: model || null,
        goalId,
        taskId,
      });
    } catch (err) {
      respond(false, undefined, { message: String(err) });
    }
  };
}
```

**Step 4: Run tests, verify pass**

```bash
npx vitest run tests/task-spawn.test.js
```

**Step 5: Register in plugin**

Add to `clawcondos/condo-management/index.js`:
```javascript
import { createTaskSpawnHandler } from './lib/task-spawn.js';

// Inside register():
api.registerGatewayMethod('goals.spawnTaskSession', createTaskSpawnHandler(store));
```

**Step 6: Commit**

```bash
git add clawcondos/condo-management/lib/task-spawn.js tests/task-spawn.test.js clawcondos/condo-management/index.js
git commit -m "feat: goals.spawnTaskSession prepares context for task-driven subagent spawning"
```

---

## Task 18: Spawn Task UI (Pick Agent + Model Modal)

Add a UI in the frontend for spawning a new session for a task, letting the user pick the agent and model.

**Files:**
- Modify: `index.html`

**Step 1: Add spawn button to task items in goal view**

In `renderGoalView()`, add a "Spawn Agent" button next to each task that doesn't have a session yet. The button calls `openSpawnTaskModal(goalId, taskId)`.

Find the task rendering loop in `renderGoalView()` and add after each task item:
```javascript
// Inside the task rendering, after the task text/checkbox:
if (!task.sessionKey) {
  // Add a small "Spawn" button
  // Use: onclick="openSpawnTaskModal('${goalId}','${task.id}')"
}
```

**Step 2: Build the spawn modal using safe DOM construction**

Add a new function `openSpawnTaskModal(goalId, taskId)` to `index.html`. The modal should:
1. Fetch available agents via `rpcCall('agents.list', {})`
2. Show a dropdown to pick the agent
3. Show a dropdown/input for model selection (common models: `claude-sonnet-4-5-20250929`, `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001`)
4. Have a "Spawn" button that calls `spawnTaskSession(goalId, taskId, agentId, model)`

Build the modal using `document.createElement` for safe DOM construction:
```javascript
async function openSpawnTaskModal(goalId, taskId) {
  const goal = state.goals.find(g => g.id === goalId);
  const task = goal?.tasks?.find(t => t.id === taskId);
  if (!task) return;

  let agents = [];
  try {
    const res = await rpcCall('agents.list', {});
    agents = res?.payload?.agents || res?.agents || [];
  } catch (e) { /* fallback to default */ }

  const models = [
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
  ];

  // Build modal DOM safely with createElement
  const container = document.getElementById('modal-container');
  container.textContent = ''; // clear previous

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = () => { container.textContent = ''; };

  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';
  dialog.onclick = (e) => e.stopPropagation();

  const title = document.createElement('h3');
  title.textContent = 'Spawn Session for: ' + task.text;
  dialog.appendChild(title);

  // Agent select
  const agentLabel = document.createElement('label');
  agentLabel.textContent = 'Agent';
  const agentSelect = document.createElement('select');
  agentSelect.id = 'spawn-agent-select';
  if (agents.length === 0) agents = [{ id: 'main' }];
  for (const a of agents) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.identity?.name || a.id;
    agentSelect.appendChild(opt);
  }
  dialog.appendChild(agentLabel);
  dialog.appendChild(agentSelect);

  // Model select
  const modelLabel = document.createElement('label');
  modelLabel.textContent = 'Model';
  const modelSelect = document.createElement('select');
  modelSelect.id = 'spawn-model-select';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m.replace('claude-', '').replace(/-\d+$/, '');
    modelSelect.appendChild(opt);
  }
  dialog.appendChild(modelLabel);
  dialog.appendChild(modelSelect);

  // Spawn button
  const btn = document.createElement('button');
  btn.className = 'primary-btn';
  btn.textContent = 'Spawn Session';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Spawning...';
    await spawnTaskSession(goalId, taskId, agentSelect.value, modelSelect.value);
    container.textContent = '';
  };
  dialog.appendChild(btn);

  overlay.appendChild(dialog);
  container.appendChild(overlay);
}
```

**Step 3: Implement spawnTaskSession**

```javascript
async function spawnTaskSession(goalId, taskId, agentId, model) {
  try {
    const res = await rpcCall('goals.spawnTaskSession', { goalId, taskId, agentId, model });
    const sessionKey = res?.payload?.sessionKey;
    if (sessionKey) {
      // Send initial message to kickstart the agent with task context
      const taskContext = res.payload.taskContext;
      await rpcCall('chat.send', {
        sessionKey,
        message: taskContext + '\n\nPlease begin working on this task.',
      });

      // Reload goals and sessions
      await loadGoals();
      await loadSessions();
    }
  } catch (err) {
    console.error('Failed to spawn task session:', err);
  }
}
```

**Step 4: Test in browser**

- Open a goal with tasks
- Click "Spawn" on a task without a session
- Pick agent and model
- Verify a new session is created and linked

**Step 5: Commit**

```bash
git add index.html
git commit -m "feat: spawn task session UI with agent/model picker"
```

---

## Task 19: Enriched Context Builder for Inter-Agent Coordination

Enhance the context builder to include information about sibling sessions working on the same goal, so agents are aware of each other.

**Files:**
- Modify: `clawcondos/condo-management/lib/context-builder.js`
- Modify: `tests/context-builder.test.js`

**Step 1: Add failing tests for enriched context**

Add to `tests/context-builder.test.js`:
```javascript
describe('buildGoalContext with sibling sessions', () => {
  const goal = {
    id: 'goal_1', title: 'Ship v2', description: '', status: 'active',
    priority: null, deadline: null,
    tasks: [
      { id: 't1', text: 'Build API', done: true, sessionKey: 'agent:main:s1', summary: 'Done - all endpoints built' },
      { id: 't2', text: 'Write tests', done: false, sessionKey: 'agent:main:s2' },
      { id: 't3', text: 'Deploy', done: false, sessionKey: null },
    ],
    sessions: ['agent:main:s1', 'agent:main:s2'],
  };

  it('includes task-session assignments', () => {
    const ctx = buildGoalContext(goal, { currentSessionKey: 'agent:main:s2' });
    expect(ctx).toContain('Write tests');
    expect(ctx).toContain('(you)');
  });

  it('includes completed task summaries', () => {
    const ctx = buildGoalContext(goal, { currentSessionKey: 'agent:main:s2' });
    expect(ctx).toContain('Done - all endpoints built');
  });

  it('marks unassigned tasks', () => {
    const ctx = buildGoalContext(goal, { currentSessionKey: 'agent:main:s2' });
    expect(ctx).toContain('Deploy');
    expect(ctx).toContain('unassigned');
  });
});
```

**Step 2: Run tests, verify fail**

```bash
npx vitest run tests/context-builder.test.js
```

**Step 3: Update context builder**

Modify `buildGoalContext` to accept an options parameter:
```javascript
export function buildGoalContext(goal, opts = {}) {
  if (!goal) return null;
  const { currentSessionKey } = opts;

  const lines = [
    `# Goal: ${goal.title}`,
  ];

  if (goal.description) lines.push('', goal.description);

  const meta = [];
  if (goal.status) meta.push(`Status: ${goal.status}`);
  if (goal.priority) meta.push(`Priority: ${goal.priority}`);
  if (goal.deadline) meta.push(`Deadline: ${goal.deadline}`);
  if (goal.sessions?.length) meta.push(`Sessions: ${goal.sessions.length}`);
  if (meta.length) lines.push('', meta.join(' | '));

  if (goal.tasks?.length) {
    lines.push('', '## Tasks');
    for (const t of goal.tasks) {
      const marker = t.done ? 'x' : ' ';
      let suffix = '';
      if (t.sessionKey === currentSessionKey) {
        suffix = ' (you)';
      } else if (t.sessionKey) {
        suffix = ` (assigned: ${t.sessionKey})`;
      } else if (!t.done) {
        suffix = ' (unassigned)';
      }
      lines.push(`- [${marker}] ${t.text}${suffix}`);
      if (t.done && t.summary) {
        lines.push(`  > ${t.summary}`);
      }
    }
  }

  return lines.join('\n');
}
```

**Step 4: Update the before_agent_start hook** to pass `currentSessionKey`:

In `clawcondos/condo-management/index.js`, update the hook:
```javascript
const context = buildGoalContext(goal, { currentSessionKey: ctx.sessionKey });
```

**Step 5: Run tests, verify pass**

```bash
npx vitest run tests/context-builder.test.js
```

**Step 6: Commit**

```bash
git add clawcondos/condo-management/lib/context-builder.js tests/context-builder.test.js clawcondos/condo-management/index.js
git commit -m "feat: enriched context builder with sibling session awareness"
```

---

## Task 20: Auto-Completion Prompt in Context Injection

Add a nudge to the injected context that prompts agents to use the `goal_update` tool when they finish tasks.

**Files:**
- Modify: `clawcondos/condo-management/lib/context-builder.js`
- Modify: `tests/context-builder.test.js`

**Step 1: Add failing test**

Add to `tests/context-builder.test.js`:
```javascript
describe('auto-completion prompt', () => {
  it('includes reminder to use goal_update tool', () => {
    const goal = {
      id: 'g1', title: 'G', description: '', status: 'active',
      tasks: [{ id: 't1', text: 'Do thing', done: false }],
      sessions: ['agent:main:main'],
    };
    const ctx = buildGoalContext(goal, { currentSessionKey: 'agent:main:main' });
    expect(ctx).toContain('goal_update');
  });

  it('does not include prompt when all tasks are done', () => {
    const goal = {
      id: 'g1', title: 'G', description: '', status: 'done',
      tasks: [{ id: 't1', text: 'Done thing', done: true }],
      sessions: [],
    };
    const ctx = buildGoalContext(goal);
    expect(ctx).not.toContain('goal_update');
  });
});
```

**Step 2: Run tests, verify fail**

```bash
npx vitest run tests/context-builder.test.js
```

**Step 3: Add completion prompt to context builder**

At the end of `buildGoalContext`, before the return:
```javascript
const hasPendingTasks = (goal.tasks || []).some(t => !t.done);
if (hasPendingTasks) {
  lines.push('');
  lines.push('> When you complete a task, use the `goal_update` tool to report it as done with a brief summary of what was accomplished.');
}
```

**Step 4: Run tests, verify pass**

```bash
npx vitest run tests/context-builder.test.js
```

**Step 5: Commit**

```bash
git add clawcondos/condo-management/lib/context-builder.js tests/context-builder.test.js
git commit -m "feat: auto-completion prompt nudges agents to report task status"
```

---

## Phase 2 Summary

| Task | What | Tests |
|------|------|-------|
| 15 | Condos CRUD gateway methods | `tests/condos-handlers.test.js` |
| 16 | Extended task schema (status, sessionKey, deps) | `tests/goals-handlers.test.js` |
| 17 | `goals.spawnTaskSession` gateway method | `tests/task-spawn.test.js` |
| 18 | Spawn task UI (agent/model picker modal) | Manual (browser) |
| 19 | Enriched context builder (sibling awareness) | `tests/context-builder.test.js` |
| 20 | Auto-completion prompt in context injection | `tests/context-builder.test.js` |

**New files in Phase 2:** 2 (lib + tests for condos, task-spawn)
**Estimated lines added:** ~350 (handlers) + ~250 (tests) + ~120 (UI)

---

# Full Plan Summary

**Total new files:** 9 (plugin source) + 5 (tests) + 1 (migration script)
**Estimated serve.js lines removed:** ~210
**Estimated lines added:** ~750 (plugin) + ~450 (tests) + ~120 (UI)
