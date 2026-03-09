'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 9033;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(__dirname));

// GET /api/data — return current data
app.get('/api/data', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/recalculate — refresh trials + recompute scores
let recalcRunning = false;
app.post('/api/recalculate', async (req, res) => {
  if (recalcRunning) {
    return res.status(409).json({ error: 'Recalculation already in progress' });
  }
  recalcRunning = true;
  console.log('[recalculate] Starting...');
  try {
    const before = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

    // Step 1: refresh trial counts from ClinicalTrials.gov
    delete require.cache[require.resolve('./scripts/refresh-trials')];
    const { main: refreshTrials } = require('./scripts/refresh-trials');
    const trialChanges = await refreshTrials();

    // Step 2: recompute scores
    delete require.cache[require.resolve('./scripts/score')];
    const { main: rescore } = require('./scripts/score');
    const scoreChanges = rescore();

    const after = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

    console.log(`[recalculate] Done. ${trialChanges.length} trial changes, ${scoreChanges.length} score changes.`);
    res.json({
      success: true,
      lastUpdated: after.lastUpdated,
      trialChanges,
      scoreChanges,
      data: after
    });
  } catch (e) {
    console.error('[recalculate] Error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    recalcRunning = false;
  }
});

// GET /api/status — quick health check
app.get('/api/status', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    res.json({ ok: true, lastUpdated: data.lastUpdated, compounds: data.compounds.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Longevity Race running at http://127.0.0.1:${PORT}`);
});
