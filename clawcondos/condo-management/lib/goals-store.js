import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

export function createGoalsStore(dataDir) {
  const filePath = join(dataDir, 'goals.json');

  function newId(prefix = 'goal') {
    return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
  }

  function load() {
    if (!existsSync(filePath)) {
      return { version: 2, goals: [], condos: [], sessionIndex: {}, sessionCondoIndex: {}, notifications: [], config: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      const rawGoals = Array.isArray(parsed.goals) ? parsed.goals : [];
      const goals = rawGoals.map(g => {
        const completed = g?.completed === true || g?.status === 'done';
        // Normalize goal-level plan
        let plan = null;
        if (g?.plan && typeof g.plan === 'object') {
          plan = {
            status: g.plan.status || 'none',
            content: g.plan.content || '',
            steps: Array.isArray(g.plan.steps) ? g.plan.steps : [],
            feedback: g.plan.feedback || null,
            createdAtMs: g.plan.createdAtMs || null,
            updatedAtMs: g.plan.updatedAtMs || null,
          };
        }
        return {
          ...g,
          condoId: g?.condoId ?? null,
          completed,
          description: g?.description ?? g?.notes ?? '',
          sessions: Array.isArray(g?.sessions) ? g.sessions : [],
          tasks: Array.isArray(g?.tasks) ? g.tasks : [],
          files: Array.isArray(g?.files) ? g.files : [],
          plan,
        };
      });
      return {
        version: parsed.version ?? 2,
        goals,
        condos: Array.isArray(parsed.condos) ? parsed.condos : [],
        sessionIndex: parsed.sessionIndex && typeof parsed.sessionIndex === 'object' ? parsed.sessionIndex : {},
        sessionCondoIndex: parsed.sessionCondoIndex && typeof parsed.sessionCondoIndex === 'object' ? parsed.sessionCondoIndex : {},
        notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
        config: parsed.config && typeof parsed.config === 'object' ? parsed.config : {},
      };
    } catch (err) {
      return { version: 2, goals: [], condos: [], sessionIndex: {}, sessionCondoIndex: {}, notifications: [], config: {}, _loadError: true };
    }
  }

  function save(data) {
    if (data._loadError) {
      throw new Error('Refusing to save — store was loaded with errors (would destroy data)');
    }
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, filePath);
  }

  return { load, save, newId, filePath };
}
