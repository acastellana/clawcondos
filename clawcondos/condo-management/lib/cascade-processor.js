/**
 * Cascade Processor — auto-processes a PM's plan response for a goal.
 * Extracted helper used by the agent_end hook when a PM session completes
 * during a cascade flow, enabling backend-first cascade without frontend.
 */

import { parseTasksFromPlan, detectPlan } from './plan-parser.js';

/**
 * Set sequential dependencies on an array of tasks.
 * Each task (after the first) depends on the previous task.
 * @param {Array} tasks - Array of task objects with `id` property
 */
function setSequentialDependencies(tasks) {
  for (let i = 1; i < tasks.length; i++) {
    tasks[i].dependsOn = [tasks[i - 1].id];
  }
}

/**
 * Process a PM's cascade response for a goal.
 * Saves the response to pmChatHistory, detects plans, and optionally creates tasks.
 *
 * @param {object} store - Goals store instance
 * @param {object} goal - Goal object (from store data — caller must save after)
 * @param {string} pmResponseContent - The PM's response text
 * @param {object} [options]
 * @param {string} [options.mode] - 'plan' or 'full' (default: goal.cascadeMode || 'plan')
 * @returns {{ hasPlan: boolean, tasksCreated: number, cascadeState: string, createdTasks: Array }}
 */
export function processPmCascadeResponse(store, goal, pmResponseContent, options = {}) {
  const mode = options.mode || goal.cascadeMode || 'plan';
  const content = (pmResponseContent || '').trim();

  if (!content) {
    return { hasPlan: false, tasksCreated: 0, cascadeState: 'response_saved', createdTasks: [] };
  }

  // Save PM response to goal's pmChatHistory
  if (!Array.isArray(goal.pmChatHistory)) {
    goal.pmChatHistory = [];
  }
  goal.pmChatHistory.push({
    role: 'assistant',
    content,
    timestamp: Date.now(),
  });

  // Detect if the response contains a plan
  const hasPlan = detectPlan(content);

  if (!hasPlan || mode === 'plan') {
    // Plan mode or no plan detected — save response, let user review
    goal.cascadeState = hasPlan ? 'plan_ready' : 'response_saved';
    goal.updatedAtMs = Date.now();
    return { hasPlan, tasksCreated: 0, cascadeState: goal.cascadeState, createdTasks: [] };
  }

  // Full mode with plan detected — parse tasks and create them
  const { tasks: parsedTasks } = parseTasksFromPlan(content);

  if (parsedTasks.length === 0) {
    // Plan detected but no parseable tasks
    goal.cascadeState = 'plan_parse_failed';
    goal.updatedAtMs = Date.now();
    return { hasPlan: true, tasksCreated: 0, cascadeState: 'plan_parse_failed', createdTasks: [] };
  }

  // Create task objects on the goal
  const now = Date.now();
  const createdTasks = [];

  for (const taskData of parsedTasks) {
    const task = {
      id: store.newId('task'),
      text: taskData.text,
      description: taskData.description || '',
      status: 'pending',
      done: false,
      priority: null,
      sessionKey: null,
      assignedAgent: taskData.agent || null,
      model: null,
      dependsOn: [],
      summary: '',
      estimatedTime: taskData.time || null,
      createdAtMs: now,
      updatedAtMs: now,
    };

    goal.tasks.push(task);
    createdTasks.push(task);
  }

  // Set sequential dependencies
  setSequentialDependencies(createdTasks);

  // Store the full plan content
  goal.pmPlanContent = content;
  goal.cascadeState = 'tasks_created';
  goal.updatedAtMs = now;

  return {
    hasPlan: true,
    tasksCreated: createdTasks.length,
    cascadeState: 'tasks_created',
    createdTasks,
  };
}
