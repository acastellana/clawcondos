/**
 * Config RPC Handlers
 * Manages global configuration including agent roles, PM session, etc.
 * Config is stored in goals.json under the `config` key
 */

import { getDefaultRoles, getAgentForRole } from './agent-roles.js';
import { verifyGitHubToken } from './github.js';

/**
 * Create config RPC handlers
 * @param {object} store - Goals store instance
 * @param {object} options - Options
 * @param {function} [options.logger] - Logger instance
 * @returns {object} Map of method names to handlers
 */
export function createConfigHandlers(store, options = {}) {
  const { logger } = options;
  const handlers = {};

  /**
   * config.get - Get current configuration
   * Params: {}
   * Response: { config: object }
   */
  handlers['config.get'] = ({ params, respond }) => {
    try {
      const data = store.load();
      const config = data.config || {};
      
      // Merge with defaults for display
      const defaults = getDefaultRoles();
      const effectiveRoles = { ...defaults, ...(config.agentRoles || {}) };

      respond(true, {
        config: {
          ...config,
          agentRoles: config.agentRoles || {},
        },
        defaults: {
          agentRoles: defaults,
          pmSession: process.env.HELIX_PM_SESSION || 'agent:main:main',
        },
        effective: {
          agentRoles: effectiveRoles,
          pmSession: config.pmSession || process.env.HELIX_PM_SESSION || 'agent:main:main',
        },
      });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * config.set - Update configuration
   * Params: { pmSession?: string, agentRoles?: object, ... }
   * Response: { ok: boolean, config: object }
   */
  handlers['config.set'] = ({ params, respond }) => {
    try {
      const data = store.load();
      
      // Initialize config if needed
      if (!data.config) {
        data.config = {};
      }

      const { pmSession, agentRoles, ...rest } = params || {};

      // Update PM session
      if (pmSession !== undefined) {
        if (pmSession === null || pmSession === '') {
          delete data.config.pmSession;
        } else {
          data.config.pmSession = pmSession;
        }
      }

      // Update agent roles (merge, don't replace)
      if (agentRoles && typeof agentRoles === 'object') {
        data.config.agentRoles = data.config.agentRoles || {};
        for (const [role, agentId] of Object.entries(agentRoles)) {
          if (agentId === null || agentId === '') {
            // Remove custom role mapping (fall back to default)
            delete data.config.agentRoles[role];
          } else if (typeof agentId === 'string') {
            data.config.agentRoles[role] = agentId;
          }
        }
        // Clean up empty object
        if (Object.keys(data.config.agentRoles).length === 0) {
          delete data.config.agentRoles;
        }
      }

      // Allow other config fields
      const allowedFields = ['defaultModel', 'defaultAutonomy', 'notifyOnComplete', 'notifyOnBlocked'];
      for (const field of allowedFields) {
        if (field in rest) {
          if (rest[field] === null) {
            delete data.config[field];
          } else {
            data.config[field] = rest[field];
          }
        }
      }

      data.config.updatedAtMs = Date.now();
      store.save(data);

      if (logger) {
        logger.info(`config.set: updated config`);
      }

      respond(true, {
        ok: true,
        config: data.config,
      });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * config.setRole - Set a single agent role mapping
   * Params: { role: string, agentId: string, description?: string }
   * Response: { ok: boolean }
   */
  handlers['config.setRole'] = ({ params, respond }) => {
    const { role, agentId, description } = params || {};

    if (!role || typeof role !== 'string') {
      return respond(false, null, 'role is required');
    }

    try {
      const data = store.load();
      
      if (!data.config) {
        data.config = {};
      }
      if (!data.config.agentRoles) {
        data.config.agentRoles = {};
      }

      const normalizedRole = role.toLowerCase();

      if (agentId === null || agentId === '' || agentId === undefined) {
        // Remove custom mapping
        delete data.config.agentRoles[normalizedRole];
      } else {
        data.config.agentRoles[normalizedRole] = agentId;
      }

      // Handle role descriptions
      if (description !== undefined) {
        if (!data.config.roles) {
          data.config.roles = {};
        }
        if (description === null || description === '') {
          // Remove description
          if (data.config.roles[normalizedRole]) {
            delete data.config.roles[normalizedRole].description;
            // Clean up empty role entry
            if (Object.keys(data.config.roles[normalizedRole]).length === 0) {
              delete data.config.roles[normalizedRole];
            }
          }
        } else {
          if (!data.config.roles[normalizedRole]) {
            data.config.roles[normalizedRole] = {};
          }
          data.config.roles[normalizedRole].description = description;
        }
        // Clean up empty roles object
        if (Object.keys(data.config.roles).length === 0) {
          delete data.config.roles;
        }
      }

      // Clean up empty object
      if (Object.keys(data.config.agentRoles).length === 0) {
        delete data.config.agentRoles;
      }

      data.config.updatedAtMs = Date.now();
      store.save(data);

      if (logger) {
        logger.info(`config.setRole: ${role} -> ${agentId || '(default)'}${description ? ` (${description})` : ''}`);
      }

      // Return resolved agent ID
      const resolved = getAgentForRole(data, normalizedRole);

      respond(true, {
        ok: true,
        role: normalizedRole,
        agentId: agentId || null,
        resolved,
        description: data.config.roles?.[normalizedRole]?.description || null,
      });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * config.getRole - Get agent ID for a role
   * Params: { role: string }
   * Response: { agentId: string, configured: string | null }
   */
  handlers['config.getRole'] = ({ params, respond }) => {
    const { role } = params || {};

    if (!role || typeof role !== 'string') {
      return respond(false, null, 'role is required');
    }

    try {
      const data = store.load();
      const configured = data.config?.agentRoles?.[role.toLowerCase()] || null;
      const resolved = getAgentForRole(data, role.toLowerCase());
      const defaults = getDefaultRoles();

      respond(true, {
        role: role.toLowerCase(),
        agentId: resolved,
        configured,
        default: defaults[role.toLowerCase()] || role.toLowerCase(),
      });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * config.listRoles - List all role mappings
   * Params: {}
   * Response: { roles: object }
   */
  handlers['config.listRoles'] = ({ params, respond }) => {
    try {
      const data = store.load();
      const configured = data.config?.agentRoles || {};
      const roleDescriptions = data.config?.roles || {};
      const defaults = getDefaultRoles();
      
      // Build complete list with resolution
      const roles = {};
      const allRoles = new Set([
        ...Object.keys(defaults),
        ...Object.keys(configured),
        ...Object.keys(roleDescriptions),
      ]);
      
      for (const role of allRoles) {
        roles[role] = {
          agentId: getAgentForRole(data, role),
          configured: configured[role] || null,
          default: defaults[role] || role,
          description: roleDescriptions[role]?.description || null,
        };
      }

      respond(true, { roles });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  // ── Service configuration methods ──

  /**
   * Mask sensitive fields in a single service config object.
   * Replaces token/apiKey/secret values with `first4****last4` and sets fieldConfigured: true.
   */
  function maskSingleService(svc) {
    if (!svc || typeof svc !== 'object') return svc;
    const masked = { ...svc };
    const sensitiveKeys = ['token', 'apiKey', 'secret', 'password', 'accessToken', 'agentToken'];
    for (const key of sensitiveKeys) {
      if (masked[key] && typeof masked[key] === 'string') {
        const val = masked[key];
        if (val.length > 8) {
          masked[key] = val.slice(0, 4) + '****' + val.slice(-4);
        } else {
          masked[key] = '****';
        }
        masked[key + 'Configured'] = true;
      }
    }
    return masked;
  }

  /**
   * Mask sensitive fields across all service configs.
   */
  function maskServiceTokens(services) {
    if (!services || typeof services !== 'object') return {};
    const masked = {};
    for (const [name, svc] of Object.entries(services)) {
      masked[name] = maskSingleService(svc);
    }
    return masked;
  }

  /**
   * config.getServices - Returns masked service configs.
   * Accepts optional condoId to deep-merge condo overrides onto global defaults.
   * Params: { condoId?: string }
   * Response: { services, overrides? }
   */
  handlers['config.getServices'] = ({ params, respond }) => {
    try {
      const data = store.load();
      const globalServices = data.config?.services || {};

      const condoId = params?.condoId;
      if (condoId) {
        const condo = data.condos.find(c => c.id === condoId);
        if (!condo) {
          return respond(false, null, 'Condo not found');
        }
        const strandOverrides = condo.services || {};

        // Deep-merge: condo overrides on top of global defaults
        const merged = { ...globalServices };
        for (const [name, overrideCfg] of Object.entries(strandOverrides)) {
          merged[name] = { ...(merged[name] || {}), ...overrideCfg };
        }

        respond(true, {
          services: maskServiceTokens(merged),
          overrides: maskServiceTokens(strandOverrides),
        });
      } else {
        respond(true, {
          services: maskServiceTokens(globalServices),
        });
      }
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * config.setService - Sets a single service config.
   * Params: { service: string, config: object, condoId?: string }
   * Response: { ok: boolean }
   */
  handlers['config.setService'] = ({ params, respond }) => {
    try {
      const { service, config: svcConfig, condoId } = params || {};
      if (!service || typeof service !== 'string') {
        return respond(false, null, 'service name is required');
      }
      if (!svcConfig || typeof svcConfig !== 'object') {
        return respond(false, null, 'config object is required');
      }

      const data = store.load();

      if (condoId) {
        // Per-condo service override
        const condo = data.condos.find(c => c.id === condoId);
        if (!condo) {
          return respond(false, null, 'Condo not found');
        }
        if (!condo.services) condo.services = {};
        condo.services[service] = { ...(condo.services[service] || {}), ...svcConfig };
        condo.updatedAtMs = Date.now();
      } else {
        // Global service config
        if (!data.config) data.config = {};
        if (!data.config.services) data.config.services = {};
        data.config.services[service] = { ...(data.config.services[service] || {}), ...svcConfig };
        data.config.updatedAtMs = Date.now();
      }

      store.save(data);

      if (logger) {
        logger.info(`config.setService: ${service}${condoId ? ` (condo: ${condoId})` : ' (global)'}`);
      }

      respond(true, { ok: true });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * config.deleteService - Removes a service config.
   * Params: { service: string, condoId?: string }
   * Response: { ok: boolean }
   */
  handlers['config.deleteService'] = ({ params, respond }) => {
    try {
      const { service, condoId } = params || {};
      if (!service || typeof service !== 'string') {
        return respond(false, null, 'service name is required');
      }

      const data = store.load();

      if (condoId) {
        const condo = data.condos.find(c => c.id === condoId);
        if (!condo) {
          return respond(false, null, 'Condo not found');
        }
        if (condo.services) {
          delete condo.services[service];
          if (Object.keys(condo.services).length === 0) {
            delete condo.services;
          }
        }
        condo.updatedAtMs = Date.now();
      } else {
        if (data.config?.services) {
          delete data.config.services[service];
          if (Object.keys(data.config.services).length === 0) {
            delete data.config.services;
          }
        }
        if (data.config) data.config.updatedAtMs = Date.now();
      }

      store.save(data);

      if (logger) {
        logger.info(`config.deleteService: ${service}${condoId ? ` (condo: ${condoId})` : ' (global)'}`);
      }

      respond(true, { ok: true });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * config.verifyGitHub - Verify GitHub token and optionally check repo access
   * Params: { token?: string, condoId?: string, repoUrl?: string }
   * Response: verification result from verifyGitHubToken()
   */
  handlers['config.verifyGitHub'] = async ({ params, respond }) => {
    try {
      const { token: rawToken, condoId, repoUrl } = params || {};

      // Resolve the token to verify
      let tokenToVerify = rawToken;
      if (!tokenToVerify) {
        const data = store.load();

        // Check per-condo override first
        if (condoId) {
          const condo = data.condos.find(c => c.id === condoId);
          const strandGh = condo?.services?.github;
          if (strandGh?.agentToken) tokenToVerify = strandGh.agentToken;
          else if (strandGh?.token) tokenToVerify = strandGh.token;
        }

        // Fall back to global
        if (!tokenToVerify) {
          const gh = data.config?.services?.github;
          if (gh?.agentToken) tokenToVerify = gh.agentToken;
          else if (gh?.token) tokenToVerify = gh.token;
        }
      }

      if (!tokenToVerify) {
        return respond(true, { valid: false, error: 'No GitHub token configured' });
      }

      const result = await verifyGitHubToken(tokenToVerify, repoUrl || undefined);
      respond(true, result);
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  return handlers;
}
