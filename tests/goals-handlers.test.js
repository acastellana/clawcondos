import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createGoalsStore } from '../openclaw-plugin/lib/goals-store.js';
import { createGoalHandlers } from '../openclaw-plugin/lib/goals-handlers.js';

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

    it('ignores tasks param (must use addTask)', () => {
      const { respond, getResult } = makeResponder();
      handlers['goals.create']({
        params: { title: 'G', tasks: [{ id: 'injected', text: 'Hacked' }] },
        respond,
      });
      expect(getResult().ok).toBe(true);
      expect(getResult().payload.goal.tasks).toEqual([]);
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
      expect(updated.updatedAtMs).toBeGreaterThanOrEqual(updated.createdAtMs);
    });

    it('trims title on update', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const id = r1.getResult().payload.goal.id;

      const r2 = makeResponder();
      handlers['goals.update']({ params: { id, title: '  Trimmed  ' }, respond: r2.respond });
      expect(r2.getResult().payload.goal.title).toBe('Trimmed');
    });

    it('rejects empty title', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const id = r1.getResult().payload.goal.id;

      const r2 = makeResponder();
      handlers['goals.update']({ params: { id, title: '' }, respond: r2.respond });
      expect(r2.getResult().ok).toBe(false);
      expect(r2.getResult().error.message).toBe('title must be a non-empty string');
    });

    it('rejects non-string title', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const id = r1.getResult().payload.goal.id;

      const r2 = makeResponder();
      handlers['goals.update']({ params: { id, title: 123 }, respond: r2.respond });
      expect(r2.getResult().ok).toBe(false);
      expect(r2.getResult().error.message).toBe('title must be a non-empty string');
    });

    it('ignores internal fields in patch', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const goal = r1.getResult().payload.goal;

      const r2 = makeResponder();
      handlers['goals.update']({
        params: { id: goal.id, createdAtMs: 0, sessions: ['hacked'], title: 'Safe' },
        respond: r2.respond,
      });
      const updated = r2.getResult().payload.goal;
      expect(updated.title).toBe('Safe');
      expect(updated.createdAtMs).toBe(goal.createdAtMs);
      expect(updated.sessions).toEqual([]);
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

  describe('goals.removeSession', () => {
    it('rejects missing sessionKey', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const id = r1.getResult().payload.goal.id;

      const { respond, getResult } = makeResponder();
      handlers['goals.removeSession']({ params: { id }, respond });
      expect(getResult().ok).toBe(false);
      expect(getResult().error.message).toBe('sessionKey is required');
    });

    it('removes a session from a goal and cleans up index', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const id = r1.getResult().payload.goal.id;

      handlers['goals.addSession']({
        params: { id, sessionKey: 'agent:main:main' },
        respond: makeResponder().respond,
      });

      const r2 = makeResponder();
      handlers['goals.removeSession']({
        params: { id, sessionKey: 'agent:main:main' },
        respond: r2.respond,
      });
      expect(r2.getResult().ok).toBe(true);
      expect(r2.getResult().payload.goal.sessions).not.toContain('agent:main:main');

      // Session index should be cleaned up
      const r3 = makeResponder();
      handlers['goals.sessionLookup']({
        params: { sessionKey: 'agent:main:main' },
        respond: r3.respond,
      });
      expect(r3.getResult().payload.goalId).toBeNull();
    });
  });

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

    it('rejects missing goalId or text', () => {
      const { respond, getResult } = makeResponder();
      handlers['goals.addTask']({ params: { goalId: 'x' }, respond });
      expect(getResult().ok).toBe(false);
    });

    it('rejects unknown goal', () => {
      const { respond, getResult } = makeResponder();
      handlers['goals.addTask']({ params: { goalId: 'goal_nope', text: 'X' }, respond });
      expect(getResult().ok).toBe(false);
    });

    it('rejects whitespace-only text', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const goalId = r1.getResult().payload.goal.id;

      const { respond, getResult } = makeResponder();
      handlers['goals.addTask']({ params: { goalId, text: '   ' }, respond });
      expect(getResult().ok).toBe(false);
      expect(getResult().error.message).toBe('goalId and text are required');
    });

    it('trims task text', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const goalId = r1.getResult().payload.goal.id;

      const r2 = makeResponder();
      handlers['goals.addTask']({
        params: { goalId, text: '  Trimmed  ' },
        respond: r2.respond,
      });
      expect(r2.getResult().payload.task.text).toBe('Trimmed');
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
        params: { goalId, taskId, status: 'in-progress' },
        respond: r3.respond,
      });
      const updated = r3.getResult().payload.task;
      expect(updated.status).toBe('in-progress');
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

    it('syncs status from done flag', () => {
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
        params: { goalId, taskId, done: true },
        respond: r3.respond,
      });
      expect(r3.getResult().payload.task.status).toBe('done');
    });

    it('ignores internal fields in patch', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const goalId = r1.getResult().payload.goal.id;

      const r2 = makeResponder();
      handlers['goals.addTask']({
        params: { goalId, text: 'Task' },
        respond: r2.respond,
      });
      const task = r2.getResult().payload.task;

      const r3 = makeResponder();
      handlers['goals.updateTask']({
        params: { goalId, taskId: task.id, createdAtMs: 0, id: 'hacked', text: 'Safe' },
        respond: r3.respond,
      });
      const updated = r3.getResult().payload.task;
      expect(updated.text).toBe('Safe');
      expect(updated.createdAtMs).toBe(task.createdAtMs);
      expect(updated.id).toBe(task.id);
    });

    it('cannot set sessionKey directly (removed from whitelist)', () => {
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
        params: { goalId, taskId, sessionKey: 'agent:main:main' },
        respond: r3.respond,
      });
      expect(r3.getResult().ok).toBe(true);
      expect(r3.getResult().payload.task.sessionKey).toBeNull();
    });
  });

  describe('goals.deleteTask', () => {
    it('deletes a task from a goal', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const goalId = r1.getResult().payload.goal.id;

      const r2 = makeResponder();
      handlers['goals.addTask']({
        params: { goalId, text: 'Doomed' },
        respond: r2.respond,
      });
      const taskId = r2.getResult().payload.task.id;

      const r3 = makeResponder();
      handlers['goals.deleteTask']({
        params: { goalId, taskId },
        respond: r3.respond,
      });
      expect(r3.getResult().ok).toBe(true);

      // Verify task is gone
      const r4 = makeResponder();
      handlers['goals.get']({ params: { id: goalId }, respond: r4.respond });
      expect(r4.getResult().payload.goal.tasks).toHaveLength(0);
    });

    it('returns error for unknown task', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const goalId = r1.getResult().payload.goal.id;

      const { respond, getResult } = makeResponder();
      handlers['goals.deleteTask']({
        params: { goalId, taskId: 'task_nope' },
        respond,
      });
      expect(getResult().ok).toBe(false);
    });

    it('cleans up sessionIndex when task had sessionKey', () => {
      const r1 = makeResponder();
      handlers['goals.create']({ params: { title: 'G' }, respond: r1.respond });
      const goalId = r1.getResult().payload.goal.id;

      const r2 = makeResponder();
      handlers['goals.addTask']({
        params: { goalId, text: 'Spawned task' },
        respond: r2.respond,
      });
      const taskId = r2.getResult().payload.task.id;

      // Manually set sessionKey on the task (simulating spawnTaskSession)
      const data = store.load();
      const task = data.goals[0].tasks.find(t => t.id === taskId);
      task.sessionKey = 'agent:main:sub1';
      data.sessionIndex['agent:main:sub1'] = { goalId };
      store.save(data);

      // Delete the task
      const r3 = makeResponder();
      handlers['goals.deleteTask']({ params: { goalId, taskId }, respond: r3.respond });
      expect(r3.getResult().ok).toBe(true);

      // sessionIndex should be cleaned up
      const r4 = makeResponder();
      handlers['goals.sessionLookup']({
        params: { sessionKey: 'agent:main:sub1' },
        respond: r4.respond,
      });
      expect(r4.getResult().payload.goalId).toBeNull();
    });
  });
});
