'use client';

/**
 * SessionCard Component
 * Displays an individual agent session with status, channel, and last message preview
 */

import type { Session, SessionKey } from '@/lib/types';

type SessionCardProps = {
  session: Session;
  isActive?: boolean;
  isChild?: boolean;
  isSelectable?: boolean;
  onClick?: (sessionKey: SessionKey) => void;
  onAbort?: (sessionKey: SessionKey) => void | Promise<void>;
};

/**
 * Parse session key to extract agent and channel info
 * Format: "agent:main:channel:provider:details..."
 */
function parseSessionKey(key: SessionKey): { agent: string; channel: string; details: string } {
  const parts = key.split(':');
  return {
    agent: parts[1] || 'unknown',
    channel: parts[2] || 'unknown',
    details: parts.slice(3).join(':') || '',
  };
}

/**
 * Get channel badge color based on channel type
 */
function getChannelColor(channel: string): string {
  const colors: Record<string, string> = {
    telegram: 'bg-[#2AABEE]/20 text-[#2AABEE]',
    discord: 'bg-[#5865F2]/20 text-[#5865F2]',
    webchat: 'bg-[var(--accent-muted)] text-[var(--accent)]',
    main: 'bg-[var(--purple-dim)] text-[var(--purple)]',
    subagent: 'bg-[var(--yellow-dim)] text-[var(--yellow)]',
  };
  return colors[channel.toLowerCase()] || 'bg-[var(--bg-hover)] text-[var(--text-secondary)]';
}

/**
 * Format timestamp to relative time
 */
function formatRelativeTime(timestamp: string | undefined): string {
  if (!timestamp) return 'Never';
  
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Truncate text with ellipsis
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim() + '…';
}

export function SessionCard({
  session,
  isActive = false,
  isChild = false,
  isSelectable = true,
  onClick,
  onAbort,
}: SessionCardProps): React.ReactElement {
  const { agent, channel, details } = parseSessionKey(session.key);
  const displayAgent = session.label ?? agent;
  const lastMessage = session.messages?.[0];
  const isInteractive = Boolean(onClick) && isSelectable;
  
  const handleClick = (): void => {
    if (!isInteractive) return;
    console.log('Session selected:', session.key);
    onClick?.(session.key);
  };

  const handleAbort = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    onAbort?.(session.key);
  };
  
  return (
    <div
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : -1}
      onClick={isInteractive ? handleClick : undefined}
      onKeyDown={isInteractive ? (e) => e.key === 'Enter' && handleClick() : undefined}
      className={`
        group p-4 border-b border-[var(--border-subtle)]
        transition-all duration-[var(--transition-fast)]
        ${isInteractive ? 'cursor-pointer hover:bg-[var(--bg-hover)]' : 'cursor-default'}
        ${isActive ? 'bg-[var(--bg-active)] border-l-2 border-l-[var(--accent)]' : ''}
        ${isChild ? 'py-3 bg-[var(--bg-elevated)]/50' : ''}
      `}
    >
      {/* Header: Agent + Channel + Time */}
      <div className="flex items-center gap-2 mb-2">
        {/* Status indicator */}
        <div 
          className={`
            w-2 h-2 rounded-full shrink-0
            ${isActive ? 'bg-[var(--green)] animate-pulse' : 'bg-[var(--text-muted)]'}
          `} 
          title={isActive ? 'Active' : 'Idle'}
        />
        
        {/* Agent name */}
        <span className="font-medium text-[var(--text)]">{displayAgent}</span>
        
        {/* Channel badge */}
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getChannelColor(channel)}`}>
          {channel}
        </span>
        
        <div className="ml-auto flex items-center gap-2">
          {isActive && onAbort && (
            <button
              type="button"
              onClick={handleAbort}
              onMouseDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              className="
                text-xs font-medium px-2 py-1 rounded-[var(--radius-sm)]
                border border-[var(--red)]/30 text-[var(--red)]
                bg-[var(--red-dim)]
                transition-all duration-[var(--transition-fast)]
                hover:bg-[var(--bg-hover)] hover:border-[var(--red)]/60 hover:text-[var(--red)]
                active:scale-[0.98]
              "
              title="Stop active run"
            >
              <span className="mr-1">⏹️</span>
              Stop
            </button>
          )}
          {/* Timestamp */}
          <span className="text-xs text-[var(--text-muted)]">
            {formatRelativeTime(session.lastMessageAt)}
          </span>
        </div>
      </div>
      
      {/* Session key (truncated details) */}
      {details && (
        <div className="text-xs text-[var(--text-dim)] font-mono mb-2 truncate">
          {truncate(details, 50)}
        </div>
      )}
      
      {/* Last message preview */}
      {lastMessage && (
        <div className="text-sm text-[var(--text-secondary)] line-clamp-2">
          <span className={`
            inline-block mr-1 text-xs font-medium
            ${lastMessage.role === 'user' ? 'text-[var(--accent)]' : 'text-[var(--purple)]'}
          `}>
            {lastMessage.role === 'user' ? 'User:' : 'Agent:'}
          </span>
          {truncate(lastMessage.content, 150)}
        </div>
      )}
      
      {/* Message count */}
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-[var(--text-muted)]">
          {session.messageCount} message{session.messageCount !== 1 ? 's' : ''}
        </span>
        
        {/* Hover action hint */}
        {isInteractive && (
          <span className="text-xs text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity">
            Click to open →
          </span>
        )}
      </div>
    </div>
  );
}

export default SessionCard;
