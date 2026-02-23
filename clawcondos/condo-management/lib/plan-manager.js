/**
 * Plan Manager - Handles parsing, reading, and tracking of Claude Code plans
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Default plan object structure
 */
export function createEmptyPlan() {
  return {
    status: 'none', // 'none' | 'draft' | 'awaiting_approval' | 'approved' | 'rejected' | 'executing' | 'completed'
    filePath: null,
    content: null,
    steps: [],
    approvedAtMs: null,
    rejectedAtMs: null,
    feedback: null,
    updatedAtMs: Date.now(),
  };
}

/**
 * Parse a plan markdown file into structured steps
 * @param {string} content - Raw markdown content
 * @returns {{ steps: Array<{ index: number, title: string, status: string, startedAtMs: number|null, completedAtMs: number|null }>, raw: string }}
 */
export function parsePlanMarkdown(content) {
  if (!content || typeof content !== 'string') {
    return { steps: [], raw: '' };
  }

  const steps = [];
  const lines = content.split('\n');
  let stepIndex = 0;

  for (const line of lines) {
    // Match markdown headers as steps (## or ### style)
    // Also match numbered lists like "1. Step title" or "- [ ] Step title"
    const headerMatch = line.match(/^#{2,3}\s+(.+)$/);
    const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
    const checkboxMatch = line.match(/^-\s+\[([ xX])\]\s+(.+)$/);

    let title = null;
    let initialStatus = 'pending';

    if (headerMatch) {
      title = headerMatch[1].trim();
    } else if (numberedMatch) {
      title = numberedMatch[1].trim();
    } else if (checkboxMatch) {
      title = checkboxMatch[2].trim();
      // Checkbox state: [ ] = pending, [x] or [X] = done
      initialStatus = checkboxMatch[1] === ' ' ? 'pending' : 'done';
    }

    if (title) {
      // Truncate step titles to 100 characters for conciseness
      const truncatedTitle = title.length > 100 ? title.slice(0, 100) + '...' : title;
      steps.push({
        index: stepIndex++,
        title: truncatedTitle,
        status: initialStatus,
        startedAtMs: null,
        completedAtMs: initialStatus === 'done' ? Date.now() : null,
      });
    }
  }

  return { steps, raw: content };
}

/**
 * Read a plan file from disk
 * @param {string} filePath - Path to the plan file (relative or absolute)
 * @param {string} [basePath] - Base path for relative file paths
 * @returns {{ success: boolean, content?: string, steps?: Array, error?: string }}
 */
export function readPlanFile(filePath, basePath = process.cwd()) {
  if (!filePath || typeof filePath !== 'string') {
    return { success: false, error: 'Invalid file path' };
  }

  const resolvedPath = resolve(basePath, filePath);

  if (!existsSync(resolvedPath)) {
    return { success: false, error: `File not found: ${resolvedPath}` };
  }

  try {
    const content = readFileSync(resolvedPath, 'utf-8');
    const parsed = parsePlanMarkdown(content);
    return {
      success: true,
      content,
      steps: parsed.steps,
      filePath: resolvedPath,
    };
  } catch (err) {
    return { success: false, error: `Failed to read file: ${err.message}` };
  }
}

/**
 * Match a log entry to a step in the plan
 * Uses fuzzy matching to correlate agent activity with plan steps
 * @param {string|object} logEntry - Log entry text or object
 * @param {Array<{ index: number, title: string }>} steps - Plan steps
 * @returns {{ matched: boolean, stepIndex?: number, confidence: number }}
 */
export function matchLogToStep(logEntry, steps) {
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return { matched: false, confidence: 0 };
  }

  const logText = typeof logEntry === 'string' 
    ? logEntry.toLowerCase() 
    : (logEntry?.text || logEntry?.message || JSON.stringify(logEntry)).toLowerCase();

  let bestMatch = { matched: false, stepIndex: undefined, confidence: 0 };

  for (const step of steps) {
    const stepTitle = step.title.toLowerCase();
    const stepWords = stepTitle.split(/\s+/).filter(w => w.length > 3);

    // Calculate word overlap
    let matchedWords = 0;
    for (const word of stepWords) {
      if (logText.includes(word)) {
        matchedWords++;
      }
    }

    // Confidence = percentage of step words found in log
    const confidence = stepWords.length > 0 ? matchedWords / stepWords.length : 0;

    // Also check for exact substring match (higher confidence)
    const exactMatch = logText.includes(stepTitle);
    const finalConfidence = exactMatch ? Math.max(confidence, 0.9) : confidence;

    if (finalConfidence > bestMatch.confidence && finalConfidence >= 0.3) {
      bestMatch = {
        matched: true,
        stepIndex: step.index,
        confidence: finalConfidence,
      };
    }
  }

  return bestMatch;
}

/**
 * Create a log buffer for plan execution logs
 * @param {number} [maxPerSession=100] - Maximum entries per session
 * @returns {object} Log buffer manager
 */
export function createPlanLogBuffer(maxPerSession = 100) {
  const buffers = new Map(); // sessionKey -> Array<LogEntry>

  return {
    /**
     * Add a log entry for a session
     * @param {string} sessionKey 
     * @param {object} entry - { timestamp, type, message, stepIndex?, metadata? }
     */
    append(sessionKey, entry) {
      if (!buffers.has(sessionKey)) {
        buffers.set(sessionKey, []);
      }
      const buffer = buffers.get(sessionKey);
      buffer.push({
        timestamp: Date.now(),
        ...entry,
      });
      // FIFO eviction
      while (buffer.length > maxPerSession) {
        buffer.shift();
      }
    },

    /**
     * Get all logs for a session
     * @param {string} sessionKey 
     * @param {number} [limit] - Optional limit
     * @returns {Array}
     */
    get(sessionKey, limit) {
      const buffer = buffers.get(sessionKey) || [];
      return limit ? buffer.slice(-limit) : [...buffer];
    },

    /**
     * Clear logs for a session
     * @param {string} sessionKey 
     */
    clear(sessionKey) {
      buffers.delete(sessionKey);
    },

    /**
     * Get all session keys with logs
     * @returns {Array<string>}
     */
    sessions() {
      return Array.from(buffers.keys());
    },

    /**
     * Get stats
     * @returns {{ sessionCount: number, totalEntries: number }}
     */
    stats() {
      let totalEntries = 0;
      for (const buffer of buffers.values()) {
        totalEntries += buffer.length;
      }
      return {
        sessionCount: buffers.size,
        totalEntries,
      };
    },
  };
}

/**
 * Update plan status based on step states
 * @param {object} plan - Plan object with steps array
 * @returns {string} New status
 */
export function computePlanStatus(plan) {
  if (!plan || !plan.steps || plan.steps.length === 0) {
    return plan?.status || 'none';
  }

  const steps = plan.steps;
  const allDone = steps.every(s => s.status === 'done' || s.status === 'skipped');
  const anyInProgress = steps.some(s => s.status === 'in-progress');
  const anyStarted = steps.some(s => s.status !== 'pending');

  if (allDone) {
    return 'completed';
  }
  if (anyInProgress || (anyStarted && plan.status === 'approved')) {
    return 'executing';
  }
  return plan.status;
}
