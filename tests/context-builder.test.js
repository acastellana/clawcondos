import { describe, it, expect } from 'vitest';
import { buildGoalContext, buildCondoContext } from '../clawcondos/condo-management/lib/context-builder.js';

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

  it('includes task list with completion markers and IDs', () => {
    const ctx = buildGoalContext(baseGoal);
    expect(ctx).toContain('[x] Build API endpoints [t1]');
    expect(ctx).toContain('[ ] Wire up frontend [t2]');
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

  it('shows completion prompt when all tasks are done', () => {
    const goal = {
      id: 'g1', title: 'G', description: '', status: 'done',
      tasks: [{ id: 't1', text: 'Done thing', done: true }],
      sessions: [],
    };
    const ctx = buildGoalContext(goal);
    expect(ctx).toContain('All tasks are complete');
    expect(ctx).toContain('goalStatus');
  });

  it('does not show completion prompt when goal has no tasks', () => {
    const goal = {
      id: 'g1', title: 'G', description: '', status: 'active',
      tasks: [], sessions: [],
    };
    const ctx = buildGoalContext(goal);
    expect(ctx).not.toContain('All tasks are complete');
  });
});

describe('buildCondoContext', () => {
  const condo = {
    id: 'condo_1',
    name: 'Website Redesign',
    description: 'Full redesign of the marketing site',
  };

  const goals = [
    {
      id: 'goal_1', title: 'Ship Landing Page', description: '', status: 'active',
      priority: 'P0', deadline: null,
      tasks: [
        { id: 't1', text: 'Design mockups', done: true, summary: 'Completed 3 variants' },
        { id: 't2', text: 'Implement responsive layout', done: false, sessionKey: null },
      ],
      sessions: [],
    },
    {
      id: 'goal_2', title: 'SEO Optimization', description: '', status: 'active',
      priority: 'P1', deadline: null,
      tasks: [
        { id: 't3', text: 'Keyword research', done: false, sessionKey: null },
      ],
      sessions: [],
    },
  ];

  it('returns null if no condo provided', () => {
    expect(buildCondoContext(null, [])).toBeNull();
  });

  it('includes condo name and description', () => {
    const ctx = buildCondoContext(condo, goals);
    expect(ctx).toContain('Website Redesign');
    expect(ctx).toContain('Full redesign of the marketing site');
  });

  it('includes all goals with tasks', () => {
    const ctx = buildCondoContext(condo, goals);
    expect(ctx).toContain('Ship Landing Page');
    expect(ctx).toContain('SEO Optimization');
    expect(ctx).toContain('Design mockups');
    expect(ctx).toContain('Keyword research');
  });

  it('renders goals as ### headings (nested under condo)', () => {
    const ctx = buildCondoContext(condo, goals);
    expect(ctx).toContain('### Goal: Ship Landing Page');
    // Should not have top-level "# Goal:" (only "### Goal:")
    expect(ctx).not.toMatch(/^# Goal:/m);
  });

  it('includes summary line', () => {
    const ctx = buildCondoContext(condo, goals);
    expect(ctx).toContain('Active: 2 goals, 2 pending tasks');
    expect(ctx).toContain('Completed: 0 goals');
  });

  it('counts completed goals correctly', () => {
    const mixed = [
      { ...goals[0], status: 'done', tasks: [{ id: 't1', text: 'Done', done: true }] },
      goals[1],
    ];
    const ctx = buildCondoContext(condo, mixed);
    expect(ctx).toContain('Active: 1 goals, 1 pending tasks');
    expect(ctx).toContain('Completed: 1 goals');
  });

  it('includes tool usage instructions', () => {
    const ctx = buildCondoContext(condo, goals);
    expect(ctx).toContain('condo_create_goal');
    expect(ctx).toContain('condo_add_task');
    expect(ctx).toContain('goal_update');
  });

  it('handles empty goals list', () => {
    const ctx = buildCondoContext(condo, []);
    expect(ctx).toContain('Website Redesign');
    expect(ctx).toContain('Active: 0 goals, 0 pending tasks');
  });
});
