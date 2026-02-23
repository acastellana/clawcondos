/**
 * Roles RPC Handlers
 * Agent role assignment and listing with labels
 */

import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { getDefaultRoles, getAgentForRole } from './agent-roles.js';

/**
 * Keywords for auto-detecting agent roles
 */
const ROLE_KEYWORDS = {
  frontend: ['frontend', 'ui', 'react', 'vue', 'angular', 'flutter', 'css', 'html', 'web', 'mobile'],
  backend: ['backend', 'api', 'database', 'server', 'node', 'python', 'java', 'go', 'rust', 'sql'],
  designer: ['design', 'ux', 'figma', 'visual', 'mockup', 'wireframe', 'sketch', 'photoshop'],
  tester: ['test', 'qa', 'quality', 'automation', 'cypress', 'jest', 'selenium', 'e2e'],
  researcher: ['research', 'analysis', 'data', 'insights', 'report', 'documentation'],
  devops: ['devops', 'ci', 'cd', 'docker', 'kubernetes', 'aws', 'azure', 'infrastructure', 'deploy'],
};

/**
 * Default agent labels (emoji + name)
 * Can be overridden via config.agentLabels
 */
const DEFAULT_AGENT_LABELS = {
  main: { emoji: '🧠', name: 'Main' },
  pm: { emoji: '📋', name: 'PM' },
  frontend: { emoji: '🎨', name: 'Frontend' },
  backend: { emoji: '⚙️', name: 'Backend' },
  designer: { emoji: '🎭', name: 'Designer' },
  tester: { emoji: '🧪', name: 'Tester' },
  devops: { emoji: '🔧', name: 'DevOps' },
  qa: { emoji: '✅', name: 'QA' },
  // Common agent names
  felix: { emoji: '🎨', name: 'Félix' },
  blake: { emoji: '⚙️', name: 'Blake' },
  claudia: { emoji: '🧠', name: 'Claudia' },
};

/**
 * Get label for an agent ID
 * @param {object} config - Config object (may contain agentLabels)
 * @param {string} agentId - Agent ID
 * @returns {{ emoji: string, name: string }}
 */
function getAgentLabel(config, agentId) {
  const id = (agentId || '').toLowerCase();
  
  // Check custom labels first
  if (config?.agentLabels?.[id]) {
    return config.agentLabels[id];
  }
  
  // Check defaults
  if (DEFAULT_AGENT_LABELS[id]) {
    return DEFAULT_AGENT_LABELS[id];
  }
  
  // Generate default label from agent ID
  const name = agentId
    ? agentId.charAt(0).toUpperCase() + agentId.slice(1)
    : 'Unknown';
  
  return { emoji: '🤖', name };
}

/**
 * Build formatted label string
 * @param {object} label - { emoji, name }
 * @returns {string}
 */
function formatLabel(label) {
  return `${label.name} ${label.emoji}`;
}

/**
 * Create roles RPC handlers
 * @param {object} store - Goals store instance
 * @param {object} options - Options
 * @param {function} [options.broadcast] - Function to broadcast events
 * @param {function} [options.logger] - Logger instance
 * @returns {object} Map of method names to handlers
 */
export function createRolesHandlers(store, options = {}) {
  const { broadcast, logger } = options;
  const handlers = {};

  /**
   * roles.assign - Assign a role to an agent
   * Params: { agentId: string, role: string }
   * Response: { ok: boolean, agentId: string, role: string, label: string }
   */
  handlers['roles.assign'] = ({ params, respond }) => {
    const { agentId, role } = params || {};

    if (!agentId || typeof agentId !== 'string') {
      return respond(false, null, 'agentId is required');
    }

    if (!role || typeof role !== 'string') {
      return respond(false, null, 'role is required');
    }

    try {
      const data = store.load();
      
      // Initialize config if needed
      if (!data.config) {
        data.config = {};
      }
      if (!data.config.agentRoles) {
        data.config.agentRoles = {};
      }

      // Set the role mapping (role -> agentId)
      const normalizedRole = role.toLowerCase();
      data.config.agentRoles[normalizedRole] = agentId;
      data.config.updatedAtMs = Date.now();
      
      store.save(data);

      // Get label for response
      const label = getAgentLabel(data.config, agentId);

      if (logger) {
        logger.info(`roles.assign: ${role} -> ${agentId} (${formatLabel(label)})`);
      }

      // Broadcast update
      if (broadcast) {
        broadcast({
          type: 'event',
          event: 'roles.updated',
          payload: {
            agentId,
            role: normalizedRole,
            label: formatLabel(label),
            timestamp: Date.now(),
          },
        });
      }

      respond(true, {
        ok: true,
        agentId,
        role: normalizedRole,
        label: formatLabel(label),
      });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * roles.list - List all agents with their assigned roles
   * Params: { includeUnassigned?: boolean }
   * Response: { agents: array, roleDescriptions: object }
   */
  handlers['roles.list'] = ({ params, respond }) => {
    const { includeUnassigned = false } = params || {};

    try {
      const data = store.load();
      const config = data.config || {};
      const configuredRoles = config.agentRoles || {};
      const roleDescriptions = config.roles || {};
      const defaults = getDefaultRoles();

      // Build map of agentId -> { roles, label }
      const agentMap = new Map();

      // Helper to add role to agent
      const addRole = (agentId, role, isConfigured = false) => {
        if (!agentId) return;
        
        if (!agentMap.has(agentId)) {
          const label = getAgentLabel(config, agentId);
          agentMap.set(agentId, {
            id: agentId,
            roles: [],
            label: formatLabel(label),
            emoji: label.emoji,
            name: label.name,
          });
        }
        
        const agent = agentMap.get(agentId);
        if (!agent.roles.includes(role)) {
          agent.roles.push(role);
        }
        
        // Track if this is a configured (non-default) assignment
        if (isConfigured) {
          agent.isConfigured = true;
        }
      };

      // Add configured roles
      for (const [role, agentId] of Object.entries(configuredRoles)) {
        addRole(agentId, role, true);
      }

      // Add default roles (if not overridden)
      for (const [role, defaultAgentId] of Object.entries(defaults)) {
        if (!configuredRoles[role]) {
          addRole(defaultAgentId, role, false);
        }
      }

      // Also add known agents from task assignments
      if (includeUnassigned) {
        for (const goal of data.goals || []) {
          for (const task of goal.tasks || []) {
            if (task.assignedAgent && !agentMap.has(task.assignedAgent)) {
              addRole(task.assignedAgent, null, false);
            }
          }
        }
      }

      // Convert to array and format
      const agents = Array.from(agentMap.values()).map(agent => ({
        id: agent.id,
        role: agent.roles[0] || null,  // Primary role
        roles: agent.roles,            // All roles
        label: agent.label,
        emoji: agent.emoji,
        name: agent.name,
        isConfigured: agent.isConfigured || false,
      }));

      // Sort: configured first, then alphabetically
      agents.sort((a, b) => {
        if (a.isConfigured !== b.isConfigured) {
          return a.isConfigured ? -1 : 1;
        }
        return a.id.localeCompare(b.id);
      });

      // Build role descriptions map for the response
      const descriptions = {};
      for (const role of Object.keys(roleDescriptions)) {
        if (roleDescriptions[role]?.description) {
          descriptions[role] = roleDescriptions[role].description;
        }
      }

      respond(true, { agents, roleDescriptions: descriptions });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * roles.unassign - Remove a role assignment
   * Params: { role: string }
   * Response: { ok: boolean }
   */
  handlers['roles.unassign'] = ({ params, respond }) => {
    const { role } = params || {};

    if (!role || typeof role !== 'string') {
      return respond(false, null, 'role is required');
    }

    try {
      const data = store.load();
      
      if (!data.config?.agentRoles) {
        return respond(true, { ok: true, note: 'No custom role assignments exist' });
      }

      const normalizedRole = role.toLowerCase();
      const previousAgent = data.config.agentRoles[normalizedRole];
      
      if (!previousAgent) {
        return respond(true, { ok: true, note: 'Role was not assigned' });
      }

      delete data.config.agentRoles[normalizedRole];
      
      // Clean up empty object
      if (Object.keys(data.config.agentRoles).length === 0) {
        delete data.config.agentRoles;
      }
      
      data.config.updatedAtMs = Date.now();
      store.save(data);

      if (logger) {
        logger.info(`roles.unassign: ${role} (was ${previousAgent})`);
      }

      // Broadcast update
      if (broadcast) {
        broadcast({
          type: 'event',
          event: 'roles.updated',
          payload: {
            role: normalizedRole,
            previousAgent,
            agentId: null,
            timestamp: Date.now(),
          },
        });
      }

      respond(true, {
        ok: true,
        role: normalizedRole,
        previousAgent,
      });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * roles.setLabel - Set custom label for an agent
   * Params: { agentId: string, emoji?: string, name?: string }
   * Response: { ok: boolean, label: string }
   */
  handlers['roles.setLabel'] = ({ params, respond }) => {
    const { agentId, emoji, name } = params || {};

    if (!agentId || typeof agentId !== 'string') {
      return respond(false, null, 'agentId is required');
    }

    if (!emoji && !name) {
      return respond(false, null, 'emoji or name is required');
    }

    try {
      const data = store.load();
      
      if (!data.config) {
        data.config = {};
      }
      if (!data.config.agentLabels) {
        data.config.agentLabels = {};
      }

      const id = agentId.toLowerCase();
      const currentLabel = getAgentLabel(data.config, id);

      data.config.agentLabels[id] = {
        emoji: emoji || currentLabel.emoji,
        name: name || currentLabel.name,
      };
      
      data.config.updatedAtMs = Date.now();
      store.save(data);

      const newLabel = data.config.agentLabels[id];

      if (logger) {
        logger.info(`roles.setLabel: ${agentId} -> ${formatLabel(newLabel)}`);
      }

      respond(true, {
        ok: true,
        agentId: id,
        label: formatLabel(newLabel),
        emoji: newLabel.emoji,
        name: newLabel.name,
      });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * roles.autoDetect - Auto-detect roles based on agent SOUL.md/IDENTITY.md
   * Params: {}
   * Response: { suggestions: [{ agentId, suggestedRole, confidence, reason }] }
   */
  handlers['roles.autoDetect'] = ({ params, respond }) => {
    try {
      const workspacesEnv = process.env.CLAWCONDOS_AGENT_WORKSPACES;
      
      if (!workspacesEnv) {
        return respond(true, {
          suggestions: [],
          note: 'CLAWCONDOS_AGENT_WORKSPACES env var not set',
        });
      }

      // Parse workspace paths (comma-separated: "agentId=/path/to/workspace,...")
      const workspaces = workspacesEnv.split(',').map(entry => {
        const [agentId, path] = entry.trim().split('=');
        return { agentId: agentId?.trim(), path: path?.trim() };
      }).filter(w => w.agentId && w.path);

      const suggestions = [];

      for (const { agentId, path } of workspaces) {
        // Try to read SOUL.md or IDENTITY.md
        let content = null;
        const soulPath = join(path, 'SOUL.md');
        const identityPath = join(path, 'IDENTITY.md');

        try {
          if (existsSync(soulPath)) {
            content = readFileSync(soulPath, 'utf-8');
          } else if (existsSync(identityPath)) {
            content = readFileSync(identityPath, 'utf-8');
          }
        } catch (err) {
          // Skip this agent if we can't read the file
          if (logger) {
            logger.warn(`roles.autoDetect: Could not read identity file for ${agentId}: ${err.message}`);
          }
          continue;
        }

        if (!content) {
          continue;
        }

        // Analyze content for keywords
        const contentLower = content.toLowerCase();
        const roleScores = {};

        for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
          let score = 0;
          const matchedKeywords = [];

          for (const keyword of keywords) {
            // Count occurrences (case insensitive)
            const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
            const matches = contentLower.match(regex);
            if (matches) {
              score += matches.length;
              if (!matchedKeywords.includes(keyword)) {
                matchedKeywords.push(keyword);
              }
            }
          }

          if (score > 0) {
            roleScores[role] = { score, keywords: matchedKeywords };
          }
        }

        // Find the best matching role
        const sortedRoles = Object.entries(roleScores)
          .sort(([, a], [, b]) => b.score - a.score);

        if (sortedRoles.length > 0) {
          const [bestRole, { score, keywords }] = sortedRoles[0];
          
          // Calculate confidence (0-1) based on score and keyword variety
          const confidence = Math.min(1, (score / 10) * (keywords.length / 3));

          suggestions.push({
            agentId,
            suggestedRole: bestRole,
            confidence: Math.round(confidence * 100) / 100,
            reason: `Found keywords: ${keywords.join(', ')}`,
            matchedKeywords: keywords,
          });
        }
      }

      if (logger) {
        logger.info(`roles.autoDetect: Detected ${suggestions.length} role suggestions`);
      }

      respond(true, { suggestions });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * roles.applyAutoDetect - Apply auto-detected role suggestions
   * Params: { suggestions: [{ agentId, role, description? }] }
   * Response: { ok: boolean, applied: number }
   */
  handlers['roles.applyAutoDetect'] = ({ params, respond }) => {
    const { suggestions } = params || {};

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      return respond(false, null, 'suggestions array is required');
    }

    try {
      const data = store.load();
      
      if (!data.config) {
        data.config = {};
      }
      if (!data.config.agentRoles) {
        data.config.agentRoles = {};
      }
      if (!data.config.roles) {
        data.config.roles = {};
      }

      let applied = 0;
      const results = [];

      for (const suggestion of suggestions) {
        const { agentId, role, description } = suggestion;

        if (!agentId || !role) {
          results.push({ agentId, role, error: 'agentId and role required' });
          continue;
        }

        const normalizedRole = role.toLowerCase();
        
        // Set the role mapping
        data.config.agentRoles[normalizedRole] = agentId;

        // Set description if provided
        if (description) {
          if (!data.config.roles[normalizedRole]) {
            data.config.roles[normalizedRole] = {};
          }
          data.config.roles[normalizedRole].description = description;
        }

        applied++;
        results.push({ agentId, role: normalizedRole, applied: true });
      }

      data.config.updatedAtMs = Date.now();
      store.save(data);

      if (logger) {
        logger.info(`roles.applyAutoDetect: Applied ${applied} role assignments`);
      }

      // Broadcast update
      if (broadcast) {
        broadcast({
          type: 'event',
          event: 'roles.updated',
          payload: {
            action: 'autoDetect',
            applied,
            timestamp: Date.now(),
          },
        });
      }

      respond(true, { ok: true, applied, results });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  return handlers;
}
