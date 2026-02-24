import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGatewayClient } from '../lib/gateway-client.js';
import { EventEmitter } from 'events';

class MockWebSocket extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    // Simulate async open
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.emit('open');
    }, 10);
  }
  send(data) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }
  close() {
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
  removeAllListeners() {
    super.removeAllListeners();
  }
}

// Factory: creates MockWebSocket that completes auth handshake automatically
function createAutoAuthMockWS() {
  return class AutoAuthWS extends MockWebSocket {
    constructor(url, opts) {
      super(url, opts);
      const origEmit = this.emit.bind(this);
      const origOn = this.on.bind(this);
      // After open, send challenge
      origOn('open', () => {
        setTimeout(() => {
          origEmit('message', JSON.stringify({
            type: 'event', event: 'connect.challenge', payload: {}
          }));
        }, 5);
      });
      // Watch for connect request, respond with hello-ok
      const origSend = this.send.bind(this);
      this.send = (data) => {
        origSend(data);
        const msg = typeof data === 'string' ? JSON.parse(data) : data;
        if (msg.method === 'connect') {
          setTimeout(() => {
            origEmit('message', JSON.stringify({
              type: 'res', id: msg.id, ok: true, payload: { message: 'hello-ok' }
            }));
          }, 5);
        }
      };
    }
  };
}

describe('createGatewayClient', () => {
  let client;
  const logger = { log: vi.fn(), error: vi.fn() };

  afterEach(() => {
    if (client) client.close();
  });

  it('starts in disconnected state', () => {
    client = createGatewayClient({
      getWsUrl: () => 'ws://localhost:18789/ws',
      getAuth: () => 'test-token',
      logger,
      WebSocketImpl: MockWebSocket
    });
    expect(client.getState()).toBe('disconnected');
  });

  it('connects and authenticates with gateway', async () => {
    const AutoAuthWS = createAutoAuthMockWS();
    client = createGatewayClient({
      getWsUrl: () => 'ws://localhost:18789/ws',
      getAuth: () => 'test-token',
      logger,
      WebSocketImpl: AutoAuthWS
    });

    await client.connect();
    expect(client.getState()).toBe('connected');
  });

  it('sends RPC calls with s-prefixed IDs', async () => {
    const AutoAuthWS = createAutoAuthMockWS();
    let wsInstance;
    class TrackingWS extends AutoAuthWS {
      constructor(url, opts) {
        super(url, opts);
        wsInstance = this;
      }
    }

    client = createGatewayClient({
      getWsUrl: () => 'ws://localhost:18789/ws',
      getAuth: () => 'token',
      logger,
      WebSocketImpl: TrackingWS
    });

    await client.connect();

    // Send RPC call, simulate response
    const promise = client.rpcCall('sessions.list', { limit: 50 });

    // Find the RPC request in sent messages
    await new Promise(r => setTimeout(r, 10));
    const rpcMsg = wsInstance.sent.find(m => m.method === 'sessions.list');
    expect(rpcMsg).toBeTruthy();
    expect(rpcMsg.id).toMatch(/^s\d+$/);
    expect(rpcMsg.type).toBe('req');

    // Simulate response
    wsInstance.emit('message', JSON.stringify({
      type: 'res', id: rpcMsg.id, ok: true, payload: { sessions: [] }
    }));

    const result = await promise;
    expect(result).toEqual({ sessions: [] });
  });

  it('rejects on RPC timeout', async () => {
    const AutoAuthWS = createAutoAuthMockWS();
    client = createGatewayClient({
      getWsUrl: () => 'ws://localhost:18789/ws',
      getAuth: () => 'token',
      logger,
      WebSocketImpl: AutoAuthWS
    });

    await client.connect();
    await expect(client.rpcCall('test.method', {}, 50)).rejects.toThrow('RPC timeout');
  });

  it('rejects rpcCall after close', async () => {
    client = createGatewayClient({
      getWsUrl: () => 'ws://localhost:18789/ws',
      getAuth: () => 'token',
      logger,
      WebSocketImpl: MockWebSocket
    });
    client.close();
    await expect(client.rpcCall('test', {})).rejects.toThrow('Client is closed');
  });

  it('lazy connects on first rpcCall', async () => {
    const AutoAuthWS = createAutoAuthMockWS();
    let wsInstance;
    class TrackingWS extends AutoAuthWS {
      constructor(url, opts) {
        super(url, opts);
        wsInstance = this;
      }
    }

    client = createGatewayClient({
      getWsUrl: () => 'ws://localhost:18789/ws',
      getAuth: () => 'token',
      logger,
      WebSocketImpl: TrackingWS
    });

    expect(client.getState()).toBe('disconnected');

    const promise = client.rpcCall('goals.list', {});

    // Wait for connection + auth
    await new Promise(r => setTimeout(r, 50));
    expect(client.getState()).toBe('connected');

    // Respond to the RPC
    const rpcMsg = wsInstance.sent.find(m => m.method === 'goals.list');
    wsInstance.emit('message', JSON.stringify({
      type: 'res', id: rpcMsg.id, ok: true, payload: { goals: [] }
    }));

    const result = await promise;
    expect(result).toEqual({ goals: [] });
  });

  it('sets Origin header from gateway URL', async () => {
    let capturedOpts;
    class CapturingWS extends MockWebSocket {
      constructor(url, opts) {
        super(url, opts);
        capturedOpts = opts;
        setTimeout(() => {
          this.emit('open');
          setTimeout(() => {
            this.emit('message', JSON.stringify({
              type: 'event', event: 'connect.challenge', payload: {}
            }));
          }, 5);
        }, 10);
        const origSend = this.send.bind(this);
        this.send = (data) => {
          origSend(data);
          const msg = typeof data === 'string' ? JSON.parse(data) : data;
          if (msg.method === 'connect') {
            setTimeout(() => {
              this.emit('message', JSON.stringify({
                type: 'res', id: msg.id, ok: true, payload: {}
              }));
            }, 5);
          }
        };
      }
    }

    client = createGatewayClient({
      getWsUrl: () => 'ws://127.0.0.1:18789/ws',
      getAuth: () => 'token',
      logger,
      WebSocketImpl: CapturingWS
    });

    await client.connect();
    expect(capturedOpts.headers.Origin).toBe('http://127.0.0.1:18789');
  });

  it('sets https Origin header for wss gateway URLs', async () => {
    let capturedOpts;
    class CapturingWS extends MockWebSocket {
      constructor(url, opts) {
        super(url, opts);
        capturedOpts = opts;
        setTimeout(() => {
          this.emit('open');
          setTimeout(() => {
            this.emit('message', JSON.stringify({
              type: 'event', event: 'connect.challenge', payload: {}
            }));
          }, 5);
        }, 10);
        const origSend = this.send.bind(this);
        this.send = (data) => {
          origSend(data);
          const msg = typeof data === 'string' ? JSON.parse(data) : data;
          if (msg.method === 'connect') {
            setTimeout(() => {
              this.emit('message', JSON.stringify({
                type: 'res', id: msg.id, ok: true, payload: {}
              }));
            }, 5);
          }
        };
      }
    }

    client = createGatewayClient({
      getWsUrl: () => 'wss://gateway.example.com/ws',
      getAuth: () => 'token',
      logger,
      WebSocketImpl: CapturingWS
    });

    await client.connect();
    expect(capturedOpts.headers.Origin).toBe('https://gateway.example.com:443');
  });

  it('prefers token auth over password when both are available', async () => {
    let wsInstance;
    class TrackingWS extends MockWebSocket {
      constructor(url, opts) {
        super(url, opts);
        wsInstance = this;
        this.on('open', () => {
          setTimeout(() => {
            this.emit('message', JSON.stringify({
              type: 'event', event: 'connect.challenge', payload: {}
            }));
          }, 0);
        });
        const origSend = this.send.bind(this);
        this.send = (data) => {
          origSend(data);
          const msg = typeof data === 'string' ? JSON.parse(data) : data;
          if (msg.method === 'connect') {
            setTimeout(() => {
              this.emit('message', JSON.stringify({
                type: 'res', id: msg.id, ok: true, payload: {}
              }));
            }, 5);
          }
        };
      }
    }

    client = createGatewayClient({
      getWsUrl: () => 'ws://localhost:18789/ws',
      getAuth: () => 'token-1',
      getPassword: () => 'pw-1',
      logger,
      WebSocketImpl: TrackingWS
    });

    await client.connect();
    const connectMsg = wsInstance.sent.find(m => m.method === 'connect');
    expect(connectMsg.params.auth.token).toBe('token-1');
    expect(connectMsg.params.auth.password).toBeUndefined();
  });

  it('uses password auth when token is not available', async () => {
    let wsInstance;
    class TrackingWS extends MockWebSocket {
      constructor(url, opts) {
        super(url, opts);
        wsInstance = this;
        this.on('open', () => {
          setTimeout(() => {
            this.emit('message', JSON.stringify({
              type: 'event', event: 'connect.challenge', payload: {}
            }));
          }, 0);
        });
        const origSend = this.send.bind(this);
        this.send = (data) => {
          origSend(data);
          const msg = typeof data === 'string' ? JSON.parse(data) : data;
          if (msg.method === 'connect') {
            setTimeout(() => {
              this.emit('message', JSON.stringify({
                type: 'res', id: msg.id, ok: true, payload: {}
              }));
            }, 5);
          }
        };
      }
    }

    client = createGatewayClient({
      getWsUrl: () => 'ws://localhost:18789/ws',
      getAuth: () => '',
      getPassword: () => 'pw-only',
      logger,
      WebSocketImpl: TrackingWS
    });

    await client.connect();
    const connectMsg = wsInstance.sent.find(m => m.method === 'connect');
    expect(connectMsg.params.auth.password).toBe('pw-only');
    expect(connectMsg.params.auth.token).toBeUndefined();
  });
});
