'use client';

/**
 * Dashboard Home Page
 * 
 * Overview of the Clawdbot ecosystem:
 * - Connection status
 * - Active sessions summary
 * - Quick actions
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useGateway } from '@/hooks/use-gateway';
import type { Session } from '@/lib/types';

type StatCardProps = {
  label: string;
  value: string | number;
  icon: string;
  trend?: string;
  color?: 'default' | 'green' | 'yellow' | 'red' | 'purple';
};

function StatCard({ label, value, icon, trend, color = 'default' }: StatCardProps): React.ReactElement {
  const colorClasses = {
    default: 'border-[var(--border-subtle)]',
    green: 'border-[var(--green)]/30 bg-[var(--green-dim)]',
    yellow: 'border-[var(--yellow)]/30 bg-[var(--yellow-dim)]',
    red: 'border-[var(--red)]/30 bg-[var(--red-dim)]',
    purple: 'border-[var(--purple)]/30 bg-[var(--purple-dim)]',
  };

  return (
    <div className={`bg-[var(--bg-card)] border rounded-[var(--radius-lg)] p-5 ${colorClasses[color]}`}>
      <div className="flex items-start justify-between mb-3">
        <span className="text-2xl">{icon}</span>
        {trend && (
          <span className="text-xs text-[var(--text-dim)]">{trend}</span>
        )}
      </div>
      <div className="text-3xl font-semibold text-[var(--text)] mb-1">{value}</div>
      <div className="text-sm text-[var(--text-secondary)]">{label}</div>
    </div>
  );
}

type QuickActionProps = {
  href: string;
  icon: string;
  label: string;
  description: string;
};

function QuickAction({ href, icon, label, description }: QuickActionProps): React.ReactElement {
  return (
    <Link
      href={href}
      className="flex items-center gap-4 p-4 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-[var(--radius-lg)] hover:border-[var(--border-hover)] hover:bg-[var(--bg-hover)] transition-all group"
    >
      <span className="text-2xl group-hover:scale-110 transition-transform">{icon}</span>
      <div className="flex-1">
        <div className="font-medium text-[var(--text)]">{label}</div>
        <div className="text-sm text-[var(--text-dim)]">{description}</div>
      </div>
      <span className="text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors">→</span>
    </Link>
  );
}

export default function DashboardPage(): React.ReactElement {
  const { status, isConnected, listSessions, gateway } = useGateway();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchStats(): Promise<void> {
      if (!isConnected) {
        setIsLoading(false);
        return;
      }

      try {
        const [sessionsResult, runsResult] = await Promise.all([
          listSessions(100),
          gateway?.getActiveRuns() ?? { runs: [] },
        ]);

        setSessions(sessionsResult.sessions);
        setActiveCount(runsResult.runs.length);
      } catch (err) {
        console.error('Failed to fetch stats:', err);
      } finally {
        setIsLoading(false);
      }
    }

    fetchStats();
  }, [isConnected, listSessions, gateway]);

  // Calculate stats
  const totalMessages = sessions.reduce((sum, s) => sum + s.messageCount, 0);
  const channelCounts = sessions.reduce((acc, s) => {
    const channel = s.key.split(':')[2] || 'unknown';
    acc[channel] = (acc[channel] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <main className="flex flex-col h-full">
      {/* Page Header */}
      <header className="h-[60px] bg-[var(--bg-panel)] border-b border-[var(--border-subtle)] flex items-center px-6 gap-4 shrink-0">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">Dashboard</h1>
        <span className="text-sm text-[var(--text-dim)]">Overview</span>
      </header>

      {/* Content */}
      <div className="flex-1 p-6 overflow-y-auto">
        {/* Connection Banner */}
        {!isConnected && (
          <div className={`
            mb-6 p-4 rounded-[var(--radius-lg)] border flex items-center gap-3
            ${status === 'connecting' 
              ? 'bg-[var(--yellow-dim)] border-[var(--yellow)]/30 text-[var(--yellow)]' 
              : 'bg-[var(--red-dim)] border-[var(--red)]/30 text-[var(--red)]'
            }
          `}>
            <div className={`w-3 h-3 rounded-full ${status === 'connecting' ? 'bg-[var(--yellow)] animate-pulse' : 'bg-[var(--red)]'}`} />
            <span className="font-medium">
              {status === 'connecting' ? 'Connecting to gateway...' : 'Not connected to gateway'}
            </span>
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            icon="🔌"
            label="Connection"
            value={isConnected ? 'Online' : 'Offline'}
            color={isConnected ? 'green' : 'red'}
          />
          <StatCard
            icon="🤖"
            label="Total Sessions"
            value={isLoading ? '—' : sessions.length}
          />
          <StatCard
            icon="⚡"
            label="Active Runs"
            value={isLoading ? '—' : activeCount}
            color={activeCount > 0 ? 'yellow' : 'default'}
          />
          <StatCard
            icon="💬"
            label="Total Messages"
            value={isLoading ? '—' : totalMessages.toLocaleString()}
          />
        </div>

        {/* Two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Quick Actions */}
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)] mb-4">Quick Actions</h2>
            <div className="space-y-3">
              <QuickAction
                href="/sessions"
                icon="🤖"
                label="View Sessions"
                description="Monitor and manage agent sessions"
              />
              <QuickAction
                href="/kb"
                icon="📚"
                label="Knowledge Base"
                description="Browse documents and notes"
              />
              <QuickAction
                href="/kb/journal"
                icon="📝"
                label="Journal"
                description="View daily entries"
              />
            </div>
          </div>

          {/* Channel Breakdown */}
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)] mb-4">Sessions by Channel</h2>
            <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-[var(--radius-lg)] overflow-hidden">
              {isLoading ? (
                <div className="p-6 text-center text-[var(--text-dim)]">
                  <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  Loading...
                </div>
              ) : Object.keys(channelCounts).length === 0 ? (
                <div className="p-6 text-center text-[var(--text-dim)]">
                  No sessions yet
                </div>
              ) : (
                <div className="divide-y divide-[var(--border-subtle)]">
                  {Object.entries(channelCounts)
                    .sort(([, a], [, b]) => b - a)
                    .map(([channel, count]) => (
                      <div key={channel} className="flex items-center justify-between px-4 py-3">
                        <span className="text-sm text-[var(--text-secondary)] capitalize">{channel}</span>
                        <span className="text-sm font-medium text-[var(--text)]">{count}</span>
                      </div>
                    ))
                  }
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
