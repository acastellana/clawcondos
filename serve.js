#!/usr/bin/env node
/**
 * ClawCondos Development Server
 * 
 * Serves static files + /api/apps + proxies to registered apps
 * Usage: node serve.js [port]
 */

import { createServer, request as httpRequest } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { join, extname, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { rewriteConnectFrame, validateStaticPath, isDotfilePath } from './lib/serve-helpers.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
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

// Goals storage (file-backed, simple JSON)
// Schema (v2): { version: 2, goals: Goal[], sessionIndex: Record<sessionKey, { goalId }>, sessionCondoIndex: Record<sessionKey, condoId> }
// Goal: { id, title, description, completed, status, condoId?, priority?, deadline?, createdAtMs, updatedAtMs, notes?, tasks?, sessions?: string[] }
function goalsFilePath() {
  return join(__dirname, '.registry', 'goals.json');
}

function loadGoalsStore() {
  const file = goalsFilePath();
  if (!existsSync(file)) return { version: 2, goals: [], sessionIndex: {}, sessionCondoIndex: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const rawGoals = Array.isArray(parsed.goals) ? parsed.goals : [];

    // v2 schema adds:
    // - condoId: goal belongs to a condo (Telegram topic)
    // - completed: boolean (sidebar hides completed goals)
    const goals = rawGoals.map(g => {
      const completed = g?.completed === true || g?.status === 'done';
      return {
        ...g,
        condoId: g?.condoId ?? null,
        completed,
        description: g?.description ?? g?.notes ?? '',
        sessions: Array.isArray(g?.sessions) ? g.sessions : [],
      };
    });

    return {
      version: parsed.version ?? 2,
      goals,
      sessionIndex: parsed.sessionIndex && typeof parsed.sessionIndex === 'object' ? parsed.sessionIndex : {},
      sessionCondoIndex: parsed.sessionCondoIndex && typeof parsed.sessionCondoIndex === 'object' ? parsed.sessionCondoIndex : {},
    };
  } catch (err) {
    console.error('loadGoalsStore: failed to parse goals file, returning empty store:', err.message);
    return { version: 2, goals: [], sessionIndex: {}, sessionCondoIndex: {}, _loadError: true };
  }
}

function saveGoalsStore(store) {
  if (store._loadError) {
    console.error('saveGoalsStore: refusing to save — store was loaded with errors (would destroy data)');
    return;
  }
  const file = goalsFilePath();
  const dir = join(__dirname, '.registry');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, file);
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
  return extname(filename || '') || '.bin';
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

function newId(prefix = 'g') {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
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

function resolveAgentWorkspace(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return null;

  // Known local agent workspaces (cheap + reliable; can be generalized later)
  if (id === 'main' || id === 'app-assistant') return resolvePath('/home/albert/clawd');
  if (id === 'caffeine') return resolvePath('/home/albert/clawd-caffeine');
  if (id === 'codex') return resolvePath('/home/albert/clawd');

  return null;
}

function parseMissionFromIdentity(md) {
  const m = String(md || '').match(/^\s*Mission:\s*(.+)$/im);
  if (m) return m[1].trim();
  const lines = String(md || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines[0]?.replace(/^#\s+/, '') || '';
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

function resolveSkills(ids) {
  const out = [];
  const bases = [
    resolvePath('/home/albert/.npm-global/lib/node_modules/openclaw/skills'),
    resolvePath('/home/albert/clawd/skills'),
  ];

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
    headers: { ...req.headers, host: `localhost:${app.port}` },
  };

  const proxyReq = httpRequest(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error(`Proxy error for ${app.id}:`, err.message);
    res.writeHead(503);
    res.end(`App "${app.name}" is offline. Start it with: ${app.startCommand}`);
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
    headers: { ...req.headers, host: `${MEDIA_UPLOAD_HOST}:${MEDIA_UPLOAD_PORT}` },
  };

  const proxyReq = httpRequest(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
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
const wss = new WebSocketServer({ noServer: true });

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

  // Proxy to OpenClaw gateway for /api/gateway/* requests
  // SECURITY: Never hardcode keys. Requires env vars:
  // - GATEWAY_HTTP_HOST (default: localhost)
  // - GATEWAY_HTTP_PORT (default: 18789)
  // - GATEWAY_AUTH (required)
  if (pathname.startsWith('/api/gateway/')) {
    const gatewayPath = pathname.replace('/api/gateway', '');
    const GATEWAY_HTTP_HOST = process.env.GATEWAY_HTTP_HOST || 'localhost';
    const GATEWAY_HTTP_PORT = Number(process.env.GATEWAY_HTTP_PORT || 18789);
    const GATEWAY_AUTH = process.env.GATEWAY_AUTH;

    if (!GATEWAY_AUTH) {
      json(res, 503, { error: { message: 'Gateway proxy disabled: missing GATEWAY_AUTH env', type: 'proxy_config' } });
      return;
    }

    const options = {
      hostname: GATEWAY_HTTP_HOST,
      port: GATEWAY_HTTP_PORT,
      path: gatewayPath + url.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${GATEWAY_HTTP_HOST}:${GATEWAY_HTTP_PORT}`,
        'Authorization': `Bearer ${GATEWAY_AUTH}`,
      },
    };

    const proxyReq = httpRequest(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
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
    if (!full.startsWith(workspace)) {
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

  // API: Goals (ClawCondos)
  // GET  /api/goals
  // POST /api/goals { title, condoId?, description?, completed?, status?, priority?, deadline?, notes?, tasks? }
  if (pathname === '/api/goals' && (req.method === 'GET' || req.method === 'POST')) {
    const store = loadGoalsStore();
    if (req.method === 'GET') {
      json(res, 200, { goals: store.goals });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const now = Date.now();
      const completed = body.completed === true || body.status === 'done';
      const goal = {
        id: newId('goal'),
        condoId: body.condoId != null ? String(body.condoId).trim() : null,
        title: String(body.title || '').trim() || 'Untitled goal',
        description: body.description != null ? String(body.description) : '',
        completed,
        status: completed ? 'done' : (body.status || 'active'),
        priority: body.priority || null,
        deadline: body.deadline || null,
        notes: body.notes || '',
        tasks: Array.isArray(body.tasks) ? body.tasks : [],
        sessions: [],
        createdAtMs: now,
        updatedAtMs: now,
      };
      store.goals.unshift(goal);
      saveGoalsStore(store);
      json(res, 201, { goal });
      return;
    } catch (e) {
      if (e?.statusCode === 413) { json(res, 413, { error: 'Body too large' }); return; }
      if (e instanceof SyntaxError) { json(res, 400, { error: 'Invalid JSON body' }); return; }
      console.error('POST /api/goals error:', e);
      json(res, 500, { error: 'Internal server error' });
      return;
    }
  }

  // GET/PUT/DELETE /api/goals/:id
  const goalMatch = pathname.match(/^\/api\/goals\/([^\/]+)$/);
  if (goalMatch) {
    const goalId = goalMatch[1];
    const store = loadGoalsStore();
    const idx = store.goals.findIndex(g => g.id === goalId);
    if (idx === -1) {
      json(res, 404, { error: 'Goal not found' });
      return;
    }
    if (req.method === 'GET') {
      json(res, 200, { goal: store.goals[idx] });
      return;
    }
    if (req.method === 'DELETE') {
      const [removed] = store.goals.splice(idx, 1);
      // Remove sessionIndex entries pointing to this goal
      for (const [k, v] of Object.entries(store.sessionIndex || {})) {
        if (v?.goalId === removed.id) delete store.sessionIndex[k];
      }
      saveGoalsStore(store);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'PUT') {
      try {
        const body = await readJsonBody(req);
        const now = Date.now();
        const nextCompleted = body.completed != null ? Boolean(body.completed) : store.goals[idx].completed;
        store.goals[idx] = {
          ...store.goals[idx],
          condoId: body.condoId != null ? String(body.condoId).trim() : store.goals[idx].condoId,
          title: body.title != null ? String(body.title).trim() : store.goals[idx].title,
          description: body.description != null ? String(body.description) : store.goals[idx].description,
          completed: nextCompleted,
          status: body.status != null ? body.status : (nextCompleted ? 'done' : store.goals[idx].status),
          priority: body.priority != null ? body.priority : store.goals[idx].priority,
          deadline: body.deadline != null ? body.deadline : store.goals[idx].deadline,
          notes: body.notes != null ? body.notes : store.goals[idx].notes,
          tasks: Array.isArray(body.tasks) ? body.tasks : store.goals[idx].tasks,
          updatedAtMs: now,
        };
        saveGoalsStore(store);
        json(res, 200, { goal: store.goals[idx] });
        return;
      } catch (e) {
        if (e?.statusCode === 413) { json(res, 413, { error: 'Body too large' }); return; }
        if (e instanceof SyntaxError) { json(res, 400, { error: 'Invalid JSON body' }); return; }
        console.error('PUT /api/goals/:id error:', e);
        json(res, 500, { error: 'Internal server error' });
        return;
      }
    }
    json(res, 405, { error: 'Method not allowed' });
    return;
  }

  // POST /api/goals/:id/sessions { sessionKey }
  const goalSessMatch = pathname.match(/^\/api\/goals\/([^\/]+)\/sessions$/);
  if (goalSessMatch && req.method === 'POST') {
    const goalId = goalSessMatch[1];
    const store = loadGoalsStore();
    const goal = store.goals.find(g => g.id === goalId);
    if (!goal) {
      json(res, 404, { error: 'Goal not found' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const sessionKey = String(body.sessionKey || '').trim();
      if (!sessionKey) {
        json(res, 400, { error: 'sessionKey is required' });
        return;
      }
      store.sessionIndex = store.sessionIndex || {};

      // Enforce invariant: 1 session belongs to exactly 1 goal.
      // If session was previously assigned, remove it from the old goal.
      const prev = store.sessionIndex[sessionKey];
      if (prev?.goalId && prev.goalId !== goalId) {
        const oldGoal = store.goals.find(g => g.id === prev.goalId);
        if (oldGoal?.sessions && Array.isArray(oldGoal.sessions)) {
          oldGoal.sessions = oldGoal.sessions.filter(k => k !== sessionKey);
          oldGoal.updatedAtMs = Date.now();
        }
      }

      // Move semantics: remove this session from any other goal first
      for (const other of store.goals) {
        if (!other || other.id === goal.id) continue;
        if (!Array.isArray(other.sessions)) continue;
        const before = other.sessions.length;
        other.sessions = other.sessions.filter(k => k !== sessionKey);
        if (other.sessions.length !== before) {
          other.updatedAtMs = Date.now();
        }
      }

      goal.sessions = Array.isArray(goal.sessions) ? goal.sessions : [];
      if (!goal.sessions.includes(sessionKey)) goal.sessions.unshift(sessionKey);
      store.sessionIndex[sessionKey] = { goalId };
      goal.updatedAtMs = Date.now();
      saveGoalsStore(store);
      json(res, 200, { ok: true, goal });
      return;
    } catch (e) {
      if (e?.statusCode === 413) { json(res, 413, { error: 'Body too large' }); return; }
      if (e instanceof SyntaxError) { json(res, 400, { error: 'Invalid JSON body' }); return; }
      console.error('POST /api/goals/:id/sessions error:', e);
      json(res, 500, { error: 'Internal server error' });
      return;
    }
  }

  // GET /api/session-goal?sessionKey=...
  if (pathname === '/api/session-goal' && req.method === 'GET') {
    const store = loadGoalsStore();
    const sessionKey = url.searchParams.get('sessionKey') || '';
    const mapping = store.sessionIndex?.[sessionKey] || null;
    json(res, 200, { mapping });
    return;
  }

  // GET /api/session-condos
  if (pathname === '/api/session-condos' && req.method === 'GET') {
    const store = loadGoalsStore();
    json(res, 200, { sessionCondoIndex: store.sessionCondoIndex || {} });
    return;
  }

  // GET /api/session-condo?sessionKey=...
  if (pathname === '/api/session-condo' && req.method === 'GET') {
    const store = loadGoalsStore();
    const sessionKey = url.searchParams.get('sessionKey') || '';
    const condoId = (store.sessionCondoIndex || {})[sessionKey] || null;
    json(res, 200, { sessionKey, condoId });
    return;
  }

  // POST /api/session-condo { sessionKey, condoId }
  if (pathname === '/api/session-condo' && req.method === 'POST') {
    const store = loadGoalsStore();
    try {
      const body = await readJsonBody(req);
      const sessionKey = String(body.sessionKey || '').trim();
      const condoId = body.condoId != null ? String(body.condoId).trim() : '';
      if (!sessionKey) {
        json(res, 400, { ok: false, error: 'sessionKey is required' });
        return;
      }
      if (!condoId) {
        json(res, 400, { ok: false, error: 'condoId is required' });
        return;
      }
      store.sessionCondoIndex = store.sessionCondoIndex && typeof store.sessionCondoIndex === 'object' ? store.sessionCondoIndex : {};
      store.sessionCondoIndex[sessionKey] = condoId;
      saveGoalsStore(store);
      json(res, 200, { ok: true, sessionKey, condoId });
      return;
    } catch (e) {
      if (e?.statusCode === 413) { json(res, 413, { ok: false, error: 'Body too large' }); return; }
      if (e instanceof SyntaxError) { json(res, 400, { ok: false, error: 'Invalid JSON body' }); return; }
      console.error('POST /api/session-condo error:', e);
      json(res, 500, { ok: false, error: 'Internal server error' });
      return;
    }
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
        serverPath: outPath,
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
      const allowedRoots = [
        resolvePath(join(__dirname, 'media')),
        resolvePath('/home/albert/clawd/apps/uploads'),
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
  // Single UI version (no /v2).
  // - Canonical: /
  // - Compatibility: /v2/* redirects to /*
  // - Deprecated: /v1/* redirects to /

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

  // Back-compat: redirect /v2/* → /*
  if (pathname === '/v2' || pathname === '/v2/') {
    res.writeHead(301, { Location: '/' + (url.search || '') });
    res.end();
    return;
  }
  if (pathname.startsWith('/v2/')) {
    const rel = pathname.slice('/v2'.length); // keep leading '/'
    res.writeHead(301, { Location: (rel || '/') + (url.search || '') });
    res.end();
    return;
  }

  // v1 is deprecated; v2 is the only UI.
  if (pathname === '/v1' || pathname.startsWith('/v1/')) {
    res.writeHead(301, { Location: '/' + (url.search || '') });
    res.end();
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

    const gatewayAuth = process.env.GATEWAY_AUTH || null;

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      const upstreamUrl = getGatewayWsUrl();
      const upstreamWs = new WebSocket(upstreamUrl, gatewayAuth ? {
        headers: {
          // Gateway supports Authorization header auth (matches prior Caddy-based approach)
          Authorization: `Bearer ${gatewayAuth}`,
        },
      } : undefined);

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
