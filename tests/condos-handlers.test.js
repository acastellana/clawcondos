import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createGoalsStore } from '../clawcondos/condo-management/lib/goals-store.js';
import { createCondoHandlers } from '../clawcondos/condo-management/lib/condos-handlers.js';
import { createGoalHandlers } from '../clawcondos/condo-management/lib/goals-handlers.js';

const TEST_DIR = join(import.meta.dirname, '__fixtures__', 'condos-handlers-test');

function makeResponder() {
  let result = null;
  const respond = (ok, payload, error) => { result = { ok, payload, error }; };
  return { respond, getResult: () => result };
}

/** Helper: create a condo and return its full object */
function createCondo(handlers, params) {
  const { respond, getResult } = makeResponder();
  handlers['condos.create']({ params, respond });
  const r = getResult();
  if (!r.ok) throw new Error(`createCondo failed: ${r.error?.message}`);
  return r.payload.condo;
}

/** Helper: create a goal and return its full object */
function createGoal(goalHandlers, params) {
  const { respond, getResult } = makeResponder();
  goalHandlers['goals.create']({ params, respond });
  const r = getResult();
  if (!r.ok) throw new Error(`createGoal failed: ${r.error?.message}`);
  return r.payload.goal;
}

describe('CondoHandlers', () => {
  let store, handlers, goalHandlers;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createGoalsStore(TEST_DIR);
    handlers = createCondoHandlers(store);
    goalHandlers = createGoalHandlers(store);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ─── condos.create ────────────────────────────────────────────────

  describe('condos.create', () => {
    it('creates a condo with required fields', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.create']({ params: { name: 'GenLayer' }, respond });
      const r = getResult();
      expect(r.ok).toBe(true);
      expect(r.payload.condo.name).toBe('GenLayer');
      expect(r.payload.condo.id).toMatch(/^condo_/);
      expect(r.payload.condo.description).toBe('');
      expect(r.payload.condo.color).toBeNull();
      expect(r.payload.condo.createdAtMs).toBeTypeOf('number');
      expect(r.payload.condo.updatedAtMs).toBeTypeOf('number');
    });

    it('rejects missing name', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.create']({ params: {}, respond });
      expect(getResult().ok).toBe(false);
      expect(getResult().error.message).toBe('name is required');
    });

    it('rejects empty string name', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.create']({ params: { name: '   ' }, respond });
      expect(getResult().ok).toBe(false);
      expect(getResult().error.message).toBe('name is required');
    });

    it('rejects non-string name (number)', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.create']({ params: { name: 42 }, respond });
      expect(getResult().ok).toBe(false);
      expect(getResult().error.message).toBe('name is required');
    });

    it('rejects non-string name (boolean)', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.create']({ params: { name: true }, respond });
      expect(getResult().ok).toBe(false);
    });

    it('rejects null name', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.create']({ params: { name: null }, respond });
      expect(getResult().ok).toBe(false);
    });

    it('trims name', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.create']({ params: { name: '  GenLayer  ' }, respond });
      expect(getResult().payload.condo.name).toBe('GenLayer');
    });

    it('accepts optional description and color', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.create']({
        params: { name: 'GenLayer', description: 'Layer 1 validator', color: '#ff0000' },
        respond,
      });
      const condo = getResult().payload.condo;
      expect(condo.description).toBe('Layer 1 validator');
      expect(condo.color).toBe('#ff0000');
    });

    it('defaults description to empty string when omitted', () => {
      const condo = createCondo(handlers, { name: 'Test' });
      expect(condo.description).toBe('');
    });

    it('coerces non-string description to empty string', () => {
      const condo = createCondo(handlers, { name: 'Test', description: 42 });
      expect(condo.description).toBe('');
    });

    it('defaults color to null when omitted', () => {
      const condo = createCondo(handlers, { name: 'Test' });
      expect(condo.color).toBeNull();
    });

    it('generates unique IDs across creates', () => {
      const c1 = createCondo(handlers, { name: 'A' });
      const c2 = createCondo(handlers, { name: 'B' });
      const c3 = createCondo(handlers, { name: 'C' });
      const ids = new Set([c1.id, c2.id, c3.id]);
      expect(ids.size).toBe(3);
    });

    it('prepends new condos (newest first)', () => {
      createCondo(handlers, { name: 'First' });
      createCondo(handlers, { name: 'Second' });
      createCondo(handlers, { name: 'Third' });

      const { respond, getResult } = makeResponder();
      handlers['condos.list']({ params: {}, respond });
      const names = getResult().payload.condos.map(c => c.name);
      expect(names).toEqual(['Third', 'Second', 'First']);
    });

    it('persists across store reload', () => {
      createCondo(handlers, { name: 'Persistent' });

      // Recreate handlers from same store directory (simulates restart)
      const freshStore = createGoalsStore(TEST_DIR);
      const freshHandlers = createCondoHandlers(freshStore);

      const { respond, getResult } = makeResponder();
      freshHandlers['condos.list']({ params: {}, respond });
      expect(getResult().payload.condos).toHaveLength(1);
      expect(getResult().payload.condos[0].name).toBe('Persistent');
    });
  });

  // ─── condos.list ──────────────────────────────────────────────────

  describe('condos.list', () => {
    it('returns empty list initially', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.list']({ params: {}, respond });
      expect(getResult().ok).toBe(true);
      expect(getResult().payload.condos).toEqual([]);
    });

    it('returns condos with goalCount enrichment', () => {
      const condo = createCondo(handlers, { name: 'Project A' });
      createGoal(goalHandlers, { title: 'Goal 1', condoId: condo.id });
      createGoal(goalHandlers, { title: 'Goal 2', condoId: condo.id });
      createGoal(goalHandlers, { title: 'Goal 3' }); // unlinked

      const { respond, getResult } = makeResponder();
      handlers['condos.list']({ params: {}, respond });
      const condos = getResult().payload.condos;
      expect(condos).toHaveLength(1);
      expect(condos[0].goalCount).toBe(2);
    });

    it('returns goalCount 0 for condos with no goals', () => {
      createCondo(handlers, { name: 'Empty' });

      const { respond, getResult } = makeResponder();
      handlers['condos.list']({ params: {}, respond });
      expect(getResult().payload.condos[0].goalCount).toBe(0);
    });

    it('computes goalCount independently per condo', () => {
      const c1 = createCondo(handlers, { name: 'Alpha' });
      const c2 = createCondo(handlers, { name: 'Beta' });
      const c3 = createCondo(handlers, { name: 'Gamma' });

      createGoal(goalHandlers, { title: 'G1', condoId: c1.id });
      createGoal(goalHandlers, { title: 'G2', condoId: c1.id });
      createGoal(goalHandlers, { title: 'G3', condoId: c1.id });
      createGoal(goalHandlers, { title: 'G4', condoId: c2.id });
      // c3 gets no goals

      const { respond, getResult } = makeResponder();
      handlers['condos.list']({ params: {}, respond });
      const condos = getResult().payload.condos;

      const byName = Object.fromEntries(condos.map(c => [c.name, c.goalCount]));
      expect(byName['Alpha']).toBe(3);
      expect(byName['Beta']).toBe(1);
      expect(byName['Gamma']).toBe(0);
    });

    it('returns multiple condos in insertion order (newest first)', () => {
      createCondo(handlers, { name: 'A' });
      createCondo(handlers, { name: 'B' });

      const { respond, getResult } = makeResponder();
      handlers['condos.list']({ params: {}, respond });
      const names = getResult().payload.condos.map(c => c.name);
      expect(names).toEqual(['B', 'A']);
    });

    it('includes all condo fields plus goalCount', () => {
      createCondo(handlers, { name: 'Full', description: 'desc', color: '#abc' });

      const { respond, getResult } = makeResponder();
      handlers['condos.list']({ params: {}, respond });
      const condo = getResult().payload.condos[0];
      expect(condo).toHaveProperty('id');
      expect(condo).toHaveProperty('name', 'Full');
      expect(condo).toHaveProperty('description', 'desc');
      expect(condo).toHaveProperty('color', '#abc');
      expect(condo).toHaveProperty('createdAtMs');
      expect(condo).toHaveProperty('updatedAtMs');
      expect(condo).toHaveProperty('goalCount', 0);
    });
  });

  // ─── condos.get ───────────────────────────────────────────────────

  describe('condos.get', () => {
    it('returns a condo by id with linked goals', () => {
      const condo = createCondo(handlers, { name: 'Project X' });
      createGoal(goalHandlers, { title: 'Task 1', condoId: condo.id });

      const { respond, getResult } = makeResponder();
      handlers['condos.get']({ params: { id: condo.id }, respond });
      expect(getResult().ok).toBe(true);
      expect(getResult().payload.condo.name).toBe('Project X');
      expect(getResult().payload.goals).toHaveLength(1);
      expect(getResult().payload.goals[0].title).toBe('Task 1');
    });

    it('returns empty goals array when no goals linked', () => {
      const condo = createCondo(handlers, { name: 'Lonely' });

      const { respond, getResult } = makeResponder();
      handlers['condos.get']({ params: { id: condo.id }, respond });
      expect(getResult().ok).toBe(true);
      expect(getResult().payload.goals).toEqual([]);
    });

    it('returns only goals matching this condo', () => {
      const c1 = createCondo(handlers, { name: 'Mine' });
      const c2 = createCondo(handlers, { name: 'Theirs' });

      createGoal(goalHandlers, { title: 'My Goal', condoId: c1.id });
      createGoal(goalHandlers, { title: 'Their Goal', condoId: c2.id });
      createGoal(goalHandlers, { title: 'Orphan Goal' }); // no condoId

      const { respond, getResult } = makeResponder();
      handlers['condos.get']({ params: { id: c1.id }, respond });
      const goals = getResult().payload.goals;
      expect(goals).toHaveLength(1);
      expect(goals[0].title).toBe('My Goal');
    });

    it('returns all condo fields', () => {
      const condo = createCondo(handlers, { name: 'Full', description: 'A desc', color: '#123' });

      const { respond, getResult } = makeResponder();
      handlers['condos.get']({ params: { id: condo.id }, respond });
      const fetched = getResult().payload.condo;
      expect(fetched.id).toBe(condo.id);
      expect(fetched.name).toBe('Full');
      expect(fetched.description).toBe('A desc');
      expect(fetched.color).toBe('#123');
      expect(fetched.createdAtMs).toBe(condo.createdAtMs);
    });

    it('returns error for missing condo', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.get']({ params: { id: 'condo_nonexistent' }, respond });
      expect(getResult().ok).toBe(false);
      expect(getResult().error.message).toBe('Condo not found');
    });
  });

  // ─── condos.update ────────────────────────────────────────────────

  describe('condos.update', () => {
    it('patches all allowed fields at once', () => {
      const condo = createCondo(handlers, { name: 'Original' });

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({
        params: { id: condo.id, name: 'Updated', description: 'New desc', color: '#00ff00' },
        respond,
      });
      const updated = getResult().payload.condo;
      expect(updated.name).toBe('Updated');
      expect(updated.description).toBe('New desc');
      expect(updated.color).toBe('#00ff00');
      expect(updated.updatedAtMs).toBeGreaterThanOrEqual(updated.createdAtMs);
    });

    it('patches only name (partial update)', () => {
      const condo = createCondo(handlers, { name: 'Old', description: 'Keep me', color: '#abc' });

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({
        params: { id: condo.id, name: 'New' },
        respond,
      });
      const updated = getResult().payload.condo;
      expect(updated.name).toBe('New');
      expect(updated.description).toBe('Keep me');
      expect(updated.color).toBe('#abc');
    });

    it('patches only description', () => {
      const condo = createCondo(handlers, { name: 'Keep', color: '#abc' });

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({
        params: { id: condo.id, description: 'New desc' },
        respond,
      });
      const updated = getResult().payload.condo;
      expect(updated.name).toBe('Keep');
      expect(updated.description).toBe('New desc');
      expect(updated.color).toBe('#abc');
    });

    it('patches only color', () => {
      const condo = createCondo(handlers, { name: 'Keep', description: 'Keep too' });

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({
        params: { id: condo.id, color: '#ff0000' },
        respond,
      });
      const updated = getResult().payload.condo;
      expect(updated.name).toBe('Keep');
      expect(updated.description).toBe('Keep too');
      expect(updated.color).toBe('#ff0000');
    });

    it('can set color to null', () => {
      const condo = createCondo(handlers, { name: 'Colored', color: '#ff0000' });

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({
        params: { id: condo.id, color: null },
        respond,
      });
      expect(getResult().payload.condo.color).toBeNull();
    });

    it('can set description to empty string', () => {
      const condo = createCondo(handlers, { name: 'C', description: 'Has desc' });

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({
        params: { id: condo.id, description: '' },
        respond,
      });
      expect(getResult().payload.condo.description).toBe('');
    });

    it('advances updatedAtMs without touching createdAtMs', () => {
      const condo = createCondo(handlers, { name: 'Timestamped' });
      const originalCreated = condo.createdAtMs;
      const originalUpdated = condo.updatedAtMs;

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({
        params: { id: condo.id, description: 'changed' },
        respond,
      });
      const updated = getResult().payload.condo;
      expect(updated.createdAtMs).toBe(originalCreated);
      expect(updated.updatedAtMs).toBeGreaterThanOrEqual(originalUpdated);
    });

    it('ignores internal fields in patch (createdAtMs, id)', () => {
      const condo = createCondo(handlers, { name: 'Condo' });

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({
        params: { id: condo.id, createdAtMs: 0, name: 'Safe' },
        respond,
      });
      const updated = getResult().payload.condo;
      expect(updated.name).toBe('Safe');
      expect(updated.createdAtMs).toBe(condo.createdAtMs);
      expect(updated.id).toBe(condo.id);
    });

    it('ignores unknown fields in patch', () => {
      const condo = createCondo(handlers, { name: 'Condo' });

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({
        params: { id: condo.id, malicious: 'payload', __proto__: 'bad', name: 'Fine' },
        respond,
      });
      const updated = getResult().payload.condo;
      expect(updated.name).toBe('Fine');
      expect(updated).not.toHaveProperty('malicious');
    });

    it('trims name on update', () => {
      const condo = createCondo(handlers, { name: 'C' });

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({ params: { id: condo.id, name: '  Trimmed  ' }, respond });
      expect(getResult().payload.condo.name).toBe('Trimmed');
    });

    it('rejects empty name after trim', () => {
      const condo = createCondo(handlers, { name: 'C' });

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({ params: { id: condo.id, name: '   ' }, respond });
      expect(getResult().ok).toBe(false);
      expect(getResult().error.message).toBe('name is required');
    });

    it('rejects non-string name', () => {
      const condo = createCondo(handlers, { name: 'C' });

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({ params: { id: condo.id, name: 123 }, respond });
      expect(getResult().ok).toBe(false);
      expect(getResult().error.message).toBe('name is required');
    });

    it('rejects empty string name', () => {
      const condo = createCondo(handlers, { name: 'C' });

      const { respond, getResult } = makeResponder();
      handlers['condos.update']({ params: { id: condo.id, name: '' }, respond });
      expect(getResult().ok).toBe(false);
      expect(getResult().error.message).toBe('name is required');
    });

    it('returns error for missing condo', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.update']({ params: { id: 'condo_nonexistent', name: 'X' }, respond });
      expect(getResult().ok).toBe(false);
      expect(getResult().error.message).toBe('Condo not found');
    });

    it('applies multiple sequential updates correctly', () => {
      const condo = createCondo(handlers, { name: 'V1' });

      const r2 = makeResponder();
      handlers['condos.update']({ params: { id: condo.id, name: 'V2' }, respond: r2.respond });
      expect(r2.getResult().payload.condo.name).toBe('V2');

      const r3 = makeResponder();
      handlers['condos.update']({ params: { id: condo.id, name: 'V3', color: '#abc' }, respond: r3.respond });
      expect(r3.getResult().payload.condo.name).toBe('V3');
      expect(r3.getResult().payload.condo.color).toBe('#abc');

      // Verify via get
      const rg = makeResponder();
      handlers['condos.get']({ params: { id: condo.id }, respond: rg.respond });
      expect(rg.getResult().payload.condo.name).toBe('V3');
      expect(rg.getResult().payload.condo.color).toBe('#abc');
    });

    it('does not affect other condos', () => {
      const c1 = createCondo(handlers, { name: 'Target' });
      const c2 = createCondo(handlers, { name: 'Bystander' });

      handlers['condos.update']({
        params: { id: c1.id, name: 'Changed' },
        respond: makeResponder().respond,
      });

      const { respond, getResult } = makeResponder();
      handlers['condos.get']({ params: { id: c2.id }, respond });
      expect(getResult().payload.condo.name).toBe('Bystander');
    });

    it('persists updates across store reload', () => {
      const condo = createCondo(handlers, { name: 'Before' });

      handlers['condos.update']({
        params: { id: condo.id, name: 'After', description: 'Updated' },
        respond: makeResponder().respond,
      });

      const freshStore = createGoalsStore(TEST_DIR);
      const freshHandlers = createCondoHandlers(freshStore);
      const { respond, getResult } = makeResponder();
      freshHandlers['condos.get']({ params: { id: condo.id }, respond });
      expect(getResult().payload.condo.name).toBe('After');
      expect(getResult().payload.condo.description).toBe('Updated');
    });
  });

  // ─── condos.delete ────────────────────────────────────────────────

  describe('condos.delete', () => {
    it('deletes a condo and nullifies condoId on linked goals', () => {
      const condo = createCondo(handlers, { name: 'Doomed' });
      const goal = createGoal(goalHandlers, { title: 'Linked Goal', condoId: condo.id });

      const { respond, getResult } = makeResponder();
      handlers['condos.delete']({ params: { id: condo.id }, respond });
      expect(getResult().ok).toBe(true);

      // Verify condo is gone
      const r2 = makeResponder();
      handlers['condos.list']({ params: {}, respond: r2.respond });
      expect(r2.getResult().payload.condos).toHaveLength(0);

      // Verify goal's condoId is nullified
      const r3 = makeResponder();
      goalHandlers['goals.get']({ params: { id: goal.id }, respond: r3.respond });
      expect(r3.getResult().payload.goal.condoId).toBeNull();
    });

    it('cascade nullifies multiple linked goals', () => {
      const condo = createCondo(handlers, { name: 'Hub' });
      const g1 = createGoal(goalHandlers, { title: 'G1', condoId: condo.id });
      const g2 = createGoal(goalHandlers, { title: 'G2', condoId: condo.id });
      const g3 = createGoal(goalHandlers, { title: 'G3', condoId: condo.id });

      handlers['condos.delete']({ params: { id: condo.id }, respond: makeResponder().respond });

      for (const gid of [g1.id, g2.id, g3.id]) {
        const { respond, getResult } = makeResponder();
        goalHandlers['goals.get']({ params: { id: gid }, respond });
        expect(getResult().payload.goal.condoId).toBeNull();
      }
    });

    it('does not affect goals linked to other condos', () => {
      const doomed = createCondo(handlers, { name: 'Doomed' });
      const safe = createCondo(handlers, { name: 'Safe' });

      createGoal(goalHandlers, { title: 'Doomed Goal', condoId: doomed.id });
      const safeGoal = createGoal(goalHandlers, { title: 'Safe Goal', condoId: safe.id });

      handlers['condos.delete']({ params: { id: doomed.id }, respond: makeResponder().respond });

      const { respond, getResult } = makeResponder();
      goalHandlers['goals.get']({ params: { id: safeGoal.id }, respond });
      expect(getResult().payload.goal.condoId).toBe(safe.id);
    });

    it('does not affect unlinked goals', () => {
      const condo = createCondo(handlers, { name: 'Doomed' });
      const orphan = createGoal(goalHandlers, { title: 'Orphan' });

      handlers['condos.delete']({ params: { id: condo.id }, respond: makeResponder().respond });

      const { respond, getResult } = makeResponder();
      goalHandlers['goals.get']({ params: { id: orphan.id }, respond });
      expect(getResult().payload.goal.condoId).toBeNull();
      expect(getResult().payload.goal.title).toBe('Orphan');
    });

    it('does not affect other condos', () => {
      const c1 = createCondo(handlers, { name: 'First' });
      const c2 = createCondo(handlers, { name: 'Second' });
      const c3 = createCondo(handlers, { name: 'Third' });

      handlers['condos.delete']({ params: { id: c2.id }, respond: makeResponder().respond });

      const { respond, getResult } = makeResponder();
      handlers['condos.list']({ params: {}, respond });
      const names = getResult().payload.condos.map(c => c.name);
      expect(names).toHaveLength(2);
      expect(names).toContain('First');
      expect(names).toContain('Third');
      expect(names).not.toContain('Second');
    });

    it('deleted condo is no longer fetchable by get', () => {
      const condo = createCondo(handlers, { name: 'Gone' });
      handlers['condos.delete']({ params: { id: condo.id }, respond: makeResponder().respond });

      const { respond, getResult } = makeResponder();
      handlers['condos.get']({ params: { id: condo.id }, respond });
      expect(getResult().ok).toBe(false);
      expect(getResult().error.message).toBe('Condo not found');
    });

    it('returns error for missing condo', () => {
      const { respond, getResult } = makeResponder();
      handlers['condos.delete']({ params: { id: 'condo_nonexistent' }, respond });
      expect(getResult().ok).toBe(false);
      expect(getResult().error.message).toBe('Condo not found');
    });

    it('double-delete returns error on second attempt', () => {
      const condo = createCondo(handlers, { name: 'Once' });

      const r1 = makeResponder();
      handlers['condos.delete']({ params: { id: condo.id }, respond: r1.respond });
      expect(r1.getResult().ok).toBe(true);

      const r2 = makeResponder();
      handlers['condos.delete']({ params: { id: condo.id }, respond: r2.respond });
      expect(r2.getResult().ok).toBe(false);
      expect(r2.getResult().error.message).toBe('Condo not found');
    });

    it('persists deletion across store reload', () => {
      const condo = createCondo(handlers, { name: 'Ephemeral' });
      handlers['condos.delete']({ params: { id: condo.id }, respond: makeResponder().respond });

      const freshStore = createGoalsStore(TEST_DIR);
      const freshHandlers = createCondoHandlers(freshStore);
      const { respond, getResult } = makeResponder();
      freshHandlers['condos.list']({ params: {}, respond });
      expect(getResult().payload.condos).toHaveLength(0);
    });

    it('cleans up sessionCondoIndex entries pointing to deleted condo', () => {
      const condo = createCondo(handlers, { name: 'Doomed' });
      const otherCondo = createCondo(handlers, { name: 'Survivor' });

      // Map sessions to the condos
      const goalH = createGoalHandlers(store);
      goalH['goals.setSessionCondo']({
        params: { sessionKey: 'agent:main:main', condoId: condo.id },
        respond: makeResponder().respond,
      });
      goalH['goals.setSessionCondo']({
        params: { sessionKey: 'agent:other:main', condoId: otherCondo.id },
        respond: makeResponder().respond,
      });

      // Delete the condo
      handlers['condos.delete']({ params: { id: condo.id }, respond: makeResponder().respond });

      // Session mapped to deleted condo should be gone
      const r1 = makeResponder();
      goalH['goals.getSessionCondo']({ params: { sessionKey: 'agent:main:main' }, respond: r1.respond });
      expect(r1.getResult().payload.condoId).toBeNull();

      // Session mapped to other condo should be untouched
      const r2 = makeResponder();
      goalH['goals.getSessionCondo']({ params: { sessionKey: 'agent:other:main' }, respond: r2.respond });
      expect(r2.getResult().payload.condoId).toBe(otherCondo.id);
    });
  });

  // ─── Cross-cutting: goal-condo relationship integrity ─────────────

  describe('goal-condo relationship integrity', () => {
    it('goalCount updates when a goal is reassigned to a different condo', () => {
      const c1 = createCondo(handlers, { name: 'Source' });
      const c2 = createCondo(handlers, { name: 'Dest' });
      const goal = createGoal(goalHandlers, { title: 'Movable', condoId: c1.id });

      // Move goal from c1 to c2
      goalHandlers['goals.update']({
        params: { id: goal.id, condoId: c2.id },
        respond: makeResponder().respond,
      });

      const { respond, getResult } = makeResponder();
      handlers['condos.list']({ params: {}, respond });
      const condos = getResult().payload.condos;
      const byName = Object.fromEntries(condos.map(c => [c.name, c.goalCount]));
      expect(byName['Source']).toBe(0);
      expect(byName['Dest']).toBe(1);
    });

    it('goalCount updates when a goal is unlinked (condoId set to null)', () => {
      const condo = createCondo(handlers, { name: 'Shrinking' });
      const goal = createGoal(goalHandlers, { title: 'Leaving', condoId: condo.id });

      goalHandlers['goals.update']({
        params: { id: goal.id, condoId: null },
        respond: makeResponder().respond,
      });

      const { respond, getResult } = makeResponder();
      handlers['condos.list']({ params: {}, respond });
      expect(getResult().payload.condos[0].goalCount).toBe(0);
    });

    it('goalCount updates when a linked goal is deleted', () => {
      const condo = createCondo(handlers, { name: 'Stable' });
      const g1 = createGoal(goalHandlers, { title: 'Stay', condoId: condo.id });
      const g2 = createGoal(goalHandlers, { title: 'Go', condoId: condo.id });

      goalHandlers['goals.delete']({ params: { id: g2.id }, respond: makeResponder().respond });

      const { respond, getResult } = makeResponder();
      handlers['condos.list']({ params: {}, respond });
      expect(getResult().payload.condos[0].goalCount).toBe(1);
    });

    it('condos.get reflects goals added after condo creation', () => {
      const condo = createCondo(handlers, { name: 'Growing' });

      // Initially empty
      const r1 = makeResponder();
      handlers['condos.get']({ params: { id: condo.id }, respond: r1.respond });
      expect(r1.getResult().payload.goals).toHaveLength(0);

      // Add goals
      createGoal(goalHandlers, { title: 'New Goal', condoId: condo.id });

      const r2 = makeResponder();
      handlers['condos.get']({ params: { id: condo.id }, respond: r2.respond });
      expect(r2.getResult().payload.goals).toHaveLength(1);
    });
  });
});
