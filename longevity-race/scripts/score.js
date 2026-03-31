#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

function computeScore(c) {
  // === ITP result + effect size: 40pts ===
  let itpScore = 0;
  const maxEffect = Math.max(c.maleNum || 0, c.femaleNum || 0);
  const effectBonus = Math.min(maxEffect / 40, 1); // 0-1 scale, cap at 40%

  if (c.itp === 'positive') {
    itpScore = 25 + Math.round(effectBonus * 15); // 25-40
  } else if (c.itp === 'mixed') {
    itpScore = 15 + Math.round(effectBonus * 5);  // 15-20
  } else if (c.itp === 'not_tested') {
    // Some non-ITP compounds have external evidence
    itpScore = 8 + Math.round(effectBonus * 4);   // 8-12
  } else {
    // negative — small points if there's still human evidence
    itpScore = 0;
  }

  // === Reproducibility (both sexes benefit): 20pts ===
  let reproScore = 0;
  const maleBenefit = (c.maleNum || 0) > 2;
  const femaleBenefit = (c.femaleNum || 0) > 2;
  if (maleBenefit && femaleBenefit) {
    reproScore = 20;
  } else if (maleBenefit || femaleBenefit) {
    reproScore = 12;
  } else if (c.itp === 'not_tested' && maxEffect > 0) {
    reproScore = 8;
  }

  // === Human trials (count + phase): 25pts ===
  let trialScore = 0;
  const trialCount = c.trials || 0;
  const phaseNum = c.phaseNum || 0;

  // Phase contribution: 0→0, 1→5, 2→10, 2.5→13, 3→17, 4→25
  const phaseMap = { 0: 0, 1: 5, 2: 10, 2.5: 13, 3: 17, 4: 25 };
  trialScore = phaseMap[phaseNum] !== undefined ? phaseMap[phaseNum] : Math.round(phaseNum * 6);

  // Trial count bonus (up to 5 extra pts)
  const countBonus = Math.min(Math.floor(trialCount / 5), 5);
  trialScore = Math.min(trialScore + countBonus, 25);

  // === Mechanistic plausibility + safety: 15pts (keep manual baseline) ===
  // Use existing score's residual as proxy — don't change this component
  // We derive it from the old score minus the other components
  // For simplicity, use a fixed lookup based on compound characteristics:
  const mechMap = {
    'Rapamycin + Acarbose Combo': 15,
    'Rapamycin': 15,
    'Metformin': 14,
    'Acarbose': 12,
    'Canagliflozin': 12,
    '17-alpha-Estradiol': 10,
    'Senolytics (D+Q)': 12,
    'NAD+ Precursors (NMN/NR)': 10,
    'GLP-1 Agonists': 13,
    'Fisetin': 8,
    'Glycine / GlyNAC': 11,
    'Astaxanthin': 9,
    'Meclizine': 8,
    'Captopril': 10,
    'Spermidine': 10,
    'NDGA': 7,
    'Resveratrol': 6,
    'Taurine': 8,
    'Alpha-Ketoglutarate': 9,
    'Curcumin': 6,
    '16-alpha-Hydroxyestradiol': 5,
    'Halofuginone': 8,
    'Mitoglitazone (MSDC-0160)': 8,
    'Epicatechin': 8,
    'Nicotinamide Riboside (NR)': 7,
  };
  const mechScore = mechMap[c.name] || 8;

  const total = itpScore + reproScore + trialScore + mechScore;
  return Math.min(Math.round(total), 100);
}

function main() {
  console.log('Loading data.json...');
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const changes = [];

  for (const c of data.compounds) {
    const oldScore = c.score;
    const newScore = computeScore(c);
    if (oldScore !== newScore) {
      changes.push({ name: c.name, old: oldScore, new: newScore });
    }
    c.score = newScore;
  }

  // Re-rank by score
  data.compounds.sort((a, b) => b.score - a.score);
  data.compounds.forEach((c, i) => { c.rank = i + 1; });

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

  console.log(`Scored ${data.compounds.length} compounds. ${changes.length} scores changed.`);
  if (changes.length > 0) {
    changes.forEach(c => console.log(`  ${c.name}: ${c.old} → ${c.new}`));
  }
  return changes;
}

if (require.main === module) {
  main();
}

module.exports = { main };
