import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { watch, existsSync, readFileSync, writeFileSync } from 'fs';
import { createGoalsStore } from './lib/goals-store.js';
import { createGoalHandlers } from './lib/goals-handlers.js';
import { createCondoHandlers } from './lib/condos-handlers.js';
import { createPlanHandlers, getPlanLogBuffer } from './lib/plan-handlers.js';
import { createPmHandlers } from './lib/pm-handlers.js';
import { createConfigHandlers } from './lib/config-handlers.js';
import { createTeamHandlers } from './lib/team-handlers.js';
import { createRolesHandlers } from './lib/roles-handlers.js';
import { createNotificationHandlers } from './lib/notification-manager.js';
import { createAutonomyHandlers } from './lib/autonomy.js';
import { buildGoalContext, buildStrandContext, buildStrandMenuContext, getProjectSummaryForGoal } from './lib/context-builder.js';
import { createGoalUpdateExecutor } from './lib/goal-update-tool.js';
import { createTaskSpawnHandler, buildPlanFilePath } from './lib/task-spawn.js';
import { matchLogToStep } from './lib/plan-manager.js';
import { resolveAgent, getAgentForRole } from './lib/agent-roles.js';
import {
  createCondoBindExecutor,
  createCondoCreateGoalExecutor,
  createCondoAddTaskExecutor,
  createCondoSpawnTaskExecutor,
  createCondoListExecutor,
  createCondoStatusExecutor,
  createCondoPmChatExecutor,
  createCondoPmKickoffExecutor,
} from './lib/condo-tools.js';
import * as workspaceManager from './lib/workspace-manager.js';
import {
  CLASSIFIER_CONFIG,
  extractLastUserMessage,
  parseTelegramContext,
  isSkippableMessage,
  tier1Classify,
  detectGoalIntent,
} from './lib/classifier.js';
import { createClassificationLog } from './lib/classification-log.js';
import { analyzeCorrections, applyLearning } from './lib/learning.js';
import { createSessionLifecycleHandlers } from './lib/session-lifecycle.js';
import { pushBranch, createPullRequest } from './lib/github.js';
import { processPmCascadeResponse } from './lib/cascade-processor.js';

export default function register(api) {
  const dataDir = api.pluginConfig?.dataDir
    || join(dirname(fileURLToPath(import.meta.url)), '.data');
  const store = createGoalsStore(dataDir);
  const classificationLog = createClassificationLog(dataDir);

  // ── Workspace management ──
  const workspacesDir = process.env.CLAWCONDOS_WORKSPACES_DIR || api.pluginConfig?.workspacesDir || null;
  const wsOps = workspacesDir
    ? { dir: workspacesDir, ...workspaceManager }
    : null;

  if (wsOps) {
    api.logger.info(`clawcondos-goals: workspaces enabled at ${workspacesDir}`);
  }

  // Shared RPC helper — calls gateway methods with proper fallback chain
  async function gatewayRpcCall(method, params) {
    if (api.callMethod) return api.callMethod(method, params);
    return new Promise((resolve, reject) => {
      const respond = (ok, data, err) => ok ? resolve(data) : reject(new Error(err?.message || err || 'RPC failed'));
      api.handleMessage?.({ type: 'req', method, params, respond }) || reject(new Error('No RPC mechanism available'));
    });
  }

  /**
   * Start spawned sessions by calling chat.send directly.
   * Used for auto-kickoffs (task completion cascade, retry, phase cascade).
   * Manual kickoff via goals.kickoff RPC does NOT use this — frontend handles it.
   * @param {Array} spawnedSessions - Sessions from internalKickoff()
   * @returns {Promise<void>}
   */
  async function startSpawnedSessions(spawnedSessions) {
    for (const s of spawnedSessions) {
      if (!s.sessionKey || !s.taskContext) continue;
      try {
        await gatewayRpcCall('chat.send', {
          sessionKey: s.sessionKey,
          message: s.taskContext,
        });
        s.headlessStarted = true;
        api.logger.info(`clawcondos-goals: backend chat.send OK for ${s.sessionKey}`);
      } catch (err) {
        api.logger.error(`clawcondos-goals: backend chat.send FAILED for ${s.sessionKey}: ${err.message}`);
        s.headlessStarted = false;
      }
    }
  }

  const handlers = createGoalHandlers(store, { wsOps, logger: api.logger });

  // Wrap setSessionCondo to track reclassifications
  const originalSetSessionCondo = handlers['goals.setSessionCondo'];
  handlers['goals.setSessionCondo'] = (msg) => {
    const { params } = msg;
    if (params?.sessionKey && params?.condoId) {
      try {
        const data = store.load();
        const previousCondo = data.sessionCondoIndex[params.sessionKey];
        if (previousCondo && previousCondo !== params.condoId) {
          classificationLog.recordReclassification(params.sessionKey, previousCondo, params.condoId);
          api.logger.info(`clawcondos-goals: reclassification ${params.sessionKey}: ${previousCondo} → ${params.condoId}`);
        }
      } catch (err) {
        api.logger.error(`clawcondos-goals: reclassification tracking failed: ${err.message}`);
      }
    }
    return originalSetSessionCondo(msg);
  };

  for (const [method, handler] of Object.entries(handlers)) {
    // Wrap goals.delete to add broadcast support (for PM chat cleanup)
    if (method === 'goals.delete') {
      api.registerGatewayMethod(method, (msg) => {
        const goalId = msg.params?.id;
        const originalRespond = msg.respond;
        msg.respond = (success, data, error) => {
          // Broadcast on success so frontend can cleanup (e.g., PM chat state)
          if (success && goalId) {
            if (api.broadcast) {
              api.broadcast({
                type: 'event',
                event: 'goal.deleted',
                payload: {
                  goalId,
                  timestamp: Date.now(),
                },
              });
            }
          }
          originalRespond(success, data, error);
        };
        handler(msg);
      });
    // Wrap goals.updatePlan to add broadcast support
    } else if (method === 'goals.updatePlan') {
      api.registerGatewayMethod(method, (msg) => {
        const originalRespond = msg.respond;
        msg.respond = (success, data, error) => {
          // Broadcast on success
          if (success && data?.plan && data?.goal) {
            if (api.broadcast) {
              api.broadcast({
                type: 'event',
                event: 'goal.plan_updated',
                payload: {
                  goalId: data.goal.id,
                  plan: data.plan,
                  timestamp: Date.now(),
                },
              });
            }
          }
          originalRespond(success, data, error);
        };
        handler(msg);
      });
    } else {
      api.registerGatewayMethod(method, handler);
    }
  }

  const strandHandlers = createCondoHandlers(store, { wsOps, logger: api.logger });
  for (const [method, handler] of Object.entries(strandHandlers)) {
    api.registerGatewayMethod(method, handler);
  }

  // ── WebSocket broadcasting for real-time plan updates ──
  // Dual-path: use api.broadcast (gateway internal) + write to kickoff file (serve.js relay)
  const kickoffEventsFile = join(dataDir, 'kickoff-events.json');

  const broadcastPlanUpdate = (payload) => {
    const eventName = payload.event || 'plan.update';

    // Path 1: api.broadcast (may or may not work depending on gateway version)
    if (api.broadcast) {
      api.broadcast({ type: 'event', event: eventName, payload });
    }

    // Path 2: Write to kickoff file for serve.js relay (reliable for goal.* events)
    if (eventName.startsWith('goal.')) {
      try {
        let existing = [];
        try { existing = JSON.parse(readFileSync(kickoffEventsFile, 'utf-8')); } catch {}
        if (!Array.isArray(existing)) existing = [];
        existing.push(payload);
        writeFileSync(kickoffEventsFile, JSON.stringify(existing), 'utf-8');
        api.logger.info(`clawcondos-goals: wrote ${eventName} to kickoff-events.json`);
      } catch (err) {
        api.logger.error(`clawcondos-goals: failed to write kickoff event: ${err.message}`);
      }
    }
  };

  // ── Send message to a specific session (for approval/rejection notifications) ──
  const sendToSession = (sessionKey, message) => {
    if (api.sendToSession) {
      api.sendToSession(sessionKey, message);
    } else {
      api.logger.warn(`clawcondos-goals: sendToSession not available, cannot notify ${sessionKey}`);
    }
  };

  // Plan management handlers (with broadcast and session notification)
  const planHandlers = createPlanHandlers(store, {
    broadcastPlanUpdate,
    sendToSession,
  });
  for (const [method, handler] of Object.entries(planHandlers)) {
    api.registerGatewayMethod(method, handler);
  }

  // PM (Project Manager) mode handlers
  const pmHandlers = createPmHandlers(store, {
    sendToSession: api.sendToSession,
    logger: api.logger,
    wsOps,
    gatewayRpcCall,
  });
  for (const [method, handler] of Object.entries(pmHandlers)) {
    api.registerGatewayMethod(method, handler);
  }

  // Config handlers (agent roles, global settings)
  const configHandlers = createConfigHandlers(store, {
    logger: api.logger,
  });
  for (const [method, handler] of Object.entries(configHandlers)) {
    api.registerGatewayMethod(method, handler);
  }

  // Team handlers (team chat, broadcast)
  const teamHandlers = createTeamHandlers(store, {
    sendToSession: api.sendToSession,
    getSessionHistory: api.getSessionHistory,
    broadcast: api.broadcast,
    logger: api.logger,
  });
  for (const [method, handler] of Object.entries(teamHandlers)) {
    api.registerGatewayMethod(method, handler);
  }

  // Roles handlers (agent role assignment with labels)
  const rolesHandlers = createRolesHandlers(store, {
    broadcast: api.broadcast,
    logger: api.logger,
  });
  for (const [method, handler] of Object.entries(rolesHandlers)) {
    api.registerGatewayMethod(method, handler);
  }

  // Notification handlers
  const notificationHandlers = createNotificationHandlers(store);
  for (const [method, handler] of Object.entries(notificationHandlers)) {
    api.registerGatewayMethod(method, handler);
  }

  // Autonomy handlers
  const autonomyHandlers = createAutonomyHandlers(store);
  for (const [method, handler] of Object.entries(autonomyHandlers)) {
    api.registerGatewayMethod(method, handler);
  }

  // Session lifecycle handlers
  const sessionLifecycleHandlers = createSessionLifecycleHandlers(store, {
    rpcCall: gatewayRpcCall,
    logger: api.logger,
  });
  for (const [method, handler] of Object.entries(sessionLifecycleHandlers)) {
    api.registerGatewayMethod(method, handler);
  }

  api.registerGatewayMethod('goals.spawnTaskSession', createTaskSpawnHandler(store));

  // goals.kickoff - Spawn sessions for all tasks with assigned agents
  const taskSpawnHandler = createTaskSpawnHandler(store);

  /**
   * Internal kickoff logic — spawns sessions for unblocked tasks in a goal.
   * Extracted so it can be reused (e.g., auto re-kickoff after task completion).
   * @param {string} goalId
   * @returns {Promise<{goalId, spawnedSessions, errors?, message}>}
   */
  async function internalKickoff(goalId) {
    const data = store.load();
    const goal = data.goals.find(g => g.id === goalId);

    if (!goal) {
      throw new Error(`Goal ${goalId} not found`);
    }

    // Check goal-level dependencies (phase-based)
    if (goal.dependsOn?.length > 0) {
      const allGoalDepsDone = goal.dependsOn.every(depGoalId => {
        const depGoal = data.goals.find(g => g.id === depGoalId);
        return depGoal && depGoal.status === 'done';
      });
      if (!allGoalDepsDone) {
        return { goalId, spawnedSessions: [], message: 'Goal blocked by dependencies' };
      }
    }

    const tasks = goal.tasks || [];

    // Collect IDs of tasks that are already done
    const doneTasks = new Set(tasks.filter(t => t.status === 'done' || t.done).map(t => t.id));

    const tasksToSpawn = tasks.filter(t => {
      // Skip already-assigned or done tasks
      if (t.sessionKey || t.status === 'done') return false;

      // Check dependency ordering: only spawn if ALL dependencies are done
      if (Array.isArray(t.dependsOn) && t.dependsOn.length > 0) {
        const allDepsDone = t.dependsOn.every(depId => doneTasks.has(depId));
        if (!allDepsDone) return false;
      }

      return true;
    });

    if (tasksToSpawn.length === 0) {
      return {
        goalId,
        spawnedSessions: [],
        message: 'No tasks to spawn',
      };
    }

    const spawnedSessions = [];
    const errors = [];

    for (const task of tasksToSpawn) {
      try {
        // Resolve role -> actual agent ID using config, fall back to 'main'
        const resolvedAgentId = resolveAgent(store, task.assignedAgent) || 'main';

        // Create a promise-based wrapper for the spawn handler
        const result = await new Promise((resolve, reject) => {
          taskSpawnHandler({
            params: {
              goalId,
              taskId: task.id,
              agentId: resolvedAgentId,
              model: task.model || null,
            },
            respond: (success, data, error) => {
              if (success) {
                resolve(data);
              } else {
                reject(new Error(error?.message || error || 'Spawn failed'));
              }
            },
          });
        });

        spawnedSessions.push({
          taskId: task.id,
          taskText: task.text,
          sessionKey: result.sessionKey,
          agentId: result.agentId,
          assignedRole: task.assignedAgent,  // Original role/spec from task
          autonomyMode: result.autonomyMode,
          taskContext: result.taskContext,
          model: result.model || null,
        });
      } catch (err) {
        errors.push({
          taskId: task.id,
          taskText: task.text,
          error: err.message,
        });
      }
    }

    // Update goal status to 'in-progress' if any sessions spawned
    if (spawnedSessions.length > 0) {
      const updatedData = store.load();
      const updatedGoal = updatedData.goals.find(g => g.id === goalId);
      if (updatedGoal && updatedGoal.status !== 'done') {
        updatedGoal.status = 'active';
        updatedGoal.updatedAtMs = Date.now();
        store.save(updatedData);
      }
    }

    return {
      goalId,
      spawnedSessions,
      errors: errors.length > 0 ? errors : undefined,
      message: `Spawned ${spawnedSessions.length} session(s)${errors.length > 0 ? `, ${errors.length} error(s)` : ''}`,
    };
  }

  /**
   * Kick off all unblocked goals in a condo (phase-based cascade).
   * Called when a goal completes to start the next wave of goals.
   * @param {string} condoId
   */
  async function kickoffUnblockedGoals(condoId) {
    const data = store.load();
    const condoGoals = data.goals.filter(g => g.condoId === condoId);

    for (const goal of condoGoals) {
      // Skip done goals or goals with no tasks
      if (goal.status === 'done' || !goal.tasks || goal.tasks.length === 0) continue;
      // Skip goals that already have spawned sessions
      if (goal.tasks.some(t => t.sessionKey)) continue;
      // Skip goals without dependsOn (they should already have been kicked off)
      if (!goal.dependsOn || goal.dependsOn.length === 0) continue;

      try {
        const result = await internalKickoff(goal.id);
        if (result.spawnedSessions.length > 0) {
          await startSpawnedSessions(result.spawnedSessions);
          broadcastPlanUpdate({
            event: 'goal.kickoff',
            goalId: goal.id,
            spawnedCount: result.spawnedSessions.length,
            spawnedSessions: result.spawnedSessions,
          });
          api.logger.info(`clawcondos-goals: kickoffUnblockedGoals: started ${result.spawnedSessions.length} session(s) for goal "${goal.title}" (phase ${goal.phase || '?'})`);
        }
      } catch (err) {
        api.logger.error(`clawcondos-goals: kickoffUnblockedGoals: failed for goal ${goal.id}: ${err.message}`);
      }
    }
  }

  /**
   * Auto-merge a goal's worktree branch into main after all tasks complete.
   * Shared by goal_update tool wrapper and agent_end hook.
   * Also marks the goal as done on successful merge and kicks off unblocked goals.
   * @param {string} goalId
   */
  async function autoMergeGoal(goalId) {
    try {
      const mergeData = store.load();
      const mergeGoal = mergeData.goals.find(g => g.id === goalId);
      if (!mergeGoal) return;

      const mergeCondo = mergeData.condos.find(c => c.id === mergeGoal.condoId);

      // If workspaces are disabled or goal has no worktree, skip git ops but still complete the goal
      if (!wsOps || !mergeGoal.worktree?.branch || !mergeCondo?.workspace?.path) {
        mergeGoal.status = 'done';
        mergeGoal.completed = true;
        mergeGoal.completedAtMs = Date.now();
        store.save(mergeData);

        broadcastPlanUpdate({
          event: 'goal.completed',
          goalId: mergeGoal.id,
          condoId: mergeCondo?.id || null,
          phase: mergeGoal.phase || null,
          timestamp: Date.now(),
        });

        api.logger.info(`clawcondos-goals: goal ${goalId} marked done (no workspace/worktree)`);

        if (mergeCondo?.id) {
          setTimeout(async () => {
            try {
              await kickoffUnblockedGoals(mergeCondo.id);
            } catch (err) {
              api.logger.error(`clawcondos-goals: kickoffUnblockedGoals failed: ${err.message}`);
            }
          }, 2000);
        }
        return;
      }

      // Auto-commit any uncommitted changes in the goal worktree before merging
      if (mergeGoal.worktree?.path && wsOps.commitWorktreeChanges) {
        const commitResult = wsOps.commitWorktreeChanges(
          mergeGoal.worktree.path,
          `Goal complete: ${mergeGoal.title || goalId}`
        );
        if (commitResult.committed) {
          api.logger.info(`clawcondos-goals: auto-committed changes in worktree for goal ${goalId}`);
          // Push the goal branch so commits are visible on GitHub before merge
          if (mergeCondo.workspace.repoUrl && wsOps.pushGoalBranch) {
            const branchPush = wsOps.pushGoalBranch(mergeGoal.worktree.path, mergeGoal.worktree.branch);
            if (branchPush.pushed) {
              api.logger.info(`clawcondos-goals: pushed goal branch ${mergeGoal.worktree.branch} to remote`);
              mergeGoal.pushStatus = 'pushed';
              mergeGoal.pushError = null;
            } else if (!branchPush.ok) {
              mergeGoal.pushStatus = 'failed';
              mergeGoal.pushError = branchPush.error || 'Push failed';
              store.save(mergeData);
              broadcastPlanUpdate({ event: 'goal.push_failed', goalId, error: branchPush.error, branch: mergeGoal.worktree.branch, timestamp: Date.now() });
            }
          }
        } else if (!commitResult.ok) {
          api.logger.warn(`clawcondos-goals: auto-commit failed for goal ${goalId}: ${commitResult.error}`);
        }
      }

      const mergeResult = wsOps.mergeGoalBranch(mergeCondo.workspace.path, mergeGoal.worktree.branch);
      mergeGoal.mergeStatus = mergeResult.ok ? 'merged' : (mergeResult.conflict ? 'conflict' : 'error');
      mergeGoal.mergedAtMs = mergeResult.ok ? Date.now() : null;
      mergeGoal.mergeError = mergeResult.error || null;

      // Auto-complete goal on successful merge
      if (mergeResult.ok) {
        mergeGoal.status = 'done';
        mergeGoal.completed = true;
        mergeGoal.completedAtMs = Date.now();
      }

      store.save(mergeData);

      broadcastPlanUpdate({
        event: 'goal.merged',
        goalId: mergeGoal.id,
        mergeStatus: mergeGoal.mergeStatus,
        branch: mergeGoal.worktree.branch,
        timestamp: Date.now(),
      });

      api.logger.info(`clawcondos-goals: auto-merge ${mergeGoal.worktree.branch} → ${mergeGoal.mergeStatus}`);

      // Auto-push main to GitHub after successful merge
      if (mergeResult.ok && mergeCondo.workspace.repoUrl) {
        try {
          const mainBranch = wsOps.getMainBranch(mergeCondo.workspace.path);
          const pushResult = pushBranch(mergeCondo.workspace.path, mainBranch);
          if (pushResult.ok) {
            api.logger.info(`clawcondos-goals: auto-pushed ${mainBranch} to GitHub for condo ${mergeCondo.id}`);
          } else {
            api.logger.error(`clawcondos-goals: auto-push failed for condo ${mergeCondo.id}: ${pushResult.error}`);
            mergeGoal.pushStatus = 'failed';
            mergeGoal.pushError = pushResult.error || 'Main branch push failed';
            store.save(mergeData);
            broadcastPlanUpdate({ event: 'goal.push_failed', goalId: mergeGoal.id, error: pushResult.error, branch: mainBranch, timestamp: Date.now() });
          }
        } catch (pushErr) {
          api.logger.error(`clawcondos-goals: auto-push error for condo ${mergeCondo.id}: ${pushErr.message}`);
        }
      }

      // Broadcast goal.completed and kick off unblocked goals
      if (mergeResult.ok && mergeCondo.id) {
        broadcastPlanUpdate({
          event: 'goal.completed',
          goalId: mergeGoal.id,
          condoId: mergeCondo.id,
          phase: mergeGoal.phase || null,
          timestamp: Date.now(),
        });

        setTimeout(async () => {
          try {
            await kickoffUnblockedGoals(mergeCondo.id);
          } catch (err) {
            api.logger.error(`clawcondos-goals: kickoffUnblockedGoals after merge failed: ${err.message}`);
          }
        }, 2000);
      }
    } catch (mergeErr) {
      api.logger.error(`clawcondos-goals: auto-merge error for goal ${goalId}: ${mergeErr.message}`);
    }
  }

  api.registerGatewayMethod('goals.kickoff', async ({ params, respond }) => {
    const { goalId } = params || {};

    if (!goalId) {
      return respond(false, null, 'goalId is required');
    }

    try {
      const result = await internalKickoff(goalId);

      // Broadcast kickoff event if sessions were spawned
      if (result.spawnedSessions.length > 0) {
        broadcastPlanUpdate({
          event: 'goal.kickoff',
          goalId,
          spawnedCount: result.spawnedSessions.length,
          spawnedSessions: result.spawnedSessions,
        });

        // Manual kickoff: frontend gets spawnedSessions in the response and
        // calls chat.send. Auto-kickoffs (cascade) call startSpawnedSessions()
        // directly so they don't depend on the frontend relay.
      }

      respond(true, result);
    } catch (err) {
      respond(false, null, err.message);
    }
  });

  // goals.close — Kill sessions, close worktree, archive goal
  api.registerGatewayMethod('goals.close', async ({ params, respond }) => {
    const { goalId } = params || {};
    if (!goalId) {
      return respond(false, null, 'goalId is required');
    }

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);
      if (!goal) {
        return respond(false, null, 'Goal not found');
      }

      // 1. Kill all sessions (goal + task + PM) — best-effort
      const sessionKeys = new Set([
        ...(goal.sessions || []),
        ...(goal.tasks || []).filter(t => t.sessionKey).map(t => t.sessionKey),
      ]);
      if (goal.pmSessionKey) sessionKeys.add(goal.pmSessionKey);

      for (const sk of sessionKeys) {
        try { await gatewayRpcCall('sessions.delete', { sessionKey: sk }); } catch { /* may not exist */ }
        try { await gatewayRpcCall('chat.abort', { sessionKey: sk }); } catch { /* best-effort */ }
      }

      // 2. Close worktree (merge + remove, preserve branch)
      if (wsOps && goal.worktree?.path && goal.condoId) {
        const condo = data.condos.find(c => c.id === goal.condoId);
        if (condo?.workspace?.path) {
          const closeResult = wsOps.closeGoalWorktree(condo.workspace.path, goalId, goal.worktree?.branch);
          if (!closeResult.ok) {
            api.logger.warn(`goals.close: worktree close failed for ${goalId}: ${closeResult.error}`);
          } else {
            api.logger.info(`goals.close: worktree closed for ${goalId} (merged: ${closeResult.merged}, conflict: ${closeResult.conflict})`);
          }
        }
      }

      // 3. Clear task session assignments for non-done tasks
      for (const task of goal.tasks || []) {
        if (task.status !== 'done' && task.sessionKey) {
          delete data.sessionIndex[task.sessionKey];
          task.sessionKey = null;
        }
      }

      // 4. Mark goal as done + closed
      goal.status = 'done';
      goal.completed = true;
      goal.closedAtMs = Date.now();
      goal.updatedAtMs = Date.now();

      // 5. Null out worktree
      goal.worktree = null;

      store.save(data);

      // 6. Broadcast goal.closed event
      if (api.broadcast) {
        api.broadcast({
          type: 'event',
          event: 'goal.closed',
          payload: {
            goalId,
            timestamp: Date.now(),
          },
        });
      }

      respond(true, { ok: true, goalId, killedSessions: [...sessionKeys] });
    } catch (err) {
      respond(false, null, err.message);
    }
  });

  // goals.branchStatus — Check branch status (ahead/behind/conflicts)
  api.registerGatewayMethod('goals.branchStatus', async ({ params, respond }) => {
    const { goalId } = params || {};
    if (!goalId) return respond(false, null, 'goalId is required');

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);
      if (!goal) return respond(false, null, 'Goal not found');
      if (!goal.worktree?.branch) return respond(false, null, 'Goal has no worktree branch');

      const condo = data.condos.find(c => c.id === goal.condoId);
      if (!condo?.workspace?.path) return respond(false, null, 'Condo has no workspace');

      if (!wsOps?.checkBranchStatus) {
        return respond(true, { ahead: 0, behind: 0, conflictFiles: [], hasRemote: false });
      }

      const status = wsOps.checkBranchStatus(condo.workspace.path, goal.worktree.branch);
      respond(true, {
        ahead: status.ahead || 0,
        behind: status.behind || 0,
        conflictFiles: status.conflictFiles || [],
        hasRemote: !!condo.workspace.repoUrl,
      });
    } catch (err) {
      respond(false, null, err.message);
    }
  });

  // goals.createPR — Create a GitHub pull request for a goal branch
  api.registerGatewayMethod('goals.createPR', async ({ params, respond }) => {
    const { goalId } = params || {};
    if (!goalId) return respond(false, null, 'goalId is required');

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);
      if (!goal) return respond(false, null, 'Goal not found');
      if (!goal.worktree?.branch) return respond(false, null, 'Goal has no worktree branch');

      const condo = data.condos.find(c => c.id === goal.condoId);
      if (!condo?.workspace?.path) return respond(false, null, 'Condo has no workspace');
      if (!condo.workspace.repoUrl) return respond(false, null, 'Condo has no remote repository URL');

      // Resolve GitHub config
      const ghConfig = (() => {
        const globalServices = data.config?.services || {};
        const strandServices = condo.services || {};
        return strandServices.github || globalServices.github || null;
      })();

      if (!ghConfig?.agentToken) return respond(false, null, 'GitHub agent token not configured');

      // Parse owner/repo from repoUrl
      const repoMatch = condo.workspace.repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (!repoMatch) return respond(false, null, 'Could not parse owner/repo from repository URL');
      const [, owner, repo] = repoMatch;

      // Push the goal branch to remote first
      const pushResult = pushBranch(condo.workspace.path, goal.worktree.branch, { setUpstream: true });
      if (!pushResult.ok) {
        return respond(false, null, `Failed to push branch: ${pushResult.error}`);
      }

      // Determine base branch
      const baseBranch = wsOps?.getMainBranch?.(condo.workspace.path) || 'main';

      // Create the PR
      const pr = await createPullRequest(ghConfig.agentToken, owner, repo, {
        head: goal.worktree.branch,
        base: baseBranch,
        title: goal.title || `Goal: ${goalId}`,
        body: `## Goal: ${goal.title}\n\n${goal.description || ''}\n\n---\nCreated by ClawCondos`,
      });

      // Store PR URL on goal
      goal.prUrl = pr.html_url;
      goal.prNumber = pr.number;
      goal.updatedAtMs = Date.now();
      store.save(data);

      // Broadcast event
      if (api.broadcast) {
        api.broadcast({
          type: 'event',
          event: 'goal.pr_created',
          payload: { goalId, prUrl: pr.html_url, prNumber: pr.number, timestamp: Date.now() },
        });
      }

      api.logger.info(`clawcondos-goals: PR #${pr.number} created for goal ${goalId}: ${pr.html_url}`);
      respond(true, { ok: true, prUrl: pr.html_url, prNumber: pr.number });
    } catch (err) {
      respond(false, null, err.message);
    }
  });

  // goals.retryPush — Retry pushing a goal branch to remote
  api.registerGatewayMethod('goals.retryPush', async ({ params, respond }) => {
    const { goalId } = params || {};
    if (!goalId) return respond(false, null, 'goalId is required');

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);
      if (!goal?.worktree?.branch) return respond(false, null, 'Goal has no worktree branch');
      const condo = data.condos.find(c => c.id === goal.condoId);
      if (!condo?.workspace?.repoUrl) return respond(false, null, 'No remote configured');

      if (!wsOps?.pushGoalBranch) return respond(false, null, 'Workspaces not enabled');

      const pushResult = wsOps.pushGoalBranch(goal.worktree.path, goal.worktree.branch);
      goal.pushStatus = (pushResult.pushed || pushResult.ok) ? 'pushed' : 'failed';
      goal.pushError = (pushResult.pushed || pushResult.ok) ? null : (pushResult.error || 'Push failed');
      goal.updatedAtMs = Date.now();
      store.save(data);
      return respond(true, { ok: pushResult.pushed || pushResult.ok, error: pushResult.error || null });
    } catch (err) {
      respond(false, null, err.message);
    }
  });

  // goals.retryMerge — Retry merging goal branch to main
  api.registerGatewayMethod('goals.retryMerge', async ({ params, respond }) => {
    const { goalId } = params || {};
    if (!goalId) return respond(false, null, 'goalId is required');

    try {
      await autoMergeGoal(goalId);
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);
      return respond(true, { mergeStatus: goal?.mergeStatus || null, mergeError: goal?.mergeError || null });
    } catch (err) {
      respond(false, null, err.message);
    }
  });

  // goals.pushMain — Push main branch to remote
  api.registerGatewayMethod('goals.pushMain', async ({ params, respond }) => {
    const { condoId } = params || {};
    if (!condoId) return respond(false, null, 'condoId is required');

    try {
      const data = store.load();
      const condo = data.condos.find(c => c.id === condoId);
      if (!condo?.workspace?.path || !condo?.workspace?.repoUrl) return respond(false, null, 'No workspace or remote');
      if (!wsOps?.getMainBranch) return respond(false, null, 'Workspaces not enabled');

      const mainBranch = wsOps.getMainBranch(condo.workspace.path);
      const pushResult = pushBranch(condo.workspace.path, mainBranch);
      return respond(true, { ok: pushResult.ok, error: pushResult.error || null });
    } catch (err) {
      respond(false, null, err.message);
    }
  });

  // ── Plan file watching ──
  const planLogBuffer = getPlanLogBuffer();
  const planFileWatchers = new Map(); // sessionKey -> { watcher, filePath, debounceTimer }
  const PLAN_WATCH_DEBOUNCE_MS = 500;

  /**
   * Start watching a plan file for a session
   */
  function watchPlanFile(sessionKey, filePath) {
    if (planFileWatchers.has(sessionKey)) {
      return; // Already watching
    }

    if (!existsSync(filePath)) {
      // File doesn't exist yet, skip watching
      return;
    }

    try {
      const watcher = watch(filePath, { persistent: false }, (eventType) => {
        const existing = planFileWatchers.get(sessionKey);
        if (!existing) return;

        // Debounce rapid changes
        if (existing.debounceTimer) {
          clearTimeout(existing.debounceTimer);
        }

        existing.debounceTimer = setTimeout(() => {
          if (!existsSync(filePath)) return;

          // Emit plan.update event
          broadcastPlanUpdate({
            event: 'plan.file_changed',
            sessionKey,
            filePath,
            timestamp: Date.now(),
          });

          // Log to plan buffer
          planLogBuffer.append(sessionKey, {
            type: 'file_change',
            message: 'Plan file updated',
            filePath,
          });

          api.logger.debug(`clawcondos-goals: plan file changed for ${sessionKey}: ${filePath}`);
        }, PLAN_WATCH_DEBOUNCE_MS);
      });

      planFileWatchers.set(sessionKey, { watcher, filePath, debounceTimer: null });
      api.logger.info(`clawcondos-goals: watching plan file for ${sessionKey}: ${filePath}`);
    } catch (err) {
      api.logger.error(`clawcondos-goals: failed to watch plan file ${filePath}: ${err.message}`);
    }
  }

  /**
   * Stop watching a plan file for a session
   */
  function unwatchPlanFile(sessionKey) {
    const existing = planFileWatchers.get(sessionKey);
    if (existing) {
      if (existing.debounceTimer) {
        clearTimeout(existing.debounceTimer);
      }
      try {
        existing.watcher.close();
      } catch {}
      planFileWatchers.delete(sessionKey);
      api.logger.info(`clawcondos-goals: stopped watching plan file for ${sessionKey}`);
    }
  }

  /**
   * Initialize plan file watchers for all active task sessions
   */
  function initPlanFileWatchers() {
    const data = store.load();
    for (const goal of data.goals) {
      if (goal.completed) continue;
      for (const task of goal.tasks || []) {
        if (!task.sessionKey || task.status === 'done') continue;

        // Get expected plan file path
        const agentMatch = task.sessionKey.match(/^agent:([^:]+):/);
        const agentId = agentMatch ? agentMatch[1] : 'main';
        const planFilePath = task.plan?.expectedFilePath || buildPlanFilePath(agentId, goal.id, task.id);

        watchPlanFile(task.sessionKey, planFilePath);
      }
    }
  }

  // Initialize watchers on plugin load
  try {
    initPlanFileWatchers();
  } catch (err) {
    api.logger.error(`clawcondos-goals: failed to initialize plan file watchers: ${err.message}`);
  }

  // Classification RPC methods
  api.registerGatewayMethod('classification.stats', ({ respond }) => {
    try {
      const stats = classificationLog.getStats();
      respond(true, { stats });
    } catch (err) {
      api.logger.error(`clawcondos-goals: classification.stats error: ${err.message}`);
      respond(false, null, err.message);
    }
  });

  api.registerGatewayMethod('classification.learningReport', ({ respond }) => {
    try {
      const suggestions = analyzeCorrections(classificationLog);
      respond(true, { suggestions });
    } catch (err) {
      api.logger.error(`clawcondos-goals: classification.learningReport error: ${err.message}`);
      respond(false, null, err.message);
    }
  });

  api.registerGatewayMethod('classification.applyLearning', ({ params, respond }) => {
    try {
      const dryRun = params?.dryRun !== false;
      const suggestions = analyzeCorrections(classificationLog);
      const applied = applyLearning(store, suggestions, dryRun);
      respond(true, { dryRun, applied });
    } catch (err) {
      api.logger.error(`clawcondos-goals: classification.applyLearning error: ${err.message}`);
      respond(false, null, err.message);
    }
  });

  // Hook: inject goal/condo context into agent prompts
  api.registerHook('before_agent_start', async (event) => {
    const sessionKey = event.context?.sessionKey;
    if (!sessionKey) return;

    // PM sessions receive fully enriched prompts via pm.chat / pm.condoCascade —
    // skip hook injection to avoid duplicate/conflicting context
    if (isPmSession(sessionKey)) return;

    const data = store.load();

    // 1. Check sessionCondoIndex (condo orchestrator path)
    const condoId = data.sessionCondoIndex[sessionKey];
    if (condoId) {
      const condo = data.condos.find(c => c.id === condoId);
      if (condo) {
        const goals = data.goals.filter(g => g.condoId === condoId);
        const context = buildStrandContext(condo, goals, { currentSessionKey: sessionKey });
        if (context) return { prependContext: context };
      }
    }

    // 2. Check sessionIndex (individual goal path — includes project summary if in a condo)
    const entry = data.sessionIndex[sessionKey];
    if (entry) {
      const goal = data.goals.find(g => g.id === entry.goalId);
      if (goal) {
        const projectSummary = getProjectSummaryForGoal(goal, data);
        const context = buildGoalContext(goal, { currentSessionKey: sessionKey });
        if (context) {
          return { prependContext: projectSummary ? `${projectSummary}\n\n${context}` : context };
        }
      }
    }

    // 3. Auto-classification for unbound sessions
    if (!CLASSIFIER_CONFIG.enabled) return;

    try {
      const message = extractLastUserMessage(event.messages);
      if (!message || isSkippableMessage(message)) return;

      const telegramCtx = parseTelegramContext(sessionKey) || {};
      const startMs = Date.now();
      const classification = tier1Classify(message, telegramCtx, data.condos);
      const latencyMs = Date.now() - startMs;

      // Log classification attempt
      classificationLog.append({
        sessionKey,
        tier: classification.tier,
        predictedCondo: classification.condoId,
        confidence: classification.confidence,
        reasoning: classification.reasoning,
        latencyMs,
      });

      // High confidence → auto-bind
      if (classification.condoId && classification.confidence >= CLASSIFIER_CONFIG.autoRouteThreshold) {
        data.sessionCondoIndex[sessionKey] = classification.condoId;
        store.save(data);

        const condo = data.condos.find(c => c.id === classification.condoId);
        if (condo) {
          const goals = data.goals.filter(g => g.condoId === classification.condoId);
          const context = buildStrandContext(condo, goals, { currentSessionKey: sessionKey });

          // Goal intent detection
          if (context) {
            const goalIntent = detectGoalIntent(message);
            const hint = goalIntent.isGoal
              ? '\n\n> This message looks like a goal or multi-step task. Consider using `condo_create_goal` to track it.'
              : '';
            api.logger.info(`clawcondos-goals: auto-routed ${sessionKey} → ${condo.name} (confidence: ${classification.confidence.toFixed(2)}, reason: ${classification.reasoning})`);
            return { prependContext: context + hint };
          }
        }
      }

      // Low confidence → inject condo menu for agent to decide
      if (data.condos.length > 0) {
        const menu = buildStrandMenuContext(data.condos, data.goals);
        if (menu) return { prependContext: menu };
      }
    } catch (err) {
      api.logger.error(`clawcondos-goals: classification error for ${sessionKey}: ${err.message}`);
    }
  });

  /**
   * Update cascade tracking on a condo after a goal's PM completes.
   * Removes goalId from cascadePendingGoals; broadcasts condo.cascade_complete when all done.
   */
  function updateCascadeTracking(condoId, goalId) {
    if (!condoId) return;
    try {
      const data = store.load();
      const condo = data.condos.find(c => c.id === condoId);
      if (!condo || !Array.isArray(condo.cascadePendingGoals)) return;

      condo.cascadePendingGoals = condo.cascadePendingGoals.filter(id => id !== goalId);

      if (condo.cascadePendingGoals.length === 0) {
        // All goals processed — clear cascade state
        condo.cascadePendingGoals = null;
        condo.updatedAtMs = Date.now();
        store.save(data);

        broadcastPlanUpdate({
          event: 'condo.cascade_complete',
          condoId,
          timestamp: Date.now(),
        });
        api.logger.info(`clawcondos-goals: cascade complete for condo ${condoId}`);
      } else {
        store.save(data);
      }
    } catch (err) {
      api.logger.error(`clawcondos-goals: updateCascadeTracking error: ${err.message}`);
    }
  }

  // Hook: track session activity on goals and condos + cleanup plan file watchers + error recovery
  api.registerHook('agent_end', async (event) => {
    const sessionKey = event.context?.sessionKey;
    if (!sessionKey) return;

    try {
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

      // PM cascade auto-processing: detect PM sessions awaiting plan responses
      if (isPmSession(sessionKey)) {
        // Find which goal this PM session belongs to
        const pmGoal = data.goals.find(g => g.pmSessionKey === sessionKey);
        if (pmGoal && pmGoal.cascadeState === 'awaiting_plan') {
          pmGoal.updatedAtMs = Date.now();

          try {
            // Fetch PM response from chat history
            const historyResult = await gatewayRpcCall('chat.history', {
              sessionKey,
              limit: 10,
            });

            // Extract last assistant message
            const messages = historyResult?.messages || historyResult || [];
            let pmContent = null;
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i];
              if (msg.role === 'assistant') {
                // Handle content as string or structured array
                pmContent = typeof msg.content === 'string'
                  ? msg.content
                  : Array.isArray(msg.content)
                    ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
                    : null;
                break;
              }
            }

            if (pmContent) {
              const cascadeResult = processPmCascadeResponse(store, pmGoal, pmContent, {
                mode: pmGoal.cascadeMode,
              });
              store.save(data);

              api.logger.info(`clawcondos-goals: agent_end PM cascade for goal "${pmGoal.title}": state=${cascadeResult.cascadeState}, tasks=${cascadeResult.tasksCreated}`);

              if (cascadeResult.cascadeState === 'tasks_created' && pmGoal.cascadeMode === 'full') {
                // Ensure goal autonomy mode is 'full' so spawned workers don't wait for approval
                pmGoal.autonomyMode = 'full';
                store.save(data);

                // Broadcast tasks created event
                broadcastPlanUpdate({
                  event: 'goal.cascade_tasks_created',
                  goalId: pmGoal.id,
                  condoId: pmGoal.condoId,
                  tasksCreated: cascadeResult.tasksCreated,
                  timestamp: Date.now(),
                });

                // Check goal-level dependencies before kickoff
                let depsSatisfied = true;
                if (pmGoal.dependsOn?.length > 0) {
                  depsSatisfied = pmGoal.dependsOn.every(depGoalId => {
                    const depGoal = data.goals.find(g => g.id === depGoalId);
                    return depGoal && depGoal.status === 'done';
                  });
                }

                if (depsSatisfied) {
                  // Auto-kickoff after a short delay
                  setTimeout(async () => {
                    try {
                      const kickoffResult = await internalKickoff(pmGoal.id);
                      if (kickoffResult.spawnedSessions?.length > 0) {
                        await startSpawnedSessions(kickoffResult.spawnedSessions);
                        broadcastPlanUpdate({
                          event: 'goal.kickoff',
                          goalId: pmGoal.id,
                          spawnedCount: kickoffResult.spawnedSessions.length,
                          spawnedSessions: kickoffResult.spawnedSessions,
                        });
                        api.logger.info(`clawcondos-goals: PM cascade auto-kickoff started ${kickoffResult.spawnedSessions.length} session(s) for goal "${pmGoal.title}"`);
                      }
                    } catch (err) {
                      api.logger.error(`clawcondos-goals: PM cascade auto-kickoff failed for goal ${pmGoal.id}: ${err.message}`);
                    }
                  }, 1000);
                } else {
                  api.logger.info(`clawcondos-goals: PM cascade: goal "${pmGoal.title}" has tasks but is blocked by dependencies`);
                }
              } else {
                // Plan mode or no tasks — broadcast plan ready
                broadcastPlanUpdate({
                  event: 'goal.cascade_plan_ready',
                  goalId: pmGoal.id,
                  condoId: pmGoal.condoId,
                  hasPlan: cascadeResult.hasPlan,
                  cascadeState: cascadeResult.cascadeState,
                  timestamp: Date.now(),
                });
              }

              // Update cascade tracking on condo
              updateCascadeTracking(pmGoal.condoId, pmGoal.id);
            } else {
              // No assistant message found
              pmGoal.cascadeState = 'plan_fetch_failed';
              store.save(data);
              api.logger.warn(`clawcondos-goals: agent_end PM cascade: no assistant message found for ${sessionKey}`);

              broadcastPlanUpdate({
                event: 'goal.cascade_plan_ready',
                goalId: pmGoal.id,
                condoId: pmGoal.condoId,
                hasPlan: false,
                cascadeState: 'plan_fetch_failed',
                timestamp: Date.now(),
              });
              updateCascadeTracking(pmGoal.condoId, pmGoal.id);
            }
          } catch (err) {
            pmGoal.cascadeState = 'plan_fetch_failed';
            store.save(data);
            api.logger.error(`clawcondos-goals: agent_end PM cascade fetch failed for ${sessionKey}: ${err.message}`);

            broadcastPlanUpdate({
              event: 'goal.cascade_plan_ready',
              goalId: pmGoal.id,
              condoId: pmGoal.condoId,
              hasPlan: false,
              cascadeState: 'plan_fetch_failed',
              timestamp: Date.now(),
            });
            updateCascadeTracking(pmGoal.condoId, pmGoal.id);
          }

          return; // PM sessions don't have tasks — skip task-level processing
        }
      }

      // Update goal timestamp if session is assigned to one
      const entry = data.sessionIndex[sessionKey];
      if (!entry) return;
      const goal = data.goals.find(g => g.id === entry.goalId);
      if (!goal) return;
      goal.updatedAtMs = Date.now();

      // Find the task associated with this session
      const task = (goal.tasks || []).find(t => t.sessionKey === sessionKey);

      if (task && task.status === 'done') {
        // Task completed successfully — cleanup watcher
        store.save(data);
        api.logger.info(`clawcondos-goals: agent_end for session ${sessionKey} (goal: ${goal.title})`);
        unwatchPlanFile(sessionKey);
        planLogBuffer.clear(sessionKey);
      } else if (task && task.status === 'in-progress') {
        // Check if agent completed normally (just didn't call goal_update)
        if (event.success !== false) {
          // Agent ended normally — auto-mark task as done
          task.status = 'done';
          task.done = true;
          task.summary = task.summary || 'Completed (auto-marked on session end)';
          task.updatedAtMs = Date.now();
          store.save(data);

          api.logger.info(`clawcondos-goals: auto-completed task ${task.id} on normal agent_end for goal "${goal.title}"`);

          // Broadcast completion event
          broadcastPlanUpdate({
            event: 'goal.task_completed',
            goalId: goal.id,
            taskId: task.id,
            allTasksDone: goal.tasks.every(t => t.status === 'done'),
            autoCompleted: true,
            timestamp: Date.now(),
          });

          // Trigger cascading kickoff or merge
          const allDone = goal.tasks.every(t => t.status === 'done');
          if (!allDone) {
            setTimeout(async () => {
              try {
                const kickoffResult = await internalKickoff(goal.id);
                if (kickoffResult.spawnedSessions?.length > 0) {
                  await startSpawnedSessions(kickoffResult.spawnedSessions);
                  broadcastPlanUpdate({
                    event: 'goal.kickoff',
                    goalId: goal.id,
                    spawnedCount: kickoffResult.spawnedSessions.length,
                    spawnedSessions: kickoffResult.spawnedSessions,
                  });
                  api.logger.info(`clawcondos-goals: auto-kickoff after auto-complete started ${kickoffResult.spawnedSessions.length} session(s) for goal "${goal.title}"`);
                }
              } catch (err) {
                api.logger.error(`auto-kickoff after auto-complete failed: ${err.message}`);
              }
            }, 1000);
          } else {
            // All tasks done — auto-merge, mark goal done, kick off unblocked goals
            await autoMergeGoal(goal.id);
          }

          unwatchPlanFile(sessionKey);
          planLogBuffer.clear(sessionKey);
          return; // Skip retry logic
        }

        // Agent ended with error — error recovery
        const retryCount = task.retryCount || 0;
        const maxRetries = goal.maxRetries ?? 1;

        if (retryCount < maxRetries) {
          // Retry: reset task for re-kickoff
          task.sessionKey = null;
          task.status = 'pending';
          task.retryCount = retryCount + 1;
          task.lastError = 'Agent failed while working on task';
          task.updatedAtMs = Date.now();
          store.save(data);

          api.logger.warn(`clawcondos-goals: task ${task.id} retry ${task.retryCount}/${maxRetries} for goal "${goal.title}"`);

          // Broadcast retry event
          broadcastPlanUpdate({
            event: 'goal.task_retry',
            goalId: goal.id,
            taskId: task.id,
            retryCount: task.retryCount,
            maxRetries,
            timestamp: Date.now(),
          });

          // Auto re-kickoff after a delay
          setTimeout(async () => {
            try {
              const kickoffResult = await internalKickoff(goal.id);
              if (kickoffResult.spawnedSessions?.length > 0) {
                await startSpawnedSessions(kickoffResult.spawnedSessions);
                broadcastPlanUpdate({
                  event: 'goal.kickoff',
                  goalId: goal.id,
                  spawnedCount: kickoffResult.spawnedSessions.length,
                  spawnedSessions: kickoffResult.spawnedSessions,
                });
                api.logger.info(`clawcondos-goals: auto re-kickoff for goal ${goal.id} after retry — started ${kickoffResult.spawnedSessions.length} session(s)`);
              }
            } catch (err) {
              api.logger.error(`clawcondos-goals: auto re-kickoff failed for goal ${goal.id}: ${err.message}`);
            }
          }, 2000);
        } else {
          // Max retries exhausted — mark task as failed
          task.status = 'failed';
          task.lastError = 'Max retries exhausted — agent ended without completing task';
          task.updatedAtMs = Date.now();
          store.save(data);

          api.logger.error(`clawcondos-goals: task ${task.id} FAILED after ${retryCount} retries for goal "${goal.title}"`);

          // Broadcast failure event
          broadcastPlanUpdate({
            event: 'goal.task_failed',
            goalId: goal.id,
            taskId: task.id,
            retryCount,
            timestamp: Date.now(),
          });
        }

        unwatchPlanFile(sessionKey);
        planLogBuffer.clear(sessionKey);
      } else {
        store.save(data);
        api.logger.info(`clawcondos-goals: agent_end for session ${sessionKey} (goal: ${goal.title})`);
      }
    } catch (err) {
      api.logger.error(`clawcondos-goals: agent_end error for ${sessionKey}: ${err.message}`);
    }
  });

  // Hook: intercept agent stream for plan.log events
  if (api.registerHook) {
    api.registerHook('agent_stream', async (event) => {
      const sessionKey = event.context?.sessionKey;
      if (!sessionKey) return;

      // Check if session is assigned to a goal with a task
      const data = store.load();
      const entry = data.sessionIndex[sessionKey];
      if (!entry) return;

      const goal = data.goals.find(g => g.id === entry.goalId);
      if (!goal) return;

      const task = (goal.tasks || []).find(t => t.sessionKey === sessionKey);
      if (!task || !task.plan) return;

      // Extract log-worthy events from stream
      const chunk = event.chunk;
      if (!chunk) return;

      // Handle tool calls
      if (chunk.type === 'tool_call' || chunk.type === 'tool_result') {
        const logEntry = {
          type: chunk.type,
          message: chunk.type === 'tool_call'
            ? `Tool call: ${chunk.name || 'unknown'}`
            : `Tool result: ${chunk.success ? 'success' : 'failure'}`,
          toolName: chunk.name,
          metadata: chunk.type === 'tool_result' ? { success: chunk.success } : null,
        };

        // Try to match to a plan step
        if (task.plan.steps && task.plan.steps.length > 0) {
          const match = matchLogToStep(logEntry.message, task.plan.steps);
          if (match.matched) {
            logEntry.stepIndex = match.stepIndex;
            logEntry.matchConfidence = match.confidence;
          }
        }

        planLogBuffer.append(sessionKey, logEntry);

        // Broadcast plan.log event
        broadcastPlanUpdate({
          event: 'plan.log',
          sessionKey,
          goalId: goal.id,
          taskId: task.id,
          entry: {
            ...logEntry,
            timestamp: Date.now(),
          },
        });
      }

      // Handle text output (selective logging)
      if (chunk.type === 'text' && chunk.text) {
        const text = chunk.text.trim();
        // Only log significant text (headings, status updates, etc.)
        if (text.startsWith('#') || text.startsWith('✓') || text.startsWith('✗') ||
            text.includes('Starting') || text.includes('Completed') ||
            text.includes('Error:') || text.includes('Step ')) {
          const logEntry = {
            type: 'text',
            message: text.slice(0, 200), // Truncate long text
          };

          // Try to match to a plan step
          if (task.plan.steps && task.plan.steps.length > 0) {
            const match = matchLogToStep(text, task.plan.steps);
            if (match.matched) {
              logEntry.stepIndex = match.stepIndex;
              logEntry.matchConfidence = match.confidence;
            }
          }

          planLogBuffer.append(sessionKey, logEntry);
        }
      }
    });
  }

  // Hook: start watching plan file when task is spawned
  api.registerHook('after_rpc', async (event) => {
    if (event.method !== 'goals.spawnTaskSession') return;
    if (!event.success || !event.result) return;

    const { sessionKey, goalId, taskId, planFilePath } = event.result;
    if (!sessionKey || !planFilePath) return;

    // Start watching the expected plan file path
    watchPlanFile(sessionKey, planFilePath);
  });

  // Tool: goal_update for agents to report task status
  const goalUpdateExecute = createGoalUpdateExecutor(store);

  api.registerTool(
    (ctx) => {
      if (!ctx.sessionKey) return null;
      if (isPmSession(ctx.sessionKey)) return null; // PMs plan, don't mutate goals directly

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
            status: { type: 'string', enum: ['done', 'in-progress', 'blocked', 'waiting'], description: 'New task status (use with taskId)' },
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
            files: {
              type: 'array',
              description: 'Files created or modified while working on this goal/task. Paths (strings).',
              items: { type: 'string' },
            },
            planFile: { type: 'string', description: 'Path to a plan markdown file to sync with the task (requires taskId)' },
            planStatus: { type: 'string', enum: ['none', 'draft', 'awaiting_approval', 'approved', 'rejected', 'executing', 'completed'], description: 'Update the plan status for the task (requires taskId)' },
            stepIndex: { type: 'integer', description: 'Index of the plan step to update (0-based, requires taskId)' },
            stepStatus: { type: 'string', enum: ['pending', 'in-progress', 'done', 'skipped'], description: 'New status for the plan step (use with stepIndex and taskId)' },
          },
        },
        async execute(toolCallId, params) {
          const result = await goalUpdateExecute(toolCallId, { ...params, sessionKey: ctx.sessionKey });

          // Broadcast task completion event if a task was marked done
          if (result._meta?.taskCompletedId) {
            broadcastPlanUpdate({
              event: 'goal.task_completed',
              goalId: result._meta.goalId,
              taskId: result._meta.taskCompletedId,
              allTasksDone: result._meta.allTasksDone,
              timestamp: Date.now(),
            });

            // Auto-merge when all tasks in a goal are done
            if (result._meta.allTasksDone) {
              await autoMergeGoal(result._meta.goalId);
            }

            // Auto-kickoff next tasks after task completion
            if (!result._meta.allTasksDone) {
              setTimeout(async () => {
                try {
                  const kickoffResult = await internalKickoff(result._meta.goalId);

                  if (kickoffResult.spawnedSessions?.length > 0) {
                    // Backend starts agents directly — no frontend relay needed
                    await startSpawnedSessions(kickoffResult.spawnedSessions);

                    // Broadcast for UI updates (frontend skips chat.send via headlessStarted flag)
                    broadcastPlanUpdate({
                      event: 'goal.kickoff',
                      goalId: result._meta.goalId,
                      spawnedCount: kickoffResult.spawnedSessions.length,
                      spawnedSessions: kickoffResult.spawnedSessions,
                    });
                    api.logger.info(`clawcondos-goals: auto-kickoff started ${kickoffResult.spawnedSessions.length} session(s) for goal ${result._meta.goalId}`);
                  }
                } catch (err) {
                  api.logger.error(`clawcondos-goals: auto-kickoff after task completion failed: ${err.message}`);
                }
              }, 1000);
            }

          }

          return result;
        },
      };
    },
    { names: ['goal_update'] }
  );

  // PM sessions should not have creation/spawn tools — PMs plan, users click buttons to execute
  function isPmSession(sessionKey) {
    return sessionKey && sessionKey.includes(':webchat:pm-');
  }

  // Tool: condo_bind for agents to bind their session to a condo
  const condoBindExecute = createCondoBindExecutor(store, wsOps);

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
            repoUrl: { type: 'string', description: 'Git repository URL to clone when creating a new condo (only used with name)' },
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
  const condoCreateGoalExecute = createCondoCreateGoalExecutor(store, wsOps);

  api.registerTool(
    (ctx) => {
      if (!ctx.sessionKey) return null;
      if (isPmSession(ctx.sessionKey)) return null; // PMs plan, don't create
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
      if (isPmSession(ctx.sessionKey)) return null; // PMs plan, don't create
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
      if (isPmSession(ctx.sessionKey)) return null; // PMs plan, don't create
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
          const result = await condoSpawnTaskExecute(toolCallId, { ...params, sessionKey: ctx.sessionKey });

          // Start agent directly
          if (result.taskContext && result.spawnRequest?.sessionKey) {
            try {
              await gatewayRpcCall('chat.send', {
                sessionKey: result.spawnRequest.sessionKey,
                message: result.taskContext,
              });
              result.headlessStarted = true;
            } catch (err) {
              api.logger.error(`clawcondos-goals: condo_spawn_task chat.send failed: ${err.message}`);
              result.headlessStarted = false;
            }

            broadcastPlanUpdate({
              event: 'goal.kickoff',
              goalId: params.goalId,
              spawnedCount: 1,
              spawnedSessions: [{
                taskId: params.taskId,
                taskText: result.spawnRequest.taskText || params.taskId,
                sessionKey: result.spawnRequest.sessionKey,
                taskContext: result.taskContext,
                headlessStarted: result.headlessStarted,
              }],
            });
          }

          return result;
        },
      };
    },
    { names: ['condo_spawn_task'] }
  );

  // Tool: condo_list for agents to list all condos
  const condoListExecute = createCondoListExecutor(store);

  api.registerTool(
    (ctx) => {
      if (!ctx.sessionKey) return null;
      return {
        name: 'condo_list',
        label: 'List Condos',
        description: 'List all condos (projects) with their goal counts.',
        parameters: { type: 'object', properties: {} },
        async execute(toolCallId, params) {
          return condoListExecute(toolCallId, params);
        },
      };
    },
    { names: ['condo_list'] }
  );

  // Tool: condo_status for agents to check condo progress
  const condoStatusExecute = createCondoStatusExecutor(store);

  api.registerTool(
    (ctx) => {
      if (!ctx.sessionKey) return null;
      return {
        name: 'condo_status',
        label: 'Condo Status',
        description: 'Get detailed status of a condo including all goals and tasks.',
        parameters: {
          type: 'object',
          properties: {
            condoId: { type: 'string', description: 'ID of the condo to check' },
          },
          required: ['condoId'],
        },
        async execute(toolCallId, params) {
          return condoStatusExecute(toolCallId, params);
        },
      };
    },
    { names: ['condo_status'] }
  );

  // Tool: condo_pm_chat for agents to talk to a condo's PM
  const condoPmChatExecute = createCondoPmChatExecutor(store, { gatewayRpcCall, logger: api.logger });

  api.registerTool(
    (ctx) => {
      if (!ctx.sessionKey) return null;
      if (isPmSession(ctx.sessionKey)) return null;
      const data = store.load();
      if (!data.sessionCondoIndex[ctx.sessionKey]) return null;

      return {
        name: 'condo_pm_chat',
        label: 'Chat with PM',
        description: 'Send a work request to the condo PM. The PM will plan goals and tasks. Returns the PM response.',
        parameters: {
          type: 'object',
          properties: {
            condoId: { type: 'string', description: 'ID of the condo whose PM to chat with' },
            message: { type: 'string', description: 'Your work request or message to the PM' },
          },
          required: ['condoId', 'message'],
        },
        async execute(toolCallId, params) {
          return condoPmChatExecute(toolCallId, params);
        },
      };
    },
    { names: ['condo_pm_chat'] }
  );

  // Tool: condo_pm_kickoff for agents to approve a plan and spawn workers
  const condoPmKickoffExecute = createCondoPmKickoffExecutor(store, {
    gatewayRpcCall,
    internalKickoff,
    startSpawnedSessions,
    broadcastPlanUpdate,
    logger: api.logger,
  });

  api.registerTool(
    (ctx) => {
      if (!ctx.sessionKey) return null;
      if (isPmSession(ctx.sessionKey)) return null;
      const data = store.load();
      if (!data.sessionCondoIndex[ctx.sessionKey]) return null;

      return {
        name: 'condo_pm_kickoff',
        label: 'Kickoff Goal',
        description: 'Approve a PM plan and spawn worker agents for a goal. If the goal has no tasks, triggers the PM cascade to create them first.',
        parameters: {
          type: 'object',
          properties: {
            condoId: { type: 'string', description: 'ID of the condo' },
            goalId: { type: 'string', description: 'ID of the goal to kick off' },
          },
          required: ['condoId', 'goalId'],
        },
        async execute(toolCallId, params) {
          return condoPmKickoffExecute(toolCallId, params);
        },
      };
    },
    { names: ['condo_pm_kickoff'] }
  );

  const totalMethods = Object.keys(handlers).length + Object.keys(strandHandlers).length + Object.keys(planHandlers).length + Object.keys(pmHandlers).length + Object.keys(configHandlers).length + Object.keys(teamHandlers).length + Object.keys(rolesHandlers).length + Object.keys(notificationHandlers).length + Object.keys(autonomyHandlers).length + Object.keys(sessionLifecycleHandlers).length + 11; // +11 directly: spawnTaskSession, kickoff, close, branchStatus, createPR, retryPush, retryMerge, pushMain, classification x3
  api.logger.info(`clawcondos-goals: registered ${totalMethods} gateway methods, 9 tools, ${planFileWatchers.size} plan file watchers, data at ${dataDir}`);
}
