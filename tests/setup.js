/**
 * Test Setup / Global Mocks
 * 
 * This file sets up the test environment with necessary mocks
 * for browser APIs that don't exist in Node.js
 */

import { vi } from 'vitest';

// ============================================================
// Mock WebSocket
// ============================================================

export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.sentMessages = [];
    this._autoConnect = true;
    
    if (this._autoConnect) {
      setTimeout(() => this._simulateOpen(), 0);
    }
  }

  send(data) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sentMessages.push(JSON.parse(data));
  }

  close(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }

  // Test helpers
  _simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  _simulateMessage(data) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  _simulateError(error) {
    this.onerror?.(error);
  }

  _simulateClose(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
}

// ============================================================
// Mock Browser APIs
// ============================================================

export function setupBrowserMocks(options = {}) {
  const {
    hostname = 'localhost',
    protocol = 'https:',
    pathname = '/',
    port = '',
    localStorage = {}
  } = options;

  // Mock window.location
  global.location = {
    hostname,
    protocol,
    pathname,
    port,
    href: `${protocol}//${hostname}${port ? ':' + port : ''}${pathname}`,
    origin: `${protocol}//${hostname}${port ? ':' + port : ''}`
  };

  // Mock window (preserve ClawCondosConfig from lib/config.js import)
  const prevConfig = global.window?.ClawCondosConfig;
  global.window = {
    location: global.location,
    ClawCondosConfig: prevConfig || {},
    CLAWCONDOS_CONFIG: null,
    localStorage: createMockLocalStorage(localStorage),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };

  // Mock document (minimal)
  global.document = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getElementById: vi.fn(),
    querySelector: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    createElement: vi.fn(() => ({
      style: {},
      classList: { add: vi.fn(), remove: vi.fn() },
      appendChild: vi.fn(),
      addEventListener: vi.fn()
    }))
  };

  // Mock WebSocket
  global.WebSocket = MockWebSocket;

  // Mock fetch
  global.fetch = vi.fn();

  // Mock console (optional, to suppress logs in tests)
  // global.console = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

  return {
    location: global.location,
    window: global.window,
    WebSocket: global.WebSocket,
    fetch: global.fetch
  };
}

// ============================================================
// Mock localStorage
// ============================================================

function createMockLocalStorage(initial = {}) {
  let store = { ...initial };
  
  return {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, value) => { store[key] = String(value); }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((index) => Object.keys(store)[index] ?? null),
    // Test helper
    _getStore: () => store
  };
}

// ============================================================
// Test Utilities
// ============================================================

/**
 * Wait for next tick (useful for async operations)
 */
export function nextTick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Create a mock RPC response
 */
export function createRpcResponse(id, result, ok = true) {
  return {
    type: 'res',
    id,
    ok,
    ...(ok ? { result } : { error: result })
  };
}

/**
 * Create a mock chat event
 */
export function createChatEvent(sessionKey, eventType, data = {}) {
  return {
    type: 'event',
    event: 'chat',
    params: {
      sessionKey,
      type: eventType,
      ...data
    }
  };
}

// ============================================================
// Default setup (runs automatically)
// ============================================================

// Set up basic mocks by default
setupBrowserMocks();
