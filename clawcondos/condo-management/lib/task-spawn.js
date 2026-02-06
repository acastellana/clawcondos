import { buildGoalContext } from './context-builder.js';

export function createTaskSpawnHandler(store) {
  return function handler({ params, respond }) {
    try {
      const { goalId, taskId, agentId, model } = params;
      if (!goalId || !taskId) {
        respond(false, undefined, { message: 'goalId and taskId are required' });
        return;
      }

      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);
      if (!goal) {
        respond(false, undefined, { message: 'Goal not found' });
        return;
      }
      const task = (goal.tasks || []).find(t => t.id === taskId);
      if (!task) {
        respond(false, undefined, { message: 'Task not found in goal' });
        return;
      }

      // Guard against re-spawning already-assigned tasks
      if (task.sessionKey) {
        respond(false, undefined, { message: 'Task already has a session' });
        return;
      }

      // Generate a session key for the spawned subagent
      const suffix = store.newId('spawn').replace('spawn_', '');
      const agent = agentId || 'main';
      const sessionKey = `agent:${agent}:subagent:${suffix}`;

      // Build task-specific context
      const goalContext = buildGoalContext(goal, { currentSessionKey: sessionKey });
      const taskContext = [
        goalContext,
        '',
        '---',
        `## Your Assignment: ${task.text}`,
        task.description ? `\n${task.description}` : '',
        '',
        'When you complete this task, use the goal_update tool to mark it done.',
      ].filter(Boolean).join('\n');

      // Link session to goal and update task
      task.sessionKey = sessionKey;
      task.status = 'in-progress';
      task.updatedAtMs = Date.now();
      goal.sessions.push(sessionKey);
      goal.updatedAtMs = Date.now();
      data.sessionIndex[sessionKey] = { goalId };
      store.save(data);

      respond(true, {
        sessionKey,
        taskContext,
        agentId: agent,
        model: model || null,
        goalId,
        taskId,
      });
    } catch (err) {
      respond(false, undefined, { message: String(err) });
    }
  };
}
