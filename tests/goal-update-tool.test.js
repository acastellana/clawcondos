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

  it('syncs task.status to waiting', async () => {
    await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_1',
      status: 'waiting',
      summary: 'Waiting for deployment',
    });

    const data = store.load();
    const task = data.goals[0].tasks.find(t => t.id === 'task_1');
    expect(task.done).toBe(false);
    expect(task.status).toBe('waiting');
    expect(task.summary).toBe('Waiting for deployment');
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

  it('goalStatus:"done" validation accounts for task being marked done in same call', async () => {
    // Mark task_1 done via direct store manipulation so only task_2 is pending
    const data = store.load();
    data.goals[0].tasks[0].done = true;
    data.goals[0].tasks[0].status = 'done';
    store.save(data);

    // Mark last pending task done AND goalStatus done in same call — should succeed
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_2',
      status: 'done',
      summary: 'Tests written',
      goalStatus: 'done',
    });
    expect(result.content[0].text).toContain('task_2');
    expect(result.content[0].text).toContain('goal marked done');
    expect(result.content[0].text).not.toContain('Error');

    const updated = store.load().goals[0];
    expect(updated.tasks[1].done).toBe(true);
    expect(updated.status).toBe('done');
    expect(updated.completed).toBe(true);
  });

  it('goalStatus:"done" early validation rejects when other tasks still pending', async () => {
    // Both tasks still pending, try to mark task_1 done + goalStatus done
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_1',
      status: 'done',
      summary: 'Built',
      goalStatus: 'done',
    });
    // Should reject because task_2 is still pending
    expect(result.content[0].text).toContain('cannot mark goal done');
    expect(result.content[0].text).toContain('1 task still pending');

    // Crucially: task_1 should NOT have been mutated (early return before mutations)
    const data = store.load();
    expect(data.goals[0].tasks[0].done).toBe(false);
  });

  it('addTasks response includes task IDs', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      addTasks: [{ text: 'Deploy' }, { text: 'Monitor' }],
    });
    const text = result.content[0].text;
    expect(text).toContain('created 2 tasks:');
    // Should include the generated task_ IDs
    expect(text).toMatch(/task_\w+, task_\w+/);
  });

  it('response includes remaining task count', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_1',
      status: 'done',
      summary: 'Done',
    });
    expect(result.content[0].text).toContain('(1 task remaining)');
  });

  it('shows "all tasks done" when last task completed', async () => {
    // Mark first task done
    const data = store.load();
    data.goals[0].tasks[0].done = true;
    data.goals[0].tasks[0].status = 'done';
    store.save(data);

    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_2',
      status: 'done',
      summary: 'Tests written',
    });
    expect(result.content[0].text).toContain('(all tasks done)');
  });

  it('auto-sets nextTask when marking in-progress', async () => {
    await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_1',
      status: 'in-progress',
    });

    const data = store.load();
    expect(data.goals[0].nextTask).toBe('Build API');
  });

  it('clears nextTask when marking task done', async () => {
    // Set a nextTask first
    const data = store.load();
    data.goals[0].nextTask = 'something else';
    store.save(data);

    await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_1',
      status: 'done',
      summary: 'Built',
    });

    expect(store.load().goals[0].nextTask).toBeNull();
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

  it('condo orchestrator can set goalStatus on any goal in condo', async () => {
    // Mark all tasks done on goal_1
    const data = store.load();
    data.goals[0].tasks[0].done = true;
    data.goals[0].tasks[0].status = 'done';
    store.save(data);

    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_1',
      goalStatus: 'done',
    });
    expect(result.content[0].text).toContain('goal marked done');
    expect(store.load().goals[0].status).toBe('done');
  });

  it('condo orchestrator can set nextTask on any goal in condo', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_2',
      nextTask: 'Working on keywords',
    });
    expect(result.content[0].text).toContain('nextTask');
    expect(store.load().goals[1].nextTask).toBe('Working on keywords');
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

describe('goal_update cross-goal boundaries', () => {
  let store, execute;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
    execute = createGoalUpdateExecutor(store);

    // Session owns goal_1, goals 1 & 2 in same condo, goal_3 in different condo, goal_4 is done
    const data = store.load();
    data.condos.push(
      { id: 'condo_1', name: 'Project A', description: '', color: null, createdAtMs: Date.now(), updatedAtMs: Date.now() },
      { id: 'condo_2', name: 'Project B', description: '', color: null, createdAtMs: Date.now(), updatedAtMs: Date.now() },
    );
    data.goals.push(
      {
        id: 'goal_1', title: 'Own Goal', status: 'active', completed: false,
        sessions: ['agent:main:main'], tasks: [
          { id: 'task_1', text: 'My task', done: false },
        ],
        condoId: 'condo_1', priority: null, deadline: null, description: '', notes: '',
        createdAtMs: Date.now(), updatedAtMs: Date.now(),
      },
      {
        id: 'goal_2', title: 'Sibling Goal', status: 'active', completed: false,
        sessions: [], tasks: [
          { id: 'task_2', text: 'Sibling task', done: false },
        ],
        condoId: 'condo_1', priority: null, deadline: null, description: '', notes: '',
        createdAtMs: Date.now(), updatedAtMs: Date.now(),
      },
      {
        id: 'goal_3', title: 'Other Condo Goal', status: 'active', completed: false,
        sessions: [], tasks: [],
        condoId: 'condo_2', priority: null, deadline: null, description: '', notes: '',
        createdAtMs: Date.now(), updatedAtMs: Date.now(),
      },
      {
        id: 'goal_4', title: 'Done Sibling', status: 'done', completed: true,
        sessions: [], tasks: [{ id: 'task_4', text: 'Done task', done: true }],
        condoId: 'condo_1', priority: null, deadline: null, description: '', notes: '',
        createdAtMs: Date.now(), updatedAtMs: Date.now(),
      },
    );
    data.sessionIndex['agent:main:main'] = { goalId: 'goal_1' };
    store.save(data);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('allows addTasks on sibling in same condo', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      goalId: 'goal_2',
      addTasks: [{ text: 'New sibling task' }],
    });
    expect(result.content[0].text).toContain('created 1 task');
    const data = store.load();
    expect(data.goals[1].tasks).toHaveLength(2);
  });

  it('allows notes on sibling in same condo', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      goalId: 'goal_2',
      notes: 'Cross-goal note',
    });
    expect(result.content[0].text).toContain('notes updated');
    expect(store.load().goals[1].notes).toBe('Cross-goal note');
  });

  it('blocks task status update on sibling', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      goalId: 'goal_2',
      taskId: 'task_2',
      status: 'in-progress',
    });
    expect(result.content[0].text).toContain('cross-goal');
    expect(result.content[0].text).toContain('only addTasks and notes');
  });

  it('blocks goalStatus on sibling', async () => {
    // Mark all sibling tasks done first
    const data = store.load();
    data.goals[1].tasks[0].done = true;
    store.save(data);

    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      goalId: 'goal_2',
      goalStatus: 'done',
    });
    expect(result.content[0].text).toContain('cross-goal');
  });

  it('blocks nextTask on sibling', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      goalId: 'goal_2',
      nextTask: 'Something',
    });
    expect(result.content[0].text).toContain('cross-goal');
  });

  it('blocks operations on different condo', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      goalId: 'goal_3',
      addTasks: [{ text: 'Sneak in' }],
    });
    expect(result.content[0].text).toContain('same project');
  });

  it('blocks operations on completed sibling goal', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      goalId: 'goal_4',
      notes: 'Trying to modify done goal',
    });
    expect(result.content[0].text).toContain('completed goal');
  });

  it('allows all operations on own goal', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      goalId: 'goal_1',
      taskId: 'task_1',
      status: 'in-progress',
    });
    expect(result.content[0].text).toContain('updated');
    expect(result.content[0].text).not.toContain('Error');
  });
});

describe('goal_update file tracking', () => {
  let store, execute;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
    execute = createGoalUpdateExecutor(store);

    const data = store.load();
    data.goals.push({
      id: 'goal_1', title: 'Ship v2', status: 'active', completed: false,
      sessions: ['agent:main:main'], tasks: [
        { id: 'task_1', text: 'Build API', done: false },
        { id: 'task_2', text: 'Write tests', done: false },
      ],
      files: [],
      condoId: null, priority: null, deadline: null, description: '', notes: '',
      createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    data.sessionIndex['agent:main:main'] = { goalId: 'goal_1' };
    store.save(data);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('tracks files via string paths', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      files: ['src/index.js', 'src/api.js'],
    });
    expect(result.content[0].text).toContain('2 files tracked');

    const data = store.load();
    expect(data.goals[0].files).toHaveLength(2);
    expect(data.goals[0].files[0].path).toBe('src/index.js');
    expect(data.goals[0].files[1].path).toBe('src/api.js');
  });

  it('tracks files via object with path property', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      files: [{ path: 'src/index.js' }, { path: 'README.md' }],
    });
    expect(result.content[0].text).toContain('2 files tracked');

    const data = store.load();
    expect(data.goals[0].files).toHaveLength(2);
    expect(data.goals[0].files[0].path).toBe('src/index.js');
  });

  it('deduplicates files by path (latest wins)', async () => {
    await execute('call1', {
      sessionKey: 'agent:main:main',
      files: ['src/index.js'],
    });
    await execute('call2', {
      sessionKey: 'agent:main:main',
      files: ['src/index.js'],
    });

    const data = store.load();
    expect(data.goals[0].files).toHaveLength(1);
    expect(data.goals[0].files[0].path).toBe('src/index.js');
  });

  it('skips empty and whitespace-only paths', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      files: ['src/index.js', '', '   ', { path: '' }],
    });
    expect(result.content[0].text).toContain('1 file tracked');
    expect(store.load().goals[0].files).toHaveLength(1);
  });

  it('files-only call is valid (no other params needed)', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:main',
      files: ['src/index.js'],
    });
    expect(result.content[0].text).not.toContain('Error');
    expect(result.content[0].text).toContain('1 file tracked');
  });

  it('stores correct taskId, sessionKey, and source', async () => {
    await execute('call1', {
      sessionKey: 'agent:main:main',
      taskId: 'task_1',
      status: 'in-progress',
      files: ['src/api.js'],
    });

    const data = store.load();
    const file = data.goals[0].files[0];
    expect(file.path).toBe('src/api.js');
    expect(file.taskId).toBe('task_1');
    expect(file.sessionKey).toBe('agent:main:main');
    expect(file.source).toBe('agent');
    expect(file.addedAtMs).toBeGreaterThan(0);
  });

  it('files without taskId store null taskId', async () => {
    await execute('call1', {
      sessionKey: 'agent:main:main',
      files: ['src/config.js'],
    });

    const data = store.load();
    expect(data.goals[0].files[0].taskId).toBeNull();
  });

  it('files default is empty array on loaded goals', () => {
    const data = store.load();
    expect(data.goals[0].files).toEqual(expect.any(Array));
  });
});
