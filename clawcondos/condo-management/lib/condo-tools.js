export function createCondoBindExecutor(store) {
  return async function execute(toolCallId, params) {
    const { sessionKey, condoId, name, description } = params;

    if (!condoId && !name) {
      return { content: [{ type: 'text', text: 'Error: provide either condoId (to bind to existing condo) or name (to create a new condo and bind).' }] };
    }

    const data = store.load();

    let condo;
    if (condoId) {
      condo = data.condos.find(c => c.id === condoId);
      if (!condo) {
        return { content: [{ type: 'text', text: `Error: condo ${condoId} not found.` }] };
      }
    } else {
      const now = Date.now();
      condo = {
        id: store.newId('condo'),
        name: name.trim(),
        description: typeof description === 'string' ? description : '',
        color: null,
        createdAtMs: now,
        updatedAtMs: now,
      };
      data.condos.unshift(condo);
    }

    data.sessionCondoIndex[sessionKey] = condo.id;
    store.save(data);

    return {
      content: [{ type: 'text', text: `Session bound to condo "${condo.name}" (${condo.id}).` }],
    };
  };
}

export function createCondoCreateGoalExecutor(store) {
  return async function execute(toolCallId, params) {
    const { sessionKey, title, description, priority, tasks } = params;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return { content: [{ type: 'text', text: 'Error: title is required.' }] };
    }

    const data = store.load();
    const condoId = data.sessionCondoIndex[sessionKey];
    if (!condoId) {
      return { content: [{ type: 'text', text: 'Error: session is not bound to a condo. Use condo_bind first.' }] };
    }

    const now = Date.now();
    const goal = {
      id: store.newId('goal'),
      title: title.trim(),
      description: description || '',
      notes: '',
      status: 'active',
      completed: false,
      condoId,
      priority: priority || null,
      deadline: null,
      tasks: [],
      sessions: [],
      createdAtMs: now,
      updatedAtMs: now,
    };

    // Add initial tasks if provided
    if (Array.isArray(tasks)) {
      for (const t of tasks) {
        const text = typeof t === 'string' ? t : t?.text;
        if (!text || typeof text !== 'string' || !text.trim()) continue;
        goal.tasks.push({
          id: store.newId('task'),
          text: text.trim(),
          description: (typeof t === 'object' && t?.description) || '',
          status: 'pending',
          done: false,
          priority: (typeof t === 'object' && t?.priority) || null,
          sessionKey: null,
          dependsOn: [],
          summary: '',
          createdAtMs: now,
          updatedAtMs: now,
        });
      }
    }

    data.goals.unshift(goal);
    store.save(data);

    const taskCount = goal.tasks.length;
    return {
      content: [{ type: 'text', text: `Goal "${goal.title}" created (${goal.id}) in condo ${condoId} with ${taskCount} task${taskCount !== 1 ? 's' : ''}.` }],
    };
  };
}

export function createCondoAddTaskExecutor(store) {
  return async function execute(toolCallId, params) {
    const { sessionKey, goalId, text, description, priority } = params;

    if (!goalId) {
      return { content: [{ type: 'text', text: 'Error: goalId is required.' }] };
    }
    if (!text || typeof text !== 'string' || !text.trim()) {
      return { content: [{ type: 'text', text: 'Error: text is required.' }] };
    }

    const data = store.load();
    const condoId = data.sessionCondoIndex[sessionKey];
    if (!condoId) {
      return { content: [{ type: 'text', text: 'Error: session is not bound to a condo.' }] };
    }

    const goal = data.goals.find(g => g.id === goalId);
    if (!goal) {
      return { content: [{ type: 'text', text: `Error: goal ${goalId} not found.` }] };
    }
    if (goal.condoId !== condoId) {
      return { content: [{ type: 'text', text: `Error: goal ${goalId} does not belong to the bound condo.` }] };
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
      dependsOn: [],
      summary: '',
      createdAtMs: now,
      updatedAtMs: now,
    };

    goal.tasks.push(task);
    goal.updatedAtMs = now;
    store.save(data);

    return {
      content: [{ type: 'text', text: `Task "${task.text}" (${task.id}) added to goal "${goal.title}".` }],
    };
  };
}

export function createCondoSpawnTaskExecutor(store) {
  return async function execute(toolCallId, params) {
    const { sessionKey, goalId, taskId, agentId, model } = params;

    if (!goalId || !taskId) {
      return { content: [{ type: 'text', text: 'Error: goalId and taskId are required.' }] };
    }

    const data = store.load();
    const condoId = data.sessionCondoIndex[sessionKey];
    if (!condoId) {
      return { content: [{ type: 'text', text: 'Error: session is not bound to a condo.' }] };
    }

    const goal = data.goals.find(g => g.id === goalId);
    if (!goal) {
      return { content: [{ type: 'text', text: `Error: goal ${goalId} not found.` }] };
    }
    if (goal.condoId !== condoId) {
      return { content: [{ type: 'text', text: `Error: goal ${goalId} does not belong to the bound condo.` }] };
    }

    const task = (goal.tasks || []).find(t => t.id === taskId);
    if (!task) {
      return { content: [{ type: 'text', text: `Error: task ${taskId} not found in goal.` }] };
    }
    if (task.sessionKey) {
      return { content: [{ type: 'text', text: `Error: task already has a session (${task.sessionKey}).` }] };
    }

    // Generate a session key for the spawned subagent
    const suffix = store.newId('spawn').replace('spawn_', '');
    const agent = agentId || 'main';
    const spawnSessionKey = `agent:${agent}:subagent:${suffix}`;

    // Link session to goal and update task
    task.sessionKey = spawnSessionKey;
    task.status = 'in-progress';
    task.updatedAtMs = Date.now();
    goal.sessions.push(spawnSessionKey);
    goal.updatedAtMs = Date.now();
    data.sessionIndex[spawnSessionKey] = { goalId };
    store.save(data);

    return {
      content: [{ type: 'text', text: `Subagent session ${spawnSessionKey} spawned for task "${task.text}".` }],
      spawnRequest: {
        sessionKey: spawnSessionKey,
        agentId: agent,
        model: model || null,
        goalId,
        taskId,
      },
    };
  };
}
