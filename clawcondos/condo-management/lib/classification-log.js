// classification-log.js — Classification attempt logging
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

const MAX_ENTRIES = 1000;

export function createClassificationLog(dataDir) {
  const filePath = join(dataDir, 'classification-log.json');

  function load() {
    if (!existsSync(filePath)) {
      return { entries: [] };
    }
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      return { entries: Array.isArray(data.entries) ? data.entries : [] };
    } catch (err) {
      return { entries: [], _loadError: err.message };
    }
  }

  function save(data) {
    if (data._loadError) {
      throw new Error(`Refusing to save classification log: previous load failed (${data._loadError})`);
    }
    if (data.entries.length > MAX_ENTRIES) {
      data.entries = data.entries.slice(-MAX_ENTRIES);
    }
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, filePath);
  }

  function append(fields) {
    const data = load();
    const entry = {
      id: `clf_${crypto.randomBytes(8).toString('hex')}`,
      timestamp: Date.now(),
      sessionKey: fields.sessionKey ?? '',
      tier: fields.tier ?? 1,
      predictedCondo: fields.predictedCondo ?? null,
      confidence: fields.confidence ?? 0,
      reasoning: fields.reasoning ?? '',
      latencyMs: fields.latencyMs ?? 0,
      accepted: null,
      correctedTo: null,
      feedbackMs: null,
    };
    data.entries.push(entry);
    save(data);
    return entry;
  }

  function recordFeedback(entryId, { accepted, correctedTo }) {
    const data = load();
    const entry = data.entries.find(e => e.id === entryId);
    if (!entry) return null;
    entry.accepted = accepted;
    entry.correctedTo = correctedTo || null;
    entry.feedbackMs = Date.now();
    save(data);
    return entry;
  }

  function getCorrections(sinceMs = 0) {
    const data = load();
    return data.entries.filter(e => e.correctedTo != null && (e.feedbackMs || 0) > sinceMs);
  }

  function getStats() {
    const { entries } = load();
    const withFeedback = entries.filter(e => e.accepted != null);
    const accepted = withFeedback.filter(e => e.accepted === true).length;
    const corrected = entries.filter(e => e.correctedTo != null).length;
    return {
      total: entries.length,
      withFeedback: withFeedback.length,
      accepted,
      corrected,
      accuracy: withFeedback.length > 0 ? accepted / withFeedback.length : null,
    };
  }

  function recordReclassification(sessionKey, previousCondo, newCondo) {
    const data = load();
    // Find the most recent entry for this session that predicted previousCondo
    const entry = [...data.entries].reverse().find(
      e => e.sessionKey === sessionKey && e.predictedCondo === previousCondo
    );
    if (entry) {
      entry.accepted = false;
      entry.correctedTo = newCondo;
      entry.feedbackMs = Date.now();
      save(data);
      return entry;
    }
    // No matching classification found — create a synthetic correction entry
    const synth = {
      id: `clf_${crypto.randomBytes(8).toString('hex')}`,
      timestamp: Date.now(),
      sessionKey,
      tier: 0, // synthetic
      predictedCondo: previousCondo,
      confidence: 0,
      reasoning: 'reclassification',
      latencyMs: 0,
      accepted: false,
      correctedTo: newCondo,
      feedbackMs: Date.now(),
    };
    data.entries.push(synth);
    save(data);
    return synth;
  }

  return { load, save, append, recordFeedback, recordReclassification, getCorrections, getStats };
}
