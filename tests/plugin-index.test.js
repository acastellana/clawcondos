import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import register from '../clawcondos/condo-management/index.js';

const TEST_DIR = join(import.meta.dirname, '__fixtures__', 'plugin-index-test');

function createMockApi(dataDir) {
  const methods = {};
  const hooks = {};
  const toolFactories = [];

  return {
    pluginConfig: { dataDir },
    logger: { info: vi.fn() },
    registerGatewayMethod(name, handler) { methods[name] = handler; },
    registerHook(name, fn) { hooks[name] = fn; },
    registerTool(factory, opts) { toolFactories.push({ factory, opts }); },
    // Accessors for tests
    _methods: methods,
    _hooks: hooks,
    _toolFactories: toolFactories,
    _getToolFactory(name) {
      const entry = toolFactories.find(e => e.opts?.names?.includes(name));
      return entry?.factory ?? null;
    },
  };
}

describe('Plugin index.js', () => {
  let api;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    api = createMockApi(TEST_DIR);
    register(api);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('registration', () => {
    it('registers all 21 gateway methods', () => {
      const expected = [
        'goals.list', 'goals.create', 'goals.get', 'goals.update', 'goals.delete',
        'goals.addSession', 'goals.removeSession', 'goals.sessionLookup',
        'goals.setSessionCondo', 'goals.getSessionCondo', 'goals.listSessionCondos',
        'goals.removeSessionCondo',
        'goals.addTask', 'goals.updateTask', 'goals.deleteTask',
        'condos.create', 'condos.list', 'condos.get', 'condos.update', 'condos.delete',
        'goals.spawnTaskSession',
      ];
      for (const name of expected) {
        expect(api._methods).toHaveProperty(name);
      }
      expect(Object.keys(api._methods)).toHaveLength(21);
    });

    it('registers before_agent_start and agent_end hooks', () => {
      expect(api._hooks).toHaveProperty('before_agent_start');
      expect(api._hooks).toHaveProperty('agent_end');
    });

    it('registers 5 tool factories', () => {
      expect(api._toolFactories).toHaveLength(5);
      expect(api._getToolFactory('goal_update')).toBeTypeOf('function');
      expect(api._getToolFactory('condo_bind')).toBeTypeOf('function');
      expect(api._getToolFactory('condo_create_goal')).toBeTypeOf('function');
      expect(api._getToolFactory('condo_add_task')).toBeTypeOf('function');
      expect(api._getToolFactory('condo_spawn_task')).toBeTypeOf('function');
    });
  });

  describe('before_agent_start hook (goal path)', () => {
    function seedGoal() {
      let result;
      api._methods['goals.create']({
        params: { title: 'Test Goal', description: 'Build something' },
        respond: (ok, payload, err) => { result = { ok, payload, err }; },
      });
      const goalId = result.payload.goal.id;
      api._methods['goals.addSession']({
        params: { id: goalId, sessionKey: 'agent:main:main' },
        respond: () => {},
      });
      return goalId;
    }

    it('returns context for session assigned to a goal', async () => {
      seedGoal();
      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:main:main' },
      });
      expect(result).toHaveProperty('prependContext');
      expect(result.prependContext).toContain('Test Goal');
    });

    it('returns undefined for session not assigned to a goal', async () => {
      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:orphan:main' },
      });
      expect(result).toBeUndefined();
    });

    it('returns undefined when no sessionKey', async () => {
      const result = await api._hooks['before_agent_start']({
        context: {},
      });
      expect(result).toBeUndefined();
    });
  });

  describe('before_agent_start hook (condo path)', () => {
    function seedCondo() {
      let condoResult;
      api._methods['condos.create']({
        params: { name: 'Test Condo', description: 'Condo desc' },
        respond: (ok, payload) => { condoResult = payload; },
      });
      const condoId = condoResult.condo.id;

      // Create a goal in this condo
      let goalResult;
      api._methods['goals.create']({
        params: { title: 'Condo Goal', condoId },
        respond: (ok, payload) => { goalResult = payload; },
      });

      // Bind session to condo
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:main:telegram:123', condoId },
        respond: () => {},
      });

      return condoId;
    }

    it('returns condo context for bound session', async () => {
      seedCondo();
      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:main:telegram:123' },
      });
      expect(result).toHaveProperty('prependContext');
      expect(result.prependContext).toContain('Test Condo');
      expect(result.prependContext).toContain('Condo Goal');
    });

    it('condo path takes priority over goal path', async () => {
      seedCondo();
      // Also assign session to a different goal via sessionIndex
      let goalResult;
      api._methods['goals.create']({
        params: { title: 'Direct Goal' },
        respond: (ok, payload) => { goalResult = payload; },
      });
      api._methods['goals.addSession']({
        params: { id: goalResult.goal.id, sessionKey: 'agent:main:telegram:123' },
        respond: () => {},
      });

      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:main:telegram:123' },
      });
      // Should get condo context, not direct goal context
      expect(result.prependContext).toContain('Test Condo');
      expect(result.prependContext).not.toContain('# Goal: Direct Goal');
    });
  });

  describe('agent_end hook', () => {
    function seedGoal() {
      let result;
      api._methods['goals.create']({
        params: { title: 'Track Me' },
        respond: (ok, payload) => { result = { ok, payload }; },
      });
      const goalId = result.payload.goal.id;
      api._methods['goals.addSession']({
        params: { id: goalId, sessionKey: 'agent:main:main' },
        respond: () => {},
      });
      return goalId;
    }

    it('updates goal timestamp on success', async () => {
      const goalId = seedGoal();
      let goalBefore;
      api._methods['goals.get']({
        params: { id: goalId },
        respond: (ok, payload) => { goalBefore = payload.goal; },
      });

      await new Promise(r => setTimeout(r, 5));

      await api._hooks['agent_end']({
        context: { sessionKey: 'agent:main:main' },
        success: true,
      });

      let goalAfter;
      api._methods['goals.get']({
        params: { id: goalId },
        respond: (ok, payload) => { goalAfter = payload.goal; },
      });
      expect(goalAfter.updatedAtMs).toBeGreaterThan(goalBefore.updatedAtMs);
      expect(api.logger.info).toHaveBeenCalled();
    });

    it('does nothing on failure', async () => {
      seedGoal();
      const result = await api._hooks['agent_end']({
        context: { sessionKey: 'agent:main:main' },
        success: false,
      });
      expect(result).toBeUndefined();
    });

    it('does nothing for unassigned session', async () => {
      const result = await api._hooks['agent_end']({
        context: { sessionKey: 'agent:orphan:main' },
        success: true,
      });
      expect(result).toBeUndefined();
    });

    it('updates condo timestamp for condo-bound session', async () => {
      let condoResult;
      api._methods['condos.create']({
        params: { name: 'Tracked Condo' },
        respond: (ok, payload) => { condoResult = payload; },
      });
      const condoId = condoResult.condo.id;
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:main:telegram:123', condoId },
        respond: () => {},
      });

      let condoBefore;
      api._methods['condos.get']({
        params: { id: condoId },
        respond: (ok, payload) => { condoBefore = payload.condo; },
      });

      await new Promise(r => setTimeout(r, 5));

      await api._hooks['agent_end']({
        context: { sessionKey: 'agent:main:telegram:123' },
        success: true,
      });

      let condoAfter;
      api._methods['condos.get']({
        params: { id: condoId },
        respond: (ok, payload) => { condoAfter = payload.condo; },
      });
      expect(condoAfter.updatedAtMs).toBeGreaterThan(condoBefore.updatedAtMs);
    });
  });

  describe('goal_update tool factory', () => {
    function seedGoal() {
      let result;
      api._methods['goals.create']({
        params: { title: 'Tooled Goal' },
        respond: (ok, payload) => { result = { ok, payload }; },
      });
      const goalId = result.payload.goal.id;
      api._methods['goals.addSession']({
        params: { id: goalId, sessionKey: 'agent:main:main' },
        respond: () => {},
      });
      return goalId;
    }

    it('returns null for session without sessionKey', () => {
      const factory = api._getToolFactory('goal_update');
      expect(factory({})).toBeNull();
    });

    it('returns tool for session not yet assigned to a goal (validation deferred to execute)', () => {
      const factory = api._getToolFactory('goal_update');
      const tool = factory({ sessionKey: 'agent:orphan:main' });
      expect(tool).not.toBeNull();
      expect(tool.name).toBe('goal_update');
    });

    it('returns tool definition for assigned session', () => {
      seedGoal();
      const factory = api._getToolFactory('goal_update');
      const tool = factory({ sessionKey: 'agent:main:main' });
      expect(tool).not.toBeNull();
      expect(tool.name).toBe('goal_update');
      expect(tool.execute).toBeTypeOf('function');
    });

    it('tool execute works end-to-end', async () => {
      seedGoal();
      const factory = api._getToolFactory('goal_update');
      const tool = factory({ sessionKey: 'agent:main:main' });
      const result = await tool.execute('call1', { nextTask: 'Starting work' });
      expect(result.content[0].text).toContain('updated');
    });

    it('always includes goalId parameter in schema', () => {
      const factory = api._getToolFactory('goal_update');
      const tool = factory({ sessionKey: 'agent:main:any:123' });
      expect(tool).not.toBeNull();
      expect(tool.parameters.properties).toHaveProperty('goalId');
    });

    it('execute returns error for unassigned session without goalId', async () => {
      const factory = api._getToolFactory('goal_update');
      const tool = factory({ sessionKey: 'agent:orphan:main' });
      const result = await tool.execute('call1', { nextTask: 'test' });
      expect(result.content[0].text).toContain('Error');
    });
  });

  describe('condo_bind tool factory', () => {
    it('returns null for already-bound session', () => {
      let condoResult;
      api._methods['condos.create']({
        params: { name: 'Bound Condo' },
        respond: (ok, payload) => { condoResult = payload; },
      });
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:main:telegram:123', condoId: condoResult.condo.id },
        respond: () => {},
      });

      const factory = api._getToolFactory('condo_bind');
      expect(factory({ sessionKey: 'agent:main:telegram:123' })).toBeNull();
    });

    it('returns tool definition for unbound session', () => {
      const factory = api._getToolFactory('condo_bind');
      const tool = factory({ sessionKey: 'agent:main:telegram:456' });
      expect(tool).not.toBeNull();
      expect(tool.name).toBe('condo_bind');
    });

    it('tool execute binds session to condo', async () => {
      let condoResult;
      api._methods['condos.create']({
        params: { name: 'Bindable Condo' },
        respond: (ok, payload) => { condoResult = payload; },
      });

      const factory = api._getToolFactory('condo_bind');
      const tool = factory({ sessionKey: 'agent:main:telegram:789' });
      const result = await tool.execute('call1', { condoId: condoResult.condo.id });
      expect(result.content[0].text).toContain('Bindable Condo');

      // Verify binding persisted
      let mappingResult;
      api._methods['goals.getSessionCondo']({
        params: { sessionKey: 'agent:main:telegram:789' },
        respond: (ok, payload) => { mappingResult = payload; },
      });
      expect(mappingResult.condoId).toBe(condoResult.condo.id);
    });
  });

  describe('condo_create_goal tool factory', () => {
    function seedCondoBound() {
      let condoResult;
      api._methods['condos.create']({
        params: { name: 'Goal Condo' },
        respond: (ok, payload) => { condoResult = payload; },
      });
      const condoId = condoResult.condo.id;
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:main:telegram:123', condoId },
        respond: () => {},
      });
      return condoId;
    }

    it('returns null for unbound session', () => {
      const factory = api._getToolFactory('condo_create_goal');
      expect(factory({ sessionKey: 'agent:unbound:main' })).toBeNull();
    });

    it('returns tool definition for bound session', () => {
      seedCondoBound();
      const factory = api._getToolFactory('condo_create_goal');
      const tool = factory({ sessionKey: 'agent:main:telegram:123' });
      expect(tool).not.toBeNull();
      expect(tool.name).toBe('condo_create_goal');
    });

    it('tool execute creates goal end-to-end', async () => {
      const condoId = seedCondoBound();
      const factory = api._getToolFactory('condo_create_goal');
      const tool = factory({ sessionKey: 'agent:main:telegram:123' });
      const result = await tool.execute('call1', { title: 'New Goal', tasks: ['Task A', 'Task B'] });
      expect(result.content[0].text).toContain('New Goal');

      // Verify goal exists in store
      let listResult;
      api._methods['goals.list']({
        params: {},
        respond: (ok, payload) => { listResult = payload; },
      });
      const goal = listResult.goals.find(g => g.title === 'New Goal');
      expect(goal).toBeTruthy();
      expect(goal.condoId).toBe(condoId);
      expect(goal.tasks).toHaveLength(2);
    });
  });

  describe('condo_add_task tool factory', () => {
    it('returns null for unbound session', () => {
      const factory = api._getToolFactory('condo_add_task');
      expect(factory({ sessionKey: 'agent:unbound:main' })).toBeNull();
    });
  });

  describe('condo_spawn_task tool factory', () => {
    it('returns null for unbound session', () => {
      const factory = api._getToolFactory('condo_spawn_task');
      expect(factory({ sessionKey: 'agent:unbound:main' })).toBeNull();
    });

    it('returns tool definition for bound session', () => {
      let condoResult;
      api._methods['condos.create']({
        params: { name: 'Spawn Condo' },
        respond: (ok, payload) => { condoResult = payload; },
      });
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:main:telegram:123', condoId: condoResult.condo.id },
        respond: () => {},
      });

      const factory = api._getToolFactory('condo_spawn_task');
      const tool = factory({ sessionKey: 'agent:main:telegram:123' });
      expect(tool).not.toBeNull();
      expect(tool.name).toBe('condo_spawn_task');
    });
  });
});
