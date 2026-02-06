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

  it('syncs task.status to in-progress', async () => {
    await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_1',
      status: 'in-progress',
    });

    const data = store.load();
    const task = data.goals[0].tasks.find(t => t.id === 'task_1');
    expect(task.done).toBe(false);
    expect(task.status).toBe('in-progress');
  });

  it('syncs task.status to blocked', async () => {
    await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_2',
      status: 'blocked',
      summary: 'Waiting on API keys',
    });

    const data = store.load();
    const task = data.goals[0].tasks.find(t => t.id === 'task_2');
    expect(task.done).toBe(false);
    expect(task.status).toBe('blocked');
    expect(task.summary).toBe('Waiting on API keys');
  });

  it('syncs task.status to done', async () => {
    await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_1',
      status: 'done',
      summary: 'Built all endpoints',
    });

    const data = store.load();
    const task = data.goals[0].tasks.find(t => t.id === 'task_1');
    expect(task.done).toBe(true);
    expect(task.status).toBe('done');
  });

  it('returns error for unknown task', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_nonexistent',
      status: 'done',
    });
    expect(result.content[0].text).toContain('not found');
  });

  it('returns error for unknown session', async () => {
    const result = await execute('call2', {
      sessionKey: 'agent:unknown:main',
      taskId: 'task_1',
      status: 'done',
    });
    expect(result.content[0].text).toContain('not assigned');
  });

  it('updates goal timestamp via nextTask (goal-level update)', async () => {
    const before = store.load().goals[0].updatedAtMs;
    await new Promise(r => setTimeout(r, 5));

    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      nextTask: 'Working on Build API',
    });
    expect(result.content[0].text).toContain('updated');
    expect(result.content[0].text).toContain('nextTask');

    const after = store.load().goals[0].updatedAtMs;
    expect(after).toBeGreaterThan(before);
    expect(store.load().goals[0].nextTask).toBe('Working on Build API');
    // Tasks should be unchanged
    expect(store.load().goals[0].tasks[0].done).toBe(false);
    expect(store.load().goals[0].tasks[1].done).toBe(false);
  });

  it('returns error when no actionable params provided', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
    });
    expect(result.content[0].text).toContain('Error');
    expect(result.content[0].text).toContain('provide at least one');
  });

  it('creates tasks via addTasks', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      addTasks: [
        { text: 'Deploy to staging' },
        { text: 'Run smoke tests', description: 'Verify key flows' },
      ],
    });
    expect(result.content[0].text).toContain('created 2 tasks');

    const data = store.load();
    expect(data.goals[0].tasks).toHaveLength(4); // 2 original + 2 new
    const newTask = data.goals[0].tasks[2];
    expect(newTask.text).toBe('Deploy to staging');
    expect(newTask.id).toMatch(/^task_/);
    expect(newTask.status).toBe('pending');
    expect(newTask.done).toBe(false);
    const newTask2 = data.goals[0].tasks[3];
    expect(newTask2.description).toBe('Verify key flows');
  });

  it('skips addTasks entries with empty text', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      addTasks: [
        { text: 'Valid task' },
        { text: '' },
        { text: '   ' },
      ],
    });
    expect(result.content[0].text).toContain('created 1 task');
    expect(store.load().goals[0].tasks).toHaveLength(3); // 2 original + 1 new
  });

  it('marks goal done via goalStatus', async () => {
    // First mark all tasks done
    const data = store.load();
    data.goals[0].tasks.forEach(t => { t.done = true; t.status = 'done'; });
    store.save(data);

    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      goalStatus: 'done',
    });
    expect(result.content[0].text).toContain('goal marked done');

    const updated = store.load().goals[0];
    expect(updated.status).toBe('done');
    expect(updated.completed).toBe(true);
  });

  it('rejects goalStatus=done when tasks are pending', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      goalStatus: 'done',
    });
    expect(result.content[0].text).toContain('cannot mark goal done');
    expect(result.content[0].text).toContain('2 tasks still pending');
  });

  it('re-activates a done goal via goalStatus=active', async () => {
    const data = store.load();
    data.goals[0].status = 'done';
    data.goals[0].completed = true;
    data.goals[0].tasks.forEach(t => { t.done = true; });
    store.save(data);

    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      goalStatus: 'active',
    });
    expect(result.content[0].text).toContain('goal marked active');
    expect(store.load().goals[0].status).toBe('active');
    expect(store.load().goals[0].completed).toBe(false);
  });

  it('appends notes', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      notes: 'Found a blocker with auth',
    });
    expect(result.content[0].text).toContain('notes updated');
    expect(store.load().goals[0].notes).toBe('Found a blocker with auth');

    // Append again
    await execute('call2', {
      sessionKey: 'agent:main:main',
      notes: 'Resolved by adding token refresh',
    });
    const notes = store.load().goals[0].notes;
    expect(notes).toContain('Found a blocker with auth');
    expect(notes).toContain('Resolved by adding token refresh');
  });

  it('combines task update + nextTask in one call', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_1',
      status: 'done',
      summary: 'Built all endpoints',
      nextTask: 'Write tests next',
    });
    expect(result.content[0].text).toContain('task_1');
    expect(result.content[0].text).toContain('nextTask');

    const data = store.load();
    expect(data.goals[0].tasks[0].done).toBe(true);
    expect(data.goals[0].nextTask).toBe('Write tests next');
  });
});

describe('goal_update tool with goalId (condo path)', () => {
  let store, execute;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
    execute = createGoalUpdateExecutor(store);

    // Seed: condo-bound session with two goals
    const data = store.load();
    data.condos.push({
      id: 'condo_1', name: 'Project', description: '',
      color: null, createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    data.goals.push({
      id: 'goal_1', title: 'Ship v2', status: 'active', completed: false,
      sessions: [], tasks: [
        { id: 'task_1', text: 'Build API', done: false },
      ],
      condoId: 'condo_1', priority: null, deadline: null, description: '', notes: '',
      createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    data.goals.push({
      id: 'goal_2', title: 'SEO', status: 'active', completed: false,
      sessions: [], tasks: [
        { id: 'task_2', text: 'Keywords', done: false },
      ],
      condoId: 'condo_1', priority: null, deadline: null, description: '', notes: '',
      createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    data.goals.push({
      id: 'goal_other', title: 'Other Condo Goal', status: 'active', completed: false,
      sessions: [], tasks: [],
      condoId: 'condo_other', priority: null, deadline: null, description: '', notes: '',
      createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    data.sessionCondoIndex['agent:main:telegram:123'] = 'condo_1';
    store.save(data);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('updates task via explicit goalId', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_1',
      taskId: 'task_1',
      status: 'done',
      summary: 'All endpoints built',
    });
    expect(result.content[0].text).toContain('updated');

    const data = store.load();
    const task = data.goals[0].tasks.find(t => t.id === 'task_1');
    expect(task.done).toBe(true);
    expect(task.summary).toBe('All endpoints built');
  });

  it('can update different goals in same condo', async () => {
    await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_2',
      taskId: 'task_2',
      status: 'in-progress',
    });

    const data = store.load();
    const task = data.goals[1].tasks.find(t => t.id === 'task_2');
    expect(task.status).toBe('in-progress');
  });

  it('returns error for goalId not found', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_nonexistent',
      taskId: 'task_1',
      status: 'done',
    });
    expect(result.content[0].text).toContain('not found');
  });

  it('returns error when goalId does not belong to bound condo', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_other',
      nextTask: 'Something',
    });
    expect(result.content[0].text).toContain('does not belong');
  });

  it('falls back to sessionIndex when no goalId provided (backward compat)', async () => {
    // Also add session to sessionIndex for backward compat
    const data = store.load();
    data.sessionIndex['agent:main:telegram:123'] = { goalId: 'goal_1' };
    store.save(data);

    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      taskId: 'task_1',
      status: 'done',
    });
    expect(result.content[0].text).toContain('updated');
  });
});
