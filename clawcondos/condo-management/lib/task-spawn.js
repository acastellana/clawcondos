import { buildGoalContext, getProjectSummaryForGoal } from './context-builder.js';
import { createEmptyPlan } from './plan-manager.js';
import { resolveAutonomyMode, buildAutonomyDirective } from './autonomy.js';
import { getWorkerSkillContext } from './skill-injector.js';
import { join } from 'path';
import os from 'os';

/**
 * Build workspace path convention for a task's plan file
 * Convention: ~/.openclaw/workspace-<agentId>/plans/<goalId>/<taskId>/PLAN.md
 * @param {string} agentId - Agent ID
 * @param {string} goalId - Goal ID
 * @param {string} taskId - Task ID
 * @returns {string} Expected plan file path
 */
export function buildPlanFilePath(agentId, goalId, taskId) {
  const agent = agentId || 'main';
  const workspaceDir = join(os.homedir(), '.openclaw', `workspace-${agent}`);
  return join(workspaceDir, 'plans', goalId, taskId, 'PLAN.md');
}

/**
 * Deep-merge global + condo service configs. Tokens are NOT included — only
 * service names and non-secret metadata (org, team, model, etc.) are returned.
 */
export function resolveEffectiveServices(data, condoId) {
  const globalServices = data.config?.services || {};
  if (!condoId) return { ...globalServices };
  const condo = data.condos.find(c => c.id === condoId);
  if (!condo) return { ...globalServices };
  const strandOverrides = condo.services || {};
  const merged = { ...globalServices };
  for (const [name, overrideCfg] of Object.entries(strandOverrides)) {
    merged[name] = { ...(merged[name] || {}), ...overrideCfg };
  }
  return merged;
}

/**
 * Build an agent-friendly context block listing configured services.
 * Security: Only service names and non-secret metadata are included — tokens/keys are stripped.
 */
export function buildServiceContextBlock(services) {
  if (!services || Object.keys(services).length === 0) return null;

  const sensitiveKeys = new Set(['token', 'apiKey', 'secret', 'password', 'accessToken', 'agentToken']);
  const lines = ['## Available Services', ''];
  for (const [name, cfg] of Object.entries(services)) {
    if (name === 'github' && cfg?.authMode === 'account') {
      // GitHub account mode — give the agent rich context about its permissions
      lines.push(`- **GitHub** (Agent Account mode)`);
      if (cfg.agentUsername) lines.push(`  - Agent username: ${cfg.agentUsername}`);
      if (cfg.org) lines.push(`  - Organization: ${cfg.org}`);
      if (cfg.managerUsername) {
        lines.push(`  - Manager username: ${cfg.managerUsername}`);
        if (cfg.autoCollaborator) lines.push(`  - Auto-add manager as collaborator on new repos: YES`);
        if (cfg.autoTransfer) lines.push(`  - Auto-transfer repo ownership to manager when done: YES`);
      }
      lines.push(`  - You can create repositories, branches, and PRs using the agent account credentials.`);
    } else {
      const meta = Object.entries(cfg || {})
        .filter(([k]) => !sensitiveKeys.has(k))
        .filter(([k]) => k !== 'authMode')
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      lines.push(`- **${name}**${meta ? ` (${meta})` : ''}`);
    }
  }
  return lines.join('\n');
}

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

      // Generate a session key for the spawned task worker
      // Uses `webchat` session type so chat.send auto-creates the session on the gateway.
      // (subagent sessions require the parent agent to already be running.)
      const suffix = store.newId('spawn').replace('spawn_', '');
      const agent = agentId || 'main';
      const sessionKey = `agent:${agent}:webchat:task-${suffix}`;

      // Initialize plan with workspace path convention
      const planFilePath = buildPlanFilePath(agent, goalId, taskId);
      if (!task.plan) {
        task.plan = createEmptyPlan();
      }
      task.plan.expectedFilePath = planFilePath;
      task.plan.updatedAtMs = Date.now();

      // Resolve autonomy mode
      let condo = null;
      if (goal.condoId) {
        condo = data.condos.find(c => c.id === goal.condoId);
      }
      const autonomyMode = resolveAutonomyMode(task, goal, condo);
      const autonomyDirective = buildAutonomyDirective(autonomyMode);

      // Build spawned agent context: project summary (if in condo) + goal state + task assignment + worker skill
      const goalContext = buildGoalContext(goal, { currentSessionKey: sessionKey });
      const ps = getProjectSummaryForGoal(goal, data);
      const projectPrefix = ps ? ps + '\n\n' : '';
      
      // Resolve workspace path: goal worktree > condo workspace > null
      const workspacePath = goal.worktree?.path || condo?.workspace?.path || null;

      // Resolve effective services (global + condo overrides) for agent context
      const effectiveServices = resolveEffectiveServices(data, goal.condoId);
      const serviceContextBlock = buildServiceContextBlock(effectiveServices);

      // Get worker skill context with task details
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
      
      // Include the PM's full plan so the worker understands the bigger picture
      const pmPlan = goal.pmPlanContent || null;

      const taskContext = [
        // CRITICAL: completion instruction first — agents must see this
        `⚠️ **REQUIRED: When you finish this task, you MUST call \`goal_update\` with \`status: "done"\` and \`taskId: "${task.id}"\`. Your work is not recorded until you do this.**`,
        '',
        // Worker skill context
        workerSkillContext || null,
        '',
        // Project/goal context
        projectPrefix + goalContext,
        '',
        // PM's full plan for context
        pmPlan ? '---\n## PM Plan (for reference)\n\n' + pmPlan + '\n---' : null,
        '',
        '---',
        `## Your Assignment: ${task.text}`,
        task.description ? `\n${task.description}` : null,
        '',
        // Working directory instruction
        workspacePath ? `**Working Directory:** \`${workspacePath}\`\nIMPORTANT: Start by running \`cd ${workspacePath}\` to work in the correct directory.` : null,
        '',
        // Available services
        serviceContextBlock,
        '',
        autonomyDirective,
        '',
        `**Plan File:** If you need to create a plan, write it to: \`${planFilePath}\``,
        'Use `goal_update` with `planStatus="awaiting_approval"` when your plan is ready for review.',
        '',
        'When executing plan steps, update each step\'s status:',
        `- \`goal_update({ taskId: "${taskId}", stepIndex: 0, stepStatus: "in-progress" })\` — when starting a step`,
        `- \`goal_update({ taskId: "${taskId}", stepIndex: 0, stepStatus: "done" })\` — when completing a step`,
        '',
        // Repeat at the end for emphasis
        `⚠️ **REMINDER: When done, call \`goal_update({ taskId: "${task.id}", status: "done", summary: "..." })\`**`,
      ].filter(line => line != null).join('\n');

      // Link session to goal and update task
      task.sessionKey = sessionKey;
      task.status = 'in-progress';
      task.autonomyMode = autonomyMode;
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
        autonomyMode,
        planFilePath,
        workspacePath,
      });
    } catch (err) {
      respond(false, undefined, { message: String(err) });
    }
  };
}
