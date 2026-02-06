export function createGoalHandlers(store) {
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
        const { title, condoId, description, completed, status, priority, deadline, notes, tasks } = params;
        if (!title || typeof title !== 'string' || !title.trim()) {
          respond(false, undefined, { message: 'title is required' });
          return;
        }
        const data = loadData();
        const now = Date.now();
        const isCompleted = completed === true || status === 'done';
        const goal = {
          id: store.newId('goal'),
          title: title.trim(),
          description: description || notes || '',
          notes: notes || '',
          status: isCompleted ? 'done' : 'active',
          completed: isCompleted,
          condoId: condoId || null,
          priority: priority || null,
          deadline: deadline || null,
          tasks: [],
          sessions: [],
          createdAtMs: now,
          updatedAtMs: now,
        };
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
        if ('title' in params && (typeof params.title !== 'string' || !params.title.trim())) {
          respond(false, undefined, { message: 'title must be a non-empty string' });
          return;
        }

        // Whitelist allowed patch fields (prevent overwriting internal fields)
        const allowed = ['title', 'description', 'status', 'completed', 'condoId', 'priority', 'deadline', 'notes', 'tasks', 'nextTask', 'dropped', 'droppedAtMs'];
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

    'goals.delete': ({ params, respond }) => {
      try {
        const data = loadData();
        const idx = data.goals.findIndex(g => g.id === params.id);
        if (idx === -1) {
          respond(false, undefined, { message: 'Goal not found' });
          return;
        }
        // Clean up session index entries pointing to this goal
        for (const [key, val] of Object.entries(data.sessionIndex)) {
          if (val.goalId === params.id) delete data.sessionIndex[key];
        }
        data.goals.splice(idx, 1);
        saveData(data);
        respond(true, { ok: true });
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
        const { goalId, text, description, priority, dependsOn } = params;
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
        const allowed = ['text', 'description', 'status', 'done', 'priority', 'dependsOn', 'summary'];
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
  };
}
