/**
 * Plan RPC Handlers - Gateway methods for plan management
 */

import { readPlanFile, parsePlanMarkdown, createEmptyPlan, computePlanStatus, createPlanLogBuffer } from './plan-manager.js';
import { createNotification } from './notification-manager.js';

// Singleton plan log buffer for all sessions
const planLogBuffer = createPlanLogBuffer(100);

/**
 * Get the plan log buffer instance
 * @returns {object} Plan log buffer
 */
export function getPlanLogBuffer() {
  return planLogBuffer;
}

/**
 * Create plan RPC handlers
 * @param {object} store - Goals store instance
 * @param {object} [options] - Options
 * @param {function} [options.broadcastPlanUpdate] - Function to broadcast plan updates via WebSocket
 * @param {function} [options.sendToSession] - Function to send message to a specific session
 * @returns {object} Map of method names to handlers
 */
export function createPlanHandlers(store, options = {}) {
  const { broadcastPlanUpdate, sendToSession } = options;
  const handlers = {};

  /**
   * plans.get - Get plan for a task
   * Params: { goalId: string, taskId: string }
   * Response: { plan: object | null }
   */
  handlers['plans.get'] = ({ params, respond }) => {
    const { goalId, taskId } = params || {};

    if (!goalId || !taskId) {
      return respond(false, null, 'goalId and taskId are required');
    }

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);

      if (!goal) {
        return respond(false, null, `Goal ${goalId} not found`);
      }

      const task = (goal.tasks || []).find(t => t.id === taskId);

      if (!task) {
        return respond(false, null, `Task ${taskId} not found in goal`);
      }

      // Return the plan or an empty plan structure
      const plan = task.plan || createEmptyPlan();

      respond(true, { plan, goalId, taskId });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * plans.syncFromFile - Read a plan file and sync to task
   * Params: { goalId: string, taskId: string, filePath: string, basePath?: string }
   * Response: { plan: object, synced: boolean }
   */
  handlers['plans.syncFromFile'] = ({ params, respond }) => {
    const { goalId, taskId, filePath, basePath } = params || {};

    if (!goalId || !taskId || !filePath) {
      return respond(false, null, 'goalId, taskId, and filePath are required');
    }

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);

      if (!goal) {
        return respond(false, null, `Goal ${goalId} not found`);
      }

      const task = (goal.tasks || []).find(t => t.id === taskId);

      if (!task) {
        return respond(false, null, `Task ${taskId} not found in goal`);
      }

      // Read and parse the plan file
      const result = readPlanFile(filePath, basePath);

      if (!result.success) {
        return respond(false, null, result.error);
      }

      // Initialize or update the plan
      const existingPlan = task.plan || createEmptyPlan();
      const now = Date.now();

      task.plan = {
        ...existingPlan,
        status: existingPlan.status === 'none' ? 'draft' : existingPlan.status,
        filePath: result.filePath,
        content: result.content,
        steps: result.steps.map((step, idx) => {
          // Preserve existing step status if step titles match
          const existing = existingPlan.steps?.find(s => s.title === step.title);
          return existing ? { ...step, ...existing, index: idx } : step;
        }),
        updatedAtMs: now,
      };

      // Recompute status based on steps
      task.plan.status = computePlanStatus(task.plan);
      task.updatedAtMs = now;
      goal.updatedAtMs = now;

      store.save(data);

      respond(true, { plan: task.plan, synced: true });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * plans.updateStatus - Update plan status directly
   * Params: { goalId: string, taskId: string, status: string, feedback?: string }
   * Response: { plan: object }
   */
  handlers['plans.updateStatus'] = ({ params, respond }) => {
    const { goalId, taskId, status, feedback } = params || {};
    const validStatuses = ['none', 'draft', 'awaiting_approval', 'approved', 'rejected', 'executing', 'completed'];

    if (!goalId || !taskId) {
      return respond(false, null, 'goalId and taskId are required');
    }

    if (!status || !validStatuses.includes(status)) {
      return respond(false, null, `status must be one of: ${validStatuses.join(', ')}`);
    }

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);

      if (!goal) {
        return respond(false, null, `Goal ${goalId} not found`);
      }

      const task = (goal.tasks || []).find(t => t.id === taskId);

      if (!task) {
        return respond(false, null, `Task ${taskId} not found in goal`);
      }

      // Initialize plan if needed
      if (!task.plan) {
        task.plan = createEmptyPlan();
      }

      const now = Date.now();
      task.plan.status = status;
      task.plan.updatedAtMs = now;

      // Track approval/rejection timestamps
      if (status === 'approved') {
        task.plan.approvedAtMs = now;
      } else if (status === 'rejected') {
        task.plan.rejectedAtMs = now;
        if (feedback) {
          task.plan.feedback = feedback;
        }
      }

      task.updatedAtMs = now;
      goal.updatedAtMs = now;

      store.save(data);

      respond(true, { plan: task.plan });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * plans.updateStep - Update a specific step in the plan
   * Params: { goalId: string, taskId: string, stepIndex: number, status: string }
   * Response: { plan: object, step: object }
   */
  handlers['plans.updateStep'] = ({ params, respond }) => {
    const { goalId, taskId, stepIndex, status } = params || {};
    const validStepStatuses = ['pending', 'in-progress', 'done', 'skipped'];

    if (!goalId || !taskId || stepIndex === undefined) {
      return respond(false, null, 'goalId, taskId, and stepIndex are required');
    }

    if (!status || !validStepStatuses.includes(status)) {
      return respond(false, null, `status must be one of: ${validStepStatuses.join(', ')}`);
    }

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);

      if (!goal) {
        return respond(false, null, `Goal ${goalId} not found`);
      }

      const task = (goal.tasks || []).find(t => t.id === taskId);

      if (!task) {
        return respond(false, null, `Task ${taskId} not found in goal`);
      }

      if (!task.plan || !task.plan.steps) {
        return respond(false, null, 'Task has no plan with steps');
      }

      const step = task.plan.steps.find(s => s.index === stepIndex);

      if (!step) {
        return respond(false, null, `Step ${stepIndex} not found in plan`);
      }

      const now = Date.now();
      step.status = status;

      if (status === 'in-progress' && !step.startedAtMs) {
        step.startedAtMs = now;
      } else if (status === 'done' || status === 'skipped') {
        step.completedAtMs = now;
      }

      // Recompute overall plan status
      task.plan.status = computePlanStatus(task.plan);
      task.plan.updatedAtMs = now;
      task.updatedAtMs = now;
      goal.updatedAtMs = now;

      store.save(data);

      // Broadcast step update
      if (broadcastPlanUpdate) {
        broadcastPlanUpdate({
          event: 'plan.step_updated',
          goalId,
          taskId,
          stepIndex,
          status,
          plan: task.plan,
        });
      }

      respond(true, { plan: task.plan, step });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * plans.approve - Approve a plan and notify the agent session
   * Params: { goalId: string, taskId: string, comment?: string }
   * Response: { plan: object, notified: boolean }
   */
  handlers['plans.approve'] = ({ params, respond }) => {
    const { goalId, taskId, comment } = params || {};

    if (!goalId || !taskId) {
      return respond(false, null, 'goalId and taskId are required');
    }

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);

      if (!goal) {
        return respond(false, null, `Goal ${goalId} not found`);
      }

      const task = (goal.tasks || []).find(t => t.id === taskId);

      if (!task) {
        return respond(false, null, `Task ${taskId} not found in goal`);
      }

      if (!task.plan) {
        return respond(false, null, 'Task has no plan to approve');
      }

      if (task.plan.status !== 'awaiting_approval' && task.plan.status !== 'draft') {
        return respond(false, null, `Plan status is '${task.plan.status}', expected 'awaiting_approval' or 'draft'`);
      }

      const now = Date.now();
      task.plan.status = 'approved';
      task.plan.approvedAtMs = now;
      task.plan.updatedAtMs = now;
      if (comment) {
        task.plan.approvalComment = comment;
      }

      task.updatedAtMs = now;
      goal.updatedAtMs = now;

      store.save(data);

      // Create notification
      createNotification(store, {
        type: 'plan_approved',
        goalId,
        taskId,
        sessionKey: task.sessionKey,
        title: `Plan approved: ${task.text}`,
        detail: comment || 'Your plan has been approved. You may proceed with execution.',
      });

      // Log to plan buffer
      if (task.sessionKey) {
        planLogBuffer.append(task.sessionKey, {
          type: 'approval',
          message: 'Plan approved',
          comment: comment || null,
        });
      }

      // Send approval message to agent session
      let notified = false;
      if (sendToSession && task.sessionKey) {
        try {
          sendToSession(task.sessionKey, {
            type: 'plan_approved',
            goalId,
            taskId,
            comment: comment || null,
            message: '✅ Your plan has been approved! You may proceed with execution.',
          });
          notified = true;
        } catch (err) {
          // Log but don't fail the approval
          console.error(`Failed to notify session ${task.sessionKey}:`, err.message);
        }
      }

      // Broadcast update
      if (broadcastPlanUpdate) {
        broadcastPlanUpdate({
          event: 'plan.approved',
          goalId,
          taskId,
          plan: task.plan,
        });
      }

      respond(true, { plan: task.plan, notified });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * plans.reject - Reject a plan with feedback and notify the agent session
   * Params: { goalId: string, taskId: string, feedback: string }
   * Response: { plan: object, notified: boolean }
   */
  handlers['plans.reject'] = ({ params, respond }) => {
    const { goalId, taskId, feedback } = params || {};

    if (!goalId || !taskId) {
      return respond(false, null, 'goalId and taskId are required');
    }

    if (!feedback || typeof feedback !== 'string' || feedback.trim().length === 0) {
      return respond(false, null, 'feedback is required when rejecting a plan');
    }

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);

      if (!goal) {
        return respond(false, null, `Goal ${goalId} not found`);
      }

      const task = (goal.tasks || []).find(t => t.id === taskId);

      if (!task) {
        return respond(false, null, `Task ${taskId} not found in goal`);
      }

      if (!task.plan) {
        return respond(false, null, 'Task has no plan to reject');
      }

      if (task.plan.status !== 'awaiting_approval' && task.plan.status !== 'draft') {
        return respond(false, null, `Plan status is '${task.plan.status}', expected 'awaiting_approval' or 'draft'`);
      }

      const now = Date.now();
      task.plan.status = 'rejected';
      task.plan.rejectedAtMs = now;
      task.plan.feedback = feedback.trim();
      task.plan.updatedAtMs = now;

      task.updatedAtMs = now;
      goal.updatedAtMs = now;

      store.save(data);

      // Create notification
      createNotification(store, {
        type: 'plan_rejected',
        goalId,
        taskId,
        sessionKey: task.sessionKey,
        title: `Plan needs revision: ${task.text}`,
        detail: feedback.trim(),
      });

      // Log to plan buffer
      if (task.sessionKey) {
        planLogBuffer.append(task.sessionKey, {
          type: 'rejection',
          message: 'Plan rejected',
          feedback: feedback.trim(),
        });
      }

      // Send rejection message to agent session
      let notified = false;
      if (sendToSession && task.sessionKey) {
        try {
          sendToSession(task.sessionKey, {
            type: 'plan_rejected',
            goalId,
            taskId,
            feedback: feedback.trim(),
            message: `❌ Your plan has been rejected. Please revise based on feedback:\n\n${feedback.trim()}`,
          });
          notified = true;
        } catch (err) {
          // Log but don't fail the rejection
          console.error(`Failed to notify session ${task.sessionKey}:`, err.message);
        }
      }

      // Broadcast update
      if (broadcastPlanUpdate) {
        broadcastPlanUpdate({
          event: 'plan.rejected',
          goalId,
          taskId,
          feedback: feedback.trim(),
          plan: task.plan,
        });
      }

      respond(true, { plan: task.plan, notified });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * plans.getLogs - Get plan execution logs for a session
   * Params: { sessionKey: string, limit?: number }
   * Response: { logs: array, sessionKey: string }
   */
  handlers['plans.getLogs'] = ({ params, respond }) => {
    const { sessionKey, limit } = params || {};

    if (!sessionKey) {
      return respond(false, null, 'sessionKey is required');
    }

    try {
      const logs = planLogBuffer.get(sessionKey, limit);
      respond(true, { logs, sessionKey });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * plans.appendLog - Append a log entry for a session
   * Params: { sessionKey: string, type: string, message: string, stepIndex?: number, metadata?: object }
   * Response: { success: boolean }
   */
  handlers['plans.appendLog'] = ({ params, respond }) => {
    const { sessionKey, type, message, stepIndex, metadata } = params || {};

    if (!sessionKey || !type || !message) {
      return respond(false, null, 'sessionKey, type, and message are required');
    }

    try {
      planLogBuffer.append(sessionKey, {
        type,
        message,
        stepIndex: stepIndex !== undefined ? stepIndex : null,
        metadata: metadata || null,
      });

      // Broadcast log update
      if (broadcastPlanUpdate) {
        broadcastPlanUpdate({
          event: 'plan.log',
          sessionKey,
          entry: {
            type,
            message,
            stepIndex: stepIndex !== undefined ? stepIndex : null,
            timestamp: Date.now(),
          },
        });
      }

      respond(true, { success: true });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  return handlers;
}
