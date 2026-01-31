'use client';

/**
 * SessionCard Component
 * Displays an individual agent session with status, channel, and last message preview
 */

import type { Session, SessionKey } from '@/lib/types';

type SessionCardProps = {
  session: Session;
  isActive?: boolean;
  onClick?: (sessionKey: SessionKey) => void;
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

export function SessionCard({ session, isActive = false, onClick }: SessionCardProps): React.ReactElement {
  const { agent, channel, details } = parseSessionKey(session.key);
  const lastMessage = session.messages?.[0];
  
  const handleClick = (): void => {
    console.log('Session selected:', session.key);
    onClick?.(session.key);
  };
  
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
      className={`
        group p-4 border-b border-[var(--border-subtle)] cursor-pointer
        transition-all duration-[var(--transition-fast)]
        hover:bg-[var(--bg-hover)]
        ${isActive ? 'bg-[var(--bg-active)] border-l-2 border-l-[var(--accent)]' : ''}
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
        <span className="font-medium text-[var(--text)]">{agent}</span>
        
        {/* Channel badge */}
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getChannelColor(channel)}`}>
          {channel}
        </span>
        
        {/* Timestamp */}
        <span className="ml-auto text-xs text-[var(--text-muted)]">
          {formatRelativeTime(session.lastMessageAt)}
        </span>
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
        <span className="text-xs text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity">
          Click to open →
        </span>
      </div>
    </div>
  );
}

export default SessionCard;
