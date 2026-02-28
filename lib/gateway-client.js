/**
 * Internal WebSocket RPC client for serve.js to call gateway methods directly.
 * Independent of browser proxy connections.
 *
 * Usage:
 *   const client = createGatewayClient({ getWsUrl, getAuth });
 *   const payload = await client.rpcCall('sessions.list', { limit: 500 });
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { sign as cryptoSign, createPrivateKey, randomUUID } from 'crypto';
import { homedir } from 'os';

/**
 * Build device auth params for the gateway connect frame.
 * Returns { auth, device, role, scopes } or null if identity unavailable.
 * The gateway requires: auth.token = deviceToken + device = signed identity object.
 */
function buildDeviceConnectParams(scopes = ['operator.admin', 'operator.read'], challengeNonce = null) {
  try {
    // Support dedicated identity dir to avoid CLI overwriting shared ~/.openclaw/identity/
    const identityDir = process.env.CLAWCONDOS_IDENTITY_DIR
      ? process.env.CLAWCONDOS_IDENTITY_DIR
      : join(homedir(), '.openclaw', 'identity');
    const deviceFile = join(identityDir, 'device.json');
    const authFile = join(identityDir, 'device-auth.json');
    // device-auth.json is optional — fall back to GATEWAY_AUTH token (CLI pattern)
    if (!existsSync(deviceFile)) return null;
    if (!challengeNonce) return null; // Challenge nonce required for device auth

    const identity = JSON.parse(readFileSync(deviceFile, 'utf-8'));
    // Use device-auth.json token if present, otherwise fall back to GATEWAY_AUTH
    const authData = existsSync(authFile) ? JSON.parse(readFileSync(authFile, 'utf-8')) : null;

    const { deviceId, privateKeyPem, publicKeyPem } = identity;
    if (!deviceId || !privateKeyPem) return null;
    // Payload uses the GATEWAY auth token (not device token) — matches CLI signing behaviour
    const operatorToken = process.env.GATEWAY_AUTH || '';

    const nonce = challengeNonce;
    const signedAtMs = Date.now();
    const role = 'operator';

    // Build v2 payload string — clientId + clientMode must match the connect frame
    const clientId = process.env.CLAWCONDOS_CLIENT_ID || 'cli';
    const clientMode = process.env.CLAWCONDOS_CLIENT_MODE || 'cli';
    const payloadStr = ['v2', deviceId, clientId, clientMode, role, scopes.join(','), signedAtMs, operatorToken ?? '', nonce].join('|');

    const privateKey = createPrivateKey(privateKeyPem);
    const sig = cryptoSign(null, Buffer.from(payloadStr), privateKey);
    const signature = sig.toString('base64url');

    // Raw public key bytes: Ed25519 SPKI DER has 12-byte prefix, then 32 raw bytes
    const pubDer = Buffer.from(publicKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
    const publicKey = pubDer.slice(12).toString('base64url');

    // auth.token = GATEWAY_AUTH (same as CLI — device token is NOT used in auth field)
    return {
      auth: { token: process.env.GATEWAY_AUTH || '' },
      device: { id: deviceId, publicKey, signature, signedAt: signedAtMs, nonce },
      role,
      scopes
    };
  } catch { return null; }
}

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
      const secure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
      const scheme = secure ? 'https' : 'http';
      const defaultPort = secure ? 443 : 80;
      return `${scheme}://${parsed.hostname}:${parsed.port || defaultPort}`;
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

              // Prefer device auth (grants operator.admin/read); fall back to gateway token/password.
              // The nonce must come from the gateway challenge, not be self-generated.
              const challengeNonce = msg.payload?.nonce;
              const devParams = buildDeviceConnectParams(['operator.admin', 'operator.read'], challengeNonce);
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
                    version: 'dev',
                    platform: 'node',
                    instanceId: randomUUID()
                  },
                  caps: [],
                  ...(devParams
                    ? { auth: devParams.auth, device: devParams.device, role: devParams.role, scopes: devParams.scopes }
                    : { auth, role: 'operator', scopes: ['operator.admin', 'operator.read'] })
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
