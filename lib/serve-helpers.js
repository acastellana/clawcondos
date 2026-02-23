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

    // Ensure operator.admin scope for full method access
    if (!Array.isArray(p.scopes)) p.scopes = [];
    if (!p.scopes.includes('operator.admin')) p.scopes.push('operator.admin');

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
