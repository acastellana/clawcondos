/**
 * Tests for serve.js helper functions
 *
 * Run with: npx vitest run tests/serve-helpers.test.js
 */

import { describe, it, expect } from 'vitest';
import { rewriteConnectFrame, validateStaticPath, isDotfilePath, filterProxyHeaders, stripSensitiveHeaders } from '../lib/serve-helpers.js';

describe('rewriteConnectFrame', () => {
  // Note: device auth is injected when ~/.openclaw/identity/{device,device-auth}.json exist.
  // Tests use toSatisfy() to accept either device auth (preferred) or token/password fallback.

  it('should inject auth into connect frame (device auth or token fallback)', () => {
    const frame = {
      type: 'req',
      id: 'r1',
      method: 'connect',
      params: { minProtocol: 3, maxProtocol: 3 }
    };
    const result = JSON.parse(rewriteConnectFrame(JSON.stringify(frame), 'secret-token'));
    // Device auth preferred when identity files exist; token used as fallback
    expect(result.params.auth).toSatisfy((a) =>
      ((('device' in a && typeof a.device.payload === 'string') || ('deviceToken' in a && typeof a.deviceToken === 'string')) || ('deviceToken' in a && typeof a.deviceToken === 'string')) ||
      ('token' in a && a.token === 'secret-token')
    );
  });

  it('should inject auth with password or device auth', () => {
    const frame = {
      type: 'req',
      id: 'r1',
      method: 'connect',
      params: { minProtocol: 3, maxProtocol: 3 }
    };
    const result = JSON.parse(rewriteConnectFrame(JSON.stringify(frame), { password: 'secret-pw' }));
    expect(result.params.auth).toSatisfy((a) =>
      (('device' in a && typeof a.device.payload === 'string') || ('deviceToken' in a && typeof a.deviceToken === 'string')) ||
      ('password' in a && a.password === 'secret-pw')
    );
  });

  it('should set client.id and mode from env defaults', () => {
    const frame = {
      type: 'req',
      id: 'r1',
      method: 'connect',
      params: { client: { displayName: 'MyUI' } }
    };
    const result = JSON.parse(rewriteConnectFrame(JSON.stringify(frame), null));
    expect(result.params.client.id).toBe('cli');
    expect(result.params.client.mode).toBe('cli');
    expect(result.params.client.displayName).toBe('MyUI');
  });

  it('should set default displayName to ClawCondos when not provided', () => {
    const frame = {
      type: 'req',
      id: 'r1',
      method: 'connect',
      params: {}
    };
    const result = JSON.parse(rewriteConnectFrame(JSON.stringify(frame), null));
    expect(result.params.client.displayName).toBe('ClawCondos');
  });

  it('should enforce server-side auth even when client has existing auth', () => {
    const frame = {
      type: 'req',
      id: 'r1',
      method: 'connect',
      params: { auth: { password: 'existing' } }
    };
    // Server-side token overrides client auth (or device auth when identity files present)
    const result = JSON.parse(rewriteConnectFrame(JSON.stringify(frame), 'new-token'));
    expect(result.params.auth).toSatisfy((a) =>
      (('device' in a && typeof a.device.payload === 'string') || ('deviceToken' in a && typeof a.deviceToken === 'string')) ||
      ('token' in a && a.token === 'new-token')
    );
  });

  it('should enforce server-side password auth over existing client auth', () => {
    const frame = {
      type: 'req',
      id: 'r1',
      method: 'connect',
      params: { auth: { token: 'some-token' } }
    };
    const result = JSON.parse(rewriteConnectFrame(JSON.stringify(frame), { password: 'gateway-pw' }));
    expect(result.params.auth).toSatisfy((a) =>
      (('device' in a && typeof a.device.payload === 'string') || ('deviceToken' in a && typeof a.deviceToken === 'string')) ||
      ('password' in a && a.password === 'gateway-pw')
    );
  });

  it('should set device auth or empty auth when gatewayAuth is null', () => {
    const frame = {
      type: 'req',
      id: 'r1',
      method: 'connect',
      params: {}
    };
    const result = JSON.parse(rewriteConnectFrame(JSON.stringify(frame), null));
    expect(result.params.auth).toSatisfy((a) =>
      (('device' in a && typeof a.device.payload === 'string') || ('deviceToken' in a && typeof a.deviceToken === 'string')) ||
      (Object.keys(a).length === 0)
    );
  });

  it('should pass through non-connect frames unchanged', () => {
    const frame = {
      type: 'req',
      id: 'r2',
      method: 'chat.send',
      params: { message: 'hello' }
    };
    const raw = JSON.stringify(frame);
    expect(rewriteConnectFrame(raw, 'token')).toBe(raw);
  });

  it('should pass through invalid JSON unchanged', () => {
    const raw = 'not json{{{';
    expect(rewriteConnectFrame(raw, 'token')).toBe(raw);
  });

  it('should pass through event frames unchanged', () => {
    const frame = { type: 'event', event: 'chat', payload: {} };
    const raw = JSON.stringify(frame);
    expect(rewriteConnectFrame(raw, 'token')).toBe(raw);
  });
});

describe('validateStaticPath', () => {
  it('should return null for safe paths', () => {
    expect(validateStaticPath('styles/main.css')).toBeNull();
    expect(validateStaticPath('js/app.js')).toBeNull();
    expect(validateStaticPath('index.html')).toBeNull();
  });

  it('should reject empty paths', () => {
    expect(validateStaticPath('')).toBe('empty');
  });

  it('should reject path traversal', () => {
    expect(validateStaticPath('../etc/passwd')).toBe('traversal');
    expect(validateStaticPath('foo/../../bar')).toBe('traversal');
    expect(validateStaticPath('..')).toBe('traversal');
  });

  it('should reject null bytes', () => {
    expect(validateStaticPath('foo\0bar')).toBe('null-byte');
    expect(validateStaticPath('\0')).toBe('null-byte');
  });
});

describe('isDotfilePath', () => {
  it('should block dotfiles', () => {
    expect(isDotfilePath('.env')).toBe(true);
    expect(isDotfilePath('.gitignore')).toBe(true);
    expect(isDotfilePath('.registry/goals.json')).toBe(true);
  });

  it('should block hidden directories', () => {
    expect(isDotfilePath('.git/config')).toBe(true);
    expect(isDotfilePath('foo/.hidden/bar')).toBe(true);
  });

  it('should allow normal paths', () => {
    expect(isDotfilePath('styles/main.css')).toBe(false);
    expect(isDotfilePath('js/app.js')).toBe(false);
    expect(isDotfilePath('index.html')).toBe(false);
    expect(isDotfilePath('lib/config.js')).toBe(false);
  });

  it('should allow files with dots in name (not at start)', () => {
    expect(isDotfilePath('app.min.js')).toBe(false);
    expect(isDotfilePath('styles/main.alt.css')).toBe(false);
  });
});

describe('filterProxyHeaders', () => {
  it('should keep allowlisted headers', () => {
    const raw = {
      'content-type': 'application/json',
      'content-length': '42',
      'cache-control': 'no-cache',
      'etag': '"abc"',
      'last-modified': 'Thu, 01 Jan 2025 00:00:00 GMT',
      'vary': 'Accept',
      'location': '/redirect',
    };
    const filtered = filterProxyHeaders(raw);
    expect(filtered).toEqual(raw);
  });

  it('should strip hop-by-hop and internal headers', () => {
    const raw = {
      'content-type': 'text/html',
      'set-cookie': 'session=abc',
      'x-powered-by': 'Express',
      'transfer-encoding': 'chunked',
      'connection': 'keep-alive',
      'keep-alive': 'timeout=5',
      'server': 'nginx',
    };
    const filtered = filterProxyHeaders(raw);
    expect(filtered).toEqual({ 'content-type': 'text/html' });
  });

  it('should return empty object for no allowlisted headers', () => {
    const raw = { 'x-custom': 'foo', 'server': 'bar' };
    expect(filterProxyHeaders(raw)).toEqual({});
  });

  it('should handle empty input', () => {
    expect(filterProxyHeaders({})).toEqual({});
  });

  it('should be case-insensitive', () => {
    const raw = { 'Content-Type': 'text/html', 'CACHE-CONTROL': 'no-store' };
    const filtered = filterProxyHeaders(raw);
    expect(filtered['Content-Type']).toBe('text/html');
    expect(filtered['CACHE-CONTROL']).toBe('no-store');
  });

  it('should keep CORS headers', () => {
    const raw = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'Content-Type',
      'access-control-expose-headers': 'X-Custom',
    };
    expect(filterProxyHeaders(raw)).toEqual(raw);
  });
});

describe('stripSensitiveHeaders', () => {
  it('should strip cookie header', () => {
    const headers = { 'content-type': 'text/html', 'cookie': 'session=abc' };
    const out = stripSensitiveHeaders(headers);
    expect(out['cookie']).toBeUndefined();
    expect(out['content-type']).toBe('text/html');
  });

  it('should strip authorization header', () => {
    const headers = { 'authorization': 'Bearer secret', 'accept': '*/*' };
    const out = stripSensitiveHeaders(headers);
    expect(out['authorization']).toBeUndefined();
    expect(out['accept']).toBe('*/*');
  });

  it('should strip all x-forwarded-* headers', () => {
    const headers = {
      'x-forwarded-for': '1.2.3.4',
      'x-forwarded-host': 'example.com',
      'x-forwarded-proto': 'https',
      'host': 'localhost',
    };
    const out = stripSensitiveHeaders(headers);
    expect(out['x-forwarded-for']).toBeUndefined();
    expect(out['x-forwarded-host']).toBeUndefined();
    expect(out['x-forwarded-proto']).toBeUndefined();
    expect(out['host']).toBe('localhost');
  });

  it('should not mutate original headers', () => {
    const headers = { 'cookie': 'a=1', 'host': 'localhost' };
    stripSensitiveHeaders(headers);
    expect(headers['cookie']).toBe('a=1');
  });

  it('should pass through safe headers unchanged', () => {
    const headers = { 'content-type': 'application/json', 'accept': '*/*', 'host': 'localhost' };
    const out = stripSensitiveHeaders(headers);
    expect(out).toEqual(headers);
  });

  it('should handle empty input', () => {
    expect(stripSensitiveHeaders({})).toEqual({});
  });
});
