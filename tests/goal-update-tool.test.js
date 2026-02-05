import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createGoalsStore } from '../openclaw-plugin/lib/goals-store.js';
import { createGoalUpdateExecutor } from '../openclaw-plugin/lib/goal-update-tool.js';

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
});
