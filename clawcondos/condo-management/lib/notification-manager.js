/**
 * Notification Manager - Handles in-app notifications for ClawCondos
 */

import crypto from 'crypto';

/**
 * Create a notification
 * @param {object} store - Goals store instance
 * @param {object} options - Notification options
 * @param {string} options.type - Notification type (plan_approved, plan_rejected, task_done, etc.)
 * @param {string} [options.goalId] - Related goal ID
 * @param {string} [options.taskId] - Related task ID
 * @param {string} [options.sessionKey] - Related session key
 * @param {string} options.title - Notification title
 * @param {string} [options.detail] - Notification detail/body
 * @returns {object} Created notification
 */
export function createNotification(store, { type, goalId, taskId, sessionKey, title, detail }) {
  const data = store.load();
  
  if (!data.notifications) {
    data.notifications = [];
  }
  
  const notification = {
    id: `notif_${crypto.randomBytes(8).toString('hex')}`,
    type,
    goalId: goalId || null,
    taskId: taskId || null,
    sessionKey: sessionKey || null,
    title,
    detail: detail || null,
    read: false,
    dismissed: false,
    createdAtMs: Date.now(),
  };
  
  data.notifications.push(notification);
  
  // Keep only last 500 notifications
  if (data.notifications.length > 500) {
    data.notifications = data.notifications.slice(-500);
  }
  
  store.save(data);
  
  return notification;
}

/**
 * Mark notifications as read
 * @param {object} store - Goals store instance
 * @param {string[]} ids - Notification IDs to mark as read
 * @returns {number} Number of notifications marked
 */
export function markRead(store, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return 0;
  }
  
  const data = store.load();
  
  if (!data.notifications) {
    return 0;
  }
  
  const idSet = new Set(ids);
  let count = 0;
  
  for (const notif of data.notifications) {
    if (idSet.has(notif.id) && !notif.read) {
      notif.read = true;
      notif.readAtMs = Date.now();
      count++;
    }
  }
  
  if (count > 0) {
    store.save(data);
  }
  
  return count;
}

/**
 * Dismiss a notification
 * @param {object} store - Goals store instance
 * @param {string} id - Notification ID to dismiss
 * @returns {boolean} Whether notification was dismissed
 */
export function dismiss(store, id) {
  if (!id) {
    return false;
  }
  
  const data = store.load();
  
  if (!data.notifications) {
    return false;
  }
  
  const notif = data.notifications.find(n => n.id === id);
  
  if (!notif) {
    return false;
  }
  
  notif.dismissed = true;
  notif.dismissedAtMs = Date.now();
  
  store.save(data);
  
  return true;
}

/**
 * Get unread notification count
 * @param {object} store - Goals store instance
 * @returns {number} Number of unread notifications
 */
export function getUnreadCount(store) {
  const data = store.load();
  
  if (!data.notifications) {
    return 0;
  }
  
  return data.notifications.filter(n => !n.read && !n.dismissed).length;
}

/**
 * Get notifications with filters
 * @param {object} store - Goals store instance
 * @param {object} [options] - Filter options
 * @param {boolean} [options.unreadOnly=false] - Only return unread
 * @param {boolean} [options.includeDismissed=false] - Include dismissed
 * @param {number} [options.limit=50] - Max notifications to return
 * @param {string} [options.type] - Filter by type
 * @returns {object[]} Notifications
 */
export function getNotifications(store, options = {}) {
  const { unreadOnly = false, includeDismissed = false, limit = 50, type } = options;
  
  const data = store.load();
  
  if (!data.notifications) {
    return [];
  }
  
  let results = data.notifications.filter(n => {
    if (!includeDismissed && n.dismissed) return false;
    if (unreadOnly && n.read) return false;
    if (type && n.type !== type) return false;
    return true;
  });
  
  // Sort by createdAtMs descending (newest first)
  results.sort((a, b) => b.createdAtMs - a.createdAtMs);
  
  return results.slice(0, limit);
}

/**
 * Create notification handlers for RPC
 * @param {object} store - Goals store instance
 * @returns {object} Map of method names to handlers
 */
export function createNotificationHandlers(store) {
  const handlers = {};
  
  handlers['notifications.list'] = ({ params, respond }) => {
    try {
      const notifications = getNotifications(store, params || {});
      const unreadCount = getUnreadCount(store);
      respond(true, { notifications, unreadCount });
    } catch (err) {
      respond(false, null, err.message);
    }
  };
  
  handlers['notifications.markRead'] = ({ params, respond }) => {
    const { ids } = params || {};
    
    if (!Array.isArray(ids)) {
      return respond(false, null, 'ids must be an array');
    }
    
    try {
      const count = markRead(store, ids);
      respond(true, { marked: count });
    } catch (err) {
      respond(false, null, err.message);
    }
  };
  
  handlers['notifications.dismiss'] = ({ params, respond }) => {
    const { id } = params || {};
    
    if (!id) {
      return respond(false, null, 'id is required');
    }
    
    try {
      const dismissed = dismiss(store, id);
      respond(true, { dismissed });
    } catch (err) {
      respond(false, null, err.message);
    }
  };
  
  handlers['notifications.unreadCount'] = ({ respond }) => {
    try {
      const count = getUnreadCount(store);
      respond(true, { count });
    } catch (err) {
      respond(false, null, err.message);
    }
  };
  
  return handlers;
}
