import { pushBranch } from './github.js';

export function createGoalHandlers(store, options = {}) {
  const { wsOps, logger, rpcCall } = options;
  function loadData() { return store.load(); }
  function saveData(data) { store.save(data); }

  return {
    'goals.list': ({ params, respond }) => {
      try {
        const data = loadData();
        respond(true, { goals: data.goals });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.create': ({ params, respond }) => {
      try {
        const { title, condoId, description, completed, status, priority, deadline, notes, tasks, autonomyMode } = params;
        if (!title || typeof title !== 'string' || !title.trim()) {
          respond(false, undefined, { message: 'title is required' });
          return;
        }
        const data = loadData();
        const now = Date.now();
        const isCompleted = completed === true || status === 'done';
        const goalId = store.newId('goal');
        const goal = {
          id: goalId,
          title: title.trim(),
          description: description || notes || '',
          notes: notes || '',
          status: isCompleted ? 'done' : 'active',
          completed: isCompleted,
          condoId: condoId || null,
          priority: priority || null,
          deadline: deadline || null,
          autonomyMode: autonomyMode || null,
          worktree: null,
          tasks: [],
          sessions: [],
          createdAtMs: now,
          updatedAtMs: now,
        };

        // Create worktree if parent condo has a workspace
        if (wsOps && condoId) {
          const condo = data.condos.find(c => c.id === condoId);
          if (condo?.workspace?.path) {
            const wtResult = wsOps.createGoalWorktree(condo.workspace.path, goalId, title.trim());
            if (wtResult.ok) {
              goal.worktree = { path: wtResult.path, branch: wtResult.branch, createdAtMs: now };

              // Auto-push new branch to GitHub if remote is configured (best-effort)
              if (condo.workspace.repoUrl) {
                try {
                  const pushResult = pushBranch(condo.workspace.path, wtResult.branch, { setUpstream: true });
                  if (!pushResult.ok && logger) {
                    logger.warn(`clawcondos-goals: goals.create: failed to push branch ${wtResult.branch}: ${pushResult.error}`);
                    goal.pushError = pushResult.error;
                    goal.pushStatus = 'failed';
                  } else if (pushResult.ok) {
                    goal.pushStatus = 'pushed';
                  }
                } catch { /* best-effort */ }
              }
            } else if (logger) {
              logger.error(`clawcondos-goals: worktree creation failed for goal ${goalId}: ${wtResult.error}`);
            }
          }
        }

        data.goals.unshift(goal);
        saveData(data);
        respond(true, { goal });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.get': ({ params, respond }) => {
      try {
        const data = loadData();
        const goal = data.goals.find(g => g.id === params.id);
        if (!goal) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        respond(true, { goal });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.update': ({ params, respond }) => {
      try {
        const data = loadData();
        const idx = data.goals.findIndex(g => g.id === params.id);
        if (idx === -1) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        const goal = data.goals[idx];

        // Validate title if provided
        if ('title' in params) {
          if (typeof params.title !== 'string' || !params.title.trim()) {
            respond(false, undefined, { message: 'title must be a non-empty string' });
            return;
          }
          // Reject titles that are just numbers — these come from auto-patch
          // misinterpreting numbered goal lists in agent context.
          if (/^\d+$/.test(params.title.trim())) {
            respond(false, undefined, { message: 'title cannot be a bare number' });
            return;
          }
        }

        // Whitelist allowed patch fields (prevent overwriting internal fields)
        const allowed = ['title', 'description', 'status', 'completed', 'condoId', 'priority', 'deadline', 'notes', 'tasks', 'nextTask', 'dropped', 'droppedAtMs', 'files', 'plan', 'autonomyMode', 'phase', 'dependsOn', 'closedAtMs'];
        for (const f of allowed) {
          if (f in params) goal[f] = params[f];
        }
        if (typeof goal.title === 'string') goal.title = goal.title.trim();
        goal.updatedAtMs = Date.now();

        // Sync completed/status
        if ('status' in params) {
          goal.completed = goal.status === 'done';
        } else if ('completed' in params) {
          goal.status = goal.completed ? 'done' : 'active';
        }

        saveData(data);
        respond(true, { goal });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.delete': async ({ params, respond }) => {
      try {
        const data = loadData();
        const idx = data.goals.findIndex(g => g.id === params.id);
        if (idx === -1) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        const deletedGoal = data.goals[idx];

        // Collect ALL sessions for this goal (for abort + frontend cleanup)
        const sessionKeys = new Set([
          ...(deletedGoal.sessions || []),
          ...(deletedGoal.tasks || []).filter(t => t.sessionKey).map(t => t.sessionKey),
        ]);
        // Include goal PM session
        if (deletedGoal.pmSessionKey) sessionKeys.add(deletedGoal.pmSessionKey);

        // Kill running sessions (best-effort) — try delete first, then abort
        if (rpcCall) {
          for (const sk of sessionKeys) {
            try { await rpcCall('sessions.delete', { sessionKey: sk }); } catch { /* may not exist */ }
            try { await rpcCall('chat.abort', { sessionKey: sk }); } catch { /* best-effort */ }
          }
        }

        // Remove worktree if it exists
        if (wsOps && deletedGoal.worktree?.path && deletedGoal.condoId) {
          const condo = data.condos.find(c => c.id === deletedGoal.condoId);
          if (condo?.workspace?.path) {
            const rmResult = wsOps.removeGoalWorktree(condo.workspace.path, deletedGoal.id, deletedGoal.worktree?.branch);
            if (!rmResult.ok && logger) {
              logger.error(`clawcondos-goals: worktree removal failed for goal ${params.id}: ${rmResult.error}`);
            }
          }
        }

        // Clean up session index entries pointing to this goal
        for (const [key, val] of Object.entries(data.sessionIndex)) {
          if (val.goalId === params.id) delete data.sessionIndex[key];
        }
        data.goals.splice(idx, 1);
        saveData(data);
        respond(true, { ok: true, killedSessions: [...sessionKeys] });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.addSession': ({ params, respond }) => {
      try {
        const { id, sessionKey } = params;
        if (!sessionKey) {
          respond(false, undefined, { message: 'sessionKey is required' });
          return;
        }
        const data = loadData();
        const goal = data.goals.find(g => g.id === id);
        if (!goal) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        // Remove session from any other goal (move semantics)
        for (const g of data.goals) {
          const sIdx = (g.sessions || []).indexOf(sessionKey);
          if (sIdx !== -1) {
            g.sessions.splice(sIdx, 1);
            g.updatedAtMs = Date.now();
          }
        }
        // Add to target goal
        if (!goal.sessions.includes(sessionKey)) {
          goal.sessions.unshift(sessionKey);
        }
        goal.updatedAtMs = Date.now();
        data.sessionIndex[sessionKey] = { goalId: id };
        saveData(data);
        respond(true, { ok: true, goal });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.removeSession': ({ params, respond }) => {
      try {
        const { id, sessionKey } = params;
        if (!sessionKey) {
          respond(false, undefined, { message: 'sessionKey is required' });
          return;
        }
        const data = loadData();
        const goal = data.goals.find(g => g.id === id);
        if (!goal) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        goal.sessions = (goal.sessions || []).filter(s => s !== sessionKey);
        goal.updatedAtMs = Date.now();
        delete data.sessionIndex[sessionKey];
        saveData(data);
        respond(true, { ok: true, goal });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.sessionLookup': ({ params, respond }) => {
      try {
        const data = loadData();
        const entry = data.sessionIndex[params.sessionKey];
        respond(true, { goalId: entry?.goalId ?? null });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.setSessionCondo': ({ params, respond }) => {
      try {
        const { sessionKey, condoId } = params;
        if (!sessionKey || !condoId) {
          respond(false, undefined, { message: 'sessionKey and condoId are required' });
          return;
        }
        const data = loadData();
        const condo = data.condos.find(c => c.id === condoId);
        if (!condo) {
          respond(false, undefined, { message: 'Condo not found' });
          return;
        }
        data.sessionCondoIndex[sessionKey] = condoId;
        saveData(data);
        respond(true, { ok: true, sessionKey, condoId });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.getSessionCondo': ({ params, respond }) => {
      try {
        const data = loadData();
        respond(true, { condoId: data.sessionCondoIndex[params.sessionKey] ?? null });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.listSessionCondos': ({ params, respond }) => {
      try {
        const data = loadData();
        respond(true, { sessionCondoIndex: data.sessionCondoIndex });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.removeSessionCondo': ({ params, respond }) => {
      try {
        const { sessionKey } = params;
        if (!sessionKey) {
          respond(false, undefined, { message: 'sessionKey is required' });
          return;
        }
        const data = loadData();
        delete data.sessionCondoIndex[sessionKey];
        saveData(data);
        respond(true, { ok: true });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.addTask': ({ params, respond }) => {
      try {
        const { goalId, text, description, priority, dependsOn, assignedAgent, model } = params;
        if (!goalId || !text || typeof text !== 'string' || !text.trim()) {
          respond(false, undefined, { message: 'goalId and text are required' });
          return;
        }
        const data = loadData();
        const goal = data.goals.find(g => g.id === goalId);
        if (!goal) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        const now = Date.now();
        const task = {
          id: store.newId('task'),
          text: text.trim(),
          description: description || '',
          status: 'pending',
          done: false,
          priority: priority || null,
          sessionKey: null,
          assignedAgent: assignedAgent || null,
          model: model || null,
          dependsOn: Array.isArray(dependsOn) ? dependsOn : [],
          summary: '',
          createdAtMs: now,
          updatedAtMs: now,
        };
        goal.tasks.push(task);
        goal.updatedAtMs = now;
        saveData(data);
        respond(true, { task });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.updateTask': ({ params, respond }) => {
      try {
        const { goalId, taskId } = params;
        if (!goalId || !taskId) {
          respond(false, undefined, { message: 'goalId and taskId are required' });
          return;
        }
        const data = loadData();
        const goal = data.goals.find(g => g.id === goalId);
        if (!goal) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        const task = (goal.tasks || []).find(t => t.id === taskId);
        if (!task) {
          respond(false, undefined, { message: 'Task not found' });
          return;
        }
        // Whitelist allowed patch fields
        const allowed = ['text', 'description', 'status', 'done', 'priority', 'dependsOn', 'summary', 'assignedAgent', 'model'];
        for (const f of allowed) {
          if (f in params) task[f] = params[f];
        }
        if (typeof task.text === 'string') task.text = task.text.trim();
        task.updatedAtMs = Date.now();

        // Sync done/status
        if ('status' in params) {
          task.done = task.status === 'done';
        } else if ('done' in params) {
          task.status = task.done ? 'done' : 'pending';
        }

        goal.updatedAtMs = Date.now();
        saveData(data);
        respond(true, { task });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.deleteTask': ({ params, respond }) => {
      try {
        const { goalId, taskId } = params;
        const data = loadData();
        const goal = data.goals.find(g => g.id === goalId);
        if (!goal) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        const idx = (goal.tasks || []).findIndex(t => t.id === taskId);
        if (idx === -1) {
          respond(false, undefined, { message: 'Task not found' });
          return;
        }
        const removed = goal.tasks[idx];
        // Clean up sessionIndex if this task had an assigned session
        if (removed.sessionKey && data.sessionIndex[removed.sessionKey]) {
          delete data.sessionIndex[removed.sessionKey];
        }
        goal.tasks.splice(idx, 1);
        goal.updatedAtMs = Date.now();
        saveData(data);
        respond(true, { ok: true });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.addFiles': ({ params, respond }) => {
      try {
        const { goalId, files } = params;
        if (!goalId || !Array.isArray(files) || !files.length) {
          respond(false, undefined, { message: 'goalId and files (array) are required' });
          return;
        }
        const data = loadData();
        const goal = data.goals.find(g => g.id === goalId);
        if (!goal) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        if (!Array.isArray(goal.files)) goal.files = [];
        const now = Date.now();
        let added = 0;
        for (const f of files) {
          const path = (typeof f === 'string' ? f : f?.path || '').trim();
          if (!path) continue;
          goal.files = goal.files.filter(e => e.path !== path);
          goal.files.push({
            path,
            taskId: null,
            sessionKey: null,
            addedAtMs: now,
            source: 'manual',
          });
          added++;
        }
        goal.updatedAtMs = now;
        saveData(data);
        respond(true, { ok: true, added, files: goal.files });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.removeFile': ({ params, respond }) => {
      try {
        const { goalId, path } = params;
        if (!goalId || !path) {
          respond(false, undefined, { message: 'goalId and path are required' });
          return;
        }
        const data = loadData();
        const goal = data.goals.find(g => g.id === goalId);
        if (!goal) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        if (!Array.isArray(goal.files)) goal.files = [];
        const before = goal.files.length;
        goal.files = goal.files.filter(e => e.path !== path);
        if (goal.files.length === before) {
          respond(false, undefined, { message: 'File not found in goal' });
          return;
        }
        goal.updatedAtMs = Date.now();
        saveData(data);
        respond(true, { ok: true, files: goal.files });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.updatePlan': ({ params, respond }) => {
      try {
        const { goalId, plan } = params;
        if (!goalId) {
          respond(false, undefined, { message: 'goalId is required' });
          return;
        }
        if (!plan || typeof plan !== 'object') {
          respond(false, undefined, { message: 'plan object is required' });
          return;
        }
        const data = loadData();
        const goal = data.goals.find(g => g.id === goalId);
        if (!goal) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }

        // Initialize or update goal-level plan
        const now = Date.now();
        const existingPlan = goal.plan || {};

        // Validate plan fields
        const validStatuses = ['none', 'draft', 'awaiting_approval', 'approved', 'rejected', 'executing', 'completed'];
        const newPlan = {
          status: validStatuses.includes(plan.status) ? plan.status : (existingPlan.status || 'draft'),
          content: typeof plan.content === 'string' ? plan.content : (existingPlan.content || ''),
          steps: Array.isArray(plan.steps) ? plan.steps.map((step, idx) => ({
            index: idx,
            title: step.title || step.text || '',
            taskId: step.taskId || null,
            status: step.status || 'pending',
            description: step.description || '',
          })) : (existingPlan.steps || []),
          feedback: typeof plan.feedback === 'string' ? plan.feedback : (existingPlan.feedback || null),
          updatedAtMs: now,
          createdAtMs: existingPlan.createdAtMs || now,
        };

        goal.plan = newPlan;
        goal.updatedAtMs = now;
        saveData(data);

        respond(true, { goal, plan: newPlan });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'goals.checkConflicts': ({ params, respond }) => {
      try {
        const { condoId } = params || {};
        if (!condoId) {
          respond(false, undefined, { message: 'condoId is required' });
          return;
        }
        const data = loadData();
        const condo = data.condos.find(c => c.id === condoId);
        if (!condo) {
          respond(false, undefined, { message: 'Condo not found' });
          return;
        }
        if (!wsOps || !condo.workspace?.path) {
          respond(true, { condoId, results: [], message: 'No workspace configured' });
          return;
        }
        const goals = data.goals.filter(g => g.condoId === condoId && g.worktree?.branch);
        const results = goals.map(g => {
          const status = wsOps.checkBranchStatus(condo.workspace.path, g.worktree.branch);
          return {
            goalId: g.id,
            goalTitle: g.title,
            branch: g.worktree.branch,
            ...status,
          };
        });
        respond(true, { condoId, results });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },
  };
}
