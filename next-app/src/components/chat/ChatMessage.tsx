'use client';

import type { Message, MessageRole } from '@/lib/types';

type ChatMessageProps = {
  message: Message;
};

type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language?: string };

const ROLE_LABELS: Record<MessageRole, string> = {
  user: 'User',
  assistant: 'Agent',
  system: 'System',
  tool: 'Tool',
};

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function splitContent(content: string): ContentBlock[] {
  const parts = content.split(/```/g);
  const blocks: ContentBlock[] = [];
  
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (index % 2 === 1) {
      const lines = part.split(/\r?\n/);
      const firstLine = lines[0]?.trim();
      const hasLanguage = firstLine && !firstLine.includes(' ');
      const language = hasLanguage ? firstLine : undefined;
      const code = hasLanguage ? lines.slice(1).join('\n') : lines.join('\n');
      blocks.push({ type: 'code', content: code, language });
    } else if (part.trim()) {
      blocks.push({ type: 'text', content: part });
    }
  }
  
  return blocks;
}

function renderBlock(block: ContentBlock, index: number): React.ReactNode {
  if (block.type === 'code') {
    return (
      <pre
        key={`code-${index}`}
        className="bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] p-3 overflow-x-auto text-xs font-mono text-[var(--text-secondary)]"
      >
        {block.language ? (
          <div className="text-[10px] uppercase tracking-wide text-[var(--text-dim)] mb-2">
            {block.language}
          </div>
        ) : null}
        <code className="whitespace-pre">{block.content}</code>
      </pre>
    );
  }

  return (
    <div key={`text-${index}`} className="whitespace-pre-wrap text-[var(--text)]">
      {block.content}
    </div>
  );
}

export function ChatMessage({ message }: ChatMessageProps): React.ReactElement {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system' || message.role === 'tool';
  const blocks = splitContent(message.content);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={
          `max-w-[720px] px-4 py-3 rounded-[var(--radius-lg)] border ` +
          (isUser
            ? 'bg-[var(--accent-muted)] border-[var(--accent)] text-[var(--text)]'
            : isSystem
              ? 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-[var(--text-secondary)]'
              : 'bg-[var(--bg-card)] border-[var(--border-subtle)] text-[var(--text)]')
        }
      >
        <div className="flex items-center gap-2 mb-2 text-xs text-[var(--text-dim)]">
          <span className={isUser ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}>
            {ROLE_LABELS[message.role]}
          </span>
          {message.timestamp && <span>{formatTime(message.timestamp)}</span>}
        </div>
        <div className="space-y-3">
          {blocks.length > 0 ? blocks.map(renderBlock) : <div className="text-[var(--text-dim)]">(empty)</div>}
        </div>
      </div>
    </div>
  );
}

export default ChatMessage;
