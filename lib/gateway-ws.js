/**
 * Gateway WebSocket Client for Sharp
 * Uses the same protocol as Clawdbot's native WebChat
 */

class GatewayWS {
  constructor(options = {}) {
    // Get URL from options, config, or smart default
    // Priority: options.url > window.SharpConfig > hostname-based default
    const config = (typeof window !== 'undefined' && window.SharpConfig) || {};
    const isSecure = typeof location !== 'undefined' && location.protocol === 'https:';
    const hostname = typeof location !== 'undefined' ? location.hostname : 'localhost';
    const defaultUrl = config.gatewayWsUrl || `${isSecure ? 'wss' : 'ws'}://${hostname}/`;
    this.url = options.url || defaultUrl;
    this.auth = options.auth || null; // { token } or { password }
    this.ws = null;
    this.connected = false;
    this.reqId = 0;
    this.pending = new Map(); // id -> { resolve, reject, timeout }
    this.eventHandlers = new Map(); // event -> [handlers]
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.sessionKey = options.sessionKey || config.defaultSessionKey || 'agent:main:main';
    
    this.onConnect = options.onConnect || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});
    this.onError = options.onError || console.error;
  }
  
  connect() {
    if (this.ws) {
      this.ws.close();
    }
    
    // Build URL with auth
    let url = this.url;
    if (this.auth?.password) {
      url += `?password=${encodeURIComponent(this.auth.password)}`;
    } else if (this.auth?.token) {
      url += `?token=${encodeURIComponent(this.auth.token)}`;
    }
    
    this.ws = new WebSocket(url);
    
    this.ws.onopen = () => {
      this._sendConnect();
    };
    
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleMessage(msg);
      } catch (err) {
        this.onError('Failed to parse message', err);
      }
    };
    
    this.ws.onerror = (err) => {
      this.onError('WebSocket error', err);
    };
    
    this.ws.onclose = () => {
      this.connected = false;
      this.onDisconnect();
      
      // Reject all pending requests
      for (const [id, p] of this.pending) {
        p.reject(new Error('WebSocket closed'));
        clearTimeout(p.timeout);
      }
      this.pending.clear();
      
      // Auto-reconnect
      setTimeout(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
        this.connect();
      }, this.reconnectDelay);
    };
  }
  
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
  
  _sendConnect() {
    this._send({
      type: 'req',
      id: this._nextId(),
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'clawdbot-control-ui',
          displayName: 'Sharp Dashboard',
          version: '1.0.0',
          platform: navigator.platform || 'web',
          mode: 'ui'
        }
      }
    });
  }
  
  _send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
  
  _nextId() {
    return `r${++this.reqId}`;
  }
  
  _handleMessage(msg) {
    if (msg.type === 'res') {
      // Handle hello-ok (connection established)
      if (msg.payload?.type === 'hello-ok') {
        this.connected = true;
        this.reconnectDelay = 1000;
        this.onConnect(msg.payload);
        return;
      }
      
      // Handle regular responses
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timeout);
        
        if (msg.ok) {
          p.resolve(msg.payload);
        } else {
          p.reject(new Error(msg.error?.message || 'Request failed'));
        }
      }
    } else if (msg.type === 'event') {
      // Handle events
      const handlers = this.eventHandlers.get(msg.event) || [];
      for (const handler of handlers) {
        try {
          handler(msg.payload, msg);
        } catch (err) {
          this.onError('Event handler error', err);
        }
      }
    }
  }
  
  // Make a request and wait for response
  async request(method, params = {}, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);
      
      this.pending.set(id, { resolve, reject, timeout });
      
      this._send({
        type: 'req',
        id,
        method,
        params
      });
    });
  }
  
  // Subscribe to events
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
    return () => this.off(event, handler);
  }
  
  off(event, handler) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // HIGH-LEVEL METHODS
  // ═══════════════════════════════════════════════════════════════
  
  // Get session history
  async getHistory(sessionKey, limit = 50) {
    return this.request('chat.history', {
      sessionKey: sessionKey || this.sessionKey,
      limit
    });
  }
  
  // Send a message (returns when agent completes)
  async send(message, sessionKey) {
    return this.request('chat.send', {
      sessionKey: sessionKey || this.sessionKey,
      message
    });
  }
  
  // Abort the current run
  async abort(sessionKey) {
    return this.request('chat.abort', {
      sessionKey: sessionKey || this.sessionKey
    });
  }
  
  // Inject an assistant message (no agent run)
  async inject(content, sessionKey) {
    return this.request('chat.inject', {
      sessionKey: sessionKey || this.sessionKey,
      content
    });
  }
  
  // List sessions
  async listSessions(limit = 50, messageLimit = 1) {
    return this.request('sessions.list', { limit, messageLimit });
  }
  
  // Health check
  async health() {
    return this.request('health', {});
  }
}

// Export for both module and global use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GatewayWS;
} else {
  window.GatewayWS = GatewayWS;
}
