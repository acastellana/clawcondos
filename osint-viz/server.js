const express = require('express');
const path    = require('path');
const { exec, spawn } = require('child_process');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 9031;
const BASE = (process.env.BASE_PATH || '').replace(/\/$/, '');
const R    = BASE;

const JSON_PATH = '/home/albert/clawd/projects/datasources-db/dist/all.json';
const PY        = '/home/linuxbrew/.linuxbrew/bin/python3';
const OC        = '/home/albert/.npm-global/bin/openclaw';
const PROJ      = '/home/albert/clawd/projects/datasources-db';
const CASEWORK  = path.join(PROJ, 'casework');
const CASES_DIR = path.join(CASEWORK, 'cases');
const TOOLS_DIR = path.join(CASEWORK, 'tools');

const AGENT_ENV = Object.assign({}, process.env, {
  HOME: '/home/albert',
  PATH: `/home/albert/.npm-global/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH||''}`
});

// Track in-flight agent processes: sid → {child, startedAt}
const runningAgents = new Map();

app.use(express.json({ limit: '2mb' }));
const staticOpts = {
  setHeaders(res, filePath) {
    // Never cache HTML — always serve fresh JS/CSS
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
};
app.use(BASE || '/', express.static(path.join(__dirname, 'public'), staticOpts));
if (BASE) app.use('/', express.static(path.join(__dirname, 'public'), staticOpts));

// ── Casework helpers ───────────────────────────────────────────
function ensureDirs() {
  [CASEWORK, CASES_DIR, TOOLS_DIR].forEach(d => fs.mkdirSync(d, {recursive: true}));
  const readme = path.join(TOOLS_DIR, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme,
      '# OSINT Tool Library\n\nReusable scripts created and tested by the OSINT investigation agent.\n\n' +
      'Each tool includes: purpose, usage example, and tested output.\n\n## Index\n\n<!-- updated by agent -->\n');
  }
}
ensureDirs();

function caseDir(sid)  { return path.join(CASES_DIR, sid); }
function caseMeta(sid) { return path.join(caseDir(sid), 'metadata.json'); }
function caseReport(sid) { return path.join(caseDir(sid), 'report.md'); }
function caseRawDir(sid) { return path.join(caseDir(sid), 'raw'); }

function readMeta(sid) {
  try { return JSON.parse(fs.readFileSync(caseMeta(sid), 'utf8')); } catch { return null; }
}

function createCase(sid, target) {
  const dir = caseDir(sid);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {recursive: true});
    fs.mkdirSync(caseRawDir(sid), {recursive: true});
  }
  const meta = {
    caseId:    sid,
    target:    target || '(unknown)',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status:    'active',
    turns:     [],
    filesLog:  []
  };
  fs.writeFileSync(caseMeta(sid), JSON.stringify(meta, null, 2));
  // Seed report
  fs.writeFileSync(caseReport(sid),
    `# Investigation: ${target || sid}\n\n` +
    `**Session:** ${sid}  \n**Started:** ${meta.startedAt}  \n**Status:** active\n\n---\n\n` +
    `*Report will be populated by the agent as investigation progresses.*\n`);
  return meta;
}

function appendTurn(sid, turn) {
  const m = readMeta(sid);
  if (!m) return;
  m.turns.push(turn);
  m.updatedAt = new Date().toISOString();
  fs.writeFileSync(caseMeta(sid), JSON.stringify(m, null, 2));
}

function listCases() {
  if (!fs.existsSync(CASES_DIR)) return [];
  return fs.readdirSync(CASES_DIR)
    .filter(d => fs.statSync(path.join(CASES_DIR, d)).isDirectory())
    .map(d => readMeta(d))
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function listFiles(dir, base='') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(name => {
      const full = path.join(dir, name);
      const rel  = base ? base + '/' + name : name;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) return { name, path: rel, type: 'dir', children: listFiles(full, rel) };
      return { name, path: rel, type: 'file', size: stat.size, mtime: stat.mtime.toISOString() };
    });
}

// ── Registry loading ───────────────────────────────────────────
let entries = [], loadTime = 0;
function loadData() {
  try {
    entries = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    loadTime = Date.now();
    console.log(`Loaded ${entries.length} entries`);
  } catch(err) { console.error('Load error:', err.message); }
}
loadData();
process.on('SIGUSR1', loadData);

// ── Search helper ──────────────────────────────────────────────
function searchEntries(q, category, limit, offset) {
  const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  let pool = entries;
  if (category) {
    const cl = category.toLowerCase();
    pool = entries.filter(e => (e.categories||[]).some(c=>c.toLowerCase().includes(cl)));
  }
  if (!terms.length) {
    return [...pool]
      .sort((a,b)=>((b.quality&&b.quality.community_score)||5)-((a.quality&&a.quality.community_score)||5))
      .slice(offset, offset+limit);
  }
  const scored = pool.map(e => {
    const name = (e.name||'').toLowerCase(), desc = (e.description||'').toLowerCase();
    const cats = (e.categories||[]).join(' ').toLowerCase(), url = (e.url||'').toLowerCase();
    const cs = (e.quality&&e.quality.community_score)||5;
    let score = 0;
    terms.forEach(t => {
      if (name===t) score+=80; else if (name.startsWith(t)) score+=50;
      else if (name.includes(t)) score+=30;
      if (url.includes(t)) score+=15;
      if (desc.includes(t)) score+=8;
      if (cats.includes(t)) score+=4;
    });
    return score ? {score: score*(cs/5), entry: e} : null;
  }).filter(Boolean).sort((a,b)=>b.score-a.score);
  return scored.slice(offset, offset+limit).map(s=>s.entry);
}

// ── Health ─────────────────────────────────────────────────────
app.get([R+'/health', '/health'], (req,res) => res.json({ok:true, entries:entries.length}));

// ── Stats ──────────────────────────────────────────────────────
app.get([R+'/api/stats', '/api/stats'], (req,res) => {
  const catCounts={}, accessCounts={};
  entries.forEach(e=>{
    (e.categories||[]).forEach(c=>{const top=c.split('/')[0];catCounts[top]=(catCounts[top]||0)+1;});
    const t=(e.access&&e.access.type)||'unknown'; accessCounts[t]=(accessCounts[t]||0)+1;
  });
  const topCats   = Object.entries(catCounts).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([cat,count])=>({cat,count}));
  const topTools  = [...entries].sort((a,b)=>((b.quality&&b.quality.community_score)||5)-((a.quality&&a.quality.community_score)||5))
    .slice(0,20).map(e=>({id:e.id||(e.name||'').toLowerCase().replace(/\s+/g,'-').slice(0,40),name:e.name,url:e.url,community_score:(e.quality&&e.quality.community_score)||5,categories:e.categories}));
  res.json({total:entries.length,topCats,accessCounts,topTools});
});

// ── Categories ─────────────────────────────────────────────────
app.get([R+'/api/categories', '/api/categories'], (req,res) => {
  const counts={};
  entries.forEach(e=>(e.categories||[]).forEach(c=>{counts[c]=(counts[c]||0)+1;}));
  res.json(Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([category,count])=>({category,count})));
});

// ── Registry search ────────────────────────────────────────────
app.get([R+'/api/search', '/api/search'], (req,res) => {
  const {q='',category='',limit=60,offset=0} = req.query;
  const results = searchEntries(q, category, parseInt(limit), parseInt(offset));
  res.json(results.map(e=>({
    id:e.id||(e.name||'').toLowerCase().replace(/\s+/g,'-').slice(0,40),
    name:e.name,url:e.url,description:e.description,categories:e.categories,
    access_type:e.access&&e.access.type,community_score:(e.quality&&e.quality.community_score)||5,
  })));
});

// ── Task recommendations ───────────────────────────────────────
app.post([R+'/api/task', '/api/task'], (req,res) => {
  const {task} = req.body;
  if (!task) return res.status(400).json({error:'task required'});
  const script = `import sys,json;sys.path.insert(0,'${PROJ}/scripts');from agent_tools import get_tools_for_task;print(json.dumps(get_tools_for_task(${JSON.stringify(task)},top_n=8),default=str,ensure_ascii=False))`;
  exec(`cd '${PROJ}' && PYTHONPATH=. '${PY}' -c ${JSON.stringify(script)}`,{timeout:15000},(err,stdout,stderr)=>{
    if(err) return res.status(500).json({error:(stderr||err.message).slice(0,300)});
    try{res.json(JSON.parse(stdout));}catch(e){res.status(500).json({error:'parse error'});}
  });
});

// ── Brief ──────────────────────────────────────────────────────
app.post([R+'/api/brief', '/api/brief'], (req,res) => {
  const {target_type,target_value} = req.body;
  if (!target_type||!target_value) return res.status(400).json({error:'target_type and target_value required'});
  const script = `import sys,json;sys.path.insert(0,'${PROJ}/scripts');from agent_tools import generate_investigation_brief;print(json.dumps({'brief':generate_investigation_brief(${JSON.stringify(target_type)},${JSON.stringify(target_value)})},ensure_ascii=False))`;
  exec(`cd '${PROJ}' && PYTHONPATH=. '${PY}' -c ${JSON.stringify(script)}`,{timeout:20000},(err,stdout,stderr)=>{
    if(err) return res.status(500).json({error:(stderr||err.message).slice(0,300)});
    try{res.json(JSON.parse(stdout));}catch(e){res.status(500).json({error:'parse error'});}
  });
});

// ── Registry tool detail ───────────────────────────────────────
app.get([R+'/api/tool/:id', '/api/tool/:id'], (req,res) => {
  const id = decodeURIComponent(req.params.id).toLowerCase();
  const tool = entries.find(e=>{
    const eid=(e.id||(e.name||'').toLowerCase().replace(/\s+/g,'-').slice(0,40));
    return eid===id||(e.name||'').toLowerCase()===id;
  });
  if(!tool) return res.status(404).json({error:'not found'});
  res.json(tool);
});

// ── Casework API ───────────────────────────────────────────────

// List all cases
app.get([R+'/api/cases', '/api/cases'], (req,res) => {
  res.json(listCases());
});

// Get case metadata + file tree
app.get([R+'/api/cases/:sid', '/api/cases/:sid'], (req,res) => {
  const sid  = req.params.sid;
  const meta = readMeta(sid);
  if (!meta) return res.status(404).json({error:'case not found'});
  const files = listFiles(caseDir(sid));
  res.json({...meta, files});
});

// Read a specific file in a case (report, raw output, etc.)
app.get([R+'/api/cases/:sid/file', '/api/cases/:sid/file'], (req,res) => {
  const sid  = req.params.sid;
  const rel  = req.query.path || 'report.md';
  // security: must stay inside case dir
  const full = path.resolve(caseDir(sid), rel);
  if (!full.startsWith(caseDir(sid))) return res.status(403).json({error:'forbidden'});
  if (!fs.existsSync(full)) return res.status(404).json({error:'not found'});
  const content = fs.readFileSync(full, 'utf8');
  res.json({path: rel, content, mtime: fs.statSync(full).mtime.toISOString()});
});

// List tool library
app.get([R+'/api/tools-library', '/api/tools-library'], (req,res) => {
  const files = listFiles(TOOLS_DIR);
  res.json({dir: TOOLS_DIR, files});
});

// Read a tool file
app.get([R+'/api/tools-library/file', '/api/tools-library/file'], (req,res) => {
  const rel  = req.query.path || 'README.md';
  const full = path.resolve(TOOLS_DIR, rel);
  if (!full.startsWith(TOOLS_DIR)) return res.status(403).json({error:'forbidden'});
  if (!fs.existsSync(full)) return res.status(404).json({error:'not found'});
  res.json({path: rel, content: fs.readFileSync(full, 'utf8')});
});

// ── OSINT Chat (OpenClaw live agent with casework) ─────────────
function caseResultFile(sid) { return path.join(caseDir(sid), 'agent_result.json'); }

// Build context block for follow-up turns — injects existing report + file list
function buildFollowUpContext(sid, cDir, message) {
  const meta = readMeta(sid);
  const rp   = caseReport(sid);
  let reportContent = '(no report written yet)';
  if (fs.existsSync(rp)) {
    reportContent = fs.readFileSync(rp, 'utf8');
    if (reportContent.length > 10000) {
      reportContent = '…[first part truncated]\n\n' + reportContent.slice(-10000);
    }
  }

  const rawDir = caseRawDir(sid);
  let fileList = '(none saved yet)';
  if (fs.existsSync(rawDir)) {
    const files = fs.readdirSync(rawDir).sort();
    if (files.length) {
      fileList = files.map(f => {
        const stat = fs.statSync(path.join(rawDir, f));
        return `  ${f}  (${stat.size}B)`;
      }).join('\n');
    }
  }

  const turnsCount = meta?.turns?.length || 0;

  return `## INVESTIGATION SESSION CONTEXT
Session ID : ${sid}
Target     : ${meta?.target || '(unknown)'}
Started    : ${meta?.startedAt || '(unknown)'}
Turn #     : ${turnsCount + 1}
Case dir   : ${cDir}
Raw files  : ${path.join(cDir, 'raw')}

## FILES SAVED SO FAR
${fileList}

## CURRENT INVESTIGATION REPORT
${reportContent}

---

## FOLLOW-UP REQUEST FROM INVESTIGATOR
${message}

## YOUR TASK
Continue the investigation based on everything above.
- Do NOT repeat work already done — build on existing findings
- Reference specific files when relevant (e.g. "see 012_subdomains_crt.txt")
- Save any new raw outputs to ${path.join(cDir, 'raw')}/ using the next available sequence number
- Append new findings to the report: ${rp}`;
}

// Build primer when the chat is started from a generated brief
function buildBriefPrimer(sid, cDir, briefText, target) {
  const base = buildPrimer(sid, cDir, target);
  return `${base}

## PRE-GENERATED INVESTIGATION BRIEF
The following brief was generated before this live investigation session. Use it as your starting roadmap — but supplement with actual tool execution:

---
${briefText}
---

Now execute the brief above using real tools, saving all outputs to ${path.join(cDir, 'raw')}/`;
}

const buildPrimer = (sid, cDir, target) => `You are an expert OSINT investigator running a deep investigation. Execute every step below using real tools — do not summarise or skip.

## Session
- Session ID: ${sid}
- Case dir: ${cDir}
- Report: ${path.join(cDir, 'report.md')}
- Raw outputs: ${path.join(cDir, 'raw')} (save every tool output sequentially: 001_name.ext, 002_name.ext…)
- Tool library: ${TOOLS_DIR}

## STEP 1 — Orientation
Read the OSINT skill file to select the right playbook:
  exec: cat ~/.agents/skills/osint-agent/SKILL.md | head -200

## STEP 2 — Deep DNS Recon (for domains)
Run ALL of these and save output to raw/:
  exec: dig ${target} A +short                   → 001_dns_A.txt
  exec: dig ${target} AAAA +short                → 002_dns_AAAA.txt
  exec: dig ${target} MX +short                  → 003_dns_MX.txt
  exec: dig ${target} NS +short                  → 004_dns_NS.txt
  exec: dig ${target} TXT +short                 → 005_dns_TXT.txt
  exec: dig ${target} SOA +short                 → 006_dns_SOA.txt
  exec: dig ${target} CAA +short                 → 007_dns_CAA.txt
  exec: dig _dmarc.${target} TXT +short          → 008_dmarc.txt
  exec: dig _domainkey.${target} TXT +short      → 009_dkim.txt
  exec: dig ${target} CNAME +short               → 010_cname.txt

## STEP 3 — Email Security Analysis
Parse TXT records from Step 2 and check:
  - SPF: look for "v=spf1" in TXT — note include: sources, ~all vs -all vs +all
  - DKIM: check for selectors (google._domainkey, k1._domainkey, etc.)
    exec: dig google._domainkey.${target} TXT +short
    exec: dig k1._domainkey.${target} TXT +short
    exec: dig default._domainkey.${target} TXT +short
  - DMARC: parse p= tag (none/quarantine/reject), rua= reporting addr
  Save summary: 011_email_security.txt

## STEP 4 — Certificate Transparency (subdomain discovery)
  exec: curl -s "https://crt.sh/?q=%.${target}&output=json" | python3 -c "import sys,json; d=json.load(sys.stdin); names=sorted(set(n for r in d for n in r.get('name_value','').split('\n') if '${target}' in n)); [print(n) for n in names[:100]"
  Save to: 012_subdomains_crt.txt

## STEP 5 — RDAP / Registration Data
  exec: curl -s "https://rdap.verisign.com/com/v1/domain/${target}" | python3 -m json.tool
  (If .com fails try: https://rdap.nic.io/domain/ or https://rdap.org/domain/${target})
  Save to: 013_rdap.json
  Extract: registrar, creation date, expiry date, registrant org/country, nameservers, DNSSEC status

## STEP 6 — IP & Hosting Intelligence
  Resolve IPs from Step 2 A records, then for each IP:
  exec: curl -s "https://ipinfo.io/<ip>/json"     → 014_ipinfo.json
  exec: curl -s "https://internetdb.shodan.io/<ip>" → 015_shodan_internetdb.json
  exec: curl -s "https://api.bgpview.io/ip/<ip>"  → 016_bgp_asn.json
  Extract: ASN, org, hosting provider, open ports, CVEs, tags, country

## STEP 7 — Security Headers & TLS
  exec: curl -sI --max-time 15 "https://${target}" | head -40   → 017_http_headers.txt
  Check for: HSTS, Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
  Note SSL cert issuer + expiry from headers or:
  exec: curl -vI --max-time 10 "https://${target}" 2>&1 | grep -E "issuer|expire|subject|SSL|TLS|cipher|protocol"  → 018_tls_info.txt

## STEP 8 — Web Reconnaissance
  web_fetch: https://${target}/robots.txt          → save to 019_robots.txt
  web_fetch: https://${target}/sitemap.xml         → save to 020_sitemap.txt
  web_fetch: https://${target}/.well-known/security.txt  → save to 021_security_txt.txt
  Check for: disallowed paths, sensitive areas, contact/security info

## STEP 9 — Reputation & Threat Intel
  web_fetch: https://otx.alienvault.com/api/v1/indicators/domain/${target}/general  → 022_otx.json
  web_search: "${target} breach OR leak OR hack OR malware OR phishing"
  web_search: "${target} site:pastebin.com OR site:paste.gg"
  web_search: "${target}" security vulnerability CVE
  Save search results summary: 023_reputation.txt

## STEP 10 — Historical & Archive Data
  web_fetch: http://web.archive.org/cdx/search/cdx?url=${target}/*&output=text&limit=20&fl=timestamp,original,statuscode
  Save to: 024_wayback_cdx.txt — note oldest snapshot, interesting paths

## STEP 11 — Technology Fingerprinting
  From HTTP headers in Step 7, identify:
  - Server software (Apache/Nginx/Cloudflare/etc)
  - Powered-By headers (PHP, ASP.NET, etc)
  - CDN/WAF presence (Cloudflare, Akamai, Fastly)
  - Tracking pixels, analytics in page source
  exec: curl -sL --max-time 15 "https://${target}" | grep -iE "google-analytics|gtm|mixpanel|segment|datadog|sentry|cloudflare|powered|generator" | head -20  → 025_tech_fingerprint.txt

## STEP 12 — Write Investigation Report
Update ${path.join(cDir, 'report.md')} with structured findings:
  # Domain Security Analysis: ${target}
  
  ## Executive Summary
  [3-5 sentence overview of security posture]
  
  ## Registration & Infrastructure
  [Registrar, dates, nameservers, hosting, ASN]
  
  ## DNS Security
  [SPF/DKIM/DMARC status, notes on misconfiguration risks]
  
  ## Network Exposure
  [Open ports, services, CVEs found via Shodan]
  
  ## Web Security
  [Headers analysis, TLS, missing controls]
  
  ## Subdomain Exposure
  [Key subdomains found via crt.sh]
  
  ## Reputation & Threat Intel
  [OTX results, paste leaks, known incidents]
  
  ## Technology Stack
  [Server, CDN, frameworks detected]
  
  ## Risk Assessment
  [HIGH/MEDIUM/LOW per category with evidence]
  
  ## Recommendations
  [Actionable items ranked by priority]

## Output format for your reply
- Lead with EXECUTIVE SUMMARY (3-5 sentences)
- List KEY FINDINGS with actual data (IPs, scores, dates, etc.)
- Highlight any RED FLAGS (misconfigs, exposures, risks)
- End with PRIORITY ACTIONS
- Be precise — use real numbers and values from the tools

---
Target: ${target}`;

app.post([R+'/api/chat', '/api/chat'], (req, res) => {
  const { message, sessionId, isFirst, briefContent, briefTarget } = req.body;
  if (!message) return res.status(400).json({error:'message required'});

  const sid = (sessionId || ('osint-' + Date.now() + '-' + Math.random().toString(36).slice(2,8)))
    .replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 80);

  const cDir = caseDir(sid);

  // Create case on first message
  if (isFirst || !fs.existsSync(cDir)) {
    createCase(sid, (briefTarget || message).slice(0, 100));
  }

  // Build prompt with appropriate context:
  // - First turn from brief: embed the full brief + primer
  // - First turn (plain): standard 12-step deep analysis primer
  // - Follow-up turn: inject existing report + file list as context
  let prompt;
  if (isFirst && briefContent) {
    prompt = buildBriefPrimer(sid, cDir, briefContent, briefTarget || message);
  } else if (isFirst) {
    prompt = buildPrimer(sid, cDir, message);
  } else {
    prompt = buildFollowUpContext(sid, cDir, message);
  }

  // Log the user turn
  appendTurn(sid, {
    role: 'user',
    timestamp: new Date().toISOString(),
    message: message.slice(0, 500)
  });

  // Always wipe the result file before spawning — prevents stale 'done'/'error'
  // from a previous turn leaking into the new poll cycle
  const rf = caseResultFile(sid);
  if (fs.existsSync(rf)) fs.unlinkSync(rf);

  // For follow-up turns use a FRESH openclaw session each time.
  // The case dir (sid) stays the same; only the openclaw conversation context is isolated.
  // This prevents context-window overflow from reusing the huge history of the first run.
  const ocSessionId = isFirst
    ? sid
    : (sid.slice(0, 55) + '-t' + Date.now().toString(36));

  // Fire off agent — NON-BLOCKING, no timeout
  const child = spawn(OC, ['agent', '--session-id', ocSessionId, '--message', prompt, '--json'],
    { env: AGENT_ENV });

  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });

  runningAgents.set(sid, { child, startedAt: Date.now() });

  child.on('error', err => {
    runningAgents.delete(sid);
    const errMsg = err.message.slice(0, 500);
    appendTurn(sid, {role:'error', timestamp:new Date().toISOString(), error:errMsg});
    fs.writeFileSync(rf, JSON.stringify({
      status: 'error', error: errMsg, completedAt: new Date().toISOString()
    }));
  });

  child.on('close', code => {
    runningAgents.delete(sid);
    console.log(`[chat] ${sid} (ocSess=${ocSessionId}) exit=${code} stdoutLen=${stdout.length} stderrLen=${stderr.length}`);
    if (code !== 0 && stderr) console.log(`[chat] stderr: ${stderr.slice(0,300)}`);

    // Always try stdout first — openclaw may exit non-zero but write valid JSON
    let data = null;
    if (stdout.trim().startsWith('{')) {
      try { data = JSON.parse(stdout); } catch {}
    }

    const text  = data ? (data.result?.payloads||[]).map(p=>p.text).filter(Boolean).join('\n\n') : null;
    const durMs = data?.result?.meta?.durationMs;

    if (text) {
      appendTurn(sid, {
        role: 'agent', timestamp: new Date().toISOString(),
        durationMs: durMs, messagePreview: text.slice(0, 300)
      });
      try {
        const turnHeader = `\n\n---\n\n## ${new Date().toISOString().slice(0,16)} — ${message.slice(0,80)}\n\n`;
        fs.appendFileSync(caseReport(sid), turnHeader + text + '\n');
      } catch(e) { console.error('report append:', e.message); }

      // Detect files saved by agent
      const fileMatches = [...text.matchAll(/(?:saved?|wrote?|created?)\s+(?:to\s+)?[`'"]?(\/[^\s`'"]+\.(?:txt|json|sh|md|csv|py))[`'"]?/gi)];
      if (fileMatches.length) {
        const meta = readMeta(sid);
        if (meta) {
          meta.filesLog = [...new Set([...(meta.filesLog||[]), ...fileMatches.map(m=>m[1])])];
          meta.updatedAt = new Date().toISOString();
          fs.writeFileSync(caseMeta(sid), JSON.stringify(meta, null, 2));
        }
      }
    }

    // Save stderr to debug file for post-mortem inspection
    if (stderr) {
      try { fs.writeFileSync(path.join(caseDir(sid), 'agent_stderr.txt'), stderr); } catch {}
    }

    // Write result file for polling
    fs.writeFileSync(rf, JSON.stringify({
      status:      text ? 'done' : 'error',
      response:    text || null,
      error:       text ? null : (stderr || `exit ${code}`).slice(0, 500),
      durationMs:  durMs,
      completedAt: new Date().toISOString()
    }));
  });

  // Respond immediately — client will poll /api/chat/status/:sid
  res.json({ sessionId: sid, status: 'running' });
});

// ── Chat status polling endpoint ───────────────────────────────
app.get([R+'/api/chat/status/:sid', '/api/chat/status/:sid'], (req, res) => {
  const sid = req.params.sid;
  const isRunning = runningAgents.has(sid);
  const rf = caseResultFile(sid);

  // Latest report tail for live preview
  let reportTail = '';
  const rp = caseReport(sid);
  if (fs.existsSync(rp)) {
    const full = fs.readFileSync(rp, 'utf8');
    reportTail = full.length > 5000 ? full.slice(-5000) : full;
  }

  // Count raw files saved so far
  let rawCount = 0;
  const rawDir = caseRawDir(sid);
  if (fs.existsSync(rawDir)) rawCount = fs.readdirSync(rawDir).length;

  if (isRunning) {
    const { startedAt } = runningAgents.get(sid);
    return res.json({ status: 'running', elapsed: Date.now() - startedAt, rawCount, reportTail, sessionId: sid });
  }

  if (fs.existsSync(rf)) {
    let result;
    try { result = JSON.parse(fs.readFileSync(rf, 'utf8')); } catch { result = {status:'error',error:'result parse failed'}; }
    return res.json({ ...result, rawCount, reportTail, sessionId: sid });
  }

  // Unknown — might be a resumed session from a different server start
  return res.json({ status: 'not_found', rawCount, reportTail, sessionId: sid });
});

app.listen(PORT, ()=>console.log(`OSINT Viz :${PORT} BASE="${BASE}" entries=${entries.length} casework=${CASEWORK}`));
