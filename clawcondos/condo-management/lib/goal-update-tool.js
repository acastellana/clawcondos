export function createGoalUpdateExecutor(store) {
  return async function execute(toolCallId, params) {
    const { sessionKey, goalId, taskId, status, summary, addTasks, nextTask, goalStatus, notes } = params;

    // Require at least one actionable param.
    const hasTaskUpdate = taskId && status;
    const hasAddTasks = Array.isArray(addTasks) && addTasks.length > 0;
    const hasNextTask = typeof nextTask === 'string';
    const hasGoalStatus = typeof goalStatus === 'string';
    const hasNotes = typeof notes === 'string' && notes.trim();
    if (!hasTaskUpdate && !hasAddTasks && !hasNextTask && !hasGoalStatus && !hasNotes) {
      return { content: [{ type: 'text', text: 'Error: provide at least one of: taskId+status, addTasks, nextTask, goalStatus, notes.' }] };
    }

    const data = store.load();

    // Resolve goal: explicit goalId (condo path) or sessionIndex (single-goal path)
    let goal;
    if (goalId) {
      goal = data.goals.find(g => g.id === goalId);
      if (!goal) {
        return { content: [{ type: 'text', text: `Error: goal ${goalId} not found.` }] };
      }
      // If called from a condo-bound session, verify the goal belongs to the condo
      const condoId = data.sessionCondoIndex[sessionKey];
      if (condoId && goal.condoId !== condoId) {
        return { content: [{ type: 'text', text: `Error: goal ${goalId} does not belong to the bound condo.` }] };
      }
    } else {
      const entry = data.sessionIndex[sessionKey];
      if (!entry) {
        return { content: [{ type: 'text', text: 'Error: session not assigned to any goal.' }] };
      }
      goal = data.goals.find(g => g.id === entry.goalId);
      if (!goal) {
        return { content: [{ type: 'text', text: 'Error: goal not found.' }] };
      }
    }

    const results = [];

    // ── Task status update ──
    if (hasTaskUpdate) {
      const task = (goal.tasks || []).find(t => t.id === taskId);
      if (!task) {
        return { content: [{ type: 'text', text: `Error: task ${taskId} not found in goal.` }] };
      }
      task.done = status === 'done';
      task.status = status;
      if (summary) task.summary = summary;
      task.updatedAtMs = Date.now();
      results.push(`task ${taskId} → ${status}`);
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
        results.push(`created ${created.length} task${created.length > 1 ? 's' : ''}`);
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
        const pending = (goal.tasks || []).filter(t => !t.done);
        if (pending.length > 0) {
          return { content: [{ type: 'text', text: `Error: cannot mark goal done — ${pending.length} task${pending.length > 1 ? 's' : ''} still pending.` }] };
        }
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

    goal.updatedAtMs = Date.now();
    store.save(data);

    return {
      content: [{ type: 'text', text: `Goal "${goal.title}" updated: ${results.join(', ')}.` }],
    };
  };
}
