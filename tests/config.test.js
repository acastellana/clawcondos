/**
 * Tests for ClawCondos Configuration Module
 *
 * Run with: npx vitest run tests/config.test.js
 */

import { describe, it, expect } from 'vitest';
import { setupBrowserMocks } from './setup.js';

// Import the actual config module (attaches to window.ClawCondosConfig via IIFE)
import '../lib/config.js';

function getConfigModule() {
  return global.window?.ClawCondosConfig;
}

describe('Config Module (actual lib/config.js)', () => {
  describe('DEFAULT_CONFIG', () => {
    it('should export DEFAULT_CONFIG with required fields', () => {
      const mod = getConfigModule();
      expect(mod).toBeTruthy();
      const { DEFAULT_CONFIG } = mod;
      expect(DEFAULT_CONFIG).toHaveProperty('appsUrl');
      expect(DEFAULT_CONFIG).toHaveProperty('branding');
      expect(DEFAULT_CONFIG).toHaveProperty('sessions');
      expect(DEFAULT_CONFIG).toHaveProperty('features');
    });

    it('should have valid session defaults', () => {
      const { DEFAULT_CONFIG } = getConfigModule();
      expect(DEFAULT_CONFIG.sessions.pollInterval).toBeGreaterThan(0);
      expect(DEFAULT_CONFIG.sessions.defaultLimit).toBeGreaterThan(0);
    });

    it('should have boolean feature flags', () => {
      const { DEFAULT_CONFIG } = getConfigModule();
      expect(typeof DEFAULT_CONFIG.features.showApps).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.features.showSubagents).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.features.showAgents).toBe('boolean');
    });

    it('should have ClawCondos branding defaults', () => {
      const { DEFAULT_CONFIG } = getConfigModule();
      expect(DEFAULT_CONFIG.branding.name).toBe('ClawCondos');
      expect(DEFAULT_CONFIG.branding.logo).toBeTruthy();
    });
  });

  describe('getConfig()', () => {
    it('should return a config object with all expected keys', () => {
      const config = getConfigModule().getConfig();
      expect(config).toHaveProperty('gatewayWsUrl');
      expect(config).toHaveProperty('gatewayHttpUrl');
      expect(config).toHaveProperty('appsUrl');
      expect(config).toHaveProperty('branding');
      expect(config).toHaveProperty('sessions');
      expect(config).toHaveProperty('features');
    });

    it('should build wss:// URL for https: protocol', () => {
      setupBrowserMocks({ hostname: 'example.com', protocol: 'https:', port: '' });
      const config = getConfigModule().getConfig();
      expect(config.gatewayWsUrl).toMatch(/^wss:\/\//);
    });

    it('should build ws:// URL for http: protocol', () => {
      setupBrowserMocks({ hostname: 'localhost', protocol: 'http:', port: '9000' });
      const config = getConfigModule().getConfig();
      expect(config.gatewayWsUrl).toMatch(/^ws:\/\//);
    });

    it('should merge inline CLAWCONDOS_CONFIG overrides', () => {
      setupBrowserMocks({ hostname: 'example.com', protocol: 'https:' });
      global.window.CLAWCONDOS_CONFIG = {
        gatewayWsUrl: 'wss://custom.gateway.com/',
        branding: { name: 'MyApp' }
      };
      const config = getConfigModule().getConfig();
      expect(config.gatewayWsUrl).toBe('wss://custom.gateway.com/');
      expect(config.branding.name).toBe('MyApp');
      expect(config.appsUrl).toBe('/api/apps');
    });
  });
});

// Pure-function tests (validate the mergeConfig logic)
describe('mergeConfig behavior', () => {
  function mergeConfig(base, override) {
    const result = { ...base };
    for (const key of Object.keys(override)) {
      if (override[key] !== null && typeof override[key] === 'object' && !Array.isArray(override[key])) {
        result[key] = mergeConfig(result[key] || {}, override[key]);
      } else if (override[key] !== null && override[key] !== undefined) {
        result[key] = override[key];
      }
    }
    return result;
  }

  it('should merge flat properties', () => {
    const result = mergeConfig({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('should deep merge nested objects', () => {
    const base = { branding: { name: 'ClawCondos', logo: '🏙️' }, features: { showApps: true } };
    const override = { branding: { name: 'Custom' }, features: { showAgents: false } };
    const result = mergeConfig(base, override);
    expect(result.branding).toEqual({ name: 'Custom', logo: '🏙️' });
    expect(result.features).toEqual({ showApps: true, showAgents: false });
  });

  it('should NOT overwrite with null values', () => {
    const result = mergeConfig({ gatewayWsUrl: 'wss://example.com/' }, { gatewayWsUrl: null });
    expect(result.gatewayWsUrl).toBe('wss://example.com/');
  });

  it('should NOT overwrite with undefined values', () => {
    const result = mergeConfig({ appsUrl: '/api/apps' }, { appsUrl: undefined });
    expect(result.appsUrl).toBe('/api/apps');
  });

  it('should handle arrays as atomic values (not merge)', () => {
    const result = mergeConfig({ items: [1, 2, 3] }, { items: [4, 5] });
    expect(result.items).toEqual([4, 5]);
  });

  it('should handle deeply nested objects', () => {
    const base = { level1: { level2: { level3: { a: 1, b: 2 } } } };
    const override = { level1: { level2: { level3: { b: 99, c: 3 } } } };
    const result = mergeConfig(base, override);
    expect(result.level1.level2.level3).toEqual({ a: 1, b: 99, c: 3 });
  });
});
