'use client';

/**
 * Agent Sessions Page
 * 
 * Lists and manages Clawdbot agent sessions with real-time updates:
 * - View active/idle sessions
 * - See last message preview
 * - Click to select session
 */

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { SessionList } from '@/components/sessions';
import { useGateway } from '@/hooks/use-gateway';
import type { SessionKey } from '@/lib/types';

export default function SessionsPage(): React.ReactElement {
  const { isConnected } = useGateway();
  const router = useRouter();

  const handleSessionSelect = useCallback((sessionKey: SessionKey) => {
    const encoded = encodeURIComponent(sessionKey);
    router.push(`/sessions/${encoded}`);
  }, [router]);

  return (
    <main className="flex flex-col h-full">
      {/* Page Header */}
      <header className="h-[60px] bg-[var(--bg-panel)] border-b border-[var(--border-subtle)] flex items-center px-6 gap-4 shrink-0">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">Sessions</h1>
        <span className="text-sm text-[var(--text-dim)]">Agent Management</span>
        
        <div className="flex-1" />
        
        <button 
          className="
            bg-[var(--accent)] hover:bg-[var(--accent-hover)] 
            text-white px-4 py-2 rounded-[var(--radius-md)] 
            text-sm font-medium transition-all 
            hover:shadow-[var(--shadow-glow)]
            disabled:opacity-50 disabled:cursor-not-allowed
          "
          disabled={!isConnected}
        >
          New Session
        </button>
      </header>

      {/* Content */}
      <div className="flex-1 p-6 overflow-hidden">
        <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-[var(--radius-lg)] overflow-hidden h-full flex flex-col">
          {/* Search/filter bar */}
          <div className="px-4 py-3 border-b border-[var(--border-subtle)] flex items-center gap-3">
            <input
              type="search"
              placeholder="Search sessions..."
              className="
                flex-1 bg-[var(--bg-input)] border border-[var(--border-subtle)]
                rounded-[var(--radius-sm)] px-3 py-2 text-sm
                text-[var(--text)] placeholder:text-[var(--text-muted)]
                focus:outline-none focus:border-[var(--accent)]
                transition-colors
              "
            />
            <select 
              className="
                bg-[var(--bg-input)] border border-[var(--border-subtle)]
                rounded-[var(--radius-sm)] px-3 py-2 text-sm
                text-[var(--text-secondary)]
                focus:outline-none focus:border-[var(--accent)]
                transition-colors cursor-pointer
              "
              defaultValue="all"
            >
              <option value="all">All Channels</option>
              <option value="telegram">Telegram</option>
              <option value="discord">Discord</option>
              <option value="webchat">Webchat</option>
            </select>
          </div>

          {/* Sessions list */}
          <div className="flex-1 overflow-y-auto">
            <SessionList onSessionSelect={handleSessionSelect} />
          </div>
        </div>
      </div>
    </main>
  );
}
