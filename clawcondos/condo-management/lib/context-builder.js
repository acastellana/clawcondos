export function buildGoalContext(goal, opts = {}) {
  if (!goal) return null;
  const { currentSessionKey } = opts;

  const lines = [
    `# Goal: ${goal.title}`,
  ];

  if (goal.description) lines.push('', goal.description);

  const meta = [];
  if (goal.status) meta.push(`Status: ${goal.status}`);
  if (goal.priority) meta.push(`Priority: ${goal.priority}`);
  if (goal.deadline) meta.push(`Deadline: ${goal.deadline}`);
  if (goal.sessions?.length) meta.push(`Sessions: ${goal.sessions.length}`);
  if (meta.length) lines.push('', meta.join(' | '));

  if (goal.tasks?.length) {
    lines.push('', '## Tasks');
    for (const t of goal.tasks) {
      const marker = t.done ? 'x' : ' ';
      let suffix = '';
      if (currentSessionKey && t.sessionKey === currentSessionKey) {
        suffix = ' (you)';
      } else if (t.sessionKey) {
        suffix = ` (assigned: ${t.sessionKey})`;
      } else if (!t.done) {
        suffix = ' (unassigned)';
      }
      lines.push(`- [${marker}] ${t.text} [${t.id}]${suffix}`);
      if (t.done && t.summary) {
        lines.push(`  > ${t.summary}`);
      }
    }
  }

  const hasPendingTasks = (goal.tasks || []).some(t => !t.done);
  if (hasPendingTasks) {
    lines.push('');
    lines.push('> Use the `goal_update` tool to report progress. Pass the task ID (shown in brackets) and status. Example: goal_update({ taskId: "task_abc", status: "done", summary: "Built the API" })');
  } else if (goal.tasks?.length) {
    lines.push('');
    lines.push('> All tasks are complete. If the goal is finished, call goal_update({ goalStatus: "done" }).');
  }

  return lines.join('\n');
}

export function buildCondoContext(condo, goals, opts = {}) {
  if (!condo) return null;
  const { currentSessionKey } = opts;

  const lines = [
    `# Condo: ${condo.name}`,
  ];

  if (condo.description) lines.push('', condo.description);

  if (goals.length) {
    lines.push('', '## Goals');
    for (const goal of goals) {
      const goalBlock = buildGoalContext(goal, { currentSessionKey });
      if (goalBlock) {
        // Indent goal context under condo (replace top-level # with ###)
        lines.push('', goalBlock.replace(/^# Goal:/m, '### Goal:'));
      }
    }
  }

  // Summary line
  const active = goals.filter(g => g.status !== 'done');
  const completed = goals.filter(g => g.status === 'done');
  const pendingTasks = goals.reduce((n, g) => n + (g.tasks || []).filter(t => !t.done).length, 0);
  lines.push('', '---');
  lines.push(`Active: ${active.length} goals, ${pendingTasks} pending tasks | Completed: ${completed.length} goals`);

  // Tool usage instructions
  lines.push('');
  lines.push('> You are the orchestrator for this condo. Use `condo_create_goal` to create new goals, `condo_add_task` to add tasks to goals, and `goal_update` to report task status.');

  return lines.join('\n');
}
