/**
 * Gateway WebSocket Client for Sharp
 * Type-safe client for Clawdbot gateway WebSocket protocol
 */

import type {
  ConnectionStatus,
  ConnectParams,
  HelloOkPayload,
  RpcRequest,
  RpcResponse,
  RpcEvent,
  WsMessage,
  GatewayOptions,
  EventHandler,
  GatewayEvents,
  SessionKey,
  Session,
  Message,
  HistoryResponse,
  ChatEvent,
  AgentEvent,
} from './types';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

const WS_PROTOCOL_VERSION = 3;
const DEFAULT_TIMEOUT_MS = 120000;
const KEEPALIVE_INTERVAL_MS = 25000;
const STALE_TIMEOUT_MS = 65000;
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
const MAX_RECONNECT_ATTEMPTS = 10;

// ═══════════════════════════════════════════════════════════════
// PENDING REQUEST TYPE
// ═══════════════════════════════════════════════════════════════

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

// ═══════════════════════════════════════════════════════════════
// GATEWAY CLIENT CLASS
// ═══════════════════════════════════════════════════════════════

export class GatewayClient {
  private url: string;
  private auth: { password?: string; token?: string } | null;
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private reqId = 0;
  private pending = new Map<string, PendingRequest>();
  private eventHandlers = new Map<string, EventHandler[]>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageAt = 0;
  private connectNonce: string | null = null;
  private connectSent = false;
  private shouldReconnect: boolean;
  private maxReconnectAttempts: number;
  
  public readonly defaultSessionKey: SessionKey;
  
  // Callbacks
  private onConnectCallback?: (payload: HelloOkPayload) => void;
  private onDisconnectCallback?: () => void;
  private onErrorCallback?: (error: Error) => void;
  
  constructor(options: GatewayOptions = {}) {
    // Build URL from options or smart defaults
    const isSecure = typeof location !== 'undefined' && location.protocol === 'https:';
    const hostname = typeof location !== 'undefined' ? location.hostname : 'localhost';
    const defaultUrl = `${isSecure ? 'wss' : 'ws'}://${hostname}/ws`;
    
    this.url = options.url || defaultUrl;
    this.auth = options.auth || null;
    this.defaultSessionKey = options.defaultSessionKey || 'agent:main:main';
    this.shouldReconnect = options.reconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;
    
    this.onConnectCallback = options.onConnect;
    this.onDisconnectCallback = options.onDisconnect;
    this.onErrorCallback = options.onError;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // PUBLIC GETTERS
  // ═══════════════════════════════════════════════════════════════
  
  get connectionStatus(): ConnectionStatus {
    return this.status;
  }
  
  get isConnected(): boolean {
    return this.status === 'connected';
  }
  
  // ═══════════════════════════════════════════════════════════════
  // CONNECTION MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  
  connect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.connectNonce = null;
    this.connectSent = false;
    this.setStatus('connecting');
    
    // Build WebSocket URL
    let wsUrl = this.url;
    if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
      wsUrl = wsUrl.replace(/^http/, 'ws');
    }
    
    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this.handleError(err instanceof Error ? err : new Error(String(err)));
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }
    
    this.ws.onopen = (): void => {
      this.lastMessageAt = Date.now();
    };
    
    this.ws.onmessage = (event: MessageEvent): void => {
      this.lastMessageAt = Date.now();
      this.resetStaleTimer();
      
      try {
        const msg = JSON.parse(event.data as string) as WsMessage;
        this.handleMessage(msg);
      } catch (err) {
        this.handleError(new Error('Failed to parse message'));
      }
    };
    
    this.ws.onerror = (): void => {
      this.handleError(new Error('WebSocket error'));
    };
    
    this.ws.onclose = (): void => {
      this.cleanup();
      this.setStatus('disconnected');
      this.onDisconnectCallback?.();
      this.scheduleReconnect();
    };
  }
  
  disconnect(): void {
    this.shouldReconnect = false;
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
  }
  
  // ═══════════════════════════════════════════════════════════════
  // RPC METHODS
  // ═══════════════════════════════════════════════════════════════
  
  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected || !this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      
      const id = this.nextId();
      
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);
      
      this.pending.set(id, { 
        resolve: resolve as (value: unknown) => void, 
        reject, 
        timeout 
      });
      
      const request: RpcRequest = {
        type: 'req',
        id,
        method,
        params,
      };
      
      this.send(request);
    });
  }
  
  // ═══════════════════════════════════════════════════════════════
  // EVENT HANDLING
  // ═══════════════════════════════════════════════════════════════
  
  on<K extends keyof GatewayEvents>(
    event: K,
    handler: EventHandler<GatewayEvents[K]>
  ): () => void {
    const eventKey = event as string;
    if (!this.eventHandlers.has(eventKey)) {
      this.eventHandlers.set(eventKey, []);
    }
    this.eventHandlers.get(eventKey)!.push(handler as EventHandler);
    
    // Return unsubscribe function
    return () => this.off(event, handler);
  }
  
  off<K extends keyof GatewayEvents>(
    event: K,
    handler: EventHandler<GatewayEvents[K]>
  ): void {
    const eventKey = event as string;
    const handlers = this.eventHandlers.get(eventKey);
    if (handlers) {
      const idx = handlers.indexOf(handler as EventHandler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // HIGH-LEVEL CHAT METHODS
  // ═══════════════════════════════════════════════════════════════
  
  async getHistory(
    sessionKey?: SessionKey,
    limit = 50
  ): Promise<HistoryResponse> {
    return this.request<HistoryResponse>('chat.history', {
      sessionKey: sessionKey || this.defaultSessionKey,
      limit,
    });
  }
  
  async sendChatMessage(message: string, sessionKey?: SessionKey): Promise<Message> {
    return this.request<Message>('chat.send', {
      sessionKey: sessionKey || this.defaultSessionKey,
      message,
    });
  }
  
  async sendMessage(message: string, sessionKey?: SessionKey): Promise<Message> {
    return this.sendChatMessage(message, sessionKey);
  }
  
  async abort(sessionKey?: SessionKey): Promise<void> {
    await this.request('chat.abort', {
      sessionKey: sessionKey || this.defaultSessionKey,
    });
  }
  
  async inject(content: string, sessionKey?: SessionKey): Promise<void> {
    await this.request('chat.inject', {
      sessionKey: sessionKey || this.defaultSessionKey,
      content,
    });
  }
  
  // ═══════════════════════════════════════════════════════════════
  // SESSION METHODS
  // ═══════════════════════════════════════════════════════════════
  
  async listSessions(limit = 50, messageLimit = 1): Promise<{ sessions: Session[] }> {
    return this.request('sessions.list', { limit, messageLimit });
  }
  
  async getActiveRuns(): Promise<{ runs: Array<{ sessionKey: SessionKey; runId: string }> }> {
    return this.request('chat.activeRuns', {});
  }
  
  // ═══════════════════════════════════════════════════════════════
  // HEALTH & STATUS
  // ═══════════════════════════════════════════════════════════════
  
  async health(): Promise<{ status: string }> {
    return this.request('health', {});
  }
  
  async getStatus(): Promise<unknown> {
    return this.request('status', {});
  }
  
  // ═══════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════
  
  private setStatus(status: ConnectionStatus): void {
    this.status = status;
  }
  
  private nextId(): string {
    return `r${++this.reqId}`;
  }
  
  private send(msg: WsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
  
  private handleMessage(msg: WsMessage): void {
    // Handle challenge event
    if (msg.type === 'event' && (msg as RpcEvent).event === 'connect.challenge') {
      this.connectNonce = ((msg as RpcEvent).payload as { nonce: string })?.nonce;
      this.sendConnectRequest();
      return;
    }
    
    // Handle RPC response
    if (msg.type === 'res') {
      const res = msg as RpcResponse;
      
      // Handle hello-ok (connection established)
      if ((res.payload as HelloOkPayload)?.type === 'hello-ok') {
        this.setStatus('connected');
        this.reconnectAttempts = 0;
        this.startKeepalive();
        this.onConnectCallback?.(res.payload as HelloOkPayload);
        return;
      }
      
      // Handle regular responses
      const pending = this.pending.get(res.id);
      if (pending) {
        this.pending.delete(res.id);
        clearTimeout(pending.timeout);
        
        if (res.ok) {
          pending.resolve(res.payload ?? res.result);
        } else {
          pending.reject(new Error(res.error?.message || 'Request failed'));
        }
      }
      return;
    }
    
    // Handle events
    if (msg.type === 'event') {
      const event = msg as RpcEvent;
      const handlers = this.eventHandlers.get(event.event) || [];
      for (const handler of handlers) {
        try {
          handler(event.payload, event);
        } catch (err) {
          this.handleError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }
  
  private sendConnectRequest(): void {
    if (this.connectSent || !this.ws) return;
    this.connectSent = true;
    
    const params: ConnectParams = {
      minProtocol: WS_PROTOCOL_VERSION,
      maxProtocol: WS_PROTOCOL_VERSION,
      client: {
        id: 'sharp-dashboard',
        displayName: 'Sharp Dashboard',
        version: '2.0.0',
        platform: typeof navigator !== 'undefined' ? navigator.platform : 'web',
        mode: 'ui',
      },
    };
    
    if (this.auth?.password) {
      params.auth = { password: this.auth.password };
    } else if (this.auth?.token) {
      params.auth = { token: this.auth.token };
    }
    
    const request: RpcRequest = {
      type: 'req',
      id: this.nextId(),
      method: 'connect',
      params: params as unknown as Record<string, unknown>,
    };
    
    // Set up timeout for connect request
    const timeout = setTimeout(() => {
      this.handleError(new Error('Connect timeout'));
      this.ws?.close(1008, 'connect timeout');
    }, 10000);
    
    this.pending.set(request.id, {
      resolve: () => {
        clearTimeout(timeout);
      },
      reject: (err) => {
        clearTimeout(timeout);
        this.handleError(err);
      },
      timeout,
    });
    
    this.send(request);
  }
  
  private cleanup(): void {
    // Clear timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
    
    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('WebSocket closed'));
    }
    this.pending.clear();
    
    this.connectNonce = null;
    this.connectSent = false;
  }
  
  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.handleError(new Error(`Max reconnect attempts (${this.maxReconnectAttempts}) reached`));
      this.setStatus('error');
      return;
    }
    
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempts++;
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
  
  private startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    
    this.keepaliveTimer = setInterval(() => {
      if (this.isConnected && this.ws) {
        this.send({
          type: 'req',
          id: 'keepalive',
          method: 'status',
          params: {},
        });
      }
    }, KEEPALIVE_INTERVAL_MS);
  }
  
  private resetStaleTimer(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    
    this.staleTimer = setTimeout(() => {
      const sinceLastMessage = Date.now() - this.lastMessageAt;
      if (sinceLastMessage > 60000) {
        this.ws?.close(1000, 'stale');
      }
    }, STALE_TIMEOUT_MS);
  }
  
  private handleError(error: Error): void {
    this.onErrorCallback?.(error);
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

let gatewayInstance: GatewayClient | null = null;

export function getGateway(options?: GatewayOptions): GatewayClient {
  if (!gatewayInstance) {
    gatewayInstance = new GatewayClient(options);
  }
  return gatewayInstance;
}

export function resetGateway(): void {
  if (gatewayInstance) {
    gatewayInstance.disconnect();
    gatewayInstance = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// EVENT EMITTER HELPER
// ═══════════════════════════════════════════════════════════════

export function createGatewayEventEmitter(): {
  subscribe: <K extends keyof GatewayEvents>(
    event: K,
    handler: EventHandler<GatewayEvents[K]>
  ) => () => void;
  emit: <K extends keyof GatewayEvents>(event: K, payload: GatewayEvents[K]) => void;
} {
  const handlers = new Map<string, EventHandler[]>();
  
  return {
    subscribe: <K extends keyof GatewayEvents>(
      event: K,
      handler: EventHandler<GatewayEvents[K]>
    ): (() => void) => {
      const key = event as string;
      if (!handlers.has(key)) {
        handlers.set(key, []);
      }
      handlers.get(key)!.push(handler as EventHandler);
      
      return () => {
        const list = handlers.get(key);
        if (list) {
          const idx = list.indexOf(handler as EventHandler);
          if (idx >= 0) list.splice(idx, 1);
        }
      };
    },
    emit: <K extends keyof GatewayEvents>(event: K, payload: GatewayEvents[K]): void => {
      const list = handlers.get(event as string) || [];
      for (const handler of list) {
        handler(payload, { type: 'event', event: event as string, payload });
      }
    },
  };
}

export default GatewayClient;
