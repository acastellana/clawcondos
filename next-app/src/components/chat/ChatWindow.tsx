'use client';

import { useEffect, useRef } from 'react';
import type { Message } from '@/lib/types';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';

type ChatWindowProps = {
  messages: Message[];
  onSend: (message: string) => void;
  disabled?: boolean;
  isSending?: boolean;
  isLoading?: boolean;
};

export function ChatWindow({
  messages,
  onSend,
  disabled = false,
  isSending = false,
  isLoading = false,
}: ChatWindowProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  return (
    <div className="flex flex-col h-full bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-[var(--radius-lg)] overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-[var(--text-dim)]">
            <div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            Loading history...
          </div>
        ) : messages.length === 0 ? (
          <div className="text-sm text-[var(--text-dim)]">No messages yet. Start the conversation.</div>
        ) : (
          messages.map((message) => <ChatMessage key={message.id} message={message} />)
        )}
      </div>
      <ChatInput onSend={onSend} disabled={disabled} isSending={isSending} />
    </div>
  );
}

export default ChatWindow;
