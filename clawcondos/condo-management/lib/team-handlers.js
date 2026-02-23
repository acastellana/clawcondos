/**
 * Team RPC Handlers
 * Provides team chat support for goals - get messages from task sessions and broadcast
 */

import { getPmSession, getAgentForRole } from './agent-roles.js';

/**
 * Create team RPC handlers
 * @param {object} store - Goals store instance
 * @param {object} options - Options
 * @param {function} options.sendToSession - Function to send message to a session
 * @param {function} options.getSessionHistory - Function to get session history
 * @param {function} [options.broadcast] - Function to broadcast events
 * @param {function} [options.logger] - Logger instance
 * @returns {object} Map of method names to handlers
 */
export function createTeamHandlers(store, options = {}) {
  const { sendToSession, getSessionHistory, broadcast, logger } = options;
  const handlers = {};

  /**
   * team.getMessages - Get all messages from task sessions for a goal
   * Params: { goalId: string, limit?: number }
   * Response: { messages: array, sessions: array }
   */
  handlers['team.getMessages'] = async ({ params, respond }) => {
    const { goalId, limit = 100 } = params || {};

    if (!goalId) {
      return respond(false, null, 'goalId is required');
    }

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);

      if (!goal) {
        return respond(false, null, `Goal ${goalId} not found`);
      }

      // Collect all session keys from tasks
      const taskSessions = (goal.tasks || [])
        .filter(t => t.sessionKey)
        .map(t => ({
          sessionKey: t.sessionKey,
          taskId: t.id,
          taskText: t.text,
          agentId: t.assignedAgent || 'unknown',
          status: t.status,
        }));

      // Also include goal-level sessions
      const goalSessions = (goal.sessions || []).map(sk => ({
        sessionKey: sk,
        taskId: null,
        taskText: null,
        agentId: null,
        status: null,
      }));

      const allSessions = [...taskSessions, ...goalSessions];

      if (!getSessionHistory) {
        // If we don't have the function, return session metadata only
        return respond(true, {
          messages: [],
          sessions: allSessions,
          note: 'getSessionHistory not available - returning session list only',
        });
      }

      // Fetch messages from all sessions
      const messages = [];
      for (const session of allSessions) {
        try {
          const history = await getSessionHistory(session.sessionKey, { limit: Math.ceil(limit / allSessions.length) });
          if (history && Array.isArray(history)) {
            for (const msg of history) {
              messages.push({
                ...msg,
                sessionKey: session.sessionKey,
                taskId: session.taskId,
                agentId: session.agentId,
              });
            }
          }
        } catch (err) {
          if (logger) {
            logger.warn(`team.getMessages: failed to fetch history for ${session.sessionKey}: ${err.message}`);
          }
        }
      }

      // Sort by timestamp
      messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      // Limit total messages
      const limited = messages.slice(-limit);

      respond(true, {
        messages: limited,
        sessions: allSessions,
        total: messages.length,
        limited: messages.length > limit,
      });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * team.send - Broadcast a message to all active task sessions for a goal
   * Params: { goalId: string, message: string, excludeSessions?: string[] }
   * Response: { sent: number, failed: number, results: array }
   */
  handlers['team.send'] = async ({ params, respond }) => {
    const { goalId, message, excludeSessions = [] } = params || {};

    if (!goalId) {
      return respond(false, null, 'goalId is required');
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      return respond(false, null, 'message is required');
    }

    if (!sendToSession) {
      return respond(false, null, 'sendToSession not available');
    }

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);

      if (!goal) {
        return respond(false, null, `Goal ${goalId} not found`);
      }

      // Get active task sessions (not done, has session)
      const activeTasks = (goal.tasks || []).filter(t => 
        t.sessionKey && 
        t.status !== 'done' &&
        !excludeSessions.includes(t.sessionKey)
      );

      if (activeTasks.length === 0) {
        return respond(true, {
          sent: 0,
          failed: 0,
          results: [],
          note: 'No active task sessions to send to',
        });
      }

      const results = [];
      let sent = 0;
      let failed = 0;

      for (const task of activeTasks) {
        try {
          await sendToSession(task.sessionKey, {
            type: 'team_message',
            goalId,
            message: message.trim(),
            timestamp: Date.now(),
          });

          results.push({
            sessionKey: task.sessionKey,
            taskId: task.id,
            agentId: task.assignedAgent,
            success: true,
          });
          sent++;
        } catch (err) {
          results.push({
            sessionKey: task.sessionKey,
            taskId: task.id,
            agentId: task.assignedAgent,
            success: false,
            error: err.message,
          });
          failed++;
        }
      }

      if (logger) {
        logger.info(`team.send: sent to ${sent}/${activeTasks.length} sessions for goal ${goalId}`);
      }

      // Broadcast team message event
      if (broadcast) {
        broadcast({
          type: 'event',
          event: 'team.message',
          payload: {
            goalId,
            message: message.trim(),
            sentTo: results.filter(r => r.success).map(r => r.sessionKey),
            timestamp: Date.now(),
          },
        });
      }

      respond(true, {
        sent,
        failed,
        total: activeTasks.length,
        results,
      });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * team.notify - Send a notification to the PM and optionally to task sessions
   * Params: { goalId: string, message: string, type?: string, notifyTasks?: boolean }
   * Response: { ok: boolean, notified: array }
   */
  handlers['team.notify'] = async ({ params, respond }) => {
    const { goalId, message, type = 'info', notifyTasks = false } = params || {};

    if (!goalId) {
      return respond(false, null, 'goalId is required');
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      return respond(false, null, 'message is required');
    }

    if (!sendToSession) {
      return respond(false, null, 'sendToSession not available');
    }

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);

      if (!goal) {
        return respond(false, null, `Goal ${goalId} not found`);
      }

      const notified = [];
      
      // Notify PM
      const pmSession = getPmSession(store, goal.condoId);
      try {
        await sendToSession(pmSession, {
          type: 'team_notification',
          notificationType: type,
          goalId,
          goalTitle: goal.title,
          message: message.trim(),
          timestamp: Date.now(),
        });
        notified.push({ sessionKey: pmSession, role: 'pm', success: true });
      } catch (err) {
        notified.push({ sessionKey: pmSession, role: 'pm', success: false, error: err.message });
      }

      // Optionally notify task sessions
      if (notifyTasks) {
        const activeTasks = (goal.tasks || []).filter(t => 
          t.sessionKey && 
          t.status !== 'done'
        );

        for (const task of activeTasks) {
          try {
            await sendToSession(task.sessionKey, {
              type: 'team_notification',
              notificationType: type,
              goalId,
              goalTitle: goal.title,
              message: message.trim(),
              timestamp: Date.now(),
            });
            notified.push({ 
              sessionKey: task.sessionKey, 
              taskId: task.id,
              agentId: task.assignedAgent,
              success: true,
            });
          } catch (err) {
            notified.push({ 
              sessionKey: task.sessionKey, 
              taskId: task.id,
              agentId: task.assignedAgent,
              success: false, 
              error: err.message,
            });
          }
        }
      }

      if (logger) {
        const successCount = notified.filter(n => n.success).length;
        logger.info(`team.notify: notified ${successCount}/${notified.length} for goal ${goalId}`);
      }

      respond(true, {
        ok: true,
        notified,
        pmSession,
      });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  /**
   * team.status - Get status of all team members (sessions) for a goal
   * Params: { goalId: string }
   * Response: { members: array, summary: object }
   */
  handlers['team.status'] = ({ params, respond }) => {
    const { goalId } = params || {};

    if (!goalId) {
      return respond(false, null, 'goalId is required');
    }

    try {
      const data = store.load();
      const goal = data.goals.find(g => g.id === goalId);

      if (!goal) {
        return respond(false, null, `Goal ${goalId} not found`);
      }

      const members = [];
      const summary = {
        total: 0,
        active: 0,
        done: 0,
        blocked: 0,
        waiting: 0,
        pending: 0,
      };

      // Add PM as a member
      const pmSession = getPmSession(store, goal.condoId);
      members.push({
        role: 'pm',
        sessionKey: pmSession,
        taskId: null,
        status: 'active',
        isActive: true,
      });

      // Add task sessions
      for (const task of goal.tasks || []) {
        const member = {
          role: task.assignedAgent || 'unassigned',
          sessionKey: task.sessionKey || null,
          taskId: task.id,
          taskText: task.text,
          status: task.status || 'pending',
          isActive: !!task.sessionKey && task.status !== 'done',
        };
        members.push(member);
        summary.total++;
        
        switch (task.status) {
          case 'done':
            summary.done++;
            break;
          case 'in-progress':
            summary.active++;
            break;
          case 'blocked':
            summary.blocked++;
            break;
          case 'waiting':
            summary.waiting++;
            break;
          default:
            summary.pending++;
        }
      }

      respond(true, {
        goalId,
        goalTitle: goal.title,
        members,
        summary,
        pmSession,
      });
    } catch (err) {
      respond(false, null, err.message);
    }
  };

  return handlers;
}
