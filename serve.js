#!/usr/bin/env node
/**
 * ClawCondos Development Server
 * 
 * Serves static files + /api/apps + proxies to registered apps
 * Usage: node serve.js [port]
 */

import { createServer, request as httpRequest } from 'http';
import https from 'https';
import WebSocket, { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, extname, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import { rewriteConnectFrame, validateStaticPath, isDotfilePath, filterProxyHeaders, stripSensitiveHeaders } from './lib/serve-helpers.js';
import { createGatewayClient } from './lib/gateway-client.js';
import { filterGoals, filterSessions, crossRefFileWithGoals } from './lib/search.js';
import { createEmbeddingProvider } from './lib/embedding-provider.js';
import { createMemorySearch } from './lib/memory-search.js';
import { createChatIndex } from './lib/chat-index.js';
import { createGoalsStore } from './clawcondos/condo-management/lib/goals-store.js';
import { createGoalHandlers } from './clawcondos/condo-management/lib/goals-handlers.js';
import { createCondoHandlers } from './clawcondos/condo-management/lib/condos-handlers.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Auto-load env file (fills in any vars not already set in the environment)
const ENV_FILE = join(process.env.HOME || '', '.config', 'clawcondos.env');
if (existsSync(ENV_FILE)) {
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

// ── Real-time goal sync: watch goals.json and broadcast changes to all clients ──
import { watchFile, unwatchFile } from 'fs';
const connectedClients = new Set();
const observedSessions = new Map(); // sessionKey -> { key, updatedAt, displayName, channel, kind }
const observedActiveRuns = new Map(); // sessionKey -> { runId, startedAt }

function buildLocalSessionsFallback(limit = 500) {
  const result = new Map();

  // Best source: OpenClaw local session store via CLI.
  try {
    let raw = '';
    const candidates = ['openclaw', '/home/albert/.npm-global/bin/openclaw'];
    for (const bin of candidates) {
      try {
        raw = execFileSync(bin, ['sessions', '--json'], {
          encoding: 'utf8',
          timeout: 8000,
          env: {
            ...process.env,
            PATH: `${process.env.PATH || ''}:/home/albert/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`
          }
        });
        if (raw) break;
      } catch {}
    }
    if (!raw) throw new Error('openclaw sessions unavailable');
    const parsed = JSON.parse(raw);
    for (const s of (parsed?.sessions || [])) {
      const key = s?.key;
      if (!key) continue;
      result.set(key, {
        key,
        updatedAt: s?.updatedAt || Date.now(),
        displayName: s?.displayName || key,
        channel: key.includes(':telegram:') ? 'telegram' : undefined,
        kind: s?.kind || 'other'
      });
    }
  } catch {}

  // Merge in observed sessions from event stream.
  for (const [k, v] of observedSessions.entries()) {
    if (!result.has(k)) result.set(k, { ...v });
  }

  return Array.from(result.values())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, Math.max(1, limit));
}
const GOALS_FILE = join(__dirname, 'clawcondos/condo-management/.data/goals.json');
const GOALS_DATA_DIR = join(__dirname, 'clawcondos/condo-management/.data');
const goalsStore = createGoalsStore(GOALS_DATA_DIR);
const goalHandlers = createGoalHandlers(goalsStore);
const condoHandlers = createCondoHandlers(goalsStore);
let lastGoalsMtime = 0;

function broadcastGoalsChanged() {
  const msg = JSON.stringify({ type: 'event', event: 'goals.changed', payload: {} });
  let count = 0;
  for (const ws of connectedClients) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
        count++;
      }
    } catch {}
  }
  console.log(`[goals-sync] Broadcast goals.changed to ${count} clients`);
}

async function tryLocalGoalsRpc(method, params = {}) {
  const handler = goalHandlers?.[method] || condoHandlers?.[method];
  if (!handler) return { handled: false };
  return await new Promise((resolve) => {
    try {
      handler({
        params,
        respond: (ok, payload, error) => {
          if (ok) {
            resolve({ handled: true, ok: true, result: payload || {} });
          } else {
            resolve({ handled: true, ok: false, error: error || { message: 'Local goals RPC failed' } });
          }
        }
      });
    } catch (err) {
      resolve({ handled: true, ok: false, error: { message: err?.message || String(err) } });
    }
  });
}

function initGoalsWatcher() {
  if (!existsSync(GOALS_FILE)) {
    console.log(`[goals-sync] Goals file not found, skipping watcher`);
    return;
  }
  try {
    lastGoalsMtime = statSync(GOALS_FILE).mtimeMs;
    // Use watchFile with polling (more reliable for atomic writes)
    watchFile(GOALS_FILE, { interval: 500 }, (curr, prev) => {
      if (curr.mtimeMs !== lastGoalsMtime) {
        lastGoalsMtime = curr.mtimeMs;
        broadcastGoalsChanged();
      }
    });
    console.log(`[goals-sync] Watching ${GOALS_FILE} for changes (polling mode)`);
  } catch (err) {
    console.error(`[goals-sync] Failed to watch goals file: ${err.message}`);
  }
}
initGoalsWatcher();

// ── Kickoff event relay: plugin writes events to a file, serve.js broadcasts to clients ──
const KICKOFF_FILE = join(__dirname, 'clawcondos/condo-management/.data/kickoff-events.json');
let lastKickoffMtime = 0;

function broadcastKickoffEvents() {
  try {
    const raw = readFileSync(KICKOFF_FILE, 'utf-8').trim();
    if (!raw) return;
    const events = JSON.parse(raw);
    if (!Array.isArray(events) || events.length === 0) return;
    for (const evt of events) {
      const msg = JSON.stringify({ type: 'event', event: evt.event || 'goal.kickoff', payload: evt });
      let count = 0;
      for (const ws of connectedClients) {
        try {
          if (ws.readyState === WebSocket.OPEN) { ws.send(msg); count++; }
        } catch {}
      }
      console.log(`[kickoff-relay] Broadcast ${evt.event || 'goal.kickoff'} to ${count} clients (goal=${evt.goalId})`);
    }
    // Clear the file after broadcasting
    writeFileSync(KICKOFF_FILE, '[]', 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[kickoff-relay] Error: ${err.message}`);
  }
}

function initKickoffWatcher() {
  // Create file if missing
  const dir = dirname(KICKOFF_FILE);
  if (!existsSync(dir)) return;
  if (!existsSync(KICKOFF_FILE)) writeFileSync(KICKOFF_FILE, '[]', 'utf-8');
  try {
    lastKickoffMtime = statSync(KICKOFF_FILE).mtimeMs;
    watchFile(KICKOFF_FILE, { interval: 300 }, (curr) => {
      if (curr.mtimeMs !== lastKickoffMtime) {
        lastKickoffMtime = curr.mtimeMs;
        broadcastKickoffEvents();
      }
    });
    console.log(`[kickoff-relay] Watching ${KICKOFF_FILE} for events`);
  } catch (err) {
    console.error(`[kickoff-relay] Failed to watch: ${err.message}`);
  }
}
initKickoffWatcher();

function getGatewayWsUrl() {
  const host = process.env.GATEWAY_HTTP_HOST || '127.0.0.1';
  const port = Number(process.env.GATEWAY_HTTP_PORT || 18789);
  return process.env.GATEWAY_WS_URL || `ws://${host}:${port}/ws`;
}

function readOpenClawDotEnv() {
  try {
    const p = join(os.homedir(), '.openclaw', '.env');
    if (!existsSync(p)) return {};
    const out = {};
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

// Read gateway credentials from env/config/dotenv.
function getGatewayPassword() {
  if (process.env.GATEWAY_PASSWORD) return process.env.GATEWAY_PASSWORD;
  try {
    const confPath = join(os.homedir(), '.openclaw', 'openclaw.json');
    const conf = JSON.parse(readFileSync(confPath, 'utf-8'));
    if (conf?.gateway?.auth?.password) return conf.gateway.auth.password;
  } catch {}
  const envFile = readOpenClawDotEnv();
  return envFile.CLAWDBOT_GATEWAY_PASSWORD || '';
}

function getGatewayToken() {
  if (process.env.GATEWAY_AUTH) return process.env.GATEWAY_AUTH;
  try {
    const confPath = join(os.homedir(), '.openclaw', 'openclaw.json');
    const conf = JSON.parse(readFileSync(confPath, 'utf-8'));
    if (conf?.gateway?.auth?.token) return conf.gateway.auth.token;
  } catch {}
  const envFile = readOpenClawDotEnv();
  return envFile.CLAWDBOT_GATEWAY_TOKEN || '';
}

// Internal gateway client (lazy connect on first rpcCall)
const gatewayClient = createGatewayClient({
  getWsUrl: getGatewayWsUrl,
  getAuth: () => process.env.GATEWAY_AUTH || '',
  getPassword: getGatewayPassword
});

// ── Deep search backends ──
const embeddingProvider = createEmbeddingProvider({
  provider: process.env.CLAWCONDOS_EMBEDDING_PROVIDER || 'openai',
  apiKey: process.env.OPENAI_API_KEY,
});

const memorySearch = createMemorySearch({
  stateDir: process.env.OPENCLAW_STATE_DIR || join(os.homedir(), '.openclaw'),
  embeddingProvider,
  logger: console,
});

try { memorySearch.init(); } catch (err) {
  console.error('[memory-search] Init failed:', err.message);
}

const chatIndex = createChatIndex({
  dbPath: join(__dirname, '.data', 'chat-index.db'),
  embeddingProvider,
  logger: console,
});

const chatIndexDisabled = String(process.env.CLAWCONDOS_DISABLE_CHAT_INDEX || '') === '1';
try {
  chatIndex.init();
  if (chatIndexDisabled) {
    console.log('[chat-index] Disabled via CLAWCONDOS_DISABLE_CHAT_INDEX=1');
  } else {
    // Initial background sync (non-blocking)
    chatIndex.sync(gatewayClient).catch(err => console.error('[chat-index] Initial sync failed:', err.message));
    // Schedule recurring sync
    const syncInterval = parseInt(process.env.CLAWCONDOS_SEARCH_SYNC_INTERVAL_MS) || 300000;
    chatIndex.startBackgroundSync(gatewayClient, syncInterval);
  }
} catch (err) {
  console.error('[chat-index] Init failed:', err.message);
}

// Session cache for search (3s TTL to avoid hammering gateway on rapid keystrokes)
let _sessionCache = null;
let _sessionCacheTs = 0;
const SESSION_CACHE_TTL = 3000;

async function getCachedSessions(limit = 500) {
  const now = Date.now();
  if (_sessionCache && (now - _sessionCacheTs) < SESSION_CACHE_TTL) {
    return _sessionCache;
  }
  const result = await gatewayClient.rpcCall('sessions.list', { limit });
  const sessions = result?.sessions;
  if (!Array.isArray(sessions)) {
    console.warn('[search] sessions.list returned unexpected shape, got keys:', result ? Object.keys(result) : 'null');
    _sessionCache = [];
  } else {
    _sessionCache = sessions;
  }
  _sessionCacheTs = now;
  return _sessionCache;
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

  // API: Search status
  // GET /api/search/status
  if (pathname === '/api/search/status' && req.method === 'GET') {
    const chatStats = chatIndex.getStats();
    const memoryDbs = memorySearch.getAgentDbs();
    json(res, 200, {
      ok: true,
      chatIndex: chatStats,
      memoryDbs,
      embeddingProvider: embeddingProvider.getProviderName(),
      embeddingAvailable: embeddingProvider.isAvailable(),
    });
    return;
  }

  // API: Force reindex
  // POST /api/search/reindex
  if (pathname === '/api/search/reindex' && req.method === 'POST') {
    chatIndex.sync(gatewayClient).catch(err => console.error('[chat-index] Reindex failed:', err.message));
    json(res, 200, { ok: true, message: 'Reindex started' });
    return;
  }

  // API: Search goals and sessions (ClawCondos)
  // GET /api/search?q=<query>&limit=<max>&mode=fast|deep|auto
  if (pathname === '/api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 100, 200);
    const requestedMode = url.searchParams.get('mode') || 'fast';
    if (!q) {
      json(res, 400, { ok: false, error: 'q parameter is required' });
      return;
    }
    if (q.length > 500) {
      json(res, 400, { ok: false, error: 'Query too long (max 500 chars)' });
      return;
    }

    // Determine effective mode
    let mode = requestedMode;
    if (mode === 'auto') {
      const chatStats = chatIndex.getStats();
      mode = (chatStats.initialized && chatStats.sessionCount > 0 && q.split(/\s+/).length > 1) ? 'deep' : 'fast';
    }

    try {
      // Always run fast search (metadata-based)
      const [goalsRes, sessionsRes] = await Promise.allSettled([
        gatewayClient.rpcCall('goals.list', {}),
        getCachedSessions(500)
      ]);
      const allGoals = goalsRes.status === 'fulfilled' ? (goalsRes.value?.goals || []) : [];
      const goals = filterGoals(allGoals, q).slice(0, limit);
      const allSessionsList = sessionsRes.status === 'fulfilled' ? (sessionsRes.value || []) : [];
      const filteredSessions = sessionsRes.status === 'fulfilled'
        ? filterSessions(allSessionsList, q).slice(0, limit) : [];
      if (goalsRes.status === 'rejected') console.error('[search] goals.list failed:', goalsRes.reason?.message);
      if (sessionsRes.status === 'rejected') console.error('[search] sessions.list failed:', sessionsRes.reason?.message);

      // Enrich sessions with goal/condo info and worker/subagent detection
      function enrichSession(s) {
        // Match both legacy subagent format and new webchat:task- format
        s.isSubagent = s.key.includes(':subagent:') || s.key.includes(':webchat:task-');
        if (s.isSubagent) {
          const parts = s.key.split(':');
          if (parts.length >= 4 && (parts[2] === 'subagent' || (parts[2] === 'webchat' && parts[3]?.startsWith('task-')))) {
            s.parentKey = parts[0] + ':' + parts[1] + ':main';
          }
        }
        for (const g of allGoals) {
          if (Array.isArray(g.sessions) && g.sessions.includes(s.key)) {
            s.goalTitle = g.title;
            s.goalId = g.id;
            s.condoId = g.condoId;
            s.condoName = g.condoName;
            break;
          }
        }
      }
      for (const s of filteredSessions) enrichSession(s);

      // Include parent sessions when subagents match but parent doesn't
      const filteredKeys = new Set(filteredSessions.map(s => s.key));
      const sessionsByKey = new Map(allSessionsList.map(s => [s.key, s]));
      for (const s of [...filteredSessions]) {
        if (s.isSubagent && s.parentKey && !filteredKeys.has(s.parentKey)) {
          const parent = sessionsByKey.get(s.parentKey);
          if (parent) {
            const p = { ...parent, includedAsParent: true };
            enrichSession(p);
            filteredSessions.push(p);
            filteredKeys.add(p.key);
          }
        }
      }

      // Deep search: query both memory DBs and chat index
      let files = [];
      let deepSessions = [];
      if (mode === 'deep') {
        const [memoryRes, chatRes] = await Promise.allSettled([
          memorySearch.search(q, { limit }),
          chatIndex.search(q, { limit }),
        ]);

        if (memoryRes.status === 'fulfilled' && memoryRes.value.length > 0) {
          files = memoryRes.value.map(r => {
            const ref = crossRefFileWithGoals(r.path, allGoals);
            return {
              path: r.path,
              agentId: r.agentId,
              score: r.score,
              snippet: r.snippet,
              startLine: r.startLine,
              endLine: r.endLine,
              sessionKey: ref?.sessionKey || null,
              goalId: ref?.goalId || null,
              goalTitle: ref?.goalTitle || null,
            };
          });
        }
        if (memoryRes.status === 'rejected') console.error('[search] memory search failed:', memoryRes.reason?.message);

        if (chatRes.status === 'fulfilled' && chatRes.value.length > 0) {
          deepSessions = chatRes.value;
          // Merge deep session results with fast results (avoid duplicates)
          for (const ds of deepSessions) {
            if (!filteredKeys.has(ds.sessionKey)) {
              const sessionData = sessionsByKey.get(ds.sessionKey);
              const merged = {
                key: ds.sessionKey,
                displayName: ds.displayName || sessionData?.displayName || '',
                label: sessionData?.label || '',
                score: ds.score,
                snippet: ds.snippet,
                source: 'chat',
              };
              enrichSession(merged);
              filteredSessions.push(merged);
              filteredKeys.add(ds.sessionKey);
            } else {
              // Add snippet/score to existing result
              const existing = filteredSessions.find(s => s.key === ds.sessionKey);
              if (existing && !existing.snippet) {
                existing.snippet = ds.snippet;
                existing.score = ds.score;
                existing.source = 'chat';
              }
            }
          }
        }
        if (chatRes.status === 'rejected') console.error('[search] chat index search failed:', chatRes.reason?.message);
      }

      json(res, 200, { ok: true, query: q, mode, goals, sessions: filteredSessions, files });
    } catch (err) {
      console.error('[search] Error:', err.message, err.stack);
      json(res, 500, { ok: false, error: 'Internal search error' });
    }
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
      const extraUploadDir = process.env.CLAWCONDOS_UPLOAD_DIR || '';
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

  // API: /api/local-sessions -> local session snapshot independent of gateway WS auth
  if (pathname === '/api/local-sessions' && req.method === 'GET') {
    try {
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit') || 500)));
      const sessions = buildLocalSessionsFallback(limit);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ sessions }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
    return;
  }

  // API: /api/apps -> serve apps.json
  if (pathname === '/api/apps') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ apps }));
    return;
  }

  // API: /api/cron-recurring -> list enabled recurring cron jobs (server-side)
  if (pathname === '/api/cron-recurring' || pathname === '/api/cron-recurring/') {
    try {
      const openclawBin = process.env.OPENCLAW_BIN || '/home/albert/.npm-global/bin/openclaw';
      const raw = execFileSync(openclawBin, ['cron', 'list', '--all', '--json'], { encoding: 'utf8', timeout: 15000 });
      const parsed = JSON.parse(raw);
      const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || []);
      const recurring = jobs
        .filter(j => j && j.enabled !== false)
        .filter(j => ['cron', 'every'].includes(j?.schedule?.kind))
        .map(j => ({
          id: j.jobId || j.id,
          name: j.name || (j.jobId || j.id),
          agentId: j.agentId || 'main',
          schedule: j.schedule || null,
          model: j?.payload?.model || 'default',
          delivery: j?.delivery?.mode || 'none'
        }));
      json(res, 200, { ok: true, jobs: recurring });
    } catch (err) {
      json(res, 500, { ok: false, error: err?.message || String(err) });
    }
    return;
  }
  
  // Check if path matches a built-in static app (served from public/ — no separate server)
  for (const app of apps) {
    if (app.static && (pathname === `/${app.id}` || pathname.startsWith(`/${app.id}/`))) {
      const staticFile = join(__dirname, 'public', app.staticFile || `${app.id}.html`);
      serveFile(res, staticFile);
      return;
    }
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
  if (pathname === '/clawcondos-lib/config.js' || pathname === '/clawcondos-lib/config.js') {
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

// ── Local service config RPC handler ──
// Handles config.getServices, config.setService, config.deleteService locally
// so they work even if the gateway plugin hasn't been restarted.
function tryHandleLocalServiceRpc(raw, clientWs) {
  let frame;
  try { frame = JSON.parse(raw); } catch { return false; }
  if (!frame || frame.type !== 'req') return false;

  const LOCAL_METHODS = ['config.getServices', 'config.setService', 'config.deleteService', 'config.verifyGitHub'];
  if (!LOCAL_METHODS.includes(frame.method)) return false;

  const respond = (ok, payload, error) => {
    const res = ok
      ? { type: 'res', id: frame.id, ok: true, payload }
      : { type: 'res', id: frame.id, ok: false, error: typeof error === 'string' ? { message: error } : error };
    try { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(res)); } catch {}
  };

  try {
    const goalsPath = GOALS_FILE;
    const loadData = () => {
      if (!existsSync(goalsPath)) return { config: {}, condos: [] };
      return JSON.parse(readFileSync(goalsPath, 'utf-8'));
    };
    const persistData = (d) => {
      const dir = join(__dirname, 'clawcondos/condo-management/.data');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(goalsPath, JSON.stringify(d, null, 2));
    };

    const params = frame.params || {};

    // ── Token masking ──
    const SENSITIVE = ['token', 'apiKey', 'secret', 'password', 'accessToken', 'agentToken'];
    const maskSvc = (svc) => {
      if (!svc || typeof svc !== 'object') return svc;
      const m = { ...svc };
      for (const k of SENSITIVE) {
        if (m[k] && typeof m[k] === 'string') {
          const v = m[k];
          m[k] = v.length > 8 ? v.slice(0, 4) + '****' + v.slice(-4) : '****';
          m[k + 'Configured'] = true;
        }
      }
      return m;
    };
    const maskAll = (svcs) => {
      const r = {};
      for (const [n, s] of Object.entries(svcs || {})) r[n] = maskSvc(s);
      return r;
    };

    if (frame.method === 'config.getServices') {
      const data = loadData();
      const globalSvcs = data.config?.services || {};
      if (params.condoId) {
        const condo = (data.condos || []).find(c => c.id === params.condoId);
        if (!condo) return respond(false, null, 'Condo not found'), true;
        const overrides = condo.services || {};
        const merged = { ...globalSvcs };
        for (const [n, o] of Object.entries(overrides)) merged[n] = { ...(merged[n] || {}), ...o };
        respond(true, { services: maskAll(merged), overrides: maskAll(overrides) });
      } else {
        respond(true, { services: maskAll(globalSvcs) });
      }
      return true;
    }

    if (frame.method === 'config.setService') {
      const { service, config: svcCfg, condoId } = params;
      if (!service || typeof service !== 'string') return respond(false, null, 'service name is required'), true;
      if (!svcCfg || typeof svcCfg !== 'object') return respond(false, null, 'config object is required'), true;
      const data = loadData();
      if (condoId) {
        const condo = (data.condos || []).find(c => c.id === condoId);
        if (!condo) return respond(false, null, 'Condo not found'), true;
        if (!condo.services) condo.services = {};
        condo.services[service] = { ...(condo.services[service] || {}), ...svcCfg };
        condo.updatedAtMs = Date.now();
      } else {
        if (!data.config) data.config = {};
        if (!data.config.services) data.config.services = {};
        data.config.services[service] = { ...(data.config.services[service] || {}), ...svcCfg };
        data.config.updatedAtMs = Date.now();
      }
      persistData(data);
      respond(true, { ok: true });
      return true;
    }

    if (frame.method === 'config.deleteService') {
      const { service, condoId } = params;
      if (!service || typeof service !== 'string') return respond(false, null, 'service name is required'), true;
      const data = loadData();
      if (condoId) {
        const condo = (data.condos || []).find(c => c.id === condoId);
        if (!condo) return respond(false, null, 'Condo not found'), true;
        if (condo.services) {
          delete condo.services[service];
          if (Object.keys(condo.services).length === 0) delete condo.services;
        }
        condo.updatedAtMs = Date.now();
      } else {
        if (data.config?.services) {
          delete data.config.services[service];
          if (Object.keys(data.config.services).length === 0) delete data.config.services;
        }
        if (data.config) data.config.updatedAtMs = Date.now();
      }
      persistData(data);
      respond(true, { ok: true });
      return true;
    }

    if (frame.method === 'config.verifyGitHub') {
      const { token: rawToken, condoId, repoUrl } = params;

      // Resolve token
      let tokenToVerify = rawToken;
      if (!tokenToVerify) {
        const data = loadData();
        if (condoId) {
          const condo = (data.condos || []).find(c => c.id === condoId);
          const condoGh = condo?.services?.github;
          if (condoGh?.agentToken) tokenToVerify = condoGh.agentToken;
          else if (condoGh?.token) tokenToVerify = condoGh.token;
        }
        if (!tokenToVerify) {
          const gh = data.config?.services?.github;
          if (gh?.agentToken) tokenToVerify = gh.agentToken;
          else if (gh?.token) tokenToVerify = gh.token;
        }
      }

      if (!tokenToVerify) {
        respond(true, { valid: false, error: 'No GitHub token configured' });
        return true;
      }

      // Async: make GitHub API calls and respond when done
      const ghApiCall = (method, path) => new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.github.com', path, method,
          headers: {
            'Authorization': `Bearer ${tokenToVerify}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'ClawCondos/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }, (res) => {
          let raw = '';
          res.on('data', chunk => raw += chunk);
          res.on('end', () => {
            let data = null;
            try { data = JSON.parse(raw); } catch {}
            resolve({ data, headers: res.headers, statusCode: res.statusCode });
          });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
      });

      (async () => {
        try {
          const { data, headers: hdrs, statusCode } = await ghApiCall('GET', '/user');
          if (statusCode === 401 || statusCode === 403) {
            return respond(true, { valid: false, error: `Authentication failed (${statusCode}): ${data?.message || 'Invalid token'}` });
          }
          if (statusCode < 200 || statusCode >= 300) {
            return respond(true, { valid: false, error: `GitHub API returned ${statusCode}: ${data?.message || 'Unknown error'}` });
          }

          const scopesHeader = hdrs['x-oauth-scopes'];
          const scopes = scopesHeader ? scopesHeader.split(',').map(s => s.trim()).filter(Boolean) : [];
          const tokenType = scopesHeader !== undefined ? 'classic' : 'fine-grained';
          const result = { valid: true, login: data.login, name: data.name || null, scopes, tokenType };

          if (repoUrl && typeof repoUrl === 'string') {
            const ghMatch = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
            if (ghMatch) {
              const [, owner, repo] = ghMatch;
              try {
                const repoResp = await ghApiCall('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
                if (repoResp.statusCode >= 200 && repoResp.statusCode < 300) {
                  result.repoAccess = { accessible: true, permissions: repoResp.data?.permissions || {} };
                } else {
                  result.repoAccess = { accessible: false, error: `${repoResp.statusCode}: ${repoResp.data?.message || 'Cannot access repo'}` };
                }
              } catch (repoErr) {
                result.repoAccess = { accessible: false, error: repoErr.message };
              }
            } else {
              result.repoAccess = { accessible: null, note: 'Non-GitHub URL' };
            }
          }

          respond(true, result);
        } catch (err) {
          respond(true, { valid: false, error: err.message });
        }
      })();

      return true;
    }
  } catch (err) {
    respond(false, null, err.message);
    return true;
  }

  return false;
}

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

    const gatewayToken = process.env.GATEWAY_AUTH || null;
    const gatewayPassword = process.env.GATEWAY_PASSWORD || getGatewayPassword() || null;

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      wsConnectionCount++;
      connectedClients.add(clientWs);
      console.log(`[ws] Client connected, total: ${connectedClients.size}`);
      clientWs.on('close', () => {
        wsConnectionCount--;
        connectedClients.delete(clientWs);
        console.log(`[ws] Client disconnected, total: ${connectedClients.size}`);
      });
      const upstreamUrl = getGatewayWsUrl();
      const gatewayHost = process.env.GATEWAY_HTTP_HOST || '127.0.0.1';
      const gatewayPort = Number(process.env.GATEWAY_HTTP_PORT || 18789);
      const upstreamHeaders = {
        // Set origin to gateway host so it passes the gateway's origin check
        Origin: `http://${gatewayHost}:${gatewayPort}`,
      };
      if (gatewayToken) upstreamHeaders['Authorization'] = `Bearer ${gatewayToken}`;
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

          // Opportunistic local cache for sessions/active-runs fallback when scopes are restricted.
          try {
            const msg = JSON.parse(payload);
            if (msg?.type === 'event') {
              const p = msg?.payload || {};
              const sessionKey = p?.sessionKey;
              if (sessionKey && typeof sessionKey === 'string') {
                const now = Date.now();
                observedSessions.set(sessionKey, {
                  key: sessionKey,
                  updatedAt: now,
                  displayName: p?.displayName || p?.label || sessionKey,
                  channel: sessionKey.includes(':telegram:') ? 'telegram' : undefined,
                  kind: 'other'
                });
              }
              if (msg.event === 'agent' && sessionKey) {
                const phase = p?.data?.phase;
                const runId = p?.runId;
                if (phase === 'start' && runId) {
                  observedActiveRuns.set(sessionKey, { runId, startedAt: Date.now() });
                } else if (phase === 'end') {
                  observedActiveRuns.delete(sessionKey);
                }
              }
            }
          } catch {}

          if (clientWs.readyState === WebSocket.OPEN) clientWs.send(payload);
        } catch {
          closeBoth(1011, 'proxy send failed');
        }
      });

      upstreamWs.on('close', (code, reason) => {
        console.warn('upstream WS closed:', code, reason?.toString?.() || '');
        // Keep client socket alive for local RPC fallbacks.
      });

      upstreamWs.on('error', (err) => {
        console.error('upstream WS error:', err.message || err);
        // Keep client socket alive for local RPC fallbacks.
      });

      clientWs.on('message', async (data, isBinary) => {
        const raw = isBinary
          ? (Buffer.isBuffer(data) ? data.toString('utf-8') : String(data))
          : (typeof data === 'string' ? data : (Buffer.isBuffer(data) ? data.toString('utf-8') : String(data)));

        // ── Local intercept for service config RPC ──
        // These methods may not yet be registered on the gateway (requires restart),
        // so handle them locally against the same goals.json store.
        const localResult = tryHandleLocalServiceRpc(raw, clientWs);
        if (localResult) return; // Handled locally, don't forward

        // Handle privileged reads server-side to avoid browser scope/device limitations.
        // Browser still uses /ws, but these methods execute via trusted gatewayClient auth.
        try {
          const frame = JSON.parse(raw);
          const method = frame?.method;

          // connect handshake is handled by upstream gateway.

          const localRpcMethods = new Set([
            'sessions.list',
            'agents.list',
            'chat.activeRuns',
            'goals.list',
            'goals.get',
            'goals.create',
            'goals.update',
            'goals.delete',
            'goals.addSession',
            'goals.removeSession',
            'goals.sessionLookup',
            'goals.addTask',
            'goals.updateTask',
            'goals.deleteTask',
            'goals.addFiles',
            'goals.removeFile',
            'goals.setSessionCondo',
            'goals.getSessionCondo',
            'goals.listSessionCondos',
            'goals.removeSessionCondo',
            'goals.spawnTaskSession',
            'goals.updatePlan',
            'goals.checkConflicts',
            'goals.kickoff',
            'goals.spawnTaskSession',
            'condos.list',
            'condos.get',
            'condos.create',
            'condos.update',
            'condos.delete',
            'status',
            'chat.history'
          ]);

          if (frame?.type === 'req' && localRpcMethods.has(method)) {
            // Local/session cache fallbacks for scoped environments.
            if (method === 'sessions.list') {
              try {
                const result = await gatewayClient.rpcCall(method, frame.params || {});
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({ type: 'res', id: String(frame.id), method, ok: true, result }));
                }
                return;
              } catch {
                const limit = Number(frame?.params?.limit || 500);
                const sessions = buildLocalSessionsFallback(limit);
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({ type: 'res', id: String(frame.id), method, ok: true, result: { sessions } }));
                }
                return;
              }
            }

            if (method === 'chat.activeRuns') {
              const activeRuns = Array.from(observedActiveRuns.entries()).map(([sessionKey, v]) => ({
                sessionKey,
                runId: v?.runId,
                startedAt: v?.startedAt || Date.now()
              }));
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'res', id: String(frame.id), method, ok: true, result: { activeRuns } }));
              }
              return;
            }

            if (method === 'agents.list') {
              try {
                const cfg = JSON.parse(readFileSync(resolvePath(process.env.OPENCLAW_CONFIG_PATH || join(os.homedir(), '.openclaw', 'openclaw.json')), 'utf8'));
                const agents = (cfg?.agents?.list || []).map(a => ({ ...a }));
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({ type: 'res', id: String(frame.id), method, ok: true, result: { agents } }));
                }
                return;
              } catch {}
            }

            // Write-capable goals.*/condos.* methods are served locally to avoid scope/auth edge-cases.
            // goals.kickoff / goals.spawnTaskSession: forward to gateway + bridge chat.send for spawned sessions
            if (method === 'goals.kickoff' || method === 'goals.spawnTaskSession') {
              try {
                const result = await gatewayClient.rpcCall(method, frame.params || {});
                // Collect spawned sessions from either response shape
                const spawned = result?.spawnedSessions
                  || (result?.sessionKey && result?.taskContext ? [result] : []);

                // Bridge: start each spawned session via chat.send
                for (const s of spawned) {
                  if (!s.sessionKey || !s.taskContext) continue;
                  try {
                    await gatewayClient.rpcCall('chat.send', {
                      sessionKey: s.sessionKey,
                      message: s.taskContext,
                      idempotencyKey: `kickoff-${s.sessionKey}-${Date.now()}`,
                    });
                    console.log(`[kickoff] chat.send OK for ${s.sessionKey}`);
                  } catch (err) {
                    console.error(`[kickoff] chat.send FAILED for ${s.sessionKey}: ${err?.message || err}`);
                  }
                }

                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({ type: 'res', id: String(frame.id), method, ok: true, result }));
                }
              } catch (err) {
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({ type: 'res', id: String(frame.id), method, ok: false, error: { message: err?.message || String(err) } }));
                }
              }
              return;
            }

            if (method.startsWith('goals.') || method.startsWith('condos.')) {
              const local = await tryLocalGoalsRpc(method, frame.params || {});
              if (local.handled && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'res',
                  id: String(frame.id),
                  method,
                  ok: !!local.ok,
                  result: local.ok ? (local.result || {}) : undefined,
                  error: local.ok ? undefined : (local.error || { message: 'Local goals RPC failed' })
                }));

                // Post-kickoff: start spawned sessions via gateway chat.send
                // Handles both goals.kickoff (batch) and goals.spawnTaskSession (single)
                if (local.ok) {
                  const sessionsToStart = [];
                  if (method === 'goals.kickoff' && Array.isArray(local.result?.spawnedSessions)) {
                    sessionsToStart.push(...local.result.spawnedSessions);
                  } else if (method === 'goals.spawnTaskSession' && local.result?.sessionKey && local.result?.taskContext) {
                    sessionsToStart.push(local.result);
                  }
                  for (const s of sessionsToStart) {
                    if (!s.sessionKey || !s.taskContext) continue;
                    try {
                      await gatewayClient.rpcCall('chat.send', {
                        sessionKey: s.sessionKey,
                        message: s.taskContext,
                      });
                      console.log(`[kickoff] chat.send OK for ${s.sessionKey}`);
                    } catch (err) {
                      console.error(`[kickoff] chat.send FAILED for ${s.sessionKey}: ${err?.message || err}`);
                    }
                  }
                }

                return;
              }
            }

            // chat.history + status are local-only (no gateway equivalent)
            if (method === 'chat.history' || method === 'status') {
              let fallback = null;
              if (method === 'chat.history') {
                try {
                  const sessionKey = frame.params?.sessionKey || '';
                  const histLimit = Math.max(1, Number(frame.params?.limit || 50));
                  let agentId = 'main';
                  if (sessionKey.startsWith('agent:')) {
                    const parts = sessionKey.split(':');
                    if (parts.length >= 2) agentId = parts[1];
                  }
                  const ocDir = os.homedir() + '/.openclaw';
                  const sessionsFile = join(ocDir, 'agents', agentId, 'sessions', 'sessions.json');
                  const sessionsIndex = JSON.parse(readFileSync(sessionsFile, 'utf8'));
                  const sessionEntry = sessionsIndex[sessionKey];
                  if (sessionEntry?.sessionId) {
                    const jsonlFile = join(ocDir, 'agents', agentId, 'sessions', sessionEntry.sessionId + '.jsonl');
                    const lines = readFileSync(jsonlFile, 'utf8').split('\n').filter(l => l.trim());
                    const messages = [];
                    for (const line of lines) {
                      try {
                        const entry = JSON.parse(line);
                        if (entry.type === 'message' && entry.message) {
                          const { role } = entry.message;
                          if (role === 'user' || role === 'assistant') {
                            messages.push({
                              id: entry.id,
                              role,
                              content: entry.message.content,
                              timestamp: new Date(entry.timestamp).getTime(),
                              model: entry.message.model,
                            });
                          }
                        }
                      } catch {}
                    }
                    fallback = { messages: messages.slice(-histLimit) };
                  } else {
                    fallback = { messages: [] };
                  }
                } catch {
                  fallback = { messages: [] };
                }
              } else {
                fallback = { ok: true, status: 'running', activeSessions: 0, sessions: [] };
              }
              if (fallback && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'res', id: String(frame.id), method, ok: true, result: fallback }));
              }
              return;
            }

            try {
              const result = await gatewayClient.rpcCall(method, frame.params || {});
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'res',
                  id: String(frame.id),
                  method,
                  ok: true,
                  result
                }));
              }
            } catch (err) {
              // Fallback local responses when gateway scopes are restricted.
              const msg = String(err?.message || err || '');
              const isScopeErr = /missing scope|unauthorized/i.test(msg);
              if (isScopeErr) {
                try {
                  let fallback = null;
                  if (method === 'sessions.list') {
                    fallback = { sessions: [] };
                  } else if (method === 'agents.list') {
                    const cfg = JSON.parse(readFileSync(resolvePath(process.env.OPENCLAW_CONFIG_PATH || join(os.homedir(), '.openclaw', 'openclaw.json')), 'utf8'));
                    fallback = { agents: (cfg?.agents?.list || []).map(a => ({ ...a })) };
                  } else if (method === 'chat.activeRuns') {
                    fallback = { activeRuns: [] };
                  } else if (method === 'goals.list' || method === 'condos.list') {
                    const goalsDb = JSON.parse(readFileSync(GOALS_FILE, 'utf8'));
                    const goals = Array.isArray(goalsDb?.goals) ? goalsDb.goals : [];
                    if (method === 'goals.list') {
                      fallback = { goals };
                    } else {
                      const condos = Array.isArray(goalsDb?.condos) ? goalsDb.condos.map(c => ({
                        ...c,
                        goalCount: goals.filter(g => g.condoId === c.id).length,
                      })) : [];
                      fallback = { condos };
                    }
                  } else if (method === 'chat.history') {
                    try {
                      const sessionKey = frame.params?.sessionKey || '';
                      const histLimit = Math.max(1, Number(frame.params?.limit || 50));
                      let agentId = 'main';
                      if (sessionKey.startsWith('agent:')) {
                        const parts = sessionKey.split(':');
                        if (parts.length >= 2) agentId = parts[1];
                      }
                      const ocDir = os.homedir() + '/.openclaw';
                      const sessionsFile = join(ocDir, 'agents', agentId, 'sessions', 'sessions.json');
                      const sessionsIndex = JSON.parse(readFileSync(sessionsFile, 'utf8'));
                      const sessionEntry = sessionsIndex[sessionKey];
                      if (sessionEntry?.sessionId) {
                        const jsonlFile = join(ocDir, 'agents', agentId, 'sessions', sessionEntry.sessionId + '.jsonl');
                        const lines = readFileSync(jsonlFile, 'utf8').split('\n').filter(l => l.trim());
                        const messages = [];
                        for (const line of lines) {
                          try {
                            const entry = JSON.parse(line);
                            if (entry.type === 'message' && entry.message) {
                              const { role } = entry.message;
                              if (role === 'user' || role === 'assistant') {
                                messages.push({
                                  id: entry.id,
                                  role,
                                  content: entry.message.content,
                                  timestamp: new Date(entry.timestamp).getTime(),
                                  model: entry.message.model,
                                });
                              }
                            }
                          } catch {}
                        }
                        fallback = { messages: messages.slice(-histLimit) };
                      } else {
                        fallback = { messages: [] };
                      }
                    } catch {
                      fallback = { messages: [] };
                    }
                  } else if (method === 'status') {
                    fallback = { ok: true, status: 'running', activeSessions: 0, sessions: [] };
                  }

                  if (fallback && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                      type: 'res',
                      id: String(frame.id),
                      method,
                      ok: true,
                      result: fallback
                    }));
                    return;
                  }
                } catch (fallbackErr) {
                  console.error('[ws] local fallback failed for', method, fallbackErr?.message || fallbackErr);
                }
              }

              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'res',
                  id: String(frame.id),
                  method,
                  ok: false,
                  error: {
                    code: 'LOCAL_RPC_ERROR',
                    message: err?.message || String(err)
                  }
                }));
              }
            }
            return;
          }
        } catch {
          // non-JSON or pass-through frame
        }

        const rewritten = rewriteConnectFrame(raw, { token: gatewayToken, password: gatewayPassword });
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
🎯 [ClawCondos] Dashboard
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

// Graceful shutdown
function shutdown() {
  console.log('\n[shutdown] Closing gateway client...');
  try { gatewayClient.close(); } catch (e) {
    console.error('[shutdown] Error closing gateway client:', e.message);
  }
  try { memorySearch.close(); } catch (e) {
    console.error('[shutdown] Error closing memory search:', e.message);
  }
  try { chatIndex.close(); } catch (e) {
    console.error('[shutdown] Error closing chat index:', e.message);
  }
  try { unwatchFile(GOALS_FILE); } catch (e) {
    console.error('[shutdown] Error unwatching goals file:', e.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
