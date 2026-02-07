export function createGoalUpdateExecutor(store) {
  const error = (text) => ({ content: [{ type: 'text', text: `Error: ${text}` }] });

  return async function execute(toolCallId, params) {
    const { sessionKey, goalId, taskId, status, summary, addTasks, nextTask, goalStatus, notes, files } = params;

    // Require at least one actionable param.
    const hasTaskUpdate = taskId && status;
    const hasAddTasks = Array.isArray(addTasks) && addTasks.length > 0;
    const hasNextTask = typeof nextTask === 'string';
    const hasGoalStatus = typeof goalStatus === 'string';
    const hasNotes = typeof notes === 'string' && notes.trim();
    const hasFiles = Array.isArray(files) && files.length > 0;
    if (!hasTaskUpdate && !hasAddTasks && !hasNextTask && !hasGoalStatus && !hasNotes && !hasFiles) {
      return error('provide at least one of: taskId+status, addTasks, nextTask, goalStatus, notes, files.');
    }

    const data = store.load();

    // Resolve goal: explicit goalId (condo path) or sessionIndex (single-goal path)
    let goal;
    if (goalId) {
      goal = data.goals.find(g => g.id === goalId);
      if (!goal) {
        return error(`goal ${goalId} not found.`);
      }
      // If called from a condo-bound session, verify the goal belongs to the condo
      const condoId = data.sessionCondoIndex[sessionKey];
      if (condoId && goal.condoId !== condoId) {
        return error(`goal ${goalId} does not belong to the bound condo.`);
      }
    } else {
      const entry = data.sessionIndex[sessionKey];
      if (!entry) {
        return error('session not assigned to any goal.');
      }
      goal = data.goals.find(g => g.id === entry.goalId);
      if (!goal) {
        return error('goal not found.');
      }
    }

    // Cross-goal boundary checks
    const ownEntry = data.sessionIndex[sessionKey];
    if (ownEntry && ownEntry.goalId && ownEntry.goalId !== goal.id) {
      // Cross-goal operation
      const ownGoal = data.goals.find(g => g.id === ownEntry.goalId);
      if (!ownGoal?.condoId || ownGoal.condoId !== goal.condoId) {
        return error('can only contribute to goals in the same project.');
      }
      if (goal.status === 'done' || goal.completed) {
        return error('cannot modify a completed goal.');
      }
      if (hasTaskUpdate || hasGoalStatus || hasNextTask) {
        return error('cross-goal: only addTasks and notes allowed on sibling goals.');
      }
    }

    // ── Validate goalStatus:"done" early (before any mutations) ──
    if (hasGoalStatus && goalStatus === 'done') {
      const tasks = goal.tasks || [];
      // Account for a task being marked done in this same call
      const willMarkDone = hasTaskUpdate && status === 'done' && taskId;
      const pending = tasks.filter(t => !t.done && t.id !== (willMarkDone ? taskId : undefined));
      if (pending.length > 0) {
        return error(`cannot mark goal done — ${pending.length} task${pending.length > 1 ? 's' : ''} still pending.`);
      }
    }

    const results = [];

    // ── Task status update ──
    if (hasTaskUpdate) {
      const task = (goal.tasks || []).find(t => t.id === taskId);
      if (!task) {
        return error(`task ${taskId} not found in goal.`);
      }
      task.done = status === 'done';
      task.status = status;
      // Update stage to match status for proper UI grouping
      if (status === 'done') {
        task.stage = 'done';
      } else if (status === 'in-progress') {
        task.stage = 'in-progress';
      } else if (status === 'blocked' || status === 'waiting') {
        task.stage = 'blocked';
      } else {
        task.stage = 'backlog';
      }
      if (summary) task.summary = summary;
      task.updatedAtMs = Date.now();
      results.push(`task ${taskId} → ${status}`);

      if (status === 'in-progress') {
        goal.nextTask = task.text;
      } else if (status === 'done') {
        goal.nextTask = null;
      }
    }

    // ── Create tasks ──
    if (hasAddTasks) {
      if (!Array.isArray(goal.tasks)) goal.tasks = [];
      const created = [];
      for (const t of addTasks) {
        const text = (typeof t?.text === 'string') ? t.text.trim() : '';
        if (!text) continue;
        const now = Date.now();
        const task = {
          id: store.newId('task'),
          text,
          description: (typeof t?.description === 'string') ? t.description.trim() : '',
          status: 'pending',
          done: false,
          priority: null,
          sessionKey: null,
          dependsOn: [],
          summary: '',
          createdAtMs: now,
          updatedAtMs: now,
        };
        goal.tasks.push(task);
        created.push(task.id);
      }
      if (created.length) {
        results.push(`created ${created.length} task${created.length > 1 ? 's' : ''}: ${created.join(', ')}`);
      }
    }

    // ── nextTask ──
    if (hasNextTask) {
      goal.nextTask = nextTask.trim();
      results.push(`nextTask set`);
    }

    // ── Goal status ──
    if (hasGoalStatus) {
      if (goalStatus === 'done') {
        goal.status = 'done';
        goal.completed = true;
        results.push('goal marked done');
      } else if (goalStatus === 'active') {
        goal.status = 'active';
        goal.completed = false;
        results.push('goal marked active');
      }
    }

    // ── Notes (append) ──
    if (hasNotes) {
      const existing = (goal.notes || '').trim();
      goal.notes = existing ? `${existing}\n\n${notes.trim()}` : notes.trim();
      results.push('notes updated');
    }

    // ── Files tracking ──
    if (hasFiles) {
      if (!Array.isArray(goal.files)) goal.files = [];
      const now = Date.now();
      let added = 0;
      for (const f of files) {
        const path = (typeof f === 'string' ? f : f?.path || '').trim();
        if (!path) continue;
        // Deduplicate: remove existing entry with same path
        goal.files = goal.files.filter(e => e.path !== path);
        goal.files.push({
          path,
          taskId: taskId || null,
          sessionKey,
          addedAtMs: now,
          source: 'agent',
        });
        added++;
      }
      if (added) {
        results.push(`${added} file${added !== 1 ? 's' : ''} tracked`);
      }
    }

    goal.updatedAtMs = Date.now();
    store.save(data);

    const remaining = (goal.tasks || []).filter(t => !t.done).length;
    const countSuffix = remaining > 0
      ? ` (${remaining} task${remaining !== 1 ? 's' : ''} remaining)`
      : ' (all tasks done)';

    return {
      content: [{ type: 'text', text: `Goal "${goal.title}" updated: ${results.join(', ')}.${countSuffix}` }],
    };
  };
}
