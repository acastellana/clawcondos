import { describe, it, expect } from 'vitest';
import { buildGoalContext } from '../openclaw-plugin/lib/context-builder.js';

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

describe('buildGoalContext null safety', () => {
  it('handles goal with empty tasks array', () => {
    const goal = {
      id: 'g1', title: 'Empty Goal', description: 'No tasks yet',
      status: 'active', priority: null, deadline: null,
      tasks: [], sessions: [],
    };
    const ctx = buildGoalContext(goal);
    expect(ctx).toContain('Empty Goal');
    expect(ctx).toContain('No tasks yet');
    expect(ctx).not.toContain('## Tasks');
  });

  it('handles goal with null/missing description', () => {
    const goal = {
      id: 'g1', title: 'No Desc', description: null,
      status: 'active', priority: null, deadline: null,
      tasks: [{ id: 't1', text: 'Do thing', done: false }],
      sessions: [],
    };
    const ctx = buildGoalContext(goal);
    expect(ctx).toContain('No Desc');
    expect(ctx).toContain('Do thing');
    expect(ctx).not.toContain('null');
  });
});

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

  it('shows assigned session key for other sessions', () => {
    const ctx = buildGoalContext(goal, { currentSessionKey: 'agent:main:s2' });
    expect(ctx).toContain('(assigned: agent:main:s1)');
  });
});

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
