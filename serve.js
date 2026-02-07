#!/usr/bin/env node
/**
 * ClawCondos Development Server
 * 
 * Serves static files + /api/apps + proxies to registered apps
 * Usage: node serve.js [port]
 */

import { createServer, request as httpRequest } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'fs';
import { join, extname, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { rewriteConnectFrame, validateStaticPath, isDotfilePath, filterProxyHeaders, stripSensitiveHeaders } from './lib/serve-helpers.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Auto-load env file if GATEWAY_AUTH not already set (e.g. running outside systemd)
const ENV_FILE = join(process.env.HOME || '', '.config', 'clawcondos.env');
if (!process.env.GATEWAY_AUTH && existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const PORT = parseInt(process.argv[2]) || 9000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',

  // Voice notes / uploads
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain',
};

// Load apps registry
function loadApps() {
  const appsFile = join(__dirname, '.registry', 'apps.json');
  try {
    if (existsSync(appsFile)) {
      return JSON.parse(readFileSync(appsFile, 'utf-8')).apps || [];
    }
  } catch (err) {
    console.error('loadApps: failed to parse apps.json:', err.message);
  }
  return [];
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

async function readRawBody(req, maxBytes = 25 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new Error('Body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function parseMultipartSingleFile(req, bodyBuf) {
  const ct = String(req.headers['content-type'] || '');
  const m = ct.match(/boundary=(.+)$/i);
  if (!m) throw new Error('Missing multipart boundary');
  const boundary = m[1].replace(/^"|"$/g, '');
  const sep = Buffer.from(`--${boundary}`);

  // Split parts
  const parts = [];
  let start = bodyBuf.indexOf(sep);
  while (start !== -1) {
    const next = bodyBuf.indexOf(sep, start + sep.length);
    if (next === -1) break;
    const part = bodyBuf.slice(start + sep.length, next);
    parts.push(part);
    start = next;
  }

  for (const rawPart of parts) {
    // trim leading CRLF
    let part = rawPart;
    if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd).toString('utf-8');
    const content = part.slice(headerEnd + 4);
    const cd = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i);
    if (!cd) continue;

    const nameMatch = headerText.match(/name="([^"]+)"/i);
    const fieldName = nameMatch ? nameMatch[1] : '';
    const fnMatch = headerText.match(/filename="([^"]*)"/i);
    const filename = fnMatch ? fnMatch[1] : '';
    const typeMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);
    const mimeType = typeMatch ? typeMatch[1].trim() : 'application/octet-stream';

    // Drop trailing CRLF (multipart parts typically end with \r\n)
    const fileBuf = (content.length >= 2 && content[content.length - 2] === 13 && content[content.length - 1] === 10)
      ? content.slice(0, -2)
      : content;

    if (fieldName === 'file' && filename) {
      return { filename, mimeType, buffer: fileBuf };
    }
  }

  throw new Error('No file found in multipart body');
}

function safeExtFromMime(mime, filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.webm')) return '.webm';
  if (lower.endsWith('.m4a')) return '.m4a';
  if (lower.endsWith('.mp3')) return '.mp3';
  if (lower.endsWith('.wav')) return '.wav';
  if (lower.endsWith('.ogg')) return '.ogg';
  if (String(mime).includes('webm')) return '.webm';
  if (String(mime).includes('ogg')) return '.ogg';
  if (String(mime).includes('mpeg')) return '.mp3';
  if (String(mime).includes('wav')) return '.wav';
  if (String(mime).includes('mp4') || String(mime).includes('m4a')) return '.m4a';
  return '.bin';
}

function whisperTranscribeLocal(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      filePath,
      '--model', process.env.CLAWCONDOS_WHISPER_MODEL || 'base',
      '--device', process.env.CLAWCONDOS_WHISPER_DEVICE || 'cpu',
      '--output_format', 'txt',
      '--output_dir', join(__dirname, 'media', 'voice', 'transcripts')
    ];
    ensureDir(join(__dirname, 'media', 'voice', 'transcripts'));
    const p = spawn('whisper', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let timedOut = false;

    const timeoutMs = Number(process.env.CLAWCONDOS_WHISPER_TIMEOUT_MS || 120_000);
    const timer = setTimeout(() => {
      timedOut = true;
      try { p.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    p.stdout.on('data', d => { stdout += d.toString('utf-8'); });
    p.stderr.on('data', d => { stderr += d.toString('utf-8'); });
    p.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`whisper timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`whisper failed (code ${code}${signal ? `, signal ${signal}` : ''}): ${stderr.slice(-500)}`));
      // whisper writes <basename>.txt
      const base = filePath.split('/').pop().replace(/\.[^.]+$/, '');
      const outPath = join(__dirname, 'media', 'voice', 'transcripts', `${base}.txt`);
      let text = safeReadFile(outPath, 500_000) || '';
      text = String(text || '').trim();

      // Fallback: some environments don't emit the .txt file reliably even with code 0.
      // Parse stdout segments like: "[00:00.000 --> 00:02.000]  hello"
      if (!text) {
        const lines = String(stdout || '').split(/\r?\n/);
        const segs = [];
        for (const ln of lines) {
          const m = ln.match(/\]\s{2,}(.*)$/);
          if (m && m[1] && m[1].trim()) segs.push(m[1].trim());
        }
        text = segs.join(' ').trim();
      }

      resolve(text);
    });
  });
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw Object.assign(new Error('Body too large'), { statusCode: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function serveFile(res, filePath) {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const content = readFileSync(filePath);

  // Avoid stale UI assets
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-store, max-age=0'
  });
  res.end(content);
}

function safeReadFile(path, maxBytes = 200_000) {
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile()) return null;
    if (st.size > maxBytes) {
      const raw = readFileSync(path, 'utf-8');
      return raw.slice(0, maxBytes) + `\n\n[truncated: ${st.size} bytes]`;
    }
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

// Agent workspace mapping: set CLAWCONDOS_AGENT_WORKSPACES as JSON, e.g.
//   {"main":"/path/to/main","caffeine":"/path/to/caffeine"}
// Agents not in the map return null (introspection disabled for them).
const AGENT_WORKSPACES = (() => {
  try { return JSON.parse(process.env.CLAWCONDOS_AGENT_WORKSPACES || '{}'); } catch { return {}; }
})();

function resolveAgentWorkspace(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return null;
  const ws = AGENT_WORKSPACES[id];
  return ws ? resolvePath(ws) : null;
}

function parseMissionFromIdentity(md) {
  const m = String(md || '').match(/^\s*Mission:\s*(.+)$/im);
  if (m) return m[1].trim();
  // Fallback: find first non-heading, non-empty, non-metadata line
  const lines = String(md || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('#')) continue;        // skip headings
    if (line.startsWith('-') || line.startsWith('*')) continue; // skip list items / hr
    if (line.startsWith('|')) continue;        // skip tables
    if (line.length < 10) continue;            // skip short noise
    return line;
  }
  return '';
}

function parseHeadings(md) {
  const out = [];
  for (const line of String(md || '').split(/\r?\n/)) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) out.push({ level: m[1].length, text: m[2].trim() });
  }
  return out;
}

function buildAgentSummary(agentId) {
  const workspace = resolveAgentWorkspace(agentId);
  if (!workspace) return { ok: false, error: 'Unknown agent/workspace', agentId };

  const identityMd = safeReadFile(join(workspace, 'IDENTITY.md'), 120_000) || '';
  const heartbeatMd = safeReadFile(join(workspace, 'HEARTBEAT.md'), 120_000) || '';

  return {
    ok: true,
    agentId,
    workspace,
    mission: parseMissionFromIdentity(identityMd) || '(no mission found)',
    headings: {
      heartbeat: heartbeatMd ? parseHeadings(heartbeatMd).slice(0, 120) : []
    },
    audit: { summary: { warn: 0, info: 0 } }
  };
}

// Skill directories: set CLAWCONDOS_SKILLS_DIRS as colon-separated paths, e.g.
//   /usr/lib/node_modules/openclaw/skills:/home/user/skills
const SKILLS_DIRS = (process.env.CLAWCONDOS_SKILLS_DIRS || '')
  .split(':').map(s => s.trim()).filter(Boolean).map(s => resolvePath(s));

function resolveSkills(ids) {
  const out = [];
  const bases = SKILLS_DIRS;

  for (const id of ids) {
    let found = null;
    for (const base of bases) {
      const p = join(base, id, 'SKILL.md');
      const content = safeReadFile(p, 60_000);
      if (content != null) {
        // naive description: first non-empty line after first heading
        const lines = content.split(/\r?\n/);
        const firstPara = lines.filter(l => l.trim()).slice(0, 12).join(' ');
        found = { id, name: id, description: firstPara.slice(0, 280) };
        break;
      }
    }
    out.push(found || { id, name: id, description: '' });
  }

  return out;
}

// Proxy request to app
function proxyToApp(req, res, app, path) {
  const options = {
    hostname: 'localhost',
    port: app.port,
    path: path || '/',
    method: req.method,
    headers: { ...stripSensitiveHeaders(req.headers), host: `localhost:${app.port}` },
  };

  const proxyReq = httpRequest(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, filterProxyHeaders(proxyRes.headers));
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error(`Proxy error for ${app.id}:`, err.message);
    res.writeHead(503);
    res.end(`App "${app.name}" is unavailable`);
  });

  req.pipe(proxyReq, { end: true });
}

// Proxy to ClawCondos media-upload service (apps/media-upload) which has robust multipart parsing.
function proxyToMediaUpload(req, res, pathname, search) {
  // Map /media-upload/* → service paths
  let targetPath = pathname;
  if (targetPath === '/media-upload' || targetPath === '/media-upload/') targetPath = '/upload';
  if (targetPath.startsWith('/media-upload/')) targetPath = targetPath.slice('/media-upload'.length);
  if (targetPath === '' || targetPath === '/') targetPath = '/upload';

  const MEDIA_UPLOAD_HOST = process.env.MEDIA_UPLOAD_HOST || 'localhost';
  const MEDIA_UPLOAD_PORT = Number(process.env.MEDIA_UPLOAD_PORT || 18796);

  const options = {
    hostname: MEDIA_UPLOAD_HOST,
    port: MEDIA_UPLOAD_PORT,
    path: targetPath + (search || ''),
    method: req.method,
    headers: { ...stripSensitiveHeaders(req.headers), host: `${MEDIA_UPLOAD_HOST}:${MEDIA_UPLOAD_PORT}` },
  };

  const proxyReq = httpRequest(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, filterProxyHeaders(proxyRes.headers));
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error('Media-upload proxy error:', err.message);
    json(res, 503, { ok: false, error: 'media-upload service unavailable' });
  });

  req.pipe(proxyReq, { end: true });
}

// WebSocket proxy to OpenClaw gateway
// Goal: browser connects to ClawCondos (/ws); ClawCondos proxies to gateway and injects auth from env.
// This keeps the gateway token out of the browser and works for both localhost + Tailscale HTTPS.
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
const MAX_WS_CONNECTIONS = 50;
let wsConnectionCount = 0;

function getGatewayWsUrl() {
  const host = process.env.GATEWAY_HTTP_HOST || '127.0.0.1';
  const port = Number(process.env.GATEWAY_HTTP_PORT || 18789);
  return process.env.GATEWAY_WS_URL || `ws://${host}:${port}/ws`;
}

// rewriteConnectFrame imported from lib/serve-helpers.js

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = url.pathname;
  
  // CORS (dev-only)
  // SECURITY: this server can proxy to the OpenClaw gateway using an env Bearer token.
  // Never run with permissive CORS in production.
  const DEV_CORS = process.env.CLAWCONDOS_DEV_CORS === '1';
  const origin = String(req.headers.origin || '');
  const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (DEV_CORS && isLocalOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
  }

  // Export bounce endpoint: client POSTs markdown content + filename via
  // hidden form, server returns it with Content-Disposition so the browser
  // downloads with the correct filename.  Accepts both JSON and form-encoded.
  if (pathname === '/api/export' && req.method === 'POST') {
    const MAX_EXPORT = 5 * 1024 * 1024; // 5 MB
    let body = '';
    let overflow = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_EXPORT) overflow = true;
    });
    req.on('end', () => {
      if (overflow) { json(res, 413, { error: 'Export too large' }); return; }
      try {
        let filename, content;
        const ct = String(req.headers['content-type'] || '');
        if (ct.includes('application/json')) {
          ({ filename, content } = JSON.parse(body));
        } else {
          const params = new URLSearchParams(body);
          filename = params.get('filename');
          content = params.get('content');
        }
        const safe = String(filename || 'export.md').replace(/[^a-zA-Z0-9._-]/g, '_');
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${safe}"`,
          'Cache-Control': 'no-store',
        });
        res.end(content || '');
      } catch {
        json(res, 400, { error: 'Invalid request' });
      }
    });
    return;
  }

  // Proxy to OpenClaw gateway for /api/gateway/* requests
  // Env vars:
  // - GATEWAY_HTTP_HOST (default: localhost)
  // - GATEWAY_HTTP_PORT (default: 18789)
  // - GATEWAY_AUTH (optional — injected as Bearer token when set)
  if (pathname.startsWith('/api/gateway/')) {
    const gatewayPath = pathname.replace('/api/gateway', '');
    const GATEWAY_HTTP_HOST = process.env.GATEWAY_HTTP_HOST || 'localhost';
    const GATEWAY_HTTP_PORT = Number(process.env.GATEWAY_HTTP_PORT || 18789);
    const GATEWAY_AUTH = process.env.GATEWAY_AUTH;

    const proxyHeaders = {
      ...req.headers,
      host: `${GATEWAY_HTTP_HOST}:${GATEWAY_HTTP_PORT}`,
    };
    if (GATEWAY_AUTH) proxyHeaders['Authorization'] = `Bearer ${GATEWAY_AUTH}`;

    const options = {
      hostname: GATEWAY_HTTP_HOST,
      port: GATEWAY_HTTP_PORT,
      path: gatewayPath + url.search,
      method: req.method,
      headers: proxyHeaders,
    };

    const proxyReq = httpRequest(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, filterProxyHeaders(proxyRes.headers));
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      console.error('Gateway proxy error:', err.message);
      json(res, 503, { error: { message: 'OpenClaw gateway unavailable', type: 'proxy_error' } });
    });

    req.pipe(proxyReq, { end: true });
    return;
  }
  
  const apps = loadApps();

  // API: Agent summaries (ClawCondos)
  // GET /api/agents/summary?agentId=<id>&refresh=1
  if (pathname === '/api/agents/summary' && req.method === 'GET') {
    const agentId = url.searchParams.get('agentId') || '';
    const forceRefresh = url.searchParams.get('refresh') === '1';
    const summary = buildAgentSummary(agentId, { forceRefresh });
    json(res, summary.ok ? 200 : 404, summary);
    return;
  }

  // API: Skills index/resolve (ClawCondos)
  // GET /api/skills/resolve?ids=a,b,c
  if (pathname === '/api/skills/resolve' && req.method === 'GET') {
    const idsRaw = url.searchParams.get('ids') || '';
    const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 80);
    const resolved = resolveSkills(ids);
    json(res, 200, { ok: true, skills: resolved });
    return;
  }

  // API: Agent file browser (ClawCondos)
  // GET /api/agents/files?agentId=<id>
  if (pathname === '/api/agents/files' && req.method === 'GET') {
    const agentId = url.searchParams.get('agentId') || '';
    const workspace = resolveAgentWorkspace(agentId);
    if (!workspace) {
      json(res, 404, { ok: false, error: 'Workspace not found' });
      return;
    }

    const allowedExt = new Set(['.md', '.json', '.txt', '.log', '.sh', '.mjs', '.js', '.py']);
    const entries = [];

    function walk(dir, relBase = '') {
      let kids = [];
      try { kids = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of kids) {
        const rel = relBase ? `${relBase}/${d.name}` : d.name;
        if (rel.startsWith('.git') || rel.includes('/.git')) continue;
        if (d.isDirectory()) {
          if (d.name === 'node_modules' || d.name === '.venv' || d.name === 'dist' || d.name === 'build' || d.name === 'tmp') continue;
          entries.push({ path: rel, type: 'dir' });
          if ((rel.match(/\//g) || []).length < 4) walk(join(dir, d.name), rel);
        } else if (d.isFile()) {
          const ext = extname(d.name);
          if (!allowedExt.has(ext)) continue;
          let st;
          try { st = statSync(join(dir, d.name)); } catch { continue; }
          entries.push({ path: rel, type: 'file', size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    }

    walk(workspace, '');
    entries.sort((a, b) => a.path.localeCompare(b.path));
    json(res, 200, { ok: true, agentId, workspace, entries });
    return;
  }

  // GET /api/agents/file?agentId=<id>&path=<rel>
  if (pathname === '/api/agents/file' && req.method === 'GET') {
    const agentId = url.searchParams.get('agentId') || '';
    const rel = url.searchParams.get('path') || '';
    const workspace = resolveAgentWorkspace(agentId);
    if (!workspace) {
      json(res, 404, { ok: false, error: 'Workspace not found' });
      return;
    }
    if (!rel || rel.includes('..') || rel.startsWith('/')) {
      json(res, 400, { ok: false, error: 'Bad path' });
      return;
    }
    const full = join(workspace, rel);
    if (!full.startsWith(workspace + '/')) {
      json(res, 400, { ok: false, error: 'Bad path' });
      return;
    }
    const content = safeReadFile(full, 180_000);
    if (content == null) {
      json(res, 404, { ok: false, error: 'File not found' });
      return;
    }
    json(res, 200, { ok: true, agentId, path: rel, content });
    return;
  }

  // Media upload (for voice notes + images)
  // Health/probe endpoint (some browsers/extensions do HEAD/GET /media-upload/)
  if ((pathname === '/media-upload' || pathname === '/media-upload/' || pathname === '/media-upload/health')
      && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /media-upload/upload (multipart/form-data with field "file")
  if (pathname === '/media-upload/upload' && req.method === 'POST') {
    try {
      const body = await readRawBody(req, 25 * 1024 * 1024);
      const file = parseMultipartSingleFile(req, body);

      const ext = safeExtFromMime(file.mimeType, file.filename);
      const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      const dir = join(__dirname, 'media', 'voice');
      ensureDir(dir);
      const outName = `upload-${id}${ext}`;
      const outPath = join(dir, outName);
      writeFileSync(outPath, file.buffer);

      const sizeBytes = file.buffer?.length || 0;
      const magic = sizeBytes >= 4 ? file.buffer.slice(0, 4).toString('hex') : '';
      console.log(`media-upload :: file=${file.filename} mime=${file.mimeType} bytes=${sizeBytes} magic=${magic} -> ${outName}`);

      json(res, 200, {
        ok: true,
        url: `/media/voice/${outName}`,
        serverPath: `media/voice/${outName}`,
        mimeType: file.mimeType,
        fileName: file.filename,
        sizeBytes,
      });
      return;
    } catch (e) {
      json(res, 400, { ok: false, error: e?.message || String(e) });
      return;
    }
  }

  // Legacy proxy to a dedicated service (:18796), disabled by default.
  if ((pathname === '/media-upload' || pathname.startsWith('/media-upload/')) && process.env.ENABLE_MEDIA_UPLOAD_PROXY === '1') {
    proxyToMediaUpload(req, res, pathname, url.search);
    return;
  }

  // Whisper transcription
  if (pathname === '/api/whisper/health' && req.method === 'GET') {
    json(res, 200, { ok: true });
    return;
  }

  // GET /api/whisper/transcribe?path=<serverPath>
  if (pathname === '/api/whisper/transcribe' && req.method === 'GET') {
    try {
      const p = url.searchParams.get('path') || '';
      if (!p) throw new Error('Missing path');
      const full = resolvePath(p);
      const extraUploadDir = process.env.CLAWCONDOS_UPLOAD_DIR;
      const allowedRoots = [
        resolvePath(join(__dirname, 'media')),
        ...(extraUploadDir ? [resolvePath(extraUploadDir)] : []),
      ];
      if (!allowedRoots.some(r => full.startsWith(r))) throw new Error('Bad path');
      const text = await whisperTranscribeLocal(full);
      console.log(`whisper :: transcribed ${full} chars=${(text || '').length}`);
      json(res, 200, { ok: true, text });
      return;
    } catch (e) {
      json(res, 400, { ok: false, error: e?.message || String(e) });
      return;
    }
  }

  // Serve persisted media (voice notes)
  if (pathname.startsWith('/media/')) {
    try {
      const rel = pathname.slice('/media/'.length);
      const full = resolvePath(join(__dirname, 'media', rel));
      const allowedRoot = resolvePath(join(__dirname, 'media'));
      if (!full.startsWith(allowedRoot)) {
        res.writeHead(400);
        res.end('Bad path');
        return;
      }
      serveFile(res, full);
      return;
    } catch {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
  }

  // API: /api/apps -> serve apps.json
  if (pathname === '/api/apps') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ apps }));
    return;
  }
  
  // Check if path matches an app (/{appId}/...)
  for (const app of apps) {
    if (pathname === `/${app.id}` || pathname.startsWith(`/${app.id}/`)) {
      const appPath = pathname.slice(app.id.length + 1) || '/';
      proxyToApp(req, res, app, appPath + url.search);
      return;
    }
  }
  
  // Static files
  //
  // Serve ClawCondos's config module without colliding with Apps Gateway /lib/* handler
  if (pathname === '/clawcondos-lib/config.js') {
    const filePath = join(__dirname, 'lib', 'config.js');
    serveFile(res, filePath);
    return;
  }

  if (pathname === '/' || pathname === '') {
    const filePath = join(__dirname, 'public', 'index.html');
    serveFile(res, filePath);
    return;
  }

  if (pathname === '/app') pathname = '/app.html';

  // /index.html → canonical index
  if (pathname === '/index.html') {
    const filePath = join(__dirname, 'public', 'index.html');
    serveFile(res, filePath);
    return;
  }

  // Prefer serving static assets from ./public/ (so /app.css maps to public/app.css)
  // SECURITY: prevent absolute-path reads and path traversal.
  const rel = String(pathname || '').replace(/^\/+/, '');
  if (validateStaticPath(rel)) {
    res.writeHead(400);
    res.end('Bad path');
    return;
  }

  const publicRoot = resolvePath(__dirname, 'public');
  const repoRoot = resolvePath(__dirname);

  let filePath = resolvePath(publicRoot, rel);
  if (!filePath.startsWith(publicRoot + '/') && filePath !== publicRoot) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!existsSync(filePath)) {
    // Fallback to repo-root for specific asset directories only.
    // Blocks access to serve.js, package.json, docs/, tests/, CLAUDE.md, etc.
    const allowedRootPrefixes = ['js/', 'styles/', 'lib/', 'media/'];
    if (!allowedRootPrefixes.some(p => rel.startsWith(p))) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const candidate = resolvePath(repoRoot, rel);
    if (!candidate.startsWith(repoRoot + '/') && candidate !== repoRoot) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    filePath = candidate;
  }

  // If directory, try index.html
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }

  serveFile(res, filePath);
});

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== '/ws' && url.pathname !== '/clawcondos-ws') {
      socket.destroy();
      return;
    }

    if (wsConnectionCount >= MAX_WS_CONNECTIONS) {
      socket.destroy();
      return;
    }

    const gatewayAuth = process.env.GATEWAY_AUTH || null;

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      wsConnectionCount++;
      clientWs.on('close', () => { wsConnectionCount--; });
      const upstreamUrl = getGatewayWsUrl();
      const gatewayHost = process.env.GATEWAY_HTTP_HOST || '127.0.0.1';
      const gatewayPort = Number(process.env.GATEWAY_HTTP_PORT || 18789);
      const upstreamHeaders = {
        // Set origin to gateway host so it passes the gateway's origin check
        Origin: `http://${gatewayHost}:${gatewayPort}`,
      };
      if (gatewayAuth) upstreamHeaders['Authorization'] = `Bearer ${gatewayAuth}`;
      const upstreamWs = new WebSocket(upstreamUrl, { headers: upstreamHeaders });

      const closeBoth = (code, reason) => {
        try { clientWs.close(code, reason); } catch {}
        try { upstreamWs.close(code, reason); } catch {}
      };

      const pendingToUpstream = [];
      const MAX_PENDING = 128;

      const sendUpstream = (payload) => {
        if (upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.send(payload);
          return true;
        }
        // Buffer until upstream is open (prevents gateway handshake timeouts if client sends connect immediately)
        if (pendingToUpstream.length < MAX_PENDING) pendingToUpstream.push(payload);
        return false;
      };

      upstreamWs.on('open', () => {
        // Flush buffered frames
        while (pendingToUpstream.length) {
          const p = pendingToUpstream.shift();
          try { upstreamWs.send(p); } catch { break; }
        }
      });

      upstreamWs.on('message', (data, isBinary) => {
        try {
          // Browser WebSocket expects text frames for JSON; if we forward Buffer frames,
          // event.data becomes a Blob/ArrayBuffer and JSON.parse(event.data) fails.
          const payload = isBinary
            ? (Buffer.isBuffer(data) ? data.toString('utf-8') : String(data))
            : (typeof data === 'string' ? data : (Buffer.isBuffer(data) ? data.toString('utf-8') : String(data)));
          if (clientWs.readyState === WebSocket.OPEN) clientWs.send(payload);
        } catch {
          closeBoth(1011, 'proxy send failed');
        }
      });

      upstreamWs.on('close', (code, reason) => {
        try { if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason?.toString()); } catch {}
      });

      upstreamWs.on('error', (err) => {
        console.error('upstream WS error:', err.message || err);
        closeBoth(1011, 'gateway ws error');
      });

      clientWs.on('message', (data, isBinary) => {
        const raw = isBinary
          ? (Buffer.isBuffer(data) ? data.toString('utf-8') : String(data))
          : (typeof data === 'string' ? data : (Buffer.isBuffer(data) ? data.toString('utf-8') : String(data)));

        const rewritten = rewriteConnectFrame(raw, gatewayAuth);
        try {
          sendUpstream(rewritten);
        } catch {
          closeBoth(1011, 'proxy send failed');
        }
      });

      clientWs.on('close', (code, reason) => {
        try { if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close(code, reason); } catch {}
      });

      clientWs.on('error', (err) => {
        console.error('client WS error:', err.message || err);
        closeBoth(1011, 'client ws error');
      });
    });
  } catch (err) {
    console.error('WS upgrade error:', err.message || err);
    socket.destroy();
  }
});

server.listen(PORT, () => {
  const apps = loadApps();
  console.log(`
🎯 ClawCondos Dashboard
   http://localhost:${PORT}

📱 Registered Apps:`);
  
  if (apps.length === 0) {
    console.log('   (none - add to .registry/apps.json)');
  } else {
    apps.forEach(app => {
      console.log(`   • ${app.name} (${app.id}) → localhost:${app.port}`);
      console.log(`     Start: ${app.startCommand}`);
    });
  }
  
  console.log(`
💡 To use an app:
   1. Start the app (see commands above)
   2. Open http://localhost:${PORT}/app.html?id=<app-id>
   
   Example for Knowledge Base:
   $ cd next-app && pnpm dev --port 3001
   $ open http://localhost:${PORT}/app.html?id=kb
`);
});
