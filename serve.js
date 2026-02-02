#!/usr/bin/env node
/**
 * Sharp Development Server
 * 
 * Serves static files + /api/apps + proxies to registered apps
 * Usage: node serve.js [port]
 */

import { createServer, request as httpRequest } from 'http';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

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
};

// Load apps registry
function loadApps() {
  const appsFile = join(__dirname, '.registry', 'apps.json');
  if (existsSync(appsFile)) {
    return JSON.parse(readFileSync(appsFile, 'utf-8')).apps || [];
  }
  return [];
}

// Goals storage (file-backed, simple JSON)
// Schema (v1): { version: 1, goals: Goal[], sessionIndex: Record<sessionKey, { goalId, threadId? }> }
// Goal: { id, title, status, priority?, deadline?, createdAtMs, updatedAtMs, notes?, tasks?, sessions?: string[] }
function goalsFilePath() {
  return join(__dirname, '.registry', 'goals.json');
}

function loadGoalsStore() {
  const file = goalsFilePath();
  if (!existsSync(file)) return { version: 1, goals: [], sessionIndex: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return {
      version: parsed.version ?? 1,
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
      sessionIndex: parsed.sessionIndex && typeof parsed.sessionIndex === 'object' ? parsed.sessionIndex : {},
    };
  } catch {
    return { version: 1, goals: [], sessionIndex: {} };
  }
}

function saveGoalsStore(store) {
  const file = goalsFilePath();
  const dir = join(__dirname, '.registry');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(file, JSON.stringify(store, null, 2));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
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
  
  res.writeHead(200, { 'Content-Type': mime });
  res.end(content);
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = url.pathname;
  
  // CORS headers for dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Proxy to OpenClaw gateway for /api/gateway/* requests
  if (pathname.startsWith('/api/gateway/')) {
    const gatewayPath = pathname.replace('/api/gateway', '');
    const GATEWAY_PORT = 18789;
    const GATEWAY_AUTH = 'REDACTED';
    
    const options = {
      hostname: 'localhost',
      port: GATEWAY_PORT,
      path: gatewayPath + url.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: `localhost:${GATEWAY_PORT}`,
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
  
  // API: Goals (ClawCondos)
  // GET  /api/goals
  // POST /api/goals { title, status?, priority?, deadline?, notes?, tasks? }
  if (pathname === '/api/goals' && (req.method === 'GET' || req.method === 'POST')) {
    const store = loadGoalsStore();
    if (req.method === 'GET') {
      json(res, 200, { goals: store.goals });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const now = Date.now();
      const goal = {
        id: newId('goal'),
        title: String(body.title || '').trim() || 'Untitled goal',
        status: body.status || 'active',
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
      json(res, 400, { error: 'Invalid JSON body' });
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
        store.goals[idx] = {
          ...store.goals[idx],
          title: body.title != null ? String(body.title).trim() : store.goals[idx].title,
          status: body.status != null ? body.status : store.goals[idx].status,
          priority: body.priority != null ? body.priority : store.goals[idx].priority,
          deadline: body.deadline != null ? body.deadline : store.goals[idx].deadline,
          notes: body.notes != null ? body.notes : store.goals[idx].notes,
          tasks: Array.isArray(body.tasks) ? body.tasks : store.goals[idx].tasks,
          updatedAtMs: now,
        };
        saveGoalsStore(store);
        json(res, 200, { goal: store.goals[idx] });
        return;
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
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
        if (!other || other.id == goal.id) continue;
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
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
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
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/app') pathname = '/app.html';
  
  let filePath = join(__dirname, pathname);
  
  // If directory, try index.html
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }
  
  serveFile(res, filePath);
});

server.listen(PORT, () => {
  const apps = loadApps();
  console.log(`
🎯 Sharp Dashboard
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
