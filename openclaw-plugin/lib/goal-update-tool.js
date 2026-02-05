export function createGoalUpdateExecutor(store) {
  return async function execute(toolCallId, params) {
    const { sessionKey, taskId, status, summary } = params;

    const data = store.load();
    const entry = data.sessionIndex[sessionKey];
    if (!entry) {
      return { content: [{ type: 'text', text: 'Error: session not assigned to any goal.' }] };
    }

    const goal = data.goals.find(g => g.id === entry.goalId);
    if (!goal) {
      return { content: [{ type: 'text', text: 'Error: goal not found.' }] };
    }

    if (taskId) {
      const task = (goal.tasks || []).find(t => t.id === taskId);
      if (!task) {
        return { content: [{ type: 'text', text: `Error: task ${taskId} not found in goal.` }] };
      }
      task.done = status === 'done';
      task.status = status;
      if (summary) task.summary = summary;
    }

    goal.updatedAtMs = Date.now();
    store.save(data);

    const taskLabel = taskId ? `task ${taskId}` : 'goal';
    return {
      content: [{ type: 'text', text: `Goal "${goal.title}" updated: ${taskLabel} marked ${status}.` }],
    };
  };
}
