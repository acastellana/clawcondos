#!/usr/bin/env node
// plugins/clawcondos-goals/scripts/populate-condos.js
import { createGoalsStore } from '../lib/goals-store.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.STRAND_DATA_DIR || join(__dirname, '..', '.data');

const store = createGoalsStore(dataDir);
const data = store.load();

// Collect unique condoIds from goals that don't have a matching condo object
const existingCondoIds = new Set(data.condos.map(c => c.id));
const referencedIds = new Set(
  data.goals.map(g => g.condoId).filter(id => id && !existingCondoIds.has(id))
);

if (referencedIds.size === 0) {
  console.log('All referenced condos already exist. Nothing to do.');
  process.exit(0);
}

const dryRun = process.argv.includes('--dry-run');

for (const id of referencedIds) {
  // Derive name from id: "condo:genlayer" → "GenLayer"
  const slug = id.replace(/^condo[_:]/, '');
  const name = slug
    .split(/[-_]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const goalCount = data.goals.filter(g => g.condoId === id).length;
  console.log(`  + ${id} → "${name}" (${goalCount} goals)`);

  if (!dryRun) {
    const now = Date.now();
    data.condos.push({
      id,
      name,
      description: '',
      color: null,
      keywords: [],
      telegramTopicIds: [],
      createdAtMs: now,
      updatedAtMs: now,
    });
  }
}

if (!dryRun) {
  store.save(data);
  console.log(`\nCreated ${referencedIds.size} condo(s).`);
} else {
  console.log(`\n(dry run - ${referencedIds.size} condo(s) would be created)`);
}
