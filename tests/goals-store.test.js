import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createGoalsStore } from '../clawcondos/condo-management/lib/goals-store.js';

const TEST_DIR = join(import.meta.dirname, '__fixtures__', 'goals-store-test');

describe('GoalsStore', () => {
  let store;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('load/save', () => {
    it('returns empty store when no file exists', () => {
      const data = store.load();
      expect(data.version).toBe(2);
      expect(data.goals).toEqual([]);
      expect(data.condos).toEqual([]);
      expect(data.sessionIndex).toEqual({});
      expect(data.sessionCondoIndex).toEqual({});
    });

    it('round-trips condos through save and load', () => {
      const data = store.load();
      data.condos.push({ id: 'condo_test1', name: 'Test Condo', description: '', color: null });
      store.save(data);
      const loaded = store.load();
      expect(loaded.condos).toHaveLength(1);
      expect(loaded.condos[0].name).toBe('Test Condo');
    });

    it('round-trips data through save and load', () => {
      const goal = {
        id: 'goal_test1',
        title: 'Test Goal',
        description: '',
        status: 'active',
        completed: false,
        condoId: null,
        priority: null,
        deadline: null,
        notes: '',
        tasks: [],
        sessions: [],
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };
      const data = store.load();
      data.goals.push(goal);
      store.save(data);

      const loaded = store.load();
      expect(loaded.goals).toHaveLength(1);
      expect(loaded.goals[0].title).toBe('Test Goal');
    });

    it('uses atomic writes (temp file + rename)', () => {
      const data = store.load();
      data.goals.push({ id: 'goal_x', title: 'X', sessions: [], tasks: [] });
      store.save(data);
      // No .tmp file should remain
      expect(existsSync(join(TEST_DIR, 'goals.json.tmp'))).toBe(false);
      expect(existsSync(join(TEST_DIR, 'goals.json'))).toBe(true);
    });

    it('refuses to save if loaded with errors', () => {
      const broken = store.load();
      broken._loadError = true;
      expect(() => store.save(broken)).toThrow(/refusing to save/i);
    });
  });

  describe('data migration', () => {
    it('normalizes legacy goals', () => {
      writeFileSync(join(TEST_DIR, 'goals.json'), JSON.stringify({
        goals: [{ id: 'g1', title: 'Old', status: 'done', notes: 'some notes' }]
      }));
      const data = store.load();
      expect(data.goals[0].completed).toBe(true);
      expect(data.goals[0].description).toBe('some notes');
      expect(data.goals[0].sessions).toEqual([]);
      expect(data.goals[0].condoId).toBeNull();
    });
  });

  describe('newId', () => {
    it('generates prefixed random IDs', () => {
      const id = store.newId('goal');
      expect(id).toMatch(/^goal_[a-f0-9]{24}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => store.newId('goal')));
      expect(ids.size).toBe(100);
    });
  });
});
