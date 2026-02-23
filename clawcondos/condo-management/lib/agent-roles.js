/**
 * Agent Role Mapping
 * Maps role names to actual agent IDs
 * Configurable via store.config.agentRoles or environment variables
 */

/**
 * Get the agent ID for a given role
 * @param {object} store - Goals store instance (or data object)
 * @param {string} role - Role name (e.g., 'pm', 'frontend', 'backend')
 * @returns {string} Agent ID
 */
export function getAgentForRole(store, role) {
  // Handle both store instance and data object
  const data = typeof store.load === 'function' ? store.load() : store;
  const roles = data.config?.agentRoles || {};
  
  // Check configured roles first
  if (roles[role]) {
    return roles[role];
  }
  
  // Fall back to default roles (which check env vars internally)
  const defaults = getDefaultRoles();
  if (defaults[role]) {
    return defaults[role];
  }
  
  // Final fallback to role name as agent ID (for custom roles)
  return role;
}

/**
 * Get the default role mappings
 * @returns {object} Default role -> agent ID mappings
 */
export function getDefaultRoles() {
  return {
    pm: process.env.HELIX_PM_AGENT || 'main',
    frontend: process.env.HELIX_FRONTEND_AGENT || 'frontend',
    backend: process.env.HELIX_BACKEND_AGENT || 'backend',
    designer: process.env.HELIX_DESIGNER_AGENT || 'designer',
    tester: process.env.HELIX_TESTER_AGENT || 'tester',
    devops: process.env.HELIX_DEVOPS_AGENT || 'devops',
    qa: process.env.HELIX_QA_AGENT || 'qa',
  };
}

/**
 * Resolve an agent specification to an actual agent ID
 * Handles both role names and direct agent IDs
 * @param {object} store - Goals store instance
 * @param {string} spec - Role name or direct agent ID
 * @returns {string} Resolved agent ID
 */
export function resolveAgent(store, spec) {
  if (!spec) return null;
  
  // Check if it's a known role
  const defaults = getDefaultRoles();
  if (defaults.hasOwnProperty(spec.toLowerCase())) {
    return getAgentForRole(store, spec.toLowerCase());
  }
  
  // Otherwise, treat it as a direct agent ID
  return spec;
}

/**
 * Get the PM session key for a condo
 * @param {object} store - Goals store instance
 * @param {string} condoId - Condo ID
 * @returns {string} PM session key (e.g., 'agent:main:main')
 */
export function getPmSession(store, condoId) {
  const data = typeof store.load === 'function' ? store.load() : store;
  
  // Check condo-specific PM first
  if (condoId) {
    const condo = data.condos?.find(c => c.id === condoId);
    if (condo?.pmSession) {
      return condo.pmSession;
    }
  }
  
  // Fall back to global config or system default
  return data.config?.pmSession || 
         process.env.HELIX_PM_SESSION ||
         'agent:main:main';  // System default
}

/**
 * Get or create a dedicated PM session for a specific goal.
 * Creates a deterministic session key `agent:<pmAgentId>:webchat:pm-<goalId>`
 * and registers it in the session index so the before_agent_start hook
 * injects goal context automatically.
 *
 * Uses `webchat` session type (not `subagent`) because the gateway auto-creates
 * webchat sessions on chat.send, whereas subagent sessions may require the
 * parent agent to already be running.
 *
 * @param {object} store - Goals store instance (must have load/save)
 * @param {string} goalId - Goal ID
 * @returns {{ pmSessionKey: string, created: boolean }}
 */
export function getOrCreatePmSessionForGoal(store, goalId) {
  const data = store.load();
  const goal = data.goals.find(g => g.id === goalId);
  if (!goal) {
    throw new Error(`Goal ${goalId} not found`);
  }

  // Return existing PM session if it uses the correct (webchat) format
  if (goal.pmSessionKey && goal.pmSessionKey.includes(':webchat:pm-')) {
    return { pmSessionKey: goal.pmSessionKey, created: false };
  }

  // Clean up old subagent-type session key if it exists (migration)
  if (goal.pmSessionKey && data.sessionIndex) {
    delete data.sessionIndex[goal.pmSessionKey];
  }

  // Resolve PM agent ID and build deterministic key with webchat type
  const pmAgentId = getAgentForRole(data, 'pm');
  const pmSessionKey = `agent:${pmAgentId}:webchat:pm-${goalId}`;

  // Store on the goal and add to session index
  goal.pmSessionKey = pmSessionKey;
  if (!data.sessionIndex) data.sessionIndex = {};
  data.sessionIndex[pmSessionKey] = { goalId };
  store.save(data);

  return { pmSessionKey, created: true };
}

/**
 * Get or create a dedicated PM session for a condo.
 * Creates a deterministic session key `agent:<pmAgentId>:webchat:pm-condo-<condoId>`
 * and registers it in sessionCondoIndex so the before_agent_start hook
 * injects buildStrandContext() automatically.
 *
 * Uses `webchat` session type (not `subagent`) because the gateway auto-creates
 * webchat sessions on chat.send, whereas subagent sessions may require the
 * parent agent to already be running.
 *
 * @param {object} store - Goals store instance (must have load/save)
 * @param {string} condoId - Condo ID
 * @returns {{ pmSessionKey: string, created: boolean }}
 */
export function getOrCreatePmSessionForCondo(store, condoId) {
  const data = store.load();
  const condo = data.condos.find(c => c.id === condoId);
  if (!condo) {
    throw new Error(`Condo ${condoId} not found`);
  }

  // Return existing PM session if it uses the correct (webchat) format
  if (condo.pmCondoSessionKey && condo.pmCondoSessionKey.includes(':webchat:pm-condo-')) {
    return { pmSessionKey: condo.pmCondoSessionKey, created: false };
  }

  // Clean up old subagent-type session key if it exists (migration)
  if (condo.pmCondoSessionKey && data.sessionCondoIndex) {
    delete data.sessionCondoIndex[condo.pmCondoSessionKey];
  }

  // Resolve PM agent ID and build deterministic key with webchat type
  const pmAgentId = getAgentForRole(data, 'pm');
  const pmSessionKey = `agent:${pmAgentId}:webchat:pm-condo-${condoId}`;

  // Store on the condo and add to sessionCondoIndex
  condo.pmCondoSessionKey = pmSessionKey;
  if (!data.sessionCondoIndex) data.sessionCondoIndex = {};
  data.sessionCondoIndex[pmSessionKey] = condoId;
  store.save(data);

  return { pmSessionKey, created: true };
}

/**
 * Check if a session key is a per-goal PM session
 * @param {string} sessionKey - Session key to check
 * @returns {boolean}
 */
export function isPmSession(sessionKey) {
  if (typeof sessionKey !== 'string') return false;
  // Match both old subagent format and new webchat format for PM sessions
  return sessionKey.includes(':subagent:pm-') || sessionKey.includes(':webchat:pm-');
}

/**
 * Build an agent session key
 * @param {string} agentId - Agent ID
 * @param {string} sessionType - Session type (e.g., 'main', 'subagent')
 * @param {string} [subId] - Optional sub-identifier for subagents
 * @returns {string} Session key
 */
export function buildSessionKey(agentId, sessionType = 'main', subId = null) {
  const base = `agent:${agentId}:${sessionType}`;
  return subId ? `${base}:${subId}` : base;
}
