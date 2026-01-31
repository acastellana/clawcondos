'use client';

import { useState } from 'react';

type ChatInputProps = {
  onSend: (message: string) => void;
  disabled?: boolean;
  isSending?: boolean;
};

export function ChatInput({ onSend, disabled = false, isSending = false }: ChatInputProps): React.ReactElement {
  const [value, setValue] = useState('');

  const handleSend = (): void => {
    const trimmed = value.trim();
    if (!trimmed || disabled || isSending) return;
    onSend(trimmed);
    setValue('');
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] px-4 py-3">
      <div className="flex items-end gap-3">
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={disabled ? 'Connecting to gateway...' : 'Message the agent...'}
          className="flex-1 resize-none bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)] transition-colors"
          disabled={disabled || isSending}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || isSending || value.trim().length === 0}
          className="px-4 py-2 rounded-[var(--radius-md)] text-sm font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSending ? 'Sending...' : 'Send'}
        </button>
      </div>
      <div className="mt-2 text-xs text-[var(--text-dim)]">
        Press Enter to send, Shift+Enter for a new line
      </div>
    </div>
  );
}

export default ChatInput;
