import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createGoalsStore } from './lib/goals-store.js';
import { createGoalHandlers } from './lib/goals-handlers.js';
import { createCondoHandlers } from './lib/condos-handlers.js';
import { buildGoalContext, buildCondoContext } from './lib/context-builder.js';
import { createGoalUpdateExecutor } from './lib/goal-update-tool.js';
import { createTaskSpawnHandler } from './lib/task-spawn.js';
import {
  createCondoBindExecutor,
  createCondoCreateGoalExecutor,
  createCondoAddTaskExecutor,
  createCondoSpawnTaskExecutor,
} from './lib/condo-tools.js';

export default function register(api) {
  const dataDir = api.pluginConfig?.dataDir
    || join(dirname(fileURLToPath(import.meta.url)), '.data');
  const store = createGoalsStore(dataDir);
  const handlers = createGoalHandlers(store);

  for (const [method, handler] of Object.entries(handlers)) {
    api.registerGatewayMethod(method, handler);
  }

  const condoHandlers = createCondoHandlers(store);
  for (const [method, handler] of Object.entries(condoHandlers)) {
    api.registerGatewayMethod(method, handler);
  }

  api.registerGatewayMethod('goals.spawnTaskSession', createTaskSpawnHandler(store));

  // Hook: inject goal/condo context into agent prompts
  api.registerHook('before_agent_start', async (event) => {
    const sessionKey = event.context?.sessionKey;
    if (!sessionKey) return;
    const data = store.load();

    // 1. Check sessionCondoIndex (condo orchestrator path)
    const condoId = data.sessionCondoIndex[sessionKey];
    if (condoId) {
      const condo = data.condos.find(c => c.id === condoId);
      if (condo) {
        const goals = data.goals.filter(g => g.condoId === condoId);
        const context = buildCondoContext(condo, goals, { currentSessionKey: sessionKey });
        if (context) return { prependContext: context };
      }
    }

    // 2. Check sessionIndex (single-goal path, unchanged)
    const entry = data.sessionIndex[sessionKey];
    if (!entry) return;
    const goal = data.goals.find(g => g.id === entry.goalId);
    if (!goal) return;
    const context = buildGoalContext(goal, { currentSessionKey: sessionKey });
    if (!context) return;
    return { prependContext: context };
  });

  // Hook: track session activity on goals and condos
  api.registerHook('agent_end', async (event) => {
    const sessionKey = event.context?.sessionKey;
    if (!sessionKey || !event.success) return;
    const data = store.load();

    // Update condo timestamp if session is bound to one
    const condoId = data.sessionCondoIndex[sessionKey];
    if (condoId) {
      const condo = data.condos.find(c => c.id === condoId);
      if (condo) {
        condo.updatedAtMs = Date.now();
        store.save(data);
        api.logger.info(`clawcondos-goals: agent_end for session ${sessionKey} (condo: ${condo.name})`);
        return;
      }
    }

    // Update goal timestamp if session is assigned to one
    const entry = data.sessionIndex[sessionKey];
    if (!entry) return;
    const goal = data.goals.find(g => g.id === entry.goalId);
    if (!goal) return;
    goal.updatedAtMs = Date.now();
    store.save(data);
    api.logger.info(`clawcondos-goals: agent_end for session ${sessionKey} (goal: ${goal.title})`);
  });

  // Tool: goal_update for agents to report task status
  const goalUpdateExecute = createGoalUpdateExecutor(store);

  api.registerTool(
    (ctx) => {
      if (!ctx.sessionKey) return null;

      // Always expose the tool for any session with a key.  The executor validates
      // that the session is actually assigned to a goal at call time, which avoids
      // timing issues between goals.addSession and tool-factory evaluation.
      return {
        name: 'goal_update',
        label: 'Update Goal/Task Status',
        description: 'Update your assigned goal: report task progress, create tasks, set next task, or mark the goal done. For condo sessions, specify goalId.',
        parameters: {
          type: 'object',
          properties: {
            goalId: { type: 'string', description: 'ID of the goal to update (required for condo sessions, optional for single-goal sessions)' },
            taskId: { type: 'string', description: 'ID of the task to update (from goal context, shown in brackets like [task_abc])' },
            status: { type: 'string', enum: ['done', 'in-progress', 'blocked'], description: 'New task status (use with taskId)' },
            summary: { type: 'string', description: 'Brief summary of what was accomplished or what is blocking' },
            addTasks: {
              type: 'array',
              description: 'Create new tasks on the goal',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'Task description' },
                  description: { type: 'string', description: 'Detailed task description' },
                },
                required: ['text'],
              },
            },
            nextTask: { type: 'string', description: 'What you are working on next (shown in dashboard)' },
            goalStatus: { type: 'string', enum: ['active', 'done'], description: 'Mark overall goal as done (only if all tasks are complete) or re-activate' },
            notes: { type: 'string', description: 'Append notes to the goal' },
          },
        },
        async execute(toolCallId, params) {
          return goalUpdateExecute(toolCallId, { ...params, sessionKey: ctx.sessionKey });
        },
      };
    },
    { names: ['goal_update'] }
  );

  // Tool: condo_bind for agents to bind their session to a condo
  const condoBindExecute = createCondoBindExecutor(store);

  api.registerTool(
    (ctx) => {
      if (!ctx.sessionKey) return null;
      const data = store.load();
      // Only offer if NOT already bound to a condo AND condos exist (or allow creation)
      if (data.sessionCondoIndex[ctx.sessionKey]) return null;

      return {
        name: 'condo_bind',
        label: 'Bind Session to Condo',
        description: 'Bind this session to a condo (project). Provide condoId to bind to an existing condo, or name to create a new one.',
        parameters: {
          type: 'object',
          properties: {
            condoId: { type: 'string', description: 'ID of an existing condo to bind to' },
            name: { type: 'string', description: 'Name for a new condo to create and bind to' },
            description: { type: 'string', description: 'Description for the new condo (only used with name)' },
          },
        },
        async execute(toolCallId, params) {
          return condoBindExecute(toolCallId, { ...params, sessionKey: ctx.sessionKey });
        },
      };
    },
    { names: ['condo_bind'] }
  );

  // Tool: condo_create_goal for agents to create goals in their bound condo
  const condoCreateGoalExecute = createCondoCreateGoalExecutor(store);

  api.registerTool(
    (ctx) => {
      if (!ctx.sessionKey) return null;
      const data = store.load();
      if (!data.sessionCondoIndex[ctx.sessionKey]) return null;

      return {
        name: 'condo_create_goal',
        label: 'Create Goal in Condo',
        description: 'Create a new goal in the bound condo, optionally with initial tasks.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Goal title' },
            description: { type: 'string', description: 'Goal description' },
            priority: { type: 'string', description: 'Priority (e.g. P0, P1, P2)' },
            tasks: {
              type: 'array',
              description: 'Initial tasks (strings or {text, description, priority} objects)',
              items: {
                oneOf: [
                  { type: 'string' },
                  { type: 'object', properties: { text: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string' } } },
                ],
              },
            },
          },
          required: ['title'],
        },
        async execute(toolCallId, params) {
          return condoCreateGoalExecute(toolCallId, { ...params, sessionKey: ctx.sessionKey });
        },
      };
    },
    { names: ['condo_create_goal'] }
  );

  // Tool: condo_add_task for agents to add tasks to goals in their bound condo
  const condoAddTaskExecute = createCondoAddTaskExecutor(store);

  api.registerTool(
    (ctx) => {
      if (!ctx.sessionKey) return null;
      const data = store.load();
      if (!data.sessionCondoIndex[ctx.sessionKey]) return null;

      return {
        name: 'condo_add_task',
        label: 'Add Task to Goal',
        description: 'Add a task to a goal in the bound condo.',
        parameters: {
          type: 'object',
          properties: {
            goalId: { type: 'string', description: 'ID of the goal to add the task to' },
            text: { type: 'string', description: 'Task description' },
            description: { type: 'string', description: 'Detailed task description' },
            priority: { type: 'string', description: 'Priority (e.g. P0, P1, P2)' },
          },
          required: ['goalId', 'text'],
        },
        async execute(toolCallId, params) {
          return condoAddTaskExecute(toolCallId, { ...params, sessionKey: ctx.sessionKey });
        },
      };
    },
    { names: ['condo_add_task'] }
  );

  // Tool: condo_spawn_task for agents to spawn subagent sessions for tasks
  const condoSpawnTaskExecute = createCondoSpawnTaskExecutor(store);

  api.registerTool(
    (ctx) => {
      if (!ctx.sessionKey) return null;
      const data = store.load();
      if (!data.sessionCondoIndex[ctx.sessionKey]) return null;

      return {
        name: 'condo_spawn_task',
        label: 'Spawn Task Subagent',
        description: 'Spawn a subagent session to work on a specific task in the bound condo.',
        parameters: {
          type: 'object',
          properties: {
            goalId: { type: 'string', description: 'ID of the goal containing the task' },
            taskId: { type: 'string', description: 'ID of the task to assign to the subagent' },
            agentId: { type: 'string', description: 'Agent ID (default: main)' },
            model: { type: 'string', description: 'Model to use for the subagent' },
          },
          required: ['goalId', 'taskId'],
        },
        async execute(toolCallId, params) {
          return condoSpawnTaskExecute(toolCallId, { ...params, sessionKey: ctx.sessionKey });
        },
      };
    },
    { names: ['condo_spawn_task'] }
  );

  const totalMethods = Object.keys(handlers).length + Object.keys(condoHandlers).length + 1;
  api.logger.info(`clawcondos-goals: registered ${totalMethods} gateway methods, 5 tools, data at ${dataDir}`);
}
