/**
 * Autonomy Manager - Handles autonomy modes for tasks and condos
 * 
 * Autonomy Modes:
 * - 'full': Agent can execute without approval
 * - 'plan': Agent must get plan approved before execution
 * - 'step': Agent must get each step approved
 * - 'supervised': Agent pauses after each action for review
 */

/**
 * Valid autonomy modes
 */
export const AUTONOMY_MODES = ['full', 'plan', 'step', 'supervised'];

/**
 * Default autonomy mode if none specified
 */
export const DEFAULT_AUTONOMY_MODE = 'plan';

/**
 * Resolve the effective autonomy mode for a task
 * Resolution chain: task > goal > condo > default('plan')
 * @param {object} task - Task object
 * @param {object} [goal] - Goal object (optional)
 * @param {object} [condo] - Condo object (optional)
 * @returns {string} Effective autonomy mode
 */
export function resolveAutonomyMode(task, goal, condo) {
  // Task-level override takes precedence
  if (task?.autonomyMode && AUTONOMY_MODES.includes(task.autonomyMode)) {
    return task.autonomyMode;
  }

  // Fall back to goal-level setting
  if (goal?.autonomyMode && AUTONOMY_MODES.includes(goal.autonomyMode)) {
    return goal.autonomyMode;
  }

  // Fall back to condo-level setting
  if (condo?.autonomyMode && AUTONOMY_MODES.includes(condo.autonomyMode)) {
    return condo.autonomyMode;
  }

  // Default to 'plan' mode
  return DEFAULT_AUTONOMY_MODE;
}

/**
 * Build a directive string for the agent based on autonomy mode
 * @param {string} mode - Autonomy mode
 * @returns {string} Directive for agent context
 */
export function buildAutonomyDirective(mode) {
  switch (mode) {
    case 'full':
      return `**Autonomy: Full** — You have full autonomy. Execute the task without waiting for approval. Use your best judgment.`;
    
    case 'plan':
      return `**⚠️ Autonomy: Plan Approval Required ⚠️**\n` +
        `STOP — Do NOT execute any code or make any changes yet.\n` +
        `1. First, read your assignment and create a detailed plan in your PLAN.md file\n` +
        `2. Call \`goal_update\` with \`planStatus="awaiting_approval"\` to submit for review\n` +
        `3. WAIT for the PM to approve or provide feedback\n` +
        `4. Only after approval: call \`goal_update\` with \`planStatus="executing"\` and proceed\n` +
        `Do not execute significant actions until the plan is explicitly approved.`;
    
    case 'step':
      return `**Autonomy: Step-by-Step Approval** — Create a plan and get it approved. After approval, for EACH step:\n` +
        `1. Call \`goal_update({ taskId: "<taskId>", stepIndex: <N>, stepStatus: "in-progress" })\` before starting\n` +
        `2. Complete the step\n` +
        `3. Call \`goal_update({ taskId: "<taskId>", stepIndex: <N>, stepStatus: "done" })\` when finished\n` +
        `4. Wait for confirmation before proceeding to the next step if it involves significant changes.`;
    
    case 'supervised':
      return `**Autonomy: Supervised Mode** — This task requires close supervision. Before each action (file write, command execution, external API call), describe what you're about to do and wait for explicit approval. Create a plan first and get it approved.`;
    
    default:
      return buildAutonomyDirective(DEFAULT_AUTONOMY_MODE);
  }
}

/**
 * Set autonomy mode for a specific task
 * @param {object} store - Goals store instance
 * @param {string} goalId - Goal ID
 * @param {string} taskId - Task ID
 * @param {string} mode - Autonomy mode to set
 * @returns {{ success: boolean, error?: string, task?: object }}
 */
export function setTaskAutonomy(store, goalId, taskId, mode) {
  if (!AUTONOMY_MODES.includes(mode)) {
    return { success: false, error: `Invalid mode. Must be one of: ${AUTONOMY_MODES.join(', ')}` };
  }
  
  const data = store.load();
  const goal = data.goals.find(g => g.id === goalId);
  
  if (!goal) {
    return { success: false, error: `Goal ${goalId} not found` };
  }
  
  const task = (goal.tasks || []).find(t => t.id === taskId);
  
  if (!task) {
    return { success: false, error: `Task ${taskId} not found in goal` };
  }
  
  const now = Date.now();
  task.autonomyMode = mode;
  task.updatedAtMs = now;
  goal.updatedAtMs = now;
  
  store.save(data);
  
  return { success: true, task };
}

/**
 * Set default autonomy mode for a condo
 * @param {object} store - Goals store instance
 * @param {string} condoId - Condo ID
 * @param {string} mode - Autonomy mode to set
 * @returns {{ success: boolean, error?: string, condo?: object }}
 */
export function setCondoAutonomy(store, condoId, mode) {
  if (!AUTONOMY_MODES.includes(mode)) {
    return { success: false, error: `Invalid mode. Must be one of: ${AUTONOMY_MODES.join(', ')}` };
  }
  
  const data = store.load();
  const condo = data.condos.find(c => c.id === condoId);
  
  if (!condo) {
    return { success: false, error: `Condo ${condoId} not found` };
  }
  
  condo.autonomyMode = mode;
  condo.updatedAtMs = Date.now();
  
  store.save(data);
  
  return { success: true, condo };
}

/**
 * Get autonomy info for a task (including resolved mode)
 * @param {object} store - Goals store instance
 * @param {string} goalId - Goal ID
 * @param {string} taskId - Task ID
 * @returns {{ success: boolean, mode?: string, directive?: string, taskMode?: string, goalMode?: string, condoMode?: string, error?: string }}
 */
export function getTaskAutonomyInfo(store, goalId, taskId) {
  const data = store.load();
  const goal = data.goals.find(g => g.id === goalId);

  if (!goal) {
    return { success: false, error: `Goal ${goalId} not found` };
  }

  const task = (goal.tasks || []).find(t => t.id === taskId);

  if (!task) {
    return { success: false, error: `Task ${taskId} not found in goal` };
  }

  let condo = null;
  if (goal.condoId) {
    condo = data.condos.find(c => c.id === goal.condoId);
  }

  const mode = resolveAutonomyMode(task, goal, condo);
  const directive = buildAutonomyDirective(mode);

  return {
    success: true,
    mode,
    directive,
    taskMode: task.autonomyMode || null,
    goalMode: goal.autonomyMode || null,
    condoMode: condo?.autonomyMode || null,
  };
}

/**
 * Create autonomy RPC handlers
 * @param {object} store - Goals store instance
 * @returns {object} Map of method names to handlers
 */
export function createAutonomyHandlers(store) {
  const handlers = {};
  
  handlers['autonomy.getTaskInfo'] = ({ params, respond }) => {
    const { goalId, taskId } = params || {};
    
    if (!goalId || !taskId) {
      return respond(false, null, 'goalId and taskId are required');
    }
    
    const result = getTaskAutonomyInfo(store, goalId, taskId);
    
    if (!result.success) {
      return respond(false, null, result.error);
    }
    
    respond(true, result);
  };
  
  handlers['autonomy.setTask'] = ({ params, respond }) => {
    const { goalId, taskId, mode } = params || {};
    
    if (!goalId || !taskId || !mode) {
      return respond(false, null, 'goalId, taskId, and mode are required');
    }
    
    const result = setTaskAutonomy(store, goalId, taskId, mode);
    
    if (!result.success) {
      return respond(false, null, result.error);
    }
    
    respond(true, { task: result.task, mode });
  };
  
  handlers['autonomy.setCondo'] = ({ params, respond }) => {
    const { condoId, mode } = params || {};
    
    if (!condoId || !mode) {
      return respond(false, null, 'condoId and mode are required');
    }
    
    const result = setCondoAutonomy(store, condoId, mode);
    
    if (!result.success) {
      return respond(false, null, result.error);
    }
    
    respond(true, { condo: result.condo, mode });
  };
  
  handlers['autonomy.modes'] = ({ respond }) => {
    respond(true, {
      modes: AUTONOMY_MODES,
      default: DEFAULT_AUTONOMY_MODE,
      descriptions: {
        full: 'Full autonomy - execute without approval',
        plan: 'Plan approval required before execution',
        step: 'Step-by-step approval after plan approval',
        supervised: 'Close supervision - approve each action',
      },
    });
  };
  
  return handlers;
}
