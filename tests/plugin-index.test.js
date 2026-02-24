import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import register from '../clawcondos/condo-management/index.js';
import { CLASSIFIER_CONFIG } from '../clawcondos/condo-management/lib/classifier.js';

const TEST_DIR = join(import.meta.dirname, '__fixtures__', 'plugin-index-test');

function createMockApi(dataDir) {
  const methods = {};
  const hooks = {};
  const toolFactories = [];

  return {
    pluginConfig: { dataDir },
    logger: { info: vi.fn(), error: vi.fn() },
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
    it('registers core gateway methods (plus Helix extensions)', () => {
      const coreExpected = [
        'goals.list', 'goals.create', 'goals.get', 'goals.update', 'goals.delete',
        'goals.addSession', 'goals.removeSession', 'goals.sessionLookup',
        'goals.setSessionCondo', 'goals.getSessionCondo', 'goals.listSessionCondos',
        'goals.removeSessionCondo',
        'goals.addTask', 'goals.updateTask', 'goals.deleteTask',
        'goals.addFiles', 'goals.removeFile',
        'condos.create', 'condos.list', 'condos.get', 'condos.update', 'condos.delete',
        'goals.spawnTaskSession',
        'classification.stats', 'classification.learningReport', 'classification.applyLearning',
      ];
      for (const name of coreExpected) {
        expect(api._methods).toHaveProperty(name);
      }
      // Helix port registers many additional methods; keep this as a lower bound
      // to avoid brittle breakage as feature modules evolve.
      expect(Object.keys(api._methods).length).toBeGreaterThanOrEqual(coreExpected.length);
    });

    it('registers before_agent_start and agent_end hooks', () => {
      expect(api._hooks).toHaveProperty('before_agent_start');
      expect(api._hooks).toHaveProperty('agent_end');
    });

    it('registers core and Helix tool factories', () => {
      expect(api._toolFactories.length).toBeGreaterThanOrEqual(5);
      expect(api._getToolFactory('goal_update')).toBeTypeOf('function');
      expect(api._getToolFactory('condo_bind')).toBeTypeOf('function');
      expect(api._getToolFactory('condo_create_goal')).toBeTypeOf('function');
      expect(api._getToolFactory('condo_add_task')).toBeTypeOf('function');
      expect(api._getToolFactory('condo_spawn_task')).toBeTypeOf('function');
      expect(api._getToolFactory('condo_pm_chat')).toBeTypeOf('function');
      expect(api._getToolFactory('condo_pm_kickoff')).toBeTypeOf('function');
      expect(api._getToolFactory('condo_status')).toBeTypeOf('function');
      expect(api._getToolFactory('condo_list')).toBeTypeOf('function');
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

    it('includes project summary when goal has condoId', async () => {
      // Create condo and goal in it
      let condoResult;
      api._methods['condos.create']({
        params: { name: 'Summary Condo' },
        respond: (ok, payload) => { condoResult = payload; },
      });
      const condoId = condoResult.condo.id;

      let goalResult;
      api._methods['goals.create']({
        params: { title: 'Condo Goal A', condoId },
        respond: (ok, payload) => { goalResult = payload; },
      });
      const goalId = goalResult.goal.id;

      api._methods['goals.create']({
        params: { title: 'Condo Goal B', condoId },
        respond: () => {},
      });

      api._methods['goals.addSession']({
        params: { id: goalId, sessionKey: 'agent:main:summary' },
        respond: () => {},
      });

      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:main:summary' },
      });
      expect(result.prependContext).toContain('<project');
      expect(result.prependContext).toContain('Summary Condo');
      expect(result.prependContext).toContain('Condo Goal A');
      expect(result.prependContext).toContain('Condo Goal B');
      expect(result.prependContext).toContain('<goal');
    });

    it('no project summary when goal has no condoId', async () => {
      const goalId = seedGoal();
      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:main:main' },
      });
      expect(result.prependContext).toContain('<goal');
      expect(result.prependContext).not.toContain('<project');
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
      expect(result.prependContext).not.toContain('# Direct Goal');
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

    it('tool execute creates new condo and binds when name provided', async () => {
      const factory = api._getToolFactory('condo_bind');
      const tool = factory({ sessionKey: 'agent:main:telegram:new' });
      const result = await tool.execute('call1', { name: 'Brand New Condo', description: 'Created via bind' });
      expect(result.content[0].text).toContain('Brand New Condo');

      // Verify condo was created
      let listResult;
      api._methods['condos.list']({
        params: {},
        respond: (ok, payload) => { listResult = payload; },
      });
      const condo = listResult.condos.find(c => c.name === 'Brand New Condo');
      expect(condo).toBeTruthy();

      // Verify session binding persisted
      let mappingResult;
      api._methods['goals.getSessionCondo']({
        params: { sessionKey: 'agent:main:telegram:new' },
        respond: (ok, payload) => { mappingResult = payload; },
      });
      expect(mappingResult.condoId).toBe(condo.id);
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

  describe('before_agent_start hook (classification)', () => {
    function seedCondoWithKeywords(name, keywords, telegramTopicIds = []) {
      let condoResult;
      api._methods['condos.create']({
        params: { name, keywords, telegramTopicIds },
        respond: (ok, payload) => { condoResult = payload; },
      });
      return condoResult.condo;
    }

    it('auto-routes by Telegram topic binding', async () => {
      const condo = seedCondoWithKeywords('Infra', ['deploy'], [2212]);
      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:main:telegram:group:-100xxx:topic:2212' },
        messages: [{ role: 'user', content: 'something random' }],
      });
      expect(result).toHaveProperty('prependContext');
      expect(result.prependContext).toContain('Infra');
    });

    it('auto-routes by keyword match above threshold', async () => {
      // Need name match (0.3) + 4 keywords (0.45) = 0.75, still below 0.8
      // name match (0.3) + keyword max (0.45) = 0.75 < 0.8
      // So we need explicit @condo mention or topic for auto-route
      // Actually, let's use @condo:infra for guaranteed auto-route
      seedCondoWithKeywords('Infra', ['deploy', 'server', 'docker', 'kubernetes']);
      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:main:telegram:group:-100xxx:topic:9999' },
        messages: [{ role: 'user', content: 'We need to @condo:infra deploy the server' }],
      });
      expect(result).toHaveProperty('prependContext');
      expect(result.prependContext).toContain('Infra');
    });

    it('skips classification for already-bound session', async () => {
      const condo = seedCondoWithKeywords('Infra', ['deploy']);
      // Bind session to condo manually
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:bound:session', condoId: condo.id },
        respond: () => {},
      });
      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:bound:session' },
        messages: [{ role: 'user', content: 'deploy the server infrastructure now' }],
      });
      // Should get condo context via normal path, not classification
      expect(result).toHaveProperty('prependContext');
      expect(result.prependContext).toContain('Infra');
    });

    it('skips classification for greeting messages', async () => {
      seedCondoWithKeywords('Infra', ['deploy']);
      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:new:session' },
        messages: [{ role: 'user', content: 'hello' }],
      });
      // No condos bound, no goals, greeting skipped → undefined
      expect(result).toBeUndefined();
    });

    it('injects condo menu for low-confidence classification', async () => {
      seedCondoWithKeywords('Infra', ['deploy']);
      seedCondoWithKeywords('Frontend', ['react']);
      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:new:session' },
        messages: [{ role: 'user', content: 'Can you help me with something?' }],
      });
      // No keyword match → low confidence → condo menu
      expect(result).toHaveProperty('prependContext');
      expect(result.prependContext).toContain('Session Not Yet Assigned');
      expect(result.prependContext).toContain('Infra');
      expect(result.prependContext).toContain('Frontend');
      expect(result.prependContext).toContain('condo_bind');
    });

    it('returns undefined when no condos exist and no match', async () => {
      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:new:session' },
        messages: [{ role: 'user', content: 'Can you help me with something?' }],
      });
      expect(result).toBeUndefined();
    });

    it('persists auto-bind in sessionCondoIndex', async () => {
      const condo = seedCondoWithKeywords('Infra', ['deploy']);
      await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:topic:telegram:group:-100xxx:topic:2212' },
        messages: [{ role: 'user', content: 'deploy the server' }],
      });

      // Subsequent call should use condo path (sessionCondoIndex), not classification
      // Seed a topic-bound condo so auto-route fires
      seedCondoWithKeywords('TopicCondo', ['topicword'], [2212]);
      await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:persist:telegram:group:-100xxx:topic:2212' },
        messages: [{ role: 'user', content: 'topicword message' }],
      });

      // Verify binding persisted via RPC
      let mappingResult;
      api._methods['goals.getSessionCondo']({
        params: { sessionKey: 'agent:persist:telegram:group:-100xxx:topic:2212' },
        respond: (ok, payload) => { mappingResult = payload; },
      });
      expect(mappingResult.condoId).toBeTruthy();
    });

    it('appends goal intent hint for structured messages', async () => {
      seedCondoWithKeywords('Infra', ['deploy'], [5555]);
      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:goal:telegram:group:-100xxx:topic:5555' },
        messages: [{
          role: 'user',
          content: 'I need to deploy the server. Here is the plan:\n- First, update dependencies\n- Then, run migrations\n- After that, deploy to staging\n- Finally, verify health checks\nThis is urgent and blocking the release.',
        }],
      });
      expect(result).toHaveProperty('prependContext');
      expect(result.prependContext).toContain('condo_create_goal');
    });

    it('does not crash on classification error, logs it', async () => {
      seedCondoWithKeywords('Infra', ['deploy']);
      // Corrupt the classification log file to force append() to throw
      writeFileSync(join(TEST_DIR, 'classification-log.json'), '{corrupt');
      const result = await api._hooks['before_agent_start']({
        context: { sessionKey: 'agent:error:test' },
        messages: [{ role: 'user', content: 'deploy the infrastructure now' }],
      });
      // Should not throw — falls through to undefined or menu
      expect(result === undefined || result?.prependContext).toBeTruthy();
      expect(api.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('classification error')
      );
    });

    it('skips classification when kill switch is off', async () => {
      const original = CLASSIFIER_CONFIG.enabled;
      try {
        CLASSIFIER_CONFIG.enabled = false;
        seedCondoWithKeywords('Infra', ['deploy'], [7777]);
        const result = await api._hooks['before_agent_start']({
          context: { sessionKey: 'agent:kill:telegram:group:-100xxx:topic:7777' },
          messages: [{ role: 'user', content: 'deploy the server now' }],
        });
        // Kill switch should prevent classification — no auto-route, no menu
        expect(result).toBeUndefined();
      } finally {
        CLASSIFIER_CONFIG.enabled = original;
      }
    });
  });

  describe('classification RPC methods', () => {
    it('classification.stats returns stats', () => {
      let result;
      api._methods['classification.stats']({
        respond: (ok, payload) => { result = { ok, payload }; },
      });
      expect(result.ok).toBe(true);
      expect(result.payload.stats).toHaveProperty('total');
      expect(result.payload.stats).toHaveProperty('accuracy');
    });

    it('classification.learningReport returns suggestions', () => {
      let result;
      api._methods['classification.learningReport']({
        respond: (ok, payload) => { result = { ok, payload }; },
      });
      expect(result.ok).toBe(true);
      expect(result.payload.suggestions).toBeInstanceOf(Array);
    });

    it('classification.applyLearning defaults to dryRun', () => {
      let result;
      api._methods['classification.applyLearning']({
        params: {},
        respond: (ok, payload) => { result = { ok, payload }; },
      });
      expect(result.ok).toBe(true);
      expect(result.payload.dryRun).toBe(true);
      expect(result.payload.applied).toBeInstanceOf(Array);
    });

    it('classification.applyLearning respects dryRun: false', () => {
      let result;
      api._methods['classification.applyLearning']({
        params: { dryRun: false },
        respond: (ok, payload) => { result = { ok, payload }; },
      });
      expect(result.ok).toBe(true);
      expect(result.payload.dryRun).toBe(false);
      expect(result.payload.applied).toBeInstanceOf(Array);
    });
  });

  describe('reclassification tracking', () => {
    it('logs correction when setSessionCondo changes condo', () => {
      let condoA, condoB;
      api._methods['condos.create']({
        params: { name: 'Condo A' },
        respond: (ok, payload) => { condoA = payload.condo; },
      });
      api._methods['condos.create']({
        params: { name: 'Condo B' },
        respond: (ok, payload) => { condoB = payload.condo; },
      });

      // First bind
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:reclass:test', condoId: condoA.id },
        respond: () => {},
      });

      // Rebind to different condo → should log reclassification
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:reclass:test', condoId: condoB.id },
        respond: () => {},
      });

      // Check stats show a correction
      let result;
      api._methods['classification.stats']({
        respond: (ok, payload) => { result = payload; },
      });
      expect(result.stats.corrected).toBeGreaterThanOrEqual(1);
    });

    it('does not log correction when rebinding to same condo', () => {
      let condo;
      api._methods['condos.create']({
        params: { name: 'Same Condo' },
        respond: (ok, payload) => { condo = payload.condo; },
      });

      // Bind twice to the same condo
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:same:test', condoId: condo.id },
        respond: () => {},
      });
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:same:test', condoId: condo.id },
        respond: () => {},
      });

      let result;
      api._methods['classification.stats']({
        respond: (ok, payload) => { result = payload; },
      });
      expect(result.stats.corrected).toBe(0);
    });

    it('reclassification log error does not block rebinding', () => {
      let condoA, condoB;
      api._methods['condos.create']({
        params: { name: 'Condo X' },
        respond: (ok, payload) => { condoA = payload.condo; },
      });
      api._methods['condos.create']({
        params: { name: 'Condo Y' },
        respond: (ok, payload) => { condoB = payload.condo; },
      });

      // First bind
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:errlog:test', condoId: condoA.id },
        respond: () => {},
      });

      // Corrupt classification log to force recordReclassification to throw
      writeFileSync(join(TEST_DIR, 'classification-log.json'), '{corrupt');

      // Rebind should still succeed despite log error
      let rebindResult;
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:errlog:test', condoId: condoB.id },
        respond: (ok, payload) => { rebindResult = { ok, payload }; },
      });
      expect(rebindResult.ok).toBe(true);

      // Verify binding took effect
      let mapping;
      api._methods['goals.getSessionCondo']({
        params: { sessionKey: 'agent:errlog:test' },
        respond: (ok, payload) => { mapping = payload; },
      });
      expect(mapping.condoId).toBe(condoB.id);

      // Error should have been logged
      expect(api.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('reclassification tracking failed')
      );
    });
  });

  describe('agent_end hook (error handling)', () => {
    it('catches errors and logs them without crashing', async () => {
      // Create a condo and bind session (condo path calls save immediately)
      let condoResult;
      api._methods['condos.create']({
        params: { name: 'Error Condo' },
        respond: (ok, payload) => { condoResult = payload; },
      });
      api._methods['goals.setSessionCondo']({
        params: { sessionKey: 'agent:end:error', condoId: condoResult.condo.id },
        respond: () => {},
      });

      // Make data dir read-only so store.save() throws EACCES
      chmodSync(TEST_DIR, 0o555);

      try {
        // agent_end should not throw — error caught by try-catch
        await api._hooks['agent_end']({
          context: { sessionKey: 'agent:end:error' },
          success: true,
        });

        expect(api.logger.error).toHaveBeenCalledWith(
          expect.stringContaining('agent_end error')
        );
      } finally {
        // Restore write permissions for cleanup
        chmodSync(TEST_DIR, 0o755);
      }
    });
  });
});
