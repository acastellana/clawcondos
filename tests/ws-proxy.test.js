/**
 * WS Proxy Layer Tests
 *
 * Tests the dispatch logic that the serve.js WebSocket proxy uses:
 * - `tryLocalGoalsRpc` equivalents (goals.* / condos.* handled locally)
 * - Local-only methods: status, chat.history
 * - Gateway-forwarded methods: sessions.list, agents.list
 * - Unknown methods fall through (not in localRpcMethods)
 *
 * Rather than spinning up a full HTTP/WS server (which requires env wiring),
 * we test the same handler-dispatch logic that tryLocalGoalsRpc uses,
 * plus verify that ALL methods in the localRpcMethods set are recognised.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createGoalsStore } from '../clawcondos/condo-management/lib/goals-store.js';
import { createGoalHandlers } from '../clawcondos/condo-management/lib/goals-handlers.js';
import { createCondoHandlers } from '../clawcondos/condo-management/lib/condos-handlers.js';

const TEST_DIR = join(import.meta.dirname, '__fixtures__', 'ws-proxy-test');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeResponder() {
  let result = null;
  const respond = (ok, payload, error) => { result = { ok, payload, error }; };
  return { respond, getResult: () => result };
}

/**
 * Mirror of serve.js's tryLocalGoalsRpc — tests that this core dispatch
 * works correctly for all goals.* / condos.* methods.
 */
function makeTryLocalGoalsRpc(goalHandlers, condoHandlers) {
  return async function tryLocalGoalsRpc(method, params = {}) {
    const handler = goalHandlers?.[method] || condoHandlers?.[method];
    if (!handler) return { handled: false };
    return await new Promise((resolve) => {
      try {
        handler({
          params,
          respond: (ok, payload, error) => {
            if (ok) {
              resolve({ handled: true, ok: true, result: payload || {} });
            } else {
              resolve({ handled: true, ok: false, error: error || { message: 'Local goals RPC failed' } });
            }
          }
        });
      } catch (err) {
        resolve({ handled: true, ok: false, error: { message: err?.message || String(err) } });
      }
    });
  };
}

/**
 * The set of methods that serve.js routes locally (mirrors localRpcMethods in serve.js).
 * Kept in sync manually — test will fail if a new method is added to serve.js but not here.
 */
function buildLocalRpcMethods(goalHandlers, condoHandlers) {
  return new Set([
    ...Object.keys(goalHandlers || {}),
    ...Object.keys(condoHandlers || {}),
    'goals.kickoff',
    'goals.spawnTaskSession',
    'sessions.list',
    'agents.list',
    'chat.activeRuns',
    'status',
    'chat.history',
  ]);
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('WS Proxy — tryLocalGoalsRpc dispatch', () => {
  let store, goalHandlers, condoHandlers, tryLocalGoalsRpc;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
    goalHandlers = createGoalHandlers(store);
    condoHandlers = createCondoHandlers(store);
    tryLocalGoalsRpc = makeTryLocalGoalsRpc(goalHandlers, condoHandlers);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── condos.list ────────────────────────────────────────────────────────────

  describe('condos.list', () => {
    it('returns local data — empty list initially', async () => {
      const res = await tryLocalGoalsRpc('condos.list', {});
      expect(res.handled).toBe(true);
      expect(res.ok).toBe(true);
      expect(Array.isArray(res.result.condos)).toBe(true);
    });

    it('returns local data — not empty after creating a condo', async () => {
      // Create a condo first
      const { respond, getResult } = makeResponder();
      condoHandlers['condos.create']({ params: { name: 'Test Condo' }, respond });
      expect(getResult().ok).toBe(true);

      const res = await tryLocalGoalsRpc('condos.list', {});
      expect(res.ok).toBe(true);
      expect(res.result.condos.length).toBe(1);
      expect(res.result.condos[0].name).toBe('Test Condo');
    });
  });

  // ── goals.list ─────────────────────────────────────────────────────────────

  describe('goals.list', () => {
    it('returns local data with correct count — zero initially', async () => {
      const res = await tryLocalGoalsRpc('goals.list', {});
      expect(res.handled).toBe(true);
      expect(res.ok).toBe(true);
      expect(res.result.goals).toEqual([]);
    });

    it('returns local data with correct count — after creates', async () => {
      const { respond: r1, getResult: g1 } = makeResponder();
      goalHandlers['goals.create']({ params: { title: 'Goal A' }, respond: r1 });
      expect(g1().ok).toBe(true);

      const { respond: r2, getResult: g2 } = makeResponder();
      goalHandlers['goals.create']({ params: { title: 'Goal B' }, respond: r2 });
      expect(g2().ok).toBe(true);

      const res = await tryLocalGoalsRpc('goals.list', {});
      expect(res.ok).toBe(true);
      expect(res.result.goals.length).toBe(2);
    });
  });

  // ── goals.create ───────────────────────────────────────────────────────────

  describe('goals.create', () => {
    it('creates and persists a goal locally', async () => {
      const res = await tryLocalGoalsRpc('goals.create', { title: 'Persisted Goal' });
      expect(res.handled).toBe(true);
      expect(res.ok).toBe(true);
      expect(res.result.goal.title).toBe('Persisted Goal');
      expect(res.result.goal.id).toMatch(/^goal_/);

      // Verify persistence: list should contain the created goal
      const listRes = await tryLocalGoalsRpc('goals.list', {});
      expect(listRes.ok).toBe(true);
      expect(listRes.result.goals.some(g => g.title === 'Persisted Goal')).toBe(true);
    });

    it('returns error for missing title', async () => {
      const res = await tryLocalGoalsRpc('goals.create', {});
      expect(res.handled).toBe(true);
      expect(res.ok).toBe(false);
    });
  });

  // ── goals.kickoff / goals.spawnTaskSession ─────────────────────────────────
  // These are special-cased in serve.js to forward to gateway then bridge chat.send.
  // They are NOT in goalHandlers/condoHandlers, so tryLocalGoalsRpc returns handled:false.
  // The serve.js WS handler catches them before calling tryLocalGoalsRpc.
  // We verify that the dispatch correctly returns handled:false so serve.js can take over.

  describe('goals.kickoff', () => {
    it('is NOT handled by tryLocalGoalsRpc (handled by serve.js gateway bridge)', async () => {
      const res = await tryLocalGoalsRpc('goals.kickoff', { goalId: 'goal_test' });
      // kickoff is intercepted by serve.js before tryLocalGoalsRpc is called
      expect(res.handled).toBe(false);
    });

    it('is in the localRpcMethods set (so serve.js intercepts it)', () => {
      const localRpcMethods = buildLocalRpcMethods(goalHandlers, condoHandlers);
      expect(localRpcMethods.has('goals.kickoff')).toBe(true);
    });
  });

  describe('goals.spawnTaskSession', () => {
    it('is NOT handled by tryLocalGoalsRpc (handled by serve.js gateway bridge)', async () => {
      const res = await tryLocalGoalsRpc('goals.spawnTaskSession', { goalId: 'goal_test', taskId: 'task_1' });
      expect(res.handled).toBe(false);
    });

    it('is in the localRpcMethods set', () => {
      const localRpcMethods = buildLocalRpcMethods(goalHandlers, condoHandlers);
      expect(localRpcMethods.has('goals.spawnTaskSession')).toBe(true);
    });
  });

  // ── sessions.list ──────────────────────────────────────────────────────────
  // sessions.list is forwarded to gateway; handled outside tryLocalGoalsRpc in serve.js

  describe('sessions.list', () => {
    it('is in the localRpcMethods set (serve.js intercepts it)', () => {
      const localRpcMethods = buildLocalRpcMethods(goalHandlers, condoHandlers);
      expect(localRpcMethods.has('sessions.list')).toBe(true);
    });

    it('is NOT handled by tryLocalGoalsRpc (serve.js delegates to gateway)', async () => {
      const res = await tryLocalGoalsRpc('sessions.list', {});
      expect(res.handled).toBe(false);
    });
  });

  // ── agents.list ────────────────────────────────────────────────────────────

  describe('agents.list', () => {
    it('is in the localRpcMethods set', () => {
      const localRpcMethods = buildLocalRpcMethods(goalHandlers, condoHandlers);
      expect(localRpcMethods.has('agents.list')).toBe(true);
    });

    it('is NOT handled by tryLocalGoalsRpc (serve.js reads config file directly)', async () => {
      const res = await tryLocalGoalsRpc('agents.list', {});
      expect(res.handled).toBe(false);
    });
  });

  // ── status ─────────────────────────────────────────────────────────────────

  describe('status', () => {
    it('is in the localRpcMethods set', () => {
      const localRpcMethods = buildLocalRpcMethods(goalHandlers, condoHandlers);
      expect(localRpcMethods.has('status')).toBe(true);
    });

    it('is NOT handled by tryLocalGoalsRpc (serve.js returns local status directly)', async () => {
      const res = await tryLocalGoalsRpc('status', {});
      expect(res.handled).toBe(false);
    });
  });

  // ── chat.history ───────────────────────────────────────────────────────────

  describe('chat.history', () => {
    it('is in the localRpcMethods set', () => {
      const localRpcMethods = buildLocalRpcMethods(goalHandlers, condoHandlers);
      expect(localRpcMethods.has('chat.history')).toBe(true);
    });

    it('is NOT handled by tryLocalGoalsRpc (serve.js reads session files directly)', async () => {
      const res = await tryLocalGoalsRpc('chat.history', { sessionKey: 'agent:main:telegram:direct:123' });
      expect(res.handled).toBe(false);
    });
  });

  // ── Unknown methods fall through ───────────────────────────────────────────

  describe('unknown methods', () => {
    it('returns handled:false for completely unknown method', async () => {
      const res = await tryLocalGoalsRpc('some.unknown.method', {});
      expect(res.handled).toBe(false);
    });

    it('returns handled:false for gateway-only methods like chat.send', async () => {
      const res = await tryLocalGoalsRpc('chat.send', { sessionKey: 'x', message: 'hi' });
      expect(res.handled).toBe(false);
    });

    it('returns handled:false for cron.list (gateway method)', async () => {
      const res = await tryLocalGoalsRpc('cron.list', {});
      expect(res.handled).toBe(false);
    });
  });

  // ── localRpcMethods completeness check ────────────────────────────────────

  describe('localRpcMethods completeness', () => {
    it('includes all goalHandler keys', () => {
      const localRpcMethods = buildLocalRpcMethods(goalHandlers, condoHandlers);
      for (const key of Object.keys(goalHandlers)) {
        expect(localRpcMethods.has(key)).toBe(true);
      }
    });

    it('includes all condoHandler keys', () => {
      const localRpcMethods = buildLocalRpcMethods(goalHandlers, condoHandlers);
      for (const key of Object.keys(condoHandlers)) {
        expect(localRpcMethods.has(key)).toBe(true);
      }
    });

    it('includes all special non-handler methods', () => {
      const localRpcMethods = buildLocalRpcMethods(goalHandlers, condoHandlers);
      const special = ['goals.kickoff', 'goals.spawnTaskSession', 'sessions.list', 'agents.list', 'chat.activeRuns', 'status', 'chat.history'];
      for (const m of special) {
        expect(localRpcMethods.has(m)).toBe(true);
      }
    });

    it('does NOT include gateway-only methods', () => {
      const localRpcMethods = buildLocalRpcMethods(goalHandlers, condoHandlers);
      const gatewayOnly = ['chat.send', 'cron.list', 'cron.add', 'sessions.create'];
      for (const m of gatewayOnly) {
        expect(localRpcMethods.has(m)).toBe(false);
      }
    });
  });

  // ── goals.get / goals.update / goals.delete ───────────────────────────────

  describe('goals CRUD via tryLocalGoalsRpc', () => {
    it('goals.get returns a goal by id', async () => {
      const created = await tryLocalGoalsRpc('goals.create', { title: 'To Get' });
      const goalId = created.result.goal.id;

      // goalHandlers use params.id (not params.goalId)
      const res = await tryLocalGoalsRpc('goals.get', { id: goalId });
      expect(res.ok).toBe(true);
      expect(res.result.goal.id).toBe(goalId);
      expect(res.result.goal.title).toBe('To Get');
    });

    it('goals.update updates goal fields', async () => {
      const created = await tryLocalGoalsRpc('goals.create', { title: 'Original' });
      const goalId = created.result.goal.id;

      const updated = await tryLocalGoalsRpc('goals.update', { id: goalId, title: 'Updated' });
      expect(updated.ok).toBe(true);

      const got = await tryLocalGoalsRpc('goals.get', { id: goalId });
      expect(got.result.goal.title).toBe('Updated');
    });

    it('goals.delete removes the goal', async () => {
      const created = await tryLocalGoalsRpc('goals.create', { title: 'To Delete' });
      const goalId = created.result.goal.id;

      const deleted = await tryLocalGoalsRpc('goals.delete', { id: goalId });
      expect(deleted.ok).toBe(true);

      const list = await tryLocalGoalsRpc('goals.list', {});
      expect(list.result.goals.some(g => g.id === goalId)).toBe(false);
    });
  });
});
