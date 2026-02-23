import { buildGoalContext, getProjectSummaryForGoal } from './context-builder.js';
import { resolveAutonomyMode, buildAutonomyDirective } from './autonomy.js';
import { getWorkerSkillContext } from './skill-injector.js';
import { buildPlanFilePath, resolveEffectiveServices, buildServiceContextBlock } from './task-spawn.js';
import { createEmptyPlan } from './plan-manager.js';

export function createCondoBindExecutor(store, wsOps) {
  return async function execute(toolCallId, params) {
    const { sessionKey, condoId, name, description, repoUrl } = params;

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
      const newCondoId = store.newId('condo');
      condo = {
        id: newCondoId,
        name: name.trim(),
        description: typeof description === 'string' ? description : '',
        color: null,
        workspace: null,
        createdAtMs: now,
        updatedAtMs: now,
      };

      // Create workspace if workspaces are enabled
      if (wsOps) {
        const wsResult = wsOps.createCondoWorkspace(wsOps.dir, newCondoId, name.trim(), repoUrl || undefined);
        if (wsResult.ok) {
          condo.workspace = { path: wsResult.path, repoUrl: repoUrl || null, createdAtMs: now };
        }
      }

      data.condos.unshift(condo);
    }

    data.sessionCondoIndex[sessionKey] = condo.id;
    store.save(data);

    return {
      content: [{ type: 'text', text: `Session bound to condo "${condo.name}" (${condo.id}).` }],
    };
  };
}

export function createCondoCreateGoalExecutor(store, wsOps) {
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
    const goalId = store.newId('goal');
    const goal = {
      id: goalId,
      title: title.trim(),
      description: description || '',
      notes: '',
      status: 'active',
      completed: false,
      condoId,
      priority: priority || null,
      deadline: null,
      worktree: null,
      tasks: [],
      sessions: [],
      createdAtMs: now,
      updatedAtMs: now,
    };

    // Create worktree if condo has a workspace
    if (wsOps) {
      const condo = data.condos.find(c => c.id === condoId);
      if (condo?.workspace?.path) {
        const wtResult = wsOps.createGoalWorktree(condo.workspace.path, goalId, title.trim());
        if (wtResult.ok) {
          goal.worktree = { path: wtResult.path, branch: wtResult.branch, createdAtMs: now };
          // Push new branch to remote so it's visible on GitHub
          if (condo.workspace.repoUrl && wsOps.pushGoalBranch) {
            const pushResult = wsOps.pushGoalBranch(wtResult.path, wtResult.branch);
            if (pushResult.pushed || pushResult.ok) {
              goal.pushStatus = 'pushed';
            } else {
              goal.pushStatus = 'failed';
              goal.pushError = pushResult.error || 'Push failed';
            }
          }
        }
      }
    }

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

    // Generate a session key for the spawned task worker
    // Uses `webchat` session type so chat.send auto-creates the session on the gateway.
    const suffix = store.newId('spawn').replace('spawn_', '');
    const agent = agentId || 'main';
    const spawnSessionKey = `agent:${agent}:webchat:task-${suffix}`;

    // Build taskContext using the same helpers as task-spawn.js
    const condo = data.condos.find(c => c.id === condoId);
    const planFilePath = buildPlanFilePath(agent, goalId, taskId);
    const autonomyMode = resolveAutonomyMode(task, goal, condo);
    const autonomyDirective = buildAutonomyDirective(autonomyMode);
    const goalContext = buildGoalContext(goal, { currentSessionKey: spawnSessionKey });
    const ps = getProjectSummaryForGoal(goal, data);
    const projectPrefix = ps ? ps + '\n\n' : '';
    const workspacePath = goal.worktree?.path || condo?.workspace?.path || null;
    const effectiveServices = resolveEffectiveServices(data, goal.condoId);
    const serviceContextBlock = buildServiceContextBlock(effectiveServices);
    const workerSkillContext = getWorkerSkillContext({
      goalId,
      taskId,
      taskText: task.text,
      taskDescription: task.description || null,
      goalTitle: goal.title,
      condoId: goal.condoId || null,
      condoName: condo?.name || null,
      autonomyMode,
      planFilePath,
      assignedRole: task.assignedAgent || null,
      workspacePath,
    });
    const pmPlan = goal.pmPlanContent || null;

    const taskContext = [
      `⚠️ **REQUIRED: When you finish this task, you MUST call \`goal_update\` with \`status: "done"\` and \`taskId: "${task.id}"\`. Your work is not recorded until you do this.**`,
      '',
      workerSkillContext || null,
      '',
      projectPrefix + goalContext,
      '',
      pmPlan ? '---\n## PM Plan (for reference)\n\n' + pmPlan + '\n---' : null,
      '',
      '---',
      `## Your Assignment: ${task.text}`,
      task.description ? `\n${task.description}` : null,
      '',
      workspacePath ? `**Working Directory:** \`${workspacePath}\`\nIMPORTANT: Start by running \`cd ${workspacePath}\` to work in the correct directory.` : null,
      '',
      serviceContextBlock,
      '',
      autonomyDirective,
      '',
      `**Plan File:** If you need to create a plan, write it to: \`${planFilePath}\``,
      'Use `goal_update` with `planStatus="awaiting_approval"` when your plan is ready for review.',
      '',
      `⚠️ **REMINDER: When done, call \`goal_update({ taskId: "${task.id}", status: "done", summary: "..." })\`**`,
    ].filter(line => line != null).join('\n');

    // Initialize plan
    if (!task.plan) {
      task.plan = createEmptyPlan();
    }
    task.plan.expectedFilePath = planFilePath;
    task.plan.updatedAtMs = Date.now();

    // Link session to goal and update task
    task.sessionKey = spawnSessionKey;
    task.status = 'in-progress';
    task.autonomyMode = autonomyMode;
    task.updatedAtMs = Date.now();
    goal.sessions.push(spawnSessionKey);
    goal.updatedAtMs = Date.now();
    data.sessionIndex[spawnSessionKey] = { goalId };
    store.save(data);

    return {
      content: [{ type: 'text', text: `Task session ${spawnSessionKey} spawned for task "${task.text}".` }],
      taskContext,
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

export function createCondoListExecutor(store) {
  return async function execute(toolCallId, params) {
    const data = store.load();
    const condos = data.condos || [];

    if (condos.length === 0) {
      return { content: [{ type: 'text', text: 'No condos found. Use `condo_bind` with a `name` to create one.' }] };
    }

    const lines = [`Found ${condos.length} condo(s):`, ''];
    for (const condo of condos) {
      const goalCount = (data.goals || []).filter(g => g.condoId === condo.id).length;
      const activeGoals = (data.goals || []).filter(g => g.condoId === condo.id && g.status !== 'done').length;
      lines.push(`- **${condo.name}** (${condo.id})`);
      if (condo.description) lines.push(`  ${condo.description}`);
      lines.push(`  Goals: ${goalCount} total, ${activeGoals} active`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  };
}

export function createCondoStatusExecutor(store) {
  return async function execute(toolCallId, params) {
    const { condoId } = params;

    if (!condoId) {
      return { content: [{ type: 'text', text: 'Error: condoId is required.' }] };
    }

    const data = store.load();
    const condo = data.condos.find(c => c.id === condoId);
    if (!condo) {
      return { content: [{ type: 'text', text: `Error: condo ${condoId} not found.` }] };
    }

    const goals = (data.goals || []).filter(g => g.condoId === condoId);
    const lines = [
      `# ${condo.name} (${condo.id})`,
    ];
    if (condo.description) lines.push(condo.description);
    if (condo.workspace?.path) lines.push(`Workspace: ${condo.workspace.path}`);

    if (goals.length === 0) {
      lines.push('', 'No goals yet.');
    } else {
      const active = goals.filter(g => g.status !== 'done');
      const done = goals.filter(g => g.status === 'done');
      lines.push('', `## Goals (${active.length} active, ${done.length} done)`);

      for (const goal of goals) {
        const tasks = goal.tasks || [];
        const doneTasks = tasks.filter(t => t.done || t.status === 'done').length;
        lines.push('', `### [${goal.status || 'active'}] ${goal.title} (${goal.id})`);
        if (goal.description) lines.push(goal.description);

        if (tasks.length > 0) {
          lines.push(`Tasks (${doneTasks}/${tasks.length} done):`);
          for (const t of tasks) {
            const status = t.status || (t.done ? 'done' : 'pending');
            let suffix = '';
            if (t.sessionKey) suffix = ` (session: ${t.sessionKey})`;
            else if (status !== 'done') suffix = ' — unassigned';
            lines.push(`- [${status}] ${t.text} [${t.id}]${suffix}`);
            if ((t.done || status === 'done') && t.summary) {
              lines.push(`  > ${t.summary}`);
            }
          }
        }
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  };
}

export function createCondoPmChatExecutor(store, { gatewayRpcCall, logger }) {
  return async function execute(toolCallId, params) {
    const { condoId, message } = params;

    if (!condoId) {
      return { content: [{ type: 'text', text: 'Error: condoId is required.' }] };
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return { content: [{ type: 'text', text: 'Error: message is required.' }] };
    }

    const data = store.load();
    const condo = data.condos.find(c => c.id === condoId);
    if (!condo) {
      return { content: [{ type: 'text', text: `Error: condo ${condoId} not found.` }] };
    }

    // Step 1: Build enriched message and get PM session key via pm.condoChat
    let pmSession, enrichedMessage;
    try {
      const chatResult = await gatewayRpcCall('pm.condoChat', { condoId, message: message.trim() });
      pmSession = chatResult.sessionKey || chatResult.pmSessionKey;
      enrichedMessage = chatResult.enrichedMessage || chatResult.message || message.trim();
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: failed to prepare PM chat: ${err.message}` }] };
    }

    if (!pmSession) {
      return { content: [{ type: 'text', text: 'Error: could not obtain PM session key.' }] };
    }

    // Step 2: Get baseline message count
    let baselineCount = 0;
    try {
      const history = await gatewayRpcCall('chat.history', { sessionKey: pmSession, limit: 50 });
      const messages = history?.messages || history || [];
      baselineCount = messages.length;
    } catch {
      // Fresh session, no history
    }

    // Step 3: Send message to PM
    try {
      await gatewayRpcCall('chat.send', { sessionKey: pmSession, message: enrichedMessage });
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: failed to send message to PM: ${err.message}` }] };
    }

    // Step 4: Poll for PM response
    const POLL_INTERVAL = 3000;
    const POLL_TIMEOUT = 180000;
    const startTime = Date.now();
    let pmResponse = null;

    while (Date.now() - startTime < POLL_TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));

      try {
        const history = await gatewayRpcCall('chat.history', { sessionKey: pmSession, limit: 50 });
        const messages = history?.messages || history || [];

        if (messages.length > baselineCount) {
          // Look for last assistant message
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role === 'assistant') {
              pmResponse = typeof msg.content === 'string'
                ? msg.content
                : Array.isArray(msg.content)
                  ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
                  : null;
              break;
            }
          }
          if (pmResponse) break;
        }
      } catch (err) {
        logger.warn(`condo_pm_chat: poll error: ${err.message}`);
      }
    }

    if (!pmResponse) {
      return { content: [{ type: 'text', text: 'PM did not respond within the timeout period (3 minutes). The PM session may still be processing — check back with `condo_status`.' }] };
    }

    // Step 5: Save PM response
    try {
      await gatewayRpcCall('pm.condoSaveResponse', { condoId, content: pmResponse });
    } catch (err) {
      logger.warn(`condo_pm_chat: failed to save PM response: ${err.message}`);
    }

    // Step 6: Try to auto-create goals from PM plan
    let goals = null;
    try {
      const createResult = await gatewayRpcCall('pm.condoCreateGoals', { condoId, planContent: pmResponse });
      goals = createResult?.goals || createResult?.createdGoals || null;
    } catch {
      // PM might be asking questions rather than proposing a plan — this is expected
    }

    const resultLines = ['**PM Response:**', '', pmResponse];
    if (goals && goals.length > 0) {
      resultLines.push('', '---', `**${goals.length} goal(s) created from PM plan:**`);
      for (const g of goals) {
        const taskCount = g.tasks?.length || 0;
        resultLines.push(`- ${g.title} (${g.id}) — ${taskCount} task(s)`);
      }
      resultLines.push('', 'Use `condo_pm_kickoff` with a goalId to start execution.');
    }

    return {
      content: [{ type: 'text', text: resultLines.join('\n') }],
      pmResponse,
      goals,
    };
  };
}

export function createCondoPmKickoffExecutor(store, { gatewayRpcCall, internalKickoff, startSpawnedSessions, broadcastPlanUpdate, logger }) {
  return async function execute(toolCallId, params) {
    const { condoId, goalId } = params;

    if (!condoId) {
      return { content: [{ type: 'text', text: 'Error: condoId is required.' }] };
    }
    if (!goalId) {
      return { content: [{ type: 'text', text: 'Error: goalId is required.' }] };
    }

    const data = store.load();
    const condo = data.condos.find(c => c.id === condoId);
    if (!condo) {
      return { content: [{ type: 'text', text: `Error: condo ${condoId} not found.` }] };
    }

    const goal = data.goals.find(g => g.id === goalId);
    if (!goal) {
      return { content: [{ type: 'text', text: `Error: goal ${goalId} not found.` }] };
    }
    if (goal.condoId !== condoId) {
      return { content: [{ type: 'text', text: `Error: goal ${goalId} does not belong to condo ${condoId}.` }] };
    }

    const tasks = goal.tasks || [];
    const pendingTasks = tasks.filter(t => !t.sessionKey && t.status !== 'done');

    // Goal has tasks ready to spawn
    if (pendingTasks.length > 0) {
      try {
        const kickoffResult = await internalKickoff(goalId);
        if (kickoffResult.spawnedSessions?.length > 0) {
          await startSpawnedSessions(kickoffResult.spawnedSessions);
          broadcastPlanUpdate({
            event: 'goal.kickoff',
            goalId,
            spawnedCount: kickoffResult.spawnedSessions.length,
            spawnedSessions: kickoffResult.spawnedSessions,
          });
        }

        const spawnedCount = kickoffResult.spawnedSessions?.length || 0;
        return {
          content: [{ type: 'text', text: `Kickoff complete: spawned ${spawnedCount} worker session(s) for goal "${goal.title}". Use \`condo_status\` to monitor progress.` }],
          spawnedCount,
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: kickoff failed: ${err.message}` }] };
      }
    }

    // Goal has no tasks — trigger PM goal cascade to create tasks first
    try {
      await gatewayRpcCall('pm.goalCascade', { goalId, mode: 'full' });
      return {
        content: [{ type: 'text', text: `Goal "${goal.title}" has no tasks yet. Triggered PM goal cascade to plan tasks and auto-spawn workers. Use \`condo_status\` to monitor progress.` }],
        cascadeStarted: true,
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: goal cascade failed: ${err.message}` }] };
    }
  };
}
