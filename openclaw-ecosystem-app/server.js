// Minimal OpenClaw Ecosystem API server (ESM)
// Provides:
//   GET  /openclaw-ecosystem/api/items
//   PUT  /openclaw-ecosystem/api/items/:id
// Data is stored in ./data/ecosystem.json

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3870);
const DATA_PATH = path.join(__dirname, 'data', 'ecosystem.json');

function readJson() {
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  return JSON.parse(raw);
}

function writeJson(obj) {
  const tmp = DATA_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, DATA_PATH);
}

function send(res, status, payload, headers = {}) {
  const body = payload == null ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      // basic guard against accidental huge payloads
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error('payload_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function route(req, res) {
  // CORS for local dashboards/tools
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // Serve static files from /public under /openclaw-ecosystem/
  if (req.method === 'GET' && !pathname.startsWith('/openclaw-ecosystem/api/')) {
    let filePath;
    if (pathname === '/openclaw-ecosystem' || pathname === '/openclaw-ecosystem/') {
      filePath = path.join(__dirname, 'public', 'index.html');
    } else {
      const rel = pathname.replace(/^\/openclaw-ecosystem\//, '');
      filePath = path.join(__dirname, 'public', rel);
    }
    try {
      const data = fs.readFileSync(filePath);
      const ext  = path.extname(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(data);
    } catch {
      return send(res, 404, { error: 'not_found' }, { 'Access-Control-Allow-Origin': '*' });
    }
  }

  // GET list
  if (req.method === 'GET' && pathname === '/openclaw-ecosystem/api/items') {
    try {
      const data = readJson();
      return send(res, 200, data, { 'Access-Control-Allow-Origin': '*' });
    } catch {
      return send(res, 500, { error: 'read_failed' }, { 'Access-Control-Allow-Origin': '*' });
    }
  }

  // POST create
  if (req.method === 'POST' && pathname === '/openclaw-ecosystem/api/items') {
    return readBody(req)
      .then((raw) => {
        let payload;
        try {
          payload = raw ? JSON.parse(raw) : null;
        } catch {
          return send(res, 400, { error: 'invalid_json' }, { 'Access-Control-Allow-Origin': '*' });
        }
        if (!payload || typeof payload !== 'object') {
          return send(res, 400, { error: 'missing_payload' }, { 'Access-Control-Allow-Origin': '*' });
        }
        if (!payload.url) {
          return send(res, 400, { error: 'missing_url' }, { 'Access-Control-Allow-Origin': '*' });
        }

        const data = readJson();
        const items = Array.isArray(data.items) ? data.items : [];

        // Dedup by URL — return 409 if already exists
        const existing = items.find((it) => it && it.url === payload.url);
        if (existing) {
          return send(res, 409, { error: 'conflict', id: existing.id }, { 'Access-Control-Allow-Origin': '*' });
        }

        // Auto-assign id if not provided
        if (!payload.id) {
          payload.id = `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }
        if (!payload.createdAt) {
          payload.createdAt = new Date().toISOString();
        }

        items.push(payload);
        data.items = items;
        writeJson(data);
        return send(res, 201, { ok: true, id: payload.id }, { 'Access-Control-Allow-Origin': '*' });
      })
      .catch((e) => {
        if (String(e && e.message) === 'payload_too_large') {
          return send(res, 413, { error: 'payload_too_large' }, { 'Access-Control-Allow-Origin': '*' });
        }
        return send(res, 500, { error: 'write_failed' }, { 'Access-Control-Allow-Origin': '*' });
      });
  }

  // PUT update
  const m = pathname.match(/^\/openclaw-ecosystem\/api\/items\/([^/]+)$/);
  if (req.method === 'PUT' && m) {
    const id = m[1];
    return readBody(req)
      .then((raw) => {
        let payload;
        try {
          payload = raw ? JSON.parse(raw) : null;
        } catch {
          send(res, 400, { error: 'invalid_json' }, { 'Access-Control-Allow-Origin': '*' });
          return;
        }
        if (!payload || typeof payload !== 'object') {
          send(res, 400, { error: 'missing_payload' }, { 'Access-Control-Allow-Origin': '*' });
          return;
        }
        if (payload.id !== id) {
          // avoid accidental cross-update
          send(res, 400, { error: 'id_mismatch' }, { 'Access-Control-Allow-Origin': '*' });
          return;
        }

        const data = readJson();
        const items = Array.isArray(data.items) ? data.items : [];
        const idx = items.findIndex((it) => it && it.id === id);
        if (idx === -1) {
          send(res, 404, { error: 'not_found' }, { 'Access-Control-Allow-Origin': '*' });
          return;
        }

        items[idx] = payload;
        data.items = items;
        writeJson(data);
        send(res, 200, { ok: true }, { 'Access-Control-Allow-Origin': '*' });
      })
      .catch((e) => {
        if (String(e && e.message) === 'payload_too_large') {
          return send(res, 413, { error: 'payload_too_large' }, { 'Access-Control-Allow-Origin': '*' });
        }
        return send(res, 500, { error: 'write_failed' }, { 'Access-Control-Allow-Origin': '*' });
      });
  }

  return send(res, 404, { error: 'not_found' }, { 'Access-Control-Allow-Origin': '*' });
}

http.createServer(route).listen(PORT, '127.0.0.1', () => {
  console.log(`[openclaw-ecosystem] listening on http://127.0.0.1:${PORT}`);
});
