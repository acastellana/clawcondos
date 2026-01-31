'use client';

/**
 * React Hook for Gateway WebSocket Connection
 * Provides connection status, message sending, and event subscription
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { GatewayClient, getGateway, resetGateway } from '../lib/gateway';
import type {
  ConnectionStatus,
  GatewayOptions,
  SessionKey,
  Message,
  HistoryResponse,
  Session,
  ChatEvent,
  AgentEvent,
  GatewayEvents,
  EventHandler,
} from '../lib/types';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type UseGatewayOptions = GatewayOptions & {
  autoConnect?: boolean;
};

export type UseGatewayReturn = {
  // Connection state
  status: ConnectionStatus;
  isConnected: boolean;
  isConnecting: boolean;
  error: Error | null;
  
  // Connection methods
  connect: () => void;
  disconnect: () => void;
  
  // Chat methods
  sendMessage: (message: string, sessionKey?: SessionKey) => Promise<Message>;
  getHistory: (sessionKey?: SessionKey, limit?: number) => Promise<HistoryResponse>;
  abort: (sessionKey?: SessionKey) => Promise<void>;
  
  // Session methods
  listSessions: (limit?: number) => Promise<{ sessions: Session[] }>;
  
  // Event subscription
  subscribe: <K extends keyof GatewayEvents>(
    event: K,
    handler: EventHandler<GatewayEvents[K]>
  ) => () => void;
  
  // Direct gateway access
  gateway: GatewayClient | null;
};

// ═══════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════

export function useGateway(options: UseGatewayOptions = {}): UseGatewayReturn {
  const { autoConnect = true, ...gatewayOptions } = options;
  
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [error, setError] = useState<Error | null>(null);
  const gatewayRef = useRef<GatewayClient | null>(null);
  const subscriptionsRef = useRef<Array<() => void>>([]);
  
  // Initialize gateway
  useEffect(() => {
    const gateway = getGateway({
      ...gatewayOptions,
      onConnect: (payload) => {
        setStatus('connected');
        setError(null);
        gatewayOptions.onConnect?.(payload);
      },
      onDisconnect: () => {
        setStatus('disconnected');
        gatewayOptions.onDisconnect?.();
      },
      onError: (err) => {
        setError(err);
        setStatus('error');
        gatewayOptions.onError?.(err);
      },
    });
    
    gatewayRef.current = gateway;
    
    if (autoConnect) {
      setStatus('connecting');
      gateway.connect();
    }
    
    // Cleanup on unmount
    return () => {
      // Unsubscribe all event handlers
      for (const unsub of subscriptionsRef.current) {
        unsub();
      }
      subscriptionsRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  
  // Connect method
  const connect = useCallback(() => {
    const gateway = gatewayRef.current;
    if (gateway) {
      setStatus('connecting');
      setError(null);
      gateway.connect();
    }
  }, []);
  
  // Disconnect method
  const disconnect = useCallback(() => {
    const gateway = gatewayRef.current;
    if (gateway) {
      gateway.disconnect();
      setStatus('disconnected');
    }
  }, []);
  
  // Send message
  const sendMessage = useCallback(async (
    message: string,
    sessionKey?: SessionKey
  ): Promise<Message> => {
    const gateway = gatewayRef.current;
    if (!gateway) {
      throw new Error('Gateway not initialized');
    }
    return gateway.sendMessage(message, sessionKey);
  }, []);
  
  // Get history
  const getHistory = useCallback(async (
    sessionKey?: SessionKey,
    limit?: number
  ): Promise<HistoryResponse> => {
    const gateway = gatewayRef.current;
    if (!gateway) {
      throw new Error('Gateway not initialized');
    }
    return gateway.getHistory(sessionKey, limit);
  }, []);
  
  // Abort
  const abort = useCallback(async (sessionKey?: SessionKey): Promise<void> => {
    const gateway = gatewayRef.current;
    if (!gateway) {
      throw new Error('Gateway not initialized');
    }
    return gateway.abort(sessionKey);
  }, []);
  
  // List sessions
  const listSessions = useCallback(async (
    limit = 50
  ): Promise<{ sessions: Session[] }> => {
    const gateway = gatewayRef.current;
    if (!gateway) {
      throw new Error('Gateway not initialized');
    }
    return gateway.listSessions(limit);
  }, []);
  
  // Subscribe to events
  const subscribe = useCallback(<K extends keyof GatewayEvents>(
    event: K,
    handler: EventHandler<GatewayEvents[K]>
  ): (() => void) => {
    const gateway = gatewayRef.current;
    if (!gateway) {
      return () => {};
    }
    
    const unsub = gateway.on(event, handler);
    subscriptionsRef.current.push(unsub);
    
    return () => {
      unsub();
      const idx = subscriptionsRef.current.indexOf(unsub);
      if (idx >= 0) subscriptionsRef.current.splice(idx, 1);
    };
  }, []);
  
  return {
    status,
    isConnected: status === 'connected',
    isConnecting: status === 'connecting',
    error,
    connect,
    disconnect,
    sendMessage,
    getHistory,
    abort,
    listSessions,
    subscribe,
    gateway: gatewayRef.current,
  };
}

// ═══════════════════════════════════════════════════════════════
// SPECIALIZED HOOKS
// ═══════════════════════════════════════════════════════════════

/**
 * Hook for subscribing to chat events
 */
export function useChatEvents(
  handler: (event: ChatEvent) => void,
  deps: React.DependencyList = []
): void {
  const { subscribe, isConnected } = useGateway({ autoConnect: false });
  
  useEffect(() => {
    if (!isConnected) return;
    
    return subscribe('chat', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, subscribe, ...deps]);
}

/**
 * Hook for subscribing to agent events
 */
export function useAgentEvents(
  handler: (event: AgentEvent) => void,
  deps: React.DependencyList = []
): void {
  const { subscribe, isConnected } = useGateway({ autoConnect: false });
  
  useEffect(() => {
    if (!isConnected) return;
    
    return subscribe('agent', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, subscribe, ...deps]);
}

/**
 * Hook for connection status only
 */
export function useConnectionStatus(): {
  status: ConnectionStatus;
  isConnected: boolean;
} {
  const { status, isConnected } = useGateway({ autoConnect: false });
  return { status, isConnected };
}

/**
 * Hook for chat session messages with streaming support
 */
export function useChatSession(sessionKey: SessionKey): {
  messages: Message[];
  isLoading: boolean;
  isStreaming: boolean;
  streamingContent: string;
  sendMessage: (message: string) => Promise<void>;
  abort: () => Promise<void>;
  reload: () => Promise<void>;
} {
  const { sendMessage: gatewaySend, getHistory, abort: gatewayAbort, subscribe, isConnected } = useGateway();
  
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  
  // Load initial messages
  const reload = useCallback(async () => {
    if (!isConnected) return;
    
    setIsLoading(true);
    try {
      const history = await getHistory(sessionKey);
      setMessages(history.messages);
    } catch (err) {
      console.error('Failed to load history:', err);
    } finally {
      setIsLoading(false);
    }
  }, [isConnected, getHistory, sessionKey]);
  
  // Load on connect
  useEffect(() => {
    reload();
  }, [reload]);
  
  // Subscribe to chat events for this session
  useEffect(() => {
    if (!isConnected) return;
    
    return subscribe('chat', (event: ChatEvent) => {
      if (event.sessionKey !== sessionKey) return;
      
      switch (event.type) {
        case 'start':
          setIsStreaming(true);
          setStreamingContent('');
          break;
        case 'text':
          if (event.delta) {
            setStreamingContent((prev) => prev + event.delta);
          }
          break;
        case 'done':
          setIsStreaming(false);
          // Reload to get final message
          reload();
          break;
        case 'error':
        case 'abort':
          setIsStreaming(false);
          setStreamingContent('');
          break;
      }
    });
  }, [isConnected, subscribe, sessionKey, reload]);
  
  // Send message
  const sendMessage = useCallback(async (message: string) => {
    if (!isConnected) return;
    
    // Add user message optimistically
    const userMessage: Message = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
      sessionKey,
    };
    setMessages((prev) => [...prev, userMessage]);
    
    try {
      await gatewaySend(message, sessionKey);
    } catch (err) {
      console.error('Failed to send message:', err);
      // Remove optimistic message on error
      setMessages((prev) => prev.filter((m) => m.id !== userMessage.id));
      throw err;
    }
  }, [isConnected, gatewaySend, sessionKey]);
  
  // Abort
  const abort = useCallback(async () => {
    await gatewayAbort(sessionKey);
  }, [gatewayAbort, sessionKey]);
  
  return {
    messages,
    isLoading,
    isStreaming,
    streamingContent,
    sendMessage,
    abort,
    reload,
  };
}

export default useGateway;
