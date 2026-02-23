import { readPlanFile, createEmptyPlan, computePlanStatus } from './plan-manager.js';

export function createGoalUpdateExecutor(store) {
  const error = (text) => ({ content: [{ type: 'text', text: `Error: ${text}` }] });

  return async function execute(toolCallId, params) {
    const { sessionKey, goalId, taskId, status, summary, addTasks, nextTask, goalStatus, notes, files, planFile, planStatus, stepIndex, stepStatus } = params;

    // Require at least one actionable param.
    const hasTaskUpdate = taskId && status;
    const hasAddTasks = Array.isArray(addTasks) && addTasks.length > 0;
    const hasNextTask = typeof nextTask === 'string';
    const hasGoalStatus = typeof goalStatus === 'string';
    const hasNotes = typeof notes === 'string' && notes.trim();
    const hasFiles = Array.isArray(files) && files.length > 0;
    const hasPlanFile = typeof planFile === 'string' && planFile.trim();
    const hasPlanStatus = typeof planStatus === 'string' && planStatus.trim();
    const hasStepUpdate = typeof stepIndex === 'number' && typeof stepStatus === 'string';
    if (!hasTaskUpdate && !hasAddTasks && !hasNextTask && !hasGoalStatus && !hasNotes && !hasFiles && !hasPlanFile && !hasPlanStatus && !hasStepUpdate) {
      return error('provide at least one of: taskId+status, addTasks, nextTask, goalStatus, notes, files, planFile, planStatus, stepIndex+stepStatus.');
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
      // UI stages: backlog, blocked, doing, review, done
      if (status === 'done') {
        task.stage = 'done';
      } else if (status === 'in-progress') {
        task.stage = 'doing';  // UI uses 'doing' not 'in-progress'
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
          stage: 'backlog',  // Default stage for new tasks
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

    // ── Plan file sync ──
    if (hasPlanFile && taskId) {
      const task = (goal.tasks || []).find(t => t.id === taskId);
      if (task) {
        const planResult = readPlanFile(planFile.trim());
        if (planResult.success) {
          const existingPlan = task.plan || createEmptyPlan();
          const now = Date.now();
          task.plan = {
            ...existingPlan,
            status: existingPlan.status === 'none' ? 'draft' : existingPlan.status,
            filePath: planResult.filePath,
            content: planResult.content,
            steps: planResult.steps.map((step, idx) => {
              // Preserve existing step status if step titles match
              const existing = existingPlan.steps?.find(s => s.title === step.title);
              return existing ? { ...step, ...existing, index: idx } : step;
            }),
            updatedAtMs: now,
          };
          task.plan.status = computePlanStatus(task.plan);
          task.updatedAtMs = now;
          results.push(`plan synced from ${planFile}`);
        } else {
          results.push(`plan sync failed: ${planResult.error}`);
        }
      }
    }

    // ── Plan status update ──
    if (hasPlanStatus && taskId) {
      const validPlanStatuses = ['none', 'draft', 'awaiting_approval', 'approved', 'rejected', 'executing', 'completed'];
      const task = (goal.tasks || []).find(t => t.id === taskId);
      if (task) {
        if (!validPlanStatuses.includes(planStatus)) {
          return error(`planStatus must be one of: ${validPlanStatuses.join(', ')}`);
        }
        if (!task.plan) {
          task.plan = createEmptyPlan();
        }
        const now = Date.now();
        task.plan.status = planStatus;
        task.plan.updatedAtMs = now;
        if (planStatus === 'approved') {
          task.plan.approvedAtMs = now;
        } else if (planStatus === 'rejected') {
          task.plan.rejectedAtMs = now;
        }
        task.updatedAtMs = now;
        results.push(`plan status → ${planStatus}`);
      }
    }

    // ── Plan step update ──
    if (hasStepUpdate && taskId) {
      const validStepStatuses = ['pending', 'in-progress', 'done', 'skipped'];
      if (!validStepStatuses.includes(stepStatus)) {
        return error(`stepStatus must be one of: ${validStepStatuses.join(', ')}`);
      }
      const task = (goal.tasks || []).find(t => t.id === taskId);
      if (!task) {
        return error(`task ${taskId} not found in goal.`);
      }
      if (!task.plan || !task.plan.steps || !task.plan.steps[stepIndex]) {
        return error(`step ${stepIndex} not found in task plan (${task.plan?.steps?.length || 0} steps available).`);
      }
      const step = task.plan.steps[stepIndex];
      const now = Date.now();
      step.status = stepStatus;
      if (stepStatus === 'in-progress' && !step.startedAtMs) {
        step.startedAtMs = now;
      } else if (stepStatus === 'done' || stepStatus === 'skipped') {
        step.completedAtMs = now;
      }
      task.plan.updatedAtMs = now;
      task.plan.status = computePlanStatus(task.plan);
      task.updatedAtMs = now;
      results.push(`step ${stepIndex} → ${stepStatus}`);
    }

    goal.updatedAtMs = Date.now();
    store.save(data);

    const remaining = (goal.tasks || []).filter(t => !t.done).length;
    const countSuffix = remaining > 0
      ? ` (${remaining} task${remaining !== 1 ? 's' : ''} remaining)`
      : ' (all tasks done)';

    // Build _meta for task completion events (consumed by index.js wrapper)
    const _meta = {
      goalId: goal.id,
    };
    if (hasTaskUpdate && status === 'done' && taskId) {
      _meta.taskCompletedId = taskId;
      _meta.allTasksDone = remaining === 0;
    }

    return {
      content: [{ type: 'text', text: `Goal "${goal.title}" updated: ${results.join(', ')}.${countSuffix}` }],
      _meta,
    };
  };
}
