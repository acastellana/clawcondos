/**
 * Testable helper functions extracted from serve.js
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { sign as cryptoSign, createPrivateKey } from 'crypto';
import { homedir } from 'os';

/** Build device connect params for the gateway (auth + device + role + scopes). */
function _buildDeviceConnectParams(scopes = ['operator.admin', 'operator.read']) {
  try {
    const identityDir = join(homedir(), '.openclaw', 'identity');
    const deviceFile = join(identityDir, 'device.json');
    const authFile = join(identityDir, 'device-auth.json');
    if (!existsSync(deviceFile) || !existsSync(authFile)) return null;
    const identity = JSON.parse(readFileSync(deviceFile, 'utf-8'));
    const authData = JSON.parse(readFileSync(authFile, 'utf-8'));
    const { deviceId, privateKeyPem, publicKeyPem } = identity;
    const operatorToken = authData?.tokens?.operator?.token || null;
    if (!deviceId || !privateKeyPem) return null;
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const signedAtMs = Date.now();
    const role = 'operator';
    const payloadStr = ['v2', deviceId, 'gateway-client', 'backend', role, scopes.join(','), signedAtMs, operatorToken ?? '', nonce].join('|');
    const privateKey = createPrivateKey(privateKeyPem);
    const sig = cryptoSign(null, Buffer.from(payloadStr), privateKey);
    const signature = sig.toString('base64url');
    const pubDer = Buffer.from(publicKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
    const publicKey = pubDer.slice(12).toString('base64url');
    return { auth: operatorToken ? { token: operatorToken } : {}, device: { id: deviceId, publicKey, signature, signedAt: signedAtMs, nonce }, role, scopes };
  } catch { return null; }
}

/**
 * Rewrite a WebSocket "connect" frame to inject auth and set client identity.
 * @param {string|Buffer} raw - Raw WebSocket message
 * @param {string|object|null} gatewayAuth - Gateway auth secret(s) to inject
 * @returns {string|Buffer} Rewritten message (or original if not a connect frame)
 */
export function rewriteConnectFrame(raw, gatewayAuth) {
  let frame;
  try { frame = JSON.parse(raw.toString()); } catch { return raw; }

  if (frame && frame.type === 'req' && frame.method === 'connect' && frame.params && typeof frame.params === 'object') {
    const p = frame.params;

    const forcedId = process.env.CLAWCONDOS_UPSTREAM_CLIENT_ID || 'cli';
    const forcedMode = process.env.CLAWCONDOS_UPSTREAM_CLIENT_MODE || 'cli';
    p.client = {
      ...(p.client || {}),
      id: forcedId,
      mode: forcedMode,
      displayName: (p.client && p.client.displayName) ? p.client.displayName : 'ClawCondos',
    };

    const authObj = (gatewayAuth && typeof gatewayAuth === 'object')
      ? gatewayAuth
      : (gatewayAuth ? { token: gatewayAuth } : {});

    // Prefer device auth (grants operator.admin/read); fall back to gateway token/password.
    const devParams = _buildDeviceConnectParams(['operator.admin', 'operator.read']);
    if (devParams) {
      p.auth = devParams.auth;
      p.device = devParams.device;
      p.role = devParams.role;
      p.scopes = devParams.scopes;
    } else {
      const authObj = (gatewayAuth && typeof gatewayAuth === 'object')
        ? gatewayAuth
        : (gatewayAuth ? { token: gatewayAuth } : {});
      if (authObj.password) {
        p.auth = { password: authObj.password };
      } else if (authObj.token) {
        p.auth = { token: authObj.token };
      } else if (!p.auth) {
        p.auth = {};
      }
    }

    frame.params = p;
    return JSON.stringify(frame);
  }

  return raw;
}

const PROXY_HEADER_ALLOWLIST = new Set([
  'content-type', 'content-length', 'content-encoding', 'content-disposition',
  'cache-control', 'etag', 'last-modified', 'vary', 'location',
  'access-control-allow-origin', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-expose-headers',
]);

/**
 * Filter proxy response headers to an allowlist of safe headers.
 * Strips hop-by-hop headers and internal headers (e.g. set-cookie, x-powered-by).
 * @param {object} raw - Raw headers object from upstream response
 * @returns {object} Filtered headers
 */
export function filterProxyHeaders(raw) {
  const filtered = {};
  for (const [k, v] of Object.entries(raw)) {
    if (PROXY_HEADER_ALLOWLIST.has(k.toLowerCase())) filtered[k] = v;
  }
  return filtered;
}

/**
 * Strip sensitive headers from incoming request before proxying to embedded apps.
 * Removes cookie, authorization, and x-forwarded-* headers.
 * @param {object} headers - Raw request headers
 * @returns {object} Sanitized headers
 */
export function stripSensitiveHeaders(headers) {
  const out = { ...headers };
  delete out['cookie'];
  delete out['authorization'];
  for (const k of Object.keys(out)) {
    if (k.startsWith('x-forwarded-')) delete out[k];
  }
  return out;
}

/**
 * Check if a relative URL path is safe for static file serving.
 * Returns an error string if unsafe, or null if safe.
 * @param {string} rel - Relative path (leading slashes stripped)
 * @returns {string|null} Error description or null if safe
 */
export function validateStaticPath(rel) {
  if (!rel) return 'empty';
  if (rel.includes('..')) return 'traversal';
  if (rel.includes('\0')) return 'null-byte';
  return null;
}

/**
 * Check if a relative path should be blocked from repo-root fallback.
 * @param {string} rel - Relative path
 * @returns {boolean} true if path should be blocked
 */
export function isDotfilePath(rel) {
  const segments = rel.split('/');
  return segments.some(s => s.startsWith('.'));
}
