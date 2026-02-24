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
      id: 'goal_1', title: 'Ship feature', description: 'Launch feature',
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
    expect(r.payload.sessionKey).toMatch(/^agent:main:webchat:task-/);
    expect(r.payload.taskContext).toContain('Build API');
    expect(r.payload.taskContext).toContain('Ship feature');
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

  it('defaults agentId to main', () => {
    const { respond, getResult } = makeResponder();
    handler({
      params: { goalId: 'goal_1', taskId: 'task_1' },
      respond,
    });
    expect(getResult().payload.agentId).toBe('main');
    expect(getResult().payload.sessionKey).toMatch(/^agent:main:webchat:task-/);
  });

  it('defaults model to null', () => {
    const { respond, getResult } = makeResponder();
    handler({
      params: { goalId: 'goal_1', taskId: 'task_1' },
      respond,
    });
    expect(getResult().payload.model).toBeNull();
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

  it('rejects missing goalId', () => {
    const { respond, getResult } = makeResponder();
    handler({
      params: { taskId: 'task_1' },
      respond,
    });
    expect(getResult().ok).toBe(false);
  });

  it('rejects already-spawned task', () => {
    // First spawn succeeds
    const r1 = makeResponder();
    handler({
      params: { goalId: 'goal_1', taskId: 'task_1', agentId: 'main' },
      respond: r1.respond,
    });
    expect(r1.getResult().ok).toBe(true);

    // Second spawn of same task rejected
    const r2 = makeResponder();
    handler({
      params: { goalId: 'goal_1', taskId: 'task_1', agentId: 'main' },
      respond: r2.respond,
    });
    expect(r2.getResult().ok).toBe(false);
    expect(r2.getResult().error.message).toBe('Task already has a session');
  });

  it('rejects missing taskId', () => {
    const { respond, getResult } = makeResponder();
    handler({
      params: { goalId: 'goal_1' },
      respond,
    });
    expect(getResult().ok).toBe(false);
  });

  it('includes project summary in taskContext when goal has condoId', () => {
    // Update goal to have a condoId and add a condo + sibling goal
    const data = store.load();
    data.goals[0].condoId = 'condo_1';
    data.condos = [{ id: 'condo_1', name: 'Test Project', description: '' }];
    data.goals.push({
      id: 'goal_2', title: 'Sibling Goal', description: '',
      status: 'active', completed: false, condoId: 'condo_1',
      priority: null, deadline: null,
      tasks: [{ id: 'task_s1', text: 'Sibling task', status: 'pending', done: false, sessionKey: null }],
      sessions: [], notes: '',
      createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    store.save(data);

    const { respond, getResult } = makeResponder();
    handler({
      params: { goalId: 'goal_1', taskId: 'task_1', agentId: 'main' },
      respond,
    });
    const r = getResult();
    expect(r.ok).toBe(true);
    expect(r.payload.taskContext).toContain('<project');
    expect(r.payload.taskContext).toContain('Test Project');
    expect(r.payload.taskContext).toContain('Sibling Goal');
    expect(r.payload.taskContext).toContain('<goal');
  });

  it('no project summary when goal has no condoId', () => {
    const { respond, getResult } = makeResponder();
    handler({
      params: { goalId: 'goal_1', taskId: 'task_1', agentId: 'main' },
      respond,
    });
    const r = getResult();
    expect(r.ok).toBe(true);
    expect(r.payload.taskContext).not.toContain('<project');
    expect(r.payload.taskContext).toContain('<goal');
  });
});
