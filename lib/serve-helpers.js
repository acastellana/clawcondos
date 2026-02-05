/**
 * Testable helper functions extracted from serve.js
 */

/**
 * Rewrite a WebSocket "connect" frame to inject auth and set client identity.
 * @param {string|Buffer} raw - Raw WebSocket message
 * @param {string|null} gatewayAuth - Gateway auth token to inject
 * @returns {string|Buffer} Rewritten message (or original if not a connect frame)
 */
export function rewriteConnectFrame(raw, gatewayAuth) {
  let frame;
  try { frame = JSON.parse(raw.toString()); } catch { return raw; }

  if (frame && frame.type === 'req' && frame.method === 'connect' && frame.params && typeof frame.params === 'object') {
    const p = frame.params;

    p.client = {
      ...(p.client || {}),
      id: 'webchat-ui',
      mode: 'webchat',
      displayName: (p.client && p.client.displayName) ? p.client.displayName : 'ClawCondos',
    };

    if (!p.auth && gatewayAuth) {
      p.auth = { password: gatewayAuth };
    } else if (p.auth && gatewayAuth) {
      if (!p.auth.password) p.auth.password = gatewayAuth;
    }

    frame.params = p;
    return JSON.stringify(frame);
  }

  return raw;
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
