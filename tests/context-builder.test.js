import { describe, it, expect } from 'vitest';
import { buildGoalContext, buildCondoContext, buildProjectSummary } from '../clawcondos/condo-management/lib/context-builder.js';

describe('buildGoalContext', () => {
  const baseGoal = {
    id: 'goal_1',
    title: 'Ship feature',
    description: 'Launch the release',
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

  it('wraps output in <goal> XML tags with id and status', () => {
    const ctx = buildGoalContext(baseGoal);
    expect(ctx).toMatch(/^<goal id="goal_1" status="active">/);
    expect(ctx).toContain('</goal>');
  });

  it('includes goal title as # heading (no "Goal:" prefix)', () => {
    const ctx = buildGoalContext(baseGoal);
    expect(ctx).toContain('# Ship feature');
    expect(ctx).not.toContain('# Goal:');
  });

  it('includes description', () => {
    const ctx = buildGoalContext(baseGoal);
    expect(ctx).toContain('Launch the release');
  });

  it('includes task list with status markers and IDs', () => {
    const ctx = buildGoalContext(baseGoal);
    expect(ctx).toContain('[done] Build API endpoints [t1]');
    expect(ctx).toContain('[pending] Wire up frontend [t2]');
  });

  it('shows in-progress, waiting, and blocked status markers', () => {
    const goal = {
      ...baseGoal,
      tasks: [
        { id: 't1', text: 'Task A', done: false, status: 'in-progress' },
        { id: 't2', text: 'Task B', done: false, status: 'waiting' },
        { id: 't3', text: 'Task C', done: false, status: 'blocked' },
      ],
    };
    const ctx = buildGoalContext(goal);
    expect(ctx).toContain('[in-progress] Task A [t1]');
    expect(ctx).toContain('[waiting] Task B [t2]');
    expect(ctx).toContain('[blocked] Task C [t3]');
  });

  it('includes compact meta with priority and deadline', () => {
    const ctx = buildGoalContext(baseGoal);
    expect(ctx).toContain('P0 · Deadline: 2026-02-15');
  });

  it('does not include session count', () => {
    const ctx = buildGoalContext(baseGoal);
    // Should not have "Sessions: 2" style meta
    expect(ctx).not.toContain('Sessions:');
  });

  it('shows task progress count', () => {
    const ctx = buildGoalContext(baseGoal);
    expect(ctx).toContain('Tasks (1/3 done):');
  });

  it('counts tasks with status:"done" even if done flag is missing', () => {
    const goal = {
      ...baseGoal,
      tasks: [
        { id: 't1', text: 'A', done: false, status: 'done' },
        { id: 't2', text: 'B', done: false, status: 'pending' },
      ],
    };
    const ctx = buildGoalContext(goal);
    expect(ctx).toContain('Tasks (1/2 done):');
  });

  it('does not include instruction blockquote', () => {
    const ctx = buildGoalContext(baseGoal);
    expect(ctx).not.toContain('Use the `goal_update` tool');
    expect(ctx).not.toContain('All tasks are complete');
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
    expect(ctx).not.toContain('Tasks (');
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
    id: 'goal_1', title: 'Ship feature', description: '', status: 'active',
    priority: null, deadline: null,
    tasks: [
      { id: 't1', text: 'Build API', done: true, sessionKey: 'agent:main:s1', summary: 'Done - all endpoints built' },
      { id: 't2', text: 'Write tests', done: false, sessionKey: 'agent:main:s2' },
      { id: 't3', text: 'Deploy', done: false, sessionKey: null },
    ],
    sessions: ['agent:main:s1', 'agent:main:s2'],
  };

  it('marks current session tasks with ← you', () => {
    const ctx = buildGoalContext(goal, { currentSessionKey: 'agent:main:s2' });
    expect(ctx).toContain('Write tests [t2] ← you');
  });

  it('includes completed task summaries', () => {
    const ctx = buildGoalContext(goal, { currentSessionKey: 'agent:main:s2' });
    expect(ctx).toContain('Done - all endpoints built');
  });

  it('marks unassigned tasks with — unassigned', () => {
    const ctx = buildGoalContext(goal, { currentSessionKey: 'agent:main:s2' });
    expect(ctx).toContain('Deploy [t3] — unassigned');
  });

  it('shows agent key for other sessions', () => {
    const ctx = buildGoalContext(goal, { currentSessionKey: 'agent:main:s2' });
    expect(ctx).toContain('(agent: agent:main:s1)');
  });

  it('does not show — unassigned for done tasks with null sessionKey', () => {
    const g = {
      id: 'g1', title: 'Test', description: '', status: 'active',
      priority: null, deadline: null,
      tasks: [
        { id: 't1', text: 'Completed thing', done: true, sessionKey: null },
      ],
      sessions: [],
    };
    const ctx = buildGoalContext(g, { currentSessionKey: 'agent:main:s1' });
    expect(ctx).toContain('[done] Completed thing [t1]');
    expect(ctx).not.toContain('— unassigned');
    expect(ctx).not.toContain('← you');
  });
});

describe('buildProjectSummary', () => {
  const condo = { id: 'condo_abc', name: 'Website Redesign' };

  const goals = [
    { id: 'goal_111', title: 'Design System', status: 'done', tasks: [{ id: 't1', text: 'x', done: true }] },
    { id: 'goal_222', title: 'Ship Landing Page', status: 'active', tasks: [
      { id: 't2', text: 'a', done: true },
      { id: 't3', text: 'b', done: true },
      { id: 't4', text: 'c', done: false },
      { id: 't5', text: 'd', done: false },
    ]},
    { id: 'goal_333', title: 'Ship feature', status: 'active', tasks: [{ id: 't6', text: 'e', done: false }] },
    { id: 'goal_444', title: 'SEO Optimization', status: 'pending', tasks: [] },
    { id: 'goal_555', title: 'Performance Audit', status: 'pending', tasks: [] },
  ];

  it('returns null for null condo', () => {
    expect(buildProjectSummary(null, goals, 'goal_333')).toBeNull();
  });

  it('returns null for empty goals array', () => {
    expect(buildProjectSummary(condo, [], 'goal_333')).toBeNull();
  });

  it('includes condo name and id in <project> tag', () => {
    const result = buildProjectSummary(condo, goals, 'goal_333');
    expect(result).toContain('<project name="Website Redesign" id="condo_abc"');
    expect(result).toContain('</project>');
  });

  it('includes goal count in <project> tag', () => {
    const result = buildProjectSummary(condo, goals, 'goal_333');
    expect(result).toContain('goals="5"');
  });

  it('marks currentGoalId with ← this goal', () => {
    const result = buildProjectSummary(condo, goals, 'goal_333');
    expect(result).toContain('Ship feature (goal_333) ← this goal');
  });

  it('shows [done] and [active] status markers', () => {
    const result = buildProjectSummary(condo, goals, 'goal_333');
    expect(result).toContain('[done] Design System');
    expect(result).toContain('[active] Ship Landing Page');
  });

  it('shows task progress for active goals (not current)', () => {
    const result = buildProjectSummary(condo, goals, 'goal_333');
    expect(result).toContain('Ship Landing Page (goal_222) — 2/4 tasks');
  });

  it('does not show task progress for current goal', () => {
    const result = buildProjectSummary(condo, goals, 'goal_333');
    // goal_333 should show ← this goal, not task count
    expect(result).toMatch(/Ship feature \(goal_333\) ← this goal/);
    expect(result).not.toMatch(/Ship feature \(goal_333\) —/);
  });

  it('shows numbered list', () => {
    const result = buildProjectSummary(condo, goals, 'goal_333');
    expect(result).toContain('1. [done]');
    expect(result).toContain('5. [pending]');
  });

  it('caps at 15 goals and shows remainder', () => {
    const manyGoals = Array.from({ length: 20 }, (_, i) => ({
      id: `goal_${i}`, title: `Goal ${i}`, status: 'pending', tasks: [],
    }));
    const result = buildProjectSummary(condo, manyGoals, 'goal_0');
    expect(result).toContain('15. [pending]');
    expect(result).not.toContain('16.');
    expect(result).toContain('... and 5 more');
  });

  it('returns null for goals not in an array', () => {
    expect(buildProjectSummary(condo, null, 'goal_1')).toBeNull();
  });

  it('defaults missing status to active (matching goal creation default)', () => {
    const goalsWithNoStatus = [
      { id: 'goal_x', title: 'No Status Goal', tasks: [] },
    ];
    const result = buildProjectSummary(condo, goalsWithNoStatus, 'other');
    expect(result).toContain('[active] No Status Goal');
  });

  it('handles currentGoalId that does not match any goal', () => {
    const result = buildProjectSummary(condo, goals, 'nonexistent_goal');
    expect(result).not.toContain('← this goal');
    expect(result).toContain('Ship Landing Page');
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
    expect(ctx).toContain('### Ship Landing Page');
    // Should not have top-level "# " heading for goals (only ### inside goal blocks)
    expect(ctx).not.toMatch(/^# Ship Landing Page/m);
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
