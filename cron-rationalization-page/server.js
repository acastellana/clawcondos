const express = require('express');
const path = require('path');
const { execFileSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3891;

function classifyCadence(schedule = {}) {
  if (schedule.kind === 'every') {
    const ms = Number(schedule.everyMs || 0);
    if (ms <= 0) return 'other';
    const H = 60 * 60 * 1000;
    if (ms <= 2 * H)  return 'hourly-ish';   // ≤ 2h
    if (ms <= 24 * H) return 'daily-ish';    // 3h – 24h
    if (ms <= 7 * 24 * H) return 'weekly-ish';
    return 'other';
  }
  if (schedule.kind === 'cron') {
    const parts = String(schedule.expr || '').trim().split(/\s+/);
    if (parts.length < 5) return 'other';
    const [, hour, , , dow] = parts;

    // weekly: specific day-of-week
    if (dow !== '*' && dow !== '?') return 'weekly-ish';

    // hourly: hour is wildcard (runs every hour)
    if (hour === '*') return 'hourly-ish';

    // step notation: */N
    if (/^\*\/(\d+)$/.test(hour)) {
      const step = parseInt(hour.slice(2), 10);
      return step <= 2 ? 'hourly-ish' : 'daily-ish';  // */1,*/2 = hourly; */4,*/6 = daily
    }

    // comma list (e.g. 9,14,18) → multiple times per day → daily
    if (hour.includes(',')) return 'daily-ish';

    // single fixed hour → once per day
    return 'daily-ish';
  }
  return 'other';
}

function loadRecurringJobs() {
  const openclawBin = process.env.OPENCLAW_BIN || '/home/albert/.npm-global/bin/openclaw';
  const raw = execFileSync(openclawBin, ['cron', 'list', '--all', '--json'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  const parsed = JSON.parse(raw);
  const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || []);

  const recurring = jobs
    .filter(j => j.enabled !== false)
    .filter(j => ['cron', 'every'].includes(j?.schedule?.kind))
    .map(j => ({
      id: j.jobId || j.id,
      name: j.name || 'unnamed-job',
      schedule: j.schedule,
      cadence: classifyCadence(j.schedule),
      sessionTarget: j.sessionTarget,
      payloadKind: j.payload?.kind,
      model: j.payload?.model || 'default',
      delivery: j.delivery?.mode || 'none',
      enabled: j.enabled !== false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    totalRecurring: recurring.length,
    jobs: recurring,
  };
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true, app: 'cron-rationalization-page' }));

app.get('/api/recurring', (_req, res) => {
  try {
    res.json(loadRecurringJobs());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`cron-rationalization-page listening on ${PORT}`);
});
