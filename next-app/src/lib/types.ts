/**
 * Sharp Gateway Types
 * Type definitions for Clawdbot gateway WebSocket protocol
 */

// ═══════════════════════════════════════════════════════════════
// CONNECTION TYPES
// ═══════════════════════════════════════════════════════════════

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type ClientInfo = {
  id: string;
  displayName: string;
  version: string;
  platform: string;
  mode: 'ui' | 'cli' | 'api';
};

export type ConnectParams = {
  minProtocol: number;
  maxProtocol: number;
  client: ClientInfo;
  auth?: {
    password?: string;
    token?: string;
  };
};

export type HelloOkPayload = {
  type: 'hello-ok';
  protocol: number;
  server: {
    version: string;
    name: string;
  };
};

// ═══════════════════════════════════════════════════════════════
// RPC TYPES
// ═══════════════════════════════════════════════════════════════

export type RpcRequest = {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
};

export type RpcResponse = {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message: string;
  };
};

export type RpcEvent = {
  type: 'event';
  event: string;
  payload?: unknown;
};

export type WsMessage = RpcRequest | RpcResponse | RpcEvent;

// ═══════════════════════════════════════════════════════════════
// SESSION TYPES
// ═══════════════════════════════════════════════════════════════

export type SessionKey = string; // Format: "agent:main:channel:..."

export type Session = {
  key: SessionKey;
  channel: string;
  label?: string;
  createdAt: string;
  lastMessageAt?: string;
  messageCount: number;
  messages?: Message[];
};

export type SessionStatus = 'idle' | 'running' | 'offline';

export type SessionListResponse = {
  sessions: Session[];
};

// ═══════════════════════════════════════════════════════════════
// MESSAGE TYPES
// ═══════════════════════════════════════════════════════════════

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export type Message = {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  sessionKey?: SessionKey;
  metadata?: MessageMetadata;
};

export type MessageMetadata = {
  model?: string;
  tokens?: {
    input: number;
    output: number;
  };
  duration?: number;
  toolCalls?: ToolCall[];
};

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
};

// ═══════════════════════════════════════════════════════════════
// CHAT EVENT TYPES
// ═══════════════════════════════════════════════════════════════

export type ChatEventType = 
  | 'start'
  | 'text'
  | 'tool_start'
  | 'tool_end'
  | 'done'
  | 'error'
  | 'abort';

export type ChatEvent = {
  type: ChatEventType;
  sessionKey: SessionKey;
  messageId?: string;
  content?: string;
  delta?: string;
  tool?: {
    id: string;
    name: string;
    input?: Record<string, unknown>;
    output?: unknown;
  };
  error?: string;
};

export type AgentEventType = 'start' | 'stop' | 'error';

export type AgentEvent = {
  type: AgentEventType;
  sessionKey: SessionKey;
  runId?: string;
  error?: string;
};

// ═══════════════════════════════════════════════════════════════
// HISTORY TYPES
// ═══════════════════════════════════════════════════════════════

export type HistoryParams = {
  sessionKey: SessionKey;
  limit?: number;
  before?: string;
};

export type HistoryResponse = {
  messages: Message[];
  hasMore: boolean;
};

// ═══════════════════════════════════════════════════════════════
// GATEWAY CLIENT OPTIONS
// ═══════════════════════════════════════════════════════════════

export type GatewayOptions = {
  url?: string;
  auth?: {
    password?: string;
    token?: string;
  };
  defaultSessionKey?: SessionKey;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  onConnect?: (payload: HelloOkPayload) => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
};

// ═══════════════════════════════════════════════════════════════
// EVENT HANDLER TYPES
// ═══════════════════════════════════════════════════════════════

export type EventHandler<T = unknown> = (payload: T, message: RpcEvent) => void;

export type GatewayEvents = {
  'chat': ChatEvent;
  'agent': AgentEvent;
  'connect.challenge': { nonce: string };
  [key: string]: unknown;
};
