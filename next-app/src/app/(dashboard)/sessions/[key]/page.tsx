'use client';

/**
 * Session Chat Page
 *
 * Displays the chat interface for a specific session key.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChatWindow } from '@/components/chat';
import { useGateway } from '@/hooks/use-gateway';
import type { ChatEvent, Message, SessionKey } from '@/lib/types';

type SessionPageProps = {
  params: {
    key: string;
  };
};

function decodeSessionKey(encodedKey: string): SessionKey {
  try {
    return decodeURIComponent(encodedKey);
  } catch {
    return encodedKey;
  }
}

function createSystemMessage(content: string, sessionKey: SessionKey): Message {
  return {
    id: `system-${Date.now()}`,
    role: 'system',
    content,
    timestamp: new Date().toISOString(),
    sessionKey,
  };
}

function getStatusLabel(status: string): string {
  if (status === 'connected') return 'Connected';
  if (status === 'connecting') return 'Connecting';
  if (status === 'error') return 'Error';
  return 'Disconnected';
}

function getStatusColor(status: string): string {
  if (status === 'connected') return 'bg-[var(--green)]';
  if (status === 'connecting') return 'bg-[var(--yellow)]';
  if (status === 'error') return 'bg-[var(--red)]';
  return 'bg-[var(--text-dim)]';
}

export default function SessionChatPage({ params }: SessionPageProps): React.ReactElement {
  const sessionKey = useMemo(() => decodeSessionKey(params.key), [params.key]);
  const { status, isConnected, sendMessage, getHistory, subscribe, error } = useGateway();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadHistory = useCallback(async (): Promise<void> => {
    if (!isConnected) return;
    setIsLoading(true);
    setLoadError(null);

    try {
      const history = await getHistory(sessionKey, 200);
      setMessages(history.messages ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load history';
      setLoadError(message);
    } finally {
      setIsLoading(false);
    }
  }, [getHistory, isConnected, sessionKey]);

  useEffect(() => {
    if (!isConnected) return;
    loadHistory();
  }, [isConnected, loadHistory]);

  useEffect(() => {
    if (!isConnected) return;

    const unsub = subscribe('chat', (event: ChatEvent) => {
      if (event.sessionKey !== sessionKey) return;

      if (event.type === 'start' && event.messageId) {
        const startMsgId = event.messageId;
        setMessages((prev) => {
          if (prev.some((message) => message.id === startMsgId)) return prev;
          return [
            ...prev,
            {
              id: startMsgId,
              role: 'assistant' as const,
              content: event.content ?? '',
              timestamp: new Date().toISOString(),
              sessionKey,
            },
          ];
        });
        return;
      }

      if (event.type === 'text') {
        const delta = event.delta ?? event.content ?? '';
        if (!delta) return;

        const msgId = event.messageId ?? `stream-${Date.now()}`;
        setMessages((prev) => {
          const idx = event.messageId ? prev.findIndex((message) => message.id === event.messageId) : -1;
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], content: `${next[idx].content}${delta}` };
            return next;
          }

          return [
            ...prev,
            {
              id: msgId,
              role: 'assistant' as const,
              content: delta,
              timestamp: new Date().toISOString(),
              sessionKey,
            },
          ];
        });
        return;
      }

      if (event.type === 'error') {
        setMessages((prev) => [...prev, createSystemMessage(event.error ?? 'Agent error', sessionKey)]);
        return;
      }

      if (event.type === 'abort') {
        setMessages((prev) => [...prev, createSystemMessage('Generation aborted', sessionKey)]);
      }
    });

    return () => {
      unsub();
    };
  }, [isConnected, sessionKey, subscribe]);

  const handleSend = useCallback(
    async (content: string): Promise<void> => {
      const trimmed = content.trim();
      if (!trimmed) return;

      const tempId = `local-${Date.now()}`;
      const optimisticMessage: Message = {
        id: tempId,
        role: 'user',
        content: trimmed,
        timestamp: new Date().toISOString(),
        sessionKey,
      };

      setMessages((prev) => [...prev, optimisticMessage]);
      setIsSending(true);

      try {
        const sent = await sendMessage(trimmed, sessionKey);
        setMessages((prev) => [...prev.filter((message) => message.id !== tempId), sent]);
      } catch (err) {
        setMessages((prev) => [
          ...prev.filter((message) => message.id !== tempId),
          createSystemMessage('Failed to send message', sessionKey),
        ]);
      } finally {
        setIsSending(false);
      }
    },
    [sendMessage, sessionKey]
  );

  return (
    <main className="flex flex-col h-full">
      <header className="h-[60px] bg-[var(--bg-panel)] border-b border-[var(--border-subtle)] flex items-center px-6 gap-4 shrink-0">
        <Link
          href="/sessions"
          className="text-sm text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors"
        >
          ← Back
        </Link>
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold text-[var(--text)]">Session Chat</h1>
          <span className="text-xs text-[var(--text-dim)] font-mono">{sessionKey}</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <span className={`w-2 h-2 rounded-full ${getStatusColor(status)} ${status === 'connecting' ? 'animate-pulse' : ''}`} />
          {getStatusLabel(status)}
        </div>
      </header>

      <div className="flex-1 p-6 overflow-hidden">
        {loadError ? (
          <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-[var(--radius-lg)] p-6 text-sm text-[var(--text-secondary)]">
            <div className="text-[var(--red)] font-medium mb-2">Failed to load session history</div>
            <div className="mb-4">{loadError}</div>
            <button
              type="button"
              onClick={loadHistory}
              className="text-sm text-[var(--accent)] hover:text-[var(--accent-hover)]"
            >
              Retry
            </button>
          </div>
        ) : (
          <ChatWindow
            messages={messages}
            onSend={handleSend}
            disabled={!isConnected}
            isSending={isSending}
            isLoading={isLoading}
          />
        )}
      </div>

      {status === 'error' && error && (
        <div className="px-6 pb-4 text-xs text-[var(--red)]">Gateway error: {error.message}</div>
      )}
    </main>
  );
}
