import { AUTONOMY_MODES } from './autonomy.js';
import { initGitHubRepo, pushBranch, setupGitRemote } from './github.js';

export function createCondoHandlers(store, options = {}) {
  const { wsOps, logger, rpcCall } = options;
  function loadData() { return store.load(); }
  function saveData(data) { store.save(data); }

  /**
   * Resolve GitHub config from store (global services).
   * Returns the config if authMode === 'account' and agentToken is set, else null.
   */
  function getGitHubAgentConfig() {
    try {
      const data = loadData();
      const gh = data.config?.services?.github;
      if (gh?.authMode === 'account' && gh?.agentToken && gh?.agentUsername) {
        return gh;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Resolve the raw GitHub token from store (per-condo override or global).
   * Returns the agentToken or token, whichever is configured.
   */
  function getGitHubToken(data, condoId) {
    // Check per-condo override first
    if (condoId) {
      const condo = data.condos.find(c => c.id === condoId);
      const strandGh = condo?.services?.github;
      if (strandGh?.agentToken) return strandGh.agentToken;
      if (strandGh?.token) return strandGh.token;
    }
    // Fall back to global
    const gh = data.config?.services?.github;
    if (gh?.agentToken) return gh.agentToken;
    if (gh?.token) return gh.token;
    return null;
  }

  return {
    'condos.create': async ({ params, respond }) => {
      try {
        const { name, description, color, repoUrl, autonomyMode } = params;
        if (!name || typeof name !== 'string' || !name.trim()) {
          respond(false, undefined, { message: 'name is required' });
          return;
        }
        if (autonomyMode && !AUTONOMY_MODES.includes(autonomyMode)) {
          respond(false, undefined, { message: `Invalid autonomyMode. Must be one of: ${AUTONOMY_MODES.join(', ')}` });
          return;
        }
        const data = loadData();
        const now = Date.now();
        const condoId = store.newId('condo');
        const condo = {
          id: condoId,
          name: name.trim(),
          description: typeof description === 'string' ? description : '',
          color: color || null,
          keywords: Array.isArray(params.keywords) ? params.keywords : [],
          telegramTopicIds: Array.isArray(params.telegramTopicIds) ? params.telegramTopicIds : [],
          autonomyMode: autonomyMode || null,
          workspace: null,
          createdAtMs: now,
          updatedAtMs: now,
        };

        // Create workspace if workspaces are enabled
        if (wsOps) {
          const wsResult = wsOps.createCondoWorkspace(wsOps.dir, condoId, name.trim(), repoUrl || undefined);
          if (wsResult.ok) {
            condo.workspace = { path: wsResult.path, repoUrl: repoUrl || null, createdAtMs: now };
          } else if (logger) {
            logger.error(`clawcondos-goals: workspace creation failed for condo ${condoId}: ${wsResult.error}`);
          }
        }

        // Clone-mode: embed auth token in remote URL so pushes authenticate
        if (condo.workspace?.path && repoUrl) {
          const ghToken = getGitHubToken(loadData(), null);
          if (ghToken) {
            try {
              setupGitRemote(condo.workspace.path, repoUrl, ghToken);
            } catch (err) {
              if (logger) logger.warn(`condos.create: failed to setup authenticated remote: ${err.message}`);
            }
          }
        }

        // Auto-create GitHub repo if agent account is configured and workspace exists
        if (condo.workspace?.path && !repoUrl) {
          const ghConfig = getGitHubAgentConfig();
          if (ghConfig) {
            try {
              const ghResult = await initGitHubRepo(
                condo.workspace.path,
                ghConfig,
                name.trim(),
                typeof description === 'string' ? description : '',
              );
              if (ghResult.ok) {
                condo.workspace.repoUrl = ghResult.repoUrl;
                condo.workspace.githubFullName = ghResult.fullName;
                condo.workspace.githubRepoName = ghResult.repoName;
                if (logger) {
                  logger.info(`clawcondos-goals: GitHub repo created: ${ghResult.fullName} for condo ${condoId}`);
                }
              } else if (logger) {
                logger.error(`clawcondos-goals: GitHub repo creation failed for condo ${condoId}: ${ghResult.error}`);
              }
            } catch (ghErr) {
              if (logger) {
                logger.error(`clawcondos-goals: GitHub repo creation error for condo ${condoId}: ${ghErr.message}`);
              }
            }
          }
        }

        data.condos.unshift(condo);
        saveData(data);
        respond(true, { condo });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'condos.list': ({ params, respond }) => {
      try {
        const data = loadData();
        const condos = data.condos.map(c => ({
          ...c,
          goalCount: data.goals.filter(g => g.condoId === c.id).length,
        }));
        respond(true, { condos });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'condos.get': ({ params, respond }) => {
      try {
        const data = loadData();
        const condo = data.condos.find(c => c.id === params.id);
        if (!condo) {
          respond(false, undefined, { message: 'Condo not found' });
          return;
        }
        const goals = data.goals.filter(g => g.condoId === condo.id);
        respond(true, { condo, goals });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'condos.update': ({ params, respond }) => {
      try {
        const data = loadData();
        const idx = data.condos.findIndex(c => c.id === params.id);
        if (idx === -1) {
          respond(false, undefined, { message: 'Condo not found' });
          return;
        }
        const condo = data.condos[idx];

        // Validate name if provided (match condos.create rigor)
        if ('name' in params && (!params.name || typeof params.name !== 'string' || !params.name.trim())) {
          respond(false, undefined, { message: 'name is required' });
          return;
        }

        // Whitelist allowed patch fields (prevent overwriting internal fields)
        // Validate autonomyMode if provided
        if ('autonomyMode' in params && params.autonomyMode !== null && !AUTONOMY_MODES.includes(params.autonomyMode)) {
          respond(false, undefined, { message: `Invalid autonomyMode. Must be one of: ${AUTONOMY_MODES.join(', ')}` });
          return;
        }

        const allowed = ['name', 'description', 'color', 'keywords', 'telegramTopicIds', 'autonomyMode', 'services'];
        for (const f of allowed) {
          if (f in params) {
            // Validate array fields
            if ((f === 'keywords' || f === 'telegramTopicIds') && !Array.isArray(params[f])) continue;
            condo[f] = params[f];
          }
        }
        if (typeof condo.name === 'string') condo.name = condo.name.trim();
        condo.updatedAtMs = Date.now();

        saveData(data);
        respond(true, { condo });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'condos.delete': async ({ params, respond }) => {
      try {
        const data = loadData();
        const idx = data.condos.findIndex(c => c.id === params.id);
        if (idx === -1) {
          respond(false, undefined, { message: 'Condo not found' });
          return;
        }
        const deletedCondo = data.condos[idx];

        // Collect ALL sessions associated with this condo (for abort + frontend cleanup)
        const allSessionKeys = new Set();
        // Condo PM session
        if (deletedCondo.pmCondoSessionKey) allSessionKeys.add(deletedCondo.pmCondoSessionKey);
        // Sessions from sessionCondoIndex
        for (const [sk, cId] of Object.entries(data.sessionCondoIndex || {})) {
          if (cId === params.id) allSessionKeys.add(sk);
        }
        // Goal sessions, task sessions, and goal PM sessions
        for (const goal of data.goals.filter(g => g.condoId === params.id)) {
          if (goal.pmSessionKey) allSessionKeys.add(goal.pmSessionKey);
          for (const sk of goal.sessions || []) allSessionKeys.add(sk);
          for (const task of goal.tasks || []) {
            if (task.sessionKey) allSessionKeys.add(task.sessionKey);
          }
        }
        // Kill all running sessions (best-effort)
        if (rpcCall) {
          for (const sk of allSessionKeys) {
            try { await rpcCall('sessions.delete', { sessionKey: sk }); } catch { /* may not exist */ }
            try { await rpcCall('chat.abort', { sessionKey: sk }); } catch { /* best-effort */ }
          }
        }

        // Remove workspace if it exists
        if (wsOps && deletedCondo.workspace?.path) {
          const rmResult = wsOps.removeStrandWorkspace(deletedCondo.workspace.path);
          if (!rmResult.ok && logger) {
            logger.error(`clawcondos-goals: workspace removal failed for condo ${params.id}: ${rmResult.error}`);
          }
        }

        // Cascade-delete all goals linked to this condo (and their task sessions)
        const linkedGoalIds = data.goals
          .filter(g => g.condoId === params.id)
          .map(g => g.id);
        for (const goalId of linkedGoalIds) {
          const gIdx = data.goals.findIndex(g => g.id === goalId);
          if (gIdx === -1) continue;
          const goal = data.goals[gIdx];
          // Clean up session index entries for this goal and its tasks
          for (const [key, val] of Object.entries(data.sessionIndex || {})) {
            if (val.goalId === goalId) delete data.sessionIndex[key];
          }
          // Remove worktree (workspace dir removal above handles this too, but be explicit)
          if (wsOps && goal.worktree?.path && deletedCondo.workspace?.path) {
            try { wsOps.removeGoalWorktree(deletedCondo.workspace.path, goalId, goal.worktree?.branch); } catch {}
          }
          data.goals.splice(gIdx, 1);
        }
        // Clean up sessionCondoIndex entries pointing to this condo
        if (data.sessionCondoIndex) {
          for (const [key, val] of Object.entries(data.sessionCondoIndex)) {
            if (val === params.id) delete data.sessionCondoIndex[key];
          }
        }
        // Clean up sessionIndex entries for this condo's PM session
        if (deletedCondo.pmCondoSessionKey && data.sessionIndex) {
          delete data.sessionIndex[deletedCondo.pmCondoSessionKey];
        }
        data.condos.splice(idx, 1);
        saveData(data);
        respond(true, { ok: true, killedSessions: [...allSessionKeys] });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },
  };
}
