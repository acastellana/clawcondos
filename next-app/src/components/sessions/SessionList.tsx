'use client';

/**
 * SessionList Component
 * Displays a list of agent sessions with real-time updates
 */

import { useState, useEffect, useCallback } from 'react';
import { SessionCard } from './SessionCard';
import { useGateway } from '@/hooks/use-gateway';
import type { Session, SessionKey, ChatEvent, AgentEvent } from '@/lib/types';

const SUBAGENT_PARENT_KEY = 'sharp_subagent_parents';
const SUBAGENT_COLLAPSED_KEY = 'sharp_subagent_collapsed';
const VIRTUAL_PARENT_KEY: SessionKey = 'virtual:Unassigned:virtual';
const VIRTUAL_PARENT_LABEL = 'Unassigned';

const readLocalMap = (key: string): Record<string, unknown> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const writeLocalMap = (key: string, value: Record<string, unknown>): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore write errors
  }
};

type SessionListProps = {
  onSessionSelect?: (sessionKey: SessionKey) => void;
  selectedSession?: SessionKey | null;
};

export function SessionList({ 
  onSessionSelect, 
  selectedSession: _selectedSession 
}: SessionListProps): React.ReactElement {
  const { isConnected, listSessions, subscribe, gateway, abort } = useGateway();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeRuns, setActiveRuns] = useState<Set<SessionKey>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subagentParents, setSubagentParents] = useState<Record<SessionKey, SessionKey>>({});
  const [collapsedByParent, setCollapsedByParent] = useState<Record<SessionKey, boolean>>({});

  const selectedSession = _selectedSession ?? null;

  /**
   * Fetch sessions from gateway
   */
  const fetchSessions = useCallback(async (): Promise<void> => {
    if (!isConnected) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const [sessionsResult, runsResult] = await Promise.all([
        listSessions(100),
        gateway?.getActiveRuns() ?? { runs: [] },
      ]);
      
      setSessions(sessionsResult.sessions);
      setActiveRuns(new Set(runsResult.runs.map((r) => r.sessionKey)));
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch sessions');
    } finally {
      setIsLoading(false);
    }
  }, [isConnected, listSessions, gateway]);

  // Load localStorage maps on mount
  useEffect(() => {
    setSubagentParents(readLocalMap(SUBAGENT_PARENT_KEY) as Record<SessionKey, SessionKey>);
    setCollapsedByParent(readLocalMap(SUBAGENT_COLLAPSED_KEY) as Record<SessionKey, boolean>);
  }, []);

  // Fetch sessions on connect
  useEffect(() => {
    if (isConnected) {
      fetchSessions();
    }
  }, [isConnected, fetchSessions]);

  // Subscribe to real-time events
  useEffect(() => {
    if (!isConnected) return;

    // Handle chat events (new messages, streaming)
    const unsubChat = subscribe('chat', (event: ChatEvent) => {
      if (event.type === 'start') {
        // Mark session as active
        setActiveRuns((prev) => new Set([...prev, event.sessionKey]));
      } else if (event.type === 'done' || event.type === 'error' || event.type === 'abort') {
        // Mark session as idle
        setActiveRuns((prev) => {
          const next = new Set(prev);
          next.delete(event.sessionKey);
          return next;
        });
        // Refresh sessions to get updated message counts
        fetchSessions();
      }
    });

    // Handle agent events (start/stop)
    const unsubAgent = subscribe('agent', (event: AgentEvent) => {
      if (event.type === 'start') {
        setActiveRuns((prev) => new Set([...prev, event.sessionKey]));
      } else if (event.type === 'stop' || event.type === 'error') {
        setActiveRuns((prev) => {
          const next = new Set(prev);
          next.delete(event.sessionKey);
          return next;
        });
      }
    });

    return () => {
      unsubChat();
      unsubAgent();
    };
  }, [isConnected, subscribe, fetchSessions]);

  // Derive subagent parent mapping from current sessions
  useEffect(() => {
    if (sessions.length === 0) return;

    const mainSessions = sessions.filter((session) => !isSubagent(session.key));
    if (mainSessions.length === 0) return;

    const nextMap: Record<string, string> = { ...subagentParents };
    let changed = false;

    for (const session of sessions) {
      if (!isSubagent(session.key)) continue;
      if (nextMap[session.key]) continue;

      let parent = findParentByTiming(session, mainSessions);

      if (!parent && selectedSession && !isSubagent(selectedSession)) {
        parent = mainSessions.find((s) => s.key === selectedSession) ?? null;
      }

      if (!parent && mainSessions.length > 0) {
        parent = mainSessions[0];
      }

      if (parent) {
        nextMap[session.key] = parent.key;
        changed = true;
      }
    }

    if (changed) {
      setSubagentParents(nextMap);
      writeLocalMap(SUBAGENT_PARENT_KEY, nextMap);
    }
  }, [sessions, selectedSession, subagentParents]);

  // Parse session key to get channel type
  const getSessionChannel = (key: SessionKey): string => {
    const parts = key.split(':');
    return parts[2] || 'unknown';
  };

  // Check if session is a subagent
  const isSubagent = (key: SessionKey): boolean => {
    return getSessionChannel(key) === 'subagent';
  };

  const findParentByTiming = (subagent: Session, candidates: Session[]): Session | null => {
    const subagentTime = subagent.createdAt ? new Date(subagent.createdAt).getTime() : 0;
    let bestParent: Session | null = null;
    let bestTimeDiff = Infinity;

    for (const parent of candidates) {
      const parentTime = parent.lastMessageAt
        ? new Date(parent.lastMessageAt).getTime()
        : new Date(parent.createdAt).getTime();
      const timeDiff = subagentTime - parentTime;
      if (timeDiff >= -60000 && timeDiff < bestTimeDiff) {
        bestTimeDiff = timeDiff;
        bestParent = parent;
      }
    }

    return bestParent;
  };

  // Sort sessions: active first, then by last message time
  // But keep subagents grouped after their potential parents
  const sortedSessions = [...sessions].sort((a, b) => {
    const aActive = activeRuns.has(a.key);
    const bActive = activeRuns.has(b.key);
    const aSubagent = isSubagent(a.key);
    const bSubagent = isSubagent(b.key);
    
    // Active sessions first (but subagents stay with parents)
    if (aActive && !bActive && !aSubagent && !bSubagent) return -1;
    if (!aActive && bActive && !aSubagent && !bSubagent) return 1;
    
    // Then by last message time
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bTime - aTime;
  });

  // Build tree structure: group subagents under parent sessions
  type SessionNode = {
    session: Session;
    children: Session[];
    isVirtual?: boolean;
  };

  const buildSessionTree = (): { tree: SessionNode[]; inferredParents: Record<SessionKey, SessionKey> } => {
    const mainSessions: SessionNode[] = [];
    const mainSessionList: Session[] = [];
    const subagentSessions: Session[] = [];
    const mainByKey = new Map<SessionKey, SessionNode>();
    const inferredParents: Record<SessionKey, SessionKey> = {};
    let virtualParent: SessionNode | null = null;

    // Separate main sessions and subagents
    for (const session of sortedSessions) {
      if (isSubagent(session.key)) {
        subagentSessions.push(session);
      } else {
        const node = { session, children: [] };
        mainSessions.push(node);
        mainSessionList.push(session);
        mainByKey.set(session.key, node);
      }
    }

    if (mainSessions.length === 0 && subagentSessions.length > 0) {
      virtualParent = {
        session: {
          key: VIRTUAL_PARENT_KEY,
          channel: 'virtual',
          label: VIRTUAL_PARENT_LABEL,
          createdAt: new Date(0).toISOString(),
          messageCount: 0,
        },
        children: [],
        isVirtual: true,
      };
      mainSessions.push(virtualParent);
    }

    const selectedParentCandidate =
      selectedSession && !isSubagent(selectedSession) && mainByKey.has(selectedSession)
        ? selectedSession
        : null;

    // Attach subagents to parents using stored mapping first, then timing heuristic
    for (const subagent of subagentSessions) {
      const mappedParentKey = subagentParents[subagent.key];
      let parentNode = mappedParentKey ? mainByKey.get(mappedParentKey) ?? null : null;

      if (!parentNode) {
        const timingParent = findParentByTiming(subagent, mainSessionList);
        if (timingParent) {
          parentNode = mainByKey.get(timingParent.key) ?? null;
        }
      }

      if (!parentNode && selectedParentCandidate) {
        parentNode = mainByKey.get(selectedParentCandidate) ?? null;
      }

      if (!parentNode && mainSessions.length > 0) {
        parentNode = mainSessions[0];
      }

      if (parentNode) {
        parentNode.children.push(subagent);
        if (!mappedParentKey && !parentNode.isVirtual) {
          inferredParents[subagent.key] = parentNode.session.key;
        }
      }
    }

    return { tree: mainSessions, inferredParents };
  };

  const { tree: sessionTree, inferredParents } = buildSessionTree();

  useEffect(() => {
    const updates: Record<SessionKey, SessionKey> = {};
    let hasUpdates = false;

    for (const [subagentKey, parentKey] of Object.entries(inferredParents)) {
      if (!subagentParents[subagentKey as SessionKey]) {
        updates[subagentKey as SessionKey] = parentKey as SessionKey;
        hasUpdates = true;
      }
    }

    if (!hasUpdates) return;

    const next = { ...subagentParents, ...updates };
    setSubagentParents(next);
    writeLocalMap(SUBAGENT_PARENT_KEY, next);
  }, [inferredParents, subagentParents]);

  const toggleChildren = (parentKey: SessionKey): void => {
    setCollapsedByParent((prev) => {
      const next = { ...prev, [parentKey]: !(prev[parentKey] ?? true) };
      writeLocalMap(SUBAGENT_COLLAPSED_KEY, next);
      return next;
    });
  };

  // Loading state
  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-6 text-[var(--text-dim)]">
        <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin mb-4" />
        <div className="font-medium">Connecting to gateway...</div>
      </div>
    );
  }

  if (isLoading && sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-6 text-[var(--text-dim)]">
        <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin mb-4" />
        <div className="font-medium">Loading sessions...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-6">
        <div className="text-5xl mb-4 opacity-40">⚠️</div>
        <div className="font-medium text-[var(--red)] mb-1">Error loading sessions</div>
        <div className="text-sm text-[var(--text-muted)] mb-4">{error}</div>
        <button
          onClick={fetchSessions}
          className="text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (sortedSessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-6 text-[var(--text-dim)]">
        <div className="text-5xl mb-4 opacity-40">🤖</div>
        <div className="font-medium mb-1">No sessions yet</div>
        <div className="text-sm text-[var(--text-muted)]">
          Start a conversation to create a session
        </div>
      </div>
    );
  }

  return (
    <div className="divide-y divide-[var(--border-subtle)]">
      {/* Stats header */}
      <div className="px-4 py-2 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] flex items-center gap-4 text-xs text-[var(--text-dim)]">
        <span>{sortedSessions.length} session{sortedSessions.length !== 1 ? 's' : ''}</span>
        {activeRuns.size > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] animate-pulse" />
            {activeRuns.size} active
          </span>
        )}
        <button
          onClick={fetchSessions}
          className="ml-auto hover:text-[var(--text-secondary)] transition-colors"
          title="Refresh sessions"
        >
          ↻ Refresh
        </button>
      </div>

      {/* Session cards with tree structure */}
      {sessionTree.map((node) => {
        const isCollapsed = collapsedByParent[node.session.key] ?? true;

        return (
          <div key={node.session.key}>
            {/* Parent session */}
            <SessionCard
              session={node.session}
              isActive={activeRuns.has(node.session.key)}
              onClick={onSessionSelect}
              onAbort={abort}
              isSelectable={!node.isVirtual}
            />

            {/* Subagent toggle */}
            {node.children.length > 0 && (
              <button
                onClick={() => toggleChildren(node.session.key)}
                className="ml-6 mt-1 mb-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors flex items-center gap-1"
                title={isCollapsed ? 'Show subagents' : 'Hide subagents'}
              >
                <span className="text-[10px]">{isCollapsed ? '▶' : '▼'}</span>
                <span>{node.children.length} subagent{node.children.length !== 1 ? 's' : ''}</span>
              </button>
            )}
            
            {/* Child sessions (subagents) */}
            {node.children.length > 0 && !isCollapsed && (
              <div className="relative">
                {node.children.map((child, index) => (
                  <div key={child.key} className="relative">
                    {/* Tree connector */}
                    <div className="absolute left-4 top-0 bottom-0 flex items-start pointer-events-none">
                      {/* Vertical line */}
                      <div 
                        className={`
                          w-px bg-[var(--border-subtle)]
                          ${index === node.children.length - 1 ? 'h-6' : 'h-full'}
                        `}
                      />
                      {/* Horizontal arrow */}
                      <div className="flex items-center h-6">
                        <div className="w-3 h-px bg-[var(--border-subtle)]" />
                        <span className="text-[var(--text-muted)] text-xs ml-0.5">↳</span>
                      </div>
                    </div>
                    
                    {/* Indented child card */}
                    <div className="ml-8">
                      <SessionCard
                        session={child}
                        isActive={activeRuns.has(child.key)}
                        onClick={onSessionSelect}
                        onAbort={abort}
                        isChild
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default SessionList;
