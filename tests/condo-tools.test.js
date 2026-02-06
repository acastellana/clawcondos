import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createGoalsStore } from '../clawcondos/condo-management/lib/goals-store.js';
import {
  createCondoBindExecutor,
  createCondoCreateGoalExecutor,
  createCondoAddTaskExecutor,
  createCondoSpawnTaskExecutor,
} from '../clawcondos/condo-management/lib/condo-tools.js';

const TEST_DIR = join(import.meta.dirname, '__fixtures__', 'condo-tools-test');

describe('condo_bind tool', () => {
  let store, execute;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
    execute = createCondoBindExecutor(store);

    // Seed a condo
    const data = store.load();
    data.condos.push({
      id: 'condo_1', name: 'Website Redesign', description: 'Redesign project',
      color: null, createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    store.save(data);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('binds session to existing condo by condoId', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      condoId: 'condo_1',
    });
    expect(result.content[0].text).toContain('Website Redesign');

    const data = store.load();
    expect(data.sessionCondoIndex['agent:main:telegram:123']).toBe('condo_1');
  });

  it('creates new condo and binds when name is provided', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:456',
      name: 'New Project',
      description: 'A new project',
    });
    expect(result.content[0].text).toContain('New Project');

    const data = store.load();
    const condoId = data.sessionCondoIndex['agent:main:telegram:456'];
    expect(condoId).toBeTruthy();
    const condo = data.condos.find(c => c.id === condoId);
    expect(condo.name).toBe('New Project');
    expect(condo.description).toBe('A new project');
  });

  it('returns error for nonexistent condoId', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      condoId: 'condo_nonexistent',
    });
    expect(result.content[0].text).toContain('not found');
  });

  it('returns error when neither condoId nor name provided', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
    });
    expect(result.content[0].text).toContain('Error');
  });
});

describe('condo_create_goal tool', () => {
  let store, execute;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
    execute = createCondoCreateGoalExecutor(store);

    // Seed a condo and bind a session
    const data = store.load();
    data.condos.push({
      id: 'condo_1', name: 'Project', description: '',
      color: null, createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    data.sessionCondoIndex['agent:main:telegram:123'] = 'condo_1';
    store.save(data);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates a goal in the bound condo', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      title: 'Ship Landing Page',
    });
    expect(result.content[0].text).toContain('Ship Landing Page');
    expect(result.content[0].text).toContain('condo_1');

    const data = store.load();
    expect(data.goals).toHaveLength(1);
    expect(data.goals[0].condoId).toBe('condo_1');
    expect(data.goals[0].title).toBe('Ship Landing Page');
  });

  it('creates goal with initial tasks (string array)', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      title: 'Ship It',
      tasks: ['Design mockups', 'Write code', 'Deploy'],
    });
    expect(result.content[0].text).toContain('3 tasks');

    const data = store.load();
    expect(data.goals[0].tasks).toHaveLength(3);
    expect(data.goals[0].tasks[0].text).toBe('Design mockups');
    expect(data.goals[0].tasks[1].text).toBe('Write code');
  });

  it('creates goal with initial tasks (object array)', async () => {
    await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      title: 'Ship It',
      tasks: [{ text: 'Design', description: 'Create mockups', priority: 'P0' }],
    });

    const data = store.load();
    expect(data.goals[0].tasks[0].text).toBe('Design');
    expect(data.goals[0].tasks[0].description).toBe('Create mockups');
    expect(data.goals[0].tasks[0].priority).toBe('P0');
  });

  it('skips invalid tasks in array', async () => {
    await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      title: 'Ship It',
      tasks: ['Valid task', '', null, { text: '  ' }],
    });

    const data = store.load();
    expect(data.goals[0].tasks).toHaveLength(1);
    expect(data.goals[0].tasks[0].text).toBe('Valid task');
  });

  it('returns error for missing title', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
    });
    expect(result.content[0].text).toContain('Error');
  });

  it('returns error for unbound session', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:unbound:main',
      title: 'Orphan Goal',
    });
    expect(result.content[0].text).toContain('not bound');
  });
});

describe('condo_add_task tool', () => {
  let store, execute;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
    execute = createCondoAddTaskExecutor(store);

    // Seed a condo, goal, and binding
    const data = store.load();
    data.condos.push({
      id: 'condo_1', name: 'Project', description: '',
      color: null, createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    data.goals.push({
      id: 'goal_1', title: 'Ship It', description: '', status: 'active',
      completed: false, condoId: 'condo_1', priority: null, deadline: null,
      tasks: [], sessions: [], createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    data.sessionCondoIndex['agent:main:telegram:123'] = 'condo_1';
    store.save(data);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('adds a task to a goal in the bound condo', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_1',
      text: 'Design mockups',
    });
    expect(result.content[0].text).toContain('Design mockups');

    const data = store.load();
    expect(data.goals[0].tasks).toHaveLength(1);
    expect(data.goals[0].tasks[0].text).toBe('Design mockups');
    expect(data.goals[0].tasks[0].status).toBe('pending');
  });

  it('returns error for missing goalId', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      text: 'Orphan task',
    });
    expect(result.content[0].text).toContain('Error');
  });

  it('returns error for missing text', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_1',
    });
    expect(result.content[0].text).toContain('Error');
  });

  it('returns error when goal does not belong to the bound condo', async () => {
    // Add a goal in a different condo
    const data = store.load();
    data.goals.push({
      id: 'goal_other', title: 'Other', description: '', status: 'active',
      completed: false, condoId: 'condo_other', priority: null, deadline: null,
      tasks: [], sessions: [], createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    store.save(data);

    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_other',
      text: 'Cross-condo task',
    });
    expect(result.content[0].text).toContain('does not belong');
  });

  it('returns error for unbound session', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:unbound:main',
      goalId: 'goal_1',
      text: 'Task',
    });
    expect(result.content[0].text).toContain('not bound');
  });
});

describe('condo_spawn_task tool', () => {
  let store, execute;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
    execute = createCondoSpawnTaskExecutor(store);

    const data = store.load();
    data.condos.push({
      id: 'condo_1', name: 'Project', description: '',
      color: null, createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    data.goals.push({
      id: 'goal_1', title: 'Ship It', description: '', status: 'active',
      completed: false, condoId: 'condo_1', priority: null, deadline: null,
      tasks: [
        { id: 'task_1', text: 'Build API', description: '', status: 'pending', done: false, priority: null, sessionKey: null, dependsOn: [], summary: '', createdAtMs: Date.now(), updatedAtMs: Date.now() },
        { id: 'task_2', text: 'Deploy', description: '', status: 'pending', done: false, priority: null, sessionKey: 'agent:existing:sub', dependsOn: [], summary: '', createdAtMs: Date.now(), updatedAtMs: Date.now() },
      ],
      sessions: [], createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    data.sessionCondoIndex['agent:main:telegram:123'] = 'condo_1';
    store.save(data);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('spawns a subagent session for a task', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_1',
      taskId: 'task_1',
    });
    expect(result.content[0].text).toContain('subagent');
    expect(result.content[0].text).toContain('Build API');
    expect(result.spawnRequest).toBeTruthy();
    expect(result.spawnRequest.goalId).toBe('goal_1');
    expect(result.spawnRequest.taskId).toBe('task_1');

    const data = store.load();
    const task = data.goals[0].tasks.find(t => t.id === 'task_1');
    expect(task.sessionKey).toBeTruthy();
    expect(task.status).toBe('in-progress');
    expect(data.sessionIndex[task.sessionKey]).toEqual({ goalId: 'goal_1' });
  });

  it('returns error when task already has a session', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_1',
      taskId: 'task_2',
    });
    expect(result.content[0].text).toContain('already has a session');
  });

  it('returns error for missing goalId', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      taskId: 'task_1',
    });
    expect(result.content[0].text).toContain('Error');
  });

  it('returns error for nonexistent task', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_1',
      taskId: 'task_nonexistent',
    });
    expect(result.content[0].text).toContain('not found');
  });

  it('returns error when goal does not belong to the bound condo', async () => {
    const data = store.load();
    data.goals.push({
      id: 'goal_other', title: 'Other', description: '', status: 'active',
      completed: false, condoId: 'condo_other', priority: null, deadline: null,
      tasks: [{ id: 'task_x', text: 'X', description: '', status: 'pending', done: false, priority: null, sessionKey: null, dependsOn: [], summary: '', createdAtMs: Date.now(), updatedAtMs: Date.now() }],
      sessions: [], createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    store.save(data);

    const result = await execute('call1', {
      sessionKey: 'agent:main:telegram:123',
      goalId: 'goal_other',
      taskId: 'task_x',
    });
    expect(result.content[0].text).toContain('does not belong');
  });

  it('returns error for unbound session', async () => {
    const result = await execute('call1', {
      sessionKey: 'agent:unbound:main',
      goalId: 'goal_1',
      taskId: 'task_1',
    });
    expect(result.content[0].text).toContain('not bound');
  });
});
