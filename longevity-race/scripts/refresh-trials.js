#!/usr/bin/env node
'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'LongevityRace/1.0' } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 404) { resolve({ studies: [] }); return; }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 100)}`)); return; }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse error: ' + body.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

// Map compound name → ClinicalTrials.gov search terms
function searchTerms(name) {
  const map = {
    'Rapamycin + Acarbose Combo': ['rapamycin acarbose'],
    'Rapamycin': ['rapamycin aging', 'sirolimus aging longevity'],
    'Metformin': ['metformin aging longevity', 'metformin TAME'],
    'Acarbose': ['acarbose aging'],
    'Canagliflozin': ['canagliflozin aging longevity'],
    '17-alpha-Estradiol': ['17-alpha estradiol aging'],
    'Senolytics (D+Q)': ['dasatinib quercetin senolytic', 'senolytic aging'],
    'NAD+ Precursors (NMN/NR)': ['NMN aging', 'NR nicotinamide riboside aging', 'NAD aging longevity'],
    'GLP-1 Agonists': ['semaglutide aging longevity', 'tirzepatide aging', 'GLP-1 aging healthspan'],
    'Fisetin': ['fisetin aging senolytic'],
    'Glycine / GlyNAC': ['glycine NAC aging', 'GlyNAC aging'],
    'Astaxanthin': ['astaxanthin aging longevity'],
    'Meclizine': ['meclizine aging'],
    'Captopril': ['captopril aging longevity'],
    'Spermidine': ['spermidine aging longevity'],
    'NDGA': ['nordihydroguaiaretic aging'],
    'Resveratrol': ['resveratrol aging longevity'],
    'Taurine': ['taurine aging longevity'],
    'Alpha-Ketoglutarate': ['alpha-ketoglutarate aging', 'AKG aging longevity'],
    'Curcumin': ['curcumin aging longevity'],
    '16-alpha-Hydroxyestradiol': ['16-alpha hydroxyestradiol aging'],
    'Halofuginone': ['halofuginone aging'],
    'Mitoglitazone (MSDC-0160)': ['MSDC-0160 aging'],
    'Epicatechin': ['epicatechin aging longevity'],
    'Nicotinamide Riboside (NR)': ['nicotinamide riboside aging', 'NR aging longevity'],
  };
  return map[name] || [name.toLowerCase().replace(/[()]/g, '') + ' aging'];
}

function phaseToNum(phaseStr) {
  if (!phaseStr) return 0;
  const p = phaseStr.toUpperCase();
  if (p.includes('4') || p.includes('FOUR')) return 4;
  if (p.includes('3') || p.includes('THREE')) return 3;
  if (p.includes('2') && p.includes('3')) return 2.5;
  if (p.includes('2') || p.includes('TWO')) return 2;
  if (p.includes('1') || p.includes('ONE')) return 1;
  return 0;
}

function phaseLabel(phaseNum) {
  const map = { 0: 'Preclinical', 1: 'Phase 1', 2: 'Phase 2', 2.5: 'Phase 2/3', 3: 'Phase 3', 4: 'Phase 4' };
  return map[phaseNum] || 'Phase ' + phaseNum;
}

async function fetchTrialsForCompound(name) {
  const terms = searchTerms(name);
  let total = 0;
  let maxPhase = 0;

  for (const term of terms) {
    const encoded = encodeURIComponent(term);
    const url = `https://clinicaltrials.gov/api/v2/studies?query.term=${encoded}&pageSize=100&fields=Phase,OverallStatus`;
    try {
      const data = await httpsGet(url);
      const studies = data.studies || [];
      // Filter for relevant statuses
      const relevant = studies.filter(s => {
        const status = s.protocolSection?.statusModule?.overallStatus || '';
        return ['RECRUITING', 'ACTIVE_NOT_RECRUITING', 'COMPLETED', 'ENROLLING_BY_INVITATION',
                'NOT_YET_RECRUITING', 'SUSPENDED'].includes(status.toUpperCase());
      });
      total += relevant.length;
      for (const s of relevant) {
        const phases = s.protocolSection?.designModule?.phases || [];
        for (const p of phases) {
          const n = phaseToNum(p);
          if (n > maxPhase) maxPhase = n;
        }
      }
    } catch (e) {
      console.warn(`  Warning: failed to fetch for "${term}":`, e.message);
    }
    // Small delay to be polite
    await new Promise(r => setTimeout(r, 300));
  }

  return { trials: total, phaseNum: maxPhase, phase: phaseLabel(maxPhase) };
}

async function main() {
  console.log('Loading data.json...');
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const changes = [];

  for (const compound of data.compounds) {
    process.stdout.write(`  Fetching: ${compound.name}...`);
    try {
      const result = await fetchTrialsForCompound(compound.name);
      const oldTrials = compound.trials;
      const oldPhase = compound.phase;

      // Update if we got meaningful data (don't zero out if API returns 0)
      if (result.trials > 0 || compound.trials === 0) {
        compound.trials = result.trials;
      }
      if (result.phaseNum > compound.phaseNum) {
        compound.phaseNum = result.phaseNum;
        compound.phase = result.phase;
      }

      const changed = compound.trials !== oldTrials || compound.phase !== oldPhase;
      if (changed) {
        changes.push({ name: compound.name, oldTrials, newTrials: compound.trials, oldPhase, newPhase: compound.phase });
      }
      console.log(` ${compound.trials} trials, ${compound.phase}${changed ? ' [CHANGED]' : ''}`);
    } catch (e) {
      console.log(` ERROR: ${e.message}`);
    }
  }

  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

  console.log(`\nDone. ${changes.length} compounds updated.`);
  if (changes.length > 0) {
    console.log('\nChanges:');
    changes.forEach(c => console.log(`  ${c.name}: trials ${c.oldTrials}→${c.newTrials}, phase ${c.oldPhase}→${c.newPhase}`));
  }
  return changes;
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
