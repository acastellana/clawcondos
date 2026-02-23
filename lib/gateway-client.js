/**
 * Internal WebSocket RPC client for serve.js to call gateway methods directly.
 * Independent of browser proxy connections.
 *
 * Usage:
 *   const client = createGatewayClient({ getWsUrl, getAuth });
 *   const payload = await client.rpcCall('sessions.list', { limit: 500 });
 */

export function createGatewayClient({ getWsUrl, getAuth, getPassword, logger, WebSocketImpl }) {
  let ws = null;
  let state = 'disconnected'; // disconnected | connecting | authenticating | connected
  let _connectPromise = null;
  let _closed = false;
  let _reqCounter = 0;
  const _pending = new Map(); // id -> { resolve, reject, timer }
  const log = logger || console;

  function _getWs() {
    if (WebSocketImpl) return WebSocketImpl;
    // Lazy-load ws module (Node.js only)
    return import('ws').then(m => m.default || m);
  }

  function _nextId() {
    return 's' + (++_reqCounter);
  }

  function _cleanup(connectTimeout) {
    if (connectTimeout) clearTimeout(connectTimeout);
    if (ws) {
      try { ws.removeAllListeners(); } catch (e) {
        log.error('[gateway-client] cleanup removeAllListeners failed:', e.message);
      }
      try { ws.close(); } catch (e) {
        log.error('[gateway-client] cleanup close failed:', e.message);
      }
      ws = null;
    }
    state = 'disconnected';
    _connectPromise = null;
  }

  function _rejectAllPending(err) {
    for (const [, p] of _pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    _pending.clear();
  }

  function _parseOrigin(url) {
    try {
      const parsed = new URL(url);
      return `http://${parsed.hostname}:${parsed.port || 80}`;
    } catch (e) {
      log.error('[gateway-client] Failed to parse gateway URL for Origin header:', url, e.message);
      return url;
    }
  }

  function connect() {
    if (_closed) return Promise.reject(new Error('Client is closed'));
    if (state === 'connected') return Promise.resolve();
    if (_connectPromise) return _connectPromise;

    _connectPromise = new Promise((resolve, reject) => {
      state = 'connecting';

      const setup = async () => {
        const WS = await _getWs();
        const url = getWsUrl();
        const origin = _parseOrigin(url);

        const headers = { Origin: origin };
        const auth = getAuth ? getAuth() : '';
        if (auth) headers['Authorization'] = `Bearer ${auth}`;
        ws = new WS(url, { headers });

        const connectTimeout = setTimeout(() => {
          if (state !== 'connected') {
            _cleanup();
            reject(new Error('Connection timeout'));
          }
        }, 10000);

        ws.on('open', () => {
          state = 'authenticating';
        });

        ws.on('message', (raw) => {
          let msg;
          try {
            const str = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
            msg = JSON.parse(str);
          } catch (e) {
            const preview = typeof raw === 'string' ? raw.slice(0, 200) : '<binary>';
            log.error('[gateway-client] Failed to parse message:', e.message, 'preview:', preview);
            return;
          }

          // Auth handshake
          if (state === 'authenticating') {
            if (msg.type === 'event' && msg.event === 'connect.challenge') {
              const authToken = getAuth ? getAuth() : '';
              const authPassword = getPassword ? getPassword() : '';
              const auth = {};
              // Token takes precedence. If token exists, do NOT send password.
              if (authToken) {
                auth.token = authToken;
              } else if (authPassword) {
                auth.password = authPassword;
              }

              const connectFrame = {
                type: 'req',
                id: _nextId(),
                method: 'connect',
                params: {
                  minProtocol: 3,
                  maxProtocol: 3,
                  client: {
                    id: process.env.CLAWCONDOS_CLIENT_ID || 'cli',
                    displayName: 'ClawCondos Server',
                    mode: process.env.CLAWCONDOS_CLIENT_MODE || 'cli',
                    version: '2.0.0',
                    platform: 'node'
                  },
                  auth
                }
              };
              ws.send(JSON.stringify(connectFrame));
              return;
            }
            if (msg.type === 'res' && msg.ok === true) {
              clearTimeout(connectTimeout);
              state = 'connected';
              log.log('[gateway-client] Connected to gateway');
              resolve();
              return;
            }
            if (msg.type === 'res' && msg.ok === false) {
              _cleanup(connectTimeout);
              reject(new Error('Gateway auth failed: ' + JSON.stringify(msg.error)));
              return;
            }
            log.error('[gateway-client] Unexpected message during auth:', JSON.stringify(msg).slice(0, 200));
          }

          // RPC responses
          if (msg.type === 'res' && msg.id && _pending.has(msg.id)) {
            const p = _pending.get(msg.id);
            _pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) {
              p.resolve(msg.payload);
            } else {
              p.reject(new Error(msg.error?.message || 'RPC error'));
            }
          }
        });

        ws.on('close', () => {
          const wasConnected = state === 'connected';
          _cleanup(connectTimeout);
          _rejectAllPending(new Error('WebSocket closed'));
          if (wasConnected) {
            log.log('[gateway-client] Disconnected, will reconnect on next call');
          }
        });

        ws.on('error', (err) => {
          log.error('[gateway-client] WebSocket error:', err.message);
          _cleanup(connectTimeout);
          _rejectAllPending(new Error('WebSocket error: ' + err.message));
          reject(new Error('WebSocket error: ' + err.message));
        });
      };

      setup().catch(err => {
        _cleanup();
        reject(err);
      });
    });

    return _connectPromise;
  }

  async function rpcCall(method, params, timeoutMs = 15000) {
    if (_closed) throw new Error('Client is closed');
    if (state !== 'connected') {
      await connect();
    }

    return new Promise((resolve, reject) => {
      const id = _nextId();
      const timer = setTimeout(() => {
        _pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      _pending.set(id, { resolve, reject, timer });

      const frame = { type: 'req', id, method, params: params || {} };
      try {
        if (!ws) throw new Error('WebSocket disconnected before send');
        ws.send(JSON.stringify(frame));
      } catch (err) {
        _pending.delete(id);
        clearTimeout(timer);
        _cleanup();
        reject(err);
      }
    });
  }

  function close() {
    _closed = true;
    _rejectAllPending(new Error('Client closed'));
    _cleanup();
  }

  function getState() {
    return state;
  }

  return { connect, rpcCall, close, getState };
}
