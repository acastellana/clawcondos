#!/usr/bin/env node
/**
 * Migrate goals data from ClawCondos .registry/goals.json to plugin data dir.
 * Usage: node openclaw-plugin/migrate.js [source] [dest]
 *   source: path to .registry/goals.json (default: .registry/goals.json)
 *   dest: path to plugin data dir (default: openclaw-plugin/.data)
 */
import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';

const src = resolve(process.argv[2] || '.registry/goals.json');
const destDir = resolve(process.argv[3] || 'openclaw-plugin/.data');
const dest = join(destDir, 'goals.json');

if (!existsSync(src)) {
  console.log(`No source file at ${src} — nothing to migrate.`);
  process.exit(0);
}

if (existsSync(dest)) {
  console.log(`Destination ${dest} already exists. Aborting to avoid overwrite.`);
  console.log('Delete the destination file first if you want to re-migrate.');
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

// Verify
const data = JSON.parse(readFileSync(dest, 'utf-8'));
const goalCount = Array.isArray(data.goals) ? data.goals.length : 0;
const sessionCount = data.sessionIndex ? Object.keys(data.sessionIndex).length : 0;

console.log(`Migrated successfully:`);
console.log(`  ${goalCount} goals`);
console.log(`  ${sessionCount} session mappings`);
console.log(`  Source: ${src}`);
console.log(`  Dest:   ${dest}`);
