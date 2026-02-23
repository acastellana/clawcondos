// learning.js — Classification correction analysis

/**
 * Analyze corrections to find frequently-corrected-to condos.
 * Returns suggestions for new keywords per condo.
 */
export function analyzeCorrections(classificationLog, sinceMs = 0) {
  const corrections = classificationLog.getCorrections(sinceMs);

  // Group by corrected-to condo, count frequency
  const byTarget = new Map();
  for (const entry of corrections) {
    const target = entry.correctedTo;
    byTarget.set(target, (byTarget.get(target) || 0) + 1);
  }

  return [...byTarget.entries()]
    .filter(([, count]) => count >= 2) // Only suggest if corrected 2+ times
    .map(([condoId, correctionCount]) => ({
      condoId,
      correctionCount,
      suggestedKeywords: [], // Would need message content for keyword extraction
    }));
}

/**
 * Apply keyword suggestions to condos in the store.
 */
export function applyLearning(store, suggestions, dryRun = false) {
  const data = store.load();
  const applied = [];

  for (const suggestion of suggestions) {
    const condo = data.condos.find(c => c.id === suggestion.condoId);
    if (!condo) continue;

    const existing = new Set(condo.keywords || []);
    const added = [];

    for (const kw of (suggestion.suggestedKeywords || [])) {
      if (kw && !existing.has(kw)) {
        existing.add(kw);
        added.push(kw);
      }
    }

    if (added.length > 0) {
      if (!dryRun) {
        condo.keywords = [...existing].slice(0, 25);
        condo.updatedAtMs = Date.now();
      }
      applied.push({ condoId: condo.id, condoName: condo.name, addedKeywords: added });
    }
  }

  if (!dryRun && applied.length > 0) {
    store.save(data);
  }

  return applied;
}
