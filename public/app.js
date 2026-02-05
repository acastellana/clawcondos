    // ═══════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════
    const WS_PROTOCOL_VERSION = 3;
    const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
    // Sidebar should only show recently-active sessions (unless pinned / running)
    const SIDEBAR_HIDE_INACTIVE_MS = 15 * 60 * 1000; // 15 minutes
    
    // ═══════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════
    
    // Get configuration (from config.js)
    const config = window.ClawCondosConfig ? window.ClawCondosConfig.getConfig() : {};

    // localStorage keys (migrate from legacy "sharp_*" keys)
    const LS_PREFIX = 'clawcondos_';
    function lsGet(key, fallback = null) {
      const v = localStorage.getItem(LS_PREFIX + key);
      if (v != null) return v;
      const legacy = localStorage.getItem('sharp_' + key);
      if (legacy != null) return legacy;
      return fallback;
    }
    function lsSet(key, value) {
      localStorage.setItem(LS_PREFIX + key, value);
    }
    function lsRemove(key) {
      localStorage.removeItem(LS_PREFIX + key);
    }

    const state = {
      // Data
      sessions: [],
      apps: [],
      agents: [],
      goals: [],
      currentGoalId: 'all',
      currentGoalOpenId: null,
      currentCondoId: null,
      newSessionCondoId: null,
      newGoalCondoId: null,
      attachSessionKey: null,
      attachGoalId: null,
      
      // UI
      currentView: 'dashboard',
      currentSession: null,
      selectedAppId: null,
      // Recurring tasks (cron)
      selectedCronJobId: null,    // preferred: cron job id
      cronJobs: [],
      cronJobsLoaded: false,
      cronRunsByJobId: {},
      newSessionAgentId: null,
      pendingRouteSessionKey: null,
      pendingRouteGoalId: null,
      pendingRouteCondoId: null,
      pendingRouteAppId: null,
      pendingRouteNewSession: null,
      pendingRouteNewGoalCondoId: null,
      chatHistory: [],
      // Cache last loaded history per session so UI doesn't go blank on transient disconnects.
      sessionHistoryCache: new Map(), // Map<sessionKey, messages[]>
      sessionHistoryLoadSeq: 0,
      isThinking: false,
      messageQueue: [],  // Queued messages when agent is busy

      // Per-session model overrides (UI-level; model switch is triggered by sending /new <model>)
      sessionModelOverrides: (() => {
        try { return JSON.parse(lsGet('session_model_overrides', '{}') || '{}') || {}; } catch { return {}; }
      })(),

      // Chat UX
      chatAutoScroll: true,          // user is at bottom (or near-bottom)
      chatUnseenCount: 0,            // new messages while scrolled up
      streamingBuffers: new Map(),   // Map<runId, string>
      streamingRaf: new Map(),       // Map<runId, rafId>
      recentMessageFingerprints: new Map(), // Map<fingerprint, timestampMs>
      recentMessageFingerprintPruneAt: 0,
      
      // Audio recording
      mediaRecorder: null,
      audioChunks: [],
      recordingStartTime: null,
      recordingTimerInterval: null,
      
      // Auth - loaded from config or localStorage
      // Token should be set via config.json or login modal, NOT hardcoded
      token: lsGet('token', null),
      gatewayUrl: (() => {
        // Priority: localStorage > config > auto-detect
        const saved = lsGet('gateway', null);
        if (saved && !saved.includes(':18789')) {
          return saved;
        }
        // Clear invalid old URLs
        if (saved && saved.includes(':18789') && window.location.hostname !== 'localhost') {
          lsRemove('gateway');
          // Also clear legacy if present
          localStorage.removeItem('sharp_gateway');
        }
        // Use config if available
        if (config.gatewayWsUrl) {
          return config.gatewayWsUrl;
        }
        // Auto-detect from location
        const host = window.location.hostname || 'localhost';
        if (host.includes('.ts.net') && window.location.protocol === 'http:') {
          return 'wss://' + host;
        }
        const proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        const port = window.location.port;
        return port ? proto + host + ':' + port : proto + host;
      })(),
      
      // WebSocket
      ws: null,
      wsReconnectTimer: null,
      wsKeepaliveTimer: null,
      wsStaleTimer: null,
      wsLastMessageAt: 0,
      wsReconnectAttempts: 0,
      connected: false,
      connectionStatus: 'connecting',
      wsLastClose: null,          // { code, reason, at }
      wsLastError: null,          // string
      wsLastConnectAttemptAt: 0,  // ms
      connectNonce: null,
      connectSent: false,
      rpcIdCounter: 0,
      rpcPending: new Map(),
      
      // Streaming
      activeRuns: new Map(),
      activeRunsStore: JSON.parse(lsGet('active_runs', '{}') || '{}'),  // Persisted: { sessionKey: { runId, startedAt } }
      sessionInputReady: new Map(),
      
      // Pin & Archive
      pinnedSessions: JSON.parse(lsGet('pinned_sessions', '[]') || '[]'),
      archivedSessions: JSON.parse(lsGet('archived_sessions', '[]') || '[]'),
      showArchived: false,
      
      // Custom session names
      sessionNames: JSON.parse(lsGet('session_names', '{}') || '{}'),

      // Per-session UI verbose toggle (best-effort)
      verboseBySession: JSON.parse(lsGet('verbose_by_session', '{}') || '{}'),
      
      // Search & Filters
      searchQuery: '',
      filterChannel: 'all',  // all, telegram, discord, signal, whatsapp, cron
      filterStatus: 'all',   // all, running, unread, error, recent, idle
      recurringSearch: lsGet('recurring_search', '') || '',
      recurringAgentFilter: lsGet('recurring_agent_filter', 'all') || 'all',
      recurringEnabledOnly: lsGet('recurring_enabled_only', '0') === '1',
      agentJobsSearchByAgent: JSON.parse(lsGet('agent_jobs_search', '{}') || '{}'),
      agentJobsEnabledOnlyByAgent: JSON.parse(lsGet('agent_jobs_enabled_only', '{}') || '{}'),
      
      // Auto-title generation tracking
      generatingTitles: new Set(),  // Currently generating
      attemptedTitles: new Set(),   // Already tried (avoid retries)
      
      // Auto-archive: 'never' or number of days
      autoArchiveDays: lsGet('auto_archive_days', '7') || '7',
      
      // Track when sessions were last viewed (for unread indicator)
      lastViewedAt: JSON.parse(lsGet('last_viewed', '{}') || '{}'),
      
      // Track which session groups are expanded (for nested view)
      expandedGroups: JSON.parse(lsGet('expanded_groups', '{}') || '{}'),

      // Track which condos are expanded/collapsed in sidebar
      expandedCondos: JSON.parse(lsGet('expanded_condos', '{}') || '{}'),

      // Track which agent nodes are expanded in sidebar (Agents > Sessions/Subsessions)
      expandedAgents: JSON.parse(lsGet('expanded_agents', '{}') || '{}'),
      
      // Session status (two separate concepts)
      // 1) Brief current state (LLM-generated text)
      sessionBriefStatus: JSON.parse(lsGet('session_brief_status', '{}') || '{}'),
      generatingStatus: new Set(),

      // 2) Agent lifecycle status (idle/thinking/offline/error)
      sessionAgentStatus: JSON.parse(lsGet('session_agent_status', '{}') || '{}'),
      
      // Tool activity tracking (for compact indicator)
      activeTools: new Map(),  // Map<toolCallId, { name, args, output, startedAt, status }>
      toolActivityExpanded: false
    };
    
    // ═══════════════════════════════════════════════════════════════
    // SESSION PIN & ARCHIVE
    // ═══════════════════════════════════════════════════════════════
    function isSessionPinned(key) {
      return state.pinnedSessions.includes(key);
    }
    
    function isSessionArchived(key) {
      return state.archivedSessions.includes(key);
    }
    
    // Parse session key to extract group info for nesting
    function parseSessionGroup(key) {
      // Match patterns like: agent:main:telegram:group:-1003814943696:topic:54
      const topicMatch = key.match(/^(agent:[^:]+:[^:]+:group:[^:]+):topic:(\d+)$/);
      if (topicMatch) {
        return {
          type: 'topic',
          groupKey: topicMatch[1],
          topicId: topicMatch[2],
          isGrouped: true
        };
      }
      // Match patterns like: agent:main:telegram:group:-1003814943696 (group without topic)
      const groupMatch = key.match(/^(agent:[^:]+:[^:]+:group:[^:]+)$/);
      if (groupMatch) {
        return {
          type: 'group',
          groupKey: groupMatch[1],
          isGrouped: false
        };
      }
      return { type: 'standalone', isGrouped: false };
    }

    function getSessionCondoId(session) {
      if (!session?.key) return 'unknown';
      const parsed = parseSessionGroup(session.key);
      if (parsed.type === 'topic') {
        return `${parsed.groupKey}:topic:${parsed.topicId}`;
      }
      if (parsed.type === 'group') {
        return parsed.groupKey;
      }
      if (session.key.startsWith('cron:')) return 'cron';
      return `misc:${session.key.split(':')[0] || 'misc'}`;
    }

    function getSessionCondoName(session) {
      if (!session) return 'Unknown';
      if (session.key.startsWith('cron:')) return 'Recurring';
      if (session.key.includes(':topic:')) return getSessionName(session);
      if (session.key.includes(':group:')) {
        const parsed = parseSessionGroup(session.key);
        return parsed.groupKey ? getGroupDisplayName(parsed.groupKey) : getSessionName(session);
      }
      return session.displayName || session.label || 'Direct';
    }

    function isGoalCompleted(goal) {
      return goal?.completed === true || goal?.status === 'done';
    }

    function getCondoIdForSessionKey(sessionKey) {
      const session = state.sessions.find(s => s.key === sessionKey);
      if (session) return getSessionCondoId(session);
      return state.currentCondoId || null;
    }
    
    function getGroupDisplayName(groupKey) {
      // Try to find a custom name for the group
      const customName = state.sessionNames[groupKey];
      if (customName) return customName;
      // Extract group ID and return a readable name
      const match = groupKey.match(/:group:(-?\d+)$/);
      if (match) {
        return `Group ${match[1]}`;
      }
      return groupKey.split(':').pop();
    }
    
    function toggleGroupExpanded(groupKey) {
      state.expandedGroups[groupKey] = !state.expandedGroups[groupKey];
      lsSet('expanded_groups', JSON.stringify(state.expandedGroups));
      renderSessions();
    }
    
    function isGroupExpanded(groupKey) {
      // Default to expanded
      return state.expandedGroups[groupKey] !== false;
    }

    function toggleCondoExpanded(condoId) {
      state.expandedCondos[condoId] = !isCondoExpanded(condoId);
      lsSet('expanded_condos', JSON.stringify(state.expandedCondos));
      renderCondos();
    }

    function isCondoExpanded(condoId) {
      // Default: expanded unless explicitly set false
      return state.expandedCondos[condoId] !== false;
    }

    function toggleAgentExpanded(agentId) {
      state.expandedAgents[agentId] = !isAgentExpanded(agentId);
      lsSet('expanded_agents', JSON.stringify(state.expandedAgents));
      renderAgents();
    }

    function isAgentExpanded(agentId) {
      // Default to expanded
      return state.expandedAgents[agentId] !== false;
    }
    
    function getGroupUnreadCount(groupKey, sessions) {
      return sessions.filter(s => {
        const parsed = parseSessionGroup(s.key);
        return parsed.groupKey === groupKey && isSessionUnread(s.key);
      }).length;
    }
    
    async function generateGroupTitles(groupKey, event) {
      if (event) event.stopPropagation();
      // Find all sessions in this group
      const groupSessions = state.sessions.filter(s => {
        const parsed = parseSessionGroup(s.key);
        return parsed.groupKey === groupKey && parsed.type === 'topic';
      });
      
      showToast(`Generating titles for ${groupSessions.length} topics...`);
      
      // Generate titles for each session that doesn't have a custom name
      for (const s of groupSessions) {
        if (!getCustomSessionName(s.key) && !state.generatingTitles.has(s.key)) {
          await generateSessionTitle(s.key);
          // Small delay between requests
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }
    
    // Session status - brief current state (5-10 words)
    function getSessionStatus(key) {
      return state.sessionBriefStatus[key] || null;
    }
    
    async function generateSessionStatusBrief(key, event) {
      if (event) event.stopPropagation();
      if (state.generatingStatus.has(key)) return;
      
      state.generatingStatus.add(key);
      renderSessions();
      
      try {
        const history = await rpcCall('chat.history', { sessionKey: key, limit: 5 });
        if (!history?.messages?.length) {
          state.generatingStatus.delete(key);
          return;
        }
        
        const context = history.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 150) : ''}`)
          .join('\n');
        
        const response = await fetch('/api/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'Write a 5-8 word status of what is currently happening. Be specific. No punctuation. Examples: "Adding unread indicators to ClawCondos sidebar", "Debugging Catastro API rate limits", "Waiting for user feedback on design"' },
              { role: 'user', content: context.slice(0, 1500) }
            ],
            max_tokens: 30,
            temperature: 0.3
          })
        });
        
        if (response.ok) {
          const data = await response.json();
          const status = data.choices?.[0]?.message?.content?.trim();
          if (status && status.length < 80) {
            state.sessionBriefStatus[key] = { text: status, updatedAt: Date.now() };
            lsSet('session_brief_status', JSON.stringify(state.sessionBriefStatus));
          }
        }
      } catch (err) {
        console.error('Status generation failed:', err);
      } finally {
        state.generatingStatus.delete(key);
        renderSessions();
      }
    }
    
    // Ask the session agent for a full summary
    async function askSessionForSummary(key, event) {
      if (event) event.stopPropagation();
      
      // Send message to the session asking for summary
      try {
        await rpcCall('chat.send', {
          sessionKey: key,
          message: 'Please give me a clean summary of our full conversation so far - what we discussed, what was accomplished, and current status.',
          idempotencyKey: `summary-request-${Date.now()}`
        });
        
        showToast('Asked session for summary - check the chat');
        // Open that session so user can see the response
        openSession(key);
      } catch (err) {
        console.error('Failed to ask for summary:', err);
        showToast('Failed to request summary', 'error');
      }
    }
    
    function renderSessionStatusLine(key) {
      const isGenerating = state.generatingStatus.has(key);
      const status = getSessionStatus(key);
      
      if (isGenerating) {
        return '<div class="item-status generating">⏳</div>';
      }
      
      if (status?.text) {
        return `<div class="item-status" onclick="event.stopPropagation(); generateSessionStatusBrief('${escapeHtml(key)}')" title="Click to refresh">${escapeHtml(status.text)}</div>`;
      }
      
      return `<div class="item-status generate-link" onclick="event.stopPropagation(); generateSessionStatusBrief('${escapeHtml(key)}')">↻ status</div>`;
    }
    
    function isSessionUnread(key) {
      const session = state.sessions.find(s => s.key === key);
      if (!session) return false;
      const lastViewed = state.lastViewedAt[key] || 0;
      const updatedAt = session.updatedAt || 0;
      // Unread if updated since last viewed (with 1s grace period)
      return updatedAt > lastViewed + 1000;
    }
    
    function markSessionRead(key) {
      state.lastViewedAt[key] = Date.now();
      lsSet('last_viewed', JSON.stringify(state.lastViewedAt));
    }
    
    function markSessionUnread(key, event) {
      if (event) event.stopPropagation();
      // Set lastViewed to 0 so it appears unread
      state.lastViewedAt[key] = 0;
      lsSet('last_viewed', JSON.stringify(state.lastViewedAt));
      renderSessions();
      renderSessionsGrid();
    }
    
    function markAllSessionsRead() {
      const now = Date.now();
      state.sessions.forEach(s => {
        state.lastViewedAt[s.key] = now;
      });
      lsSet('last_viewed', JSON.stringify(state.lastViewedAt));
      renderSessions();
      renderSessionsGrid();
      showToast('All sessions marked as read');
    }
    
    function getUnreadCount() {
      return state.sessions.filter(s => isSessionUnread(s.key)).length;
    }
    
    function togglePinSession(key) {
      const idx = state.pinnedSessions.indexOf(key);
      if (idx >= 0) {
        state.pinnedSessions.splice(idx, 1);
      } else {
        state.pinnedSessions.push(key);
      }
      lsSet('pinned_sessions', JSON.stringify(state.pinnedSessions));
      renderSessions();
      renderSessionsGrid();
    }
    
    function toggleArchiveSession(key) {
      const idx = state.archivedSessions.indexOf(key);
      if (idx >= 0) {
        state.archivedSessions.splice(idx, 1);
      } else {
        state.archivedSessions.push(key);
        // Unpin if archived
        const pinIdx = state.pinnedSessions.indexOf(key);
        if (pinIdx >= 0) {
          state.pinnedSessions.splice(pinIdx, 1);
          lsSet('pinned_sessions', JSON.stringify(state.pinnedSessions));
        }
      }
      lsSet('archived_sessions', JSON.stringify(state.archivedSessions));
      renderSessions();
      renderSessionsGrid();
    }
    
    function toggleShowArchived() {
      state.showArchived = !state.showArchived;
      renderSessions();
    }
    
    // ═══════════════════════════════════════════════════════════════
    // SESSION RENAME
    // ═══════════════════════════════════════════════════════════════
    function getCustomSessionName(key) {
      return state.sessionNames[key] || null;
    }
    
    function setCustomSessionName(key, name) {
      if (name && name.trim()) {
        state.sessionNames[key] = name.trim();
      } else {
        delete state.sessionNames[key];
      }
      lsSet('session_names', JSON.stringify(state.sessionNames));
      renderSessions();
      renderSessionsGrid();
    }
    
    function promptRenameSession(key, event) {
      if (event) event.stopPropagation();
      const session = state.sessions.find(s => s.key === key);
      const current = getCustomSessionName(key) || getDefaultSessionName(session);
      const newName = prompt('Rename session:', current);
      if (newName !== null) {
        setCustomSessionName(key, newName);
      }
    }
    
    async function generateSessionTitle(key, event) {
      if (event) event.stopPropagation();
      const session = state.sessions.find(s => s.key === key);
      if (!session) return;
      
      showToast('Generating title...', 'info', 3000);
      
      try {
        // Get first few messages from this session
        const historyResult = await rpcCall('chat.history', { sessionKey: key, limit: 5 });
        const messages = historyResult?.messages || [];
        
        if (messages.length === 0) {
          showToast('No messages to summarize', 'warning');
          return;
        }
        
        // Extract conversation context
        const conversation = messages.slice(0, 4).map(m => {
          const role = m.role === 'user' ? 'User' : 'Assistant';
          let content = '';
          if (typeof m.content === 'string') {
            content = m.content.slice(0, 150);
          } else if (Array.isArray(m.content)) {
            content = m.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join(' ')
              .slice(0, 150);
          }
          return `${role}: ${content}`;
        }).join('\n');
        
        if (!conversation.trim()) {
          showToast('No content to summarize', 'warning');
          return;
        }
        
        // Try LLM-based title generation
        const title = await generateTitleWithLLM(conversation);
        
        if (title) {
          setCustomSessionName(key, title);
          showToast(`Titled: "${title}"`, 'success');
        } else {
          showToast('Could not generate title', 'warning');
        }
      } catch (err) {
        console.error('Failed to generate title:', err);
        showToast('Failed to generate title', 'error');
      }
    }
    
    async function generateTitleWithLLM(conversation) {
      try {
        // Use server-side proxy that injects the API key
        const response = await fetch('/api/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: 'Generate a very short title (3-6 words) for this conversation. Reply with ONLY the title, no quotes, no punctuation at the end.'
              },
              {
                role: 'user',
                content: conversation
              }
            ],
            max_tokens: 20,
            temperature: 0.3
          })
        });
        
        if (!response.ok) {
          console.error('OpenAI API error:', response.status);
          return null;
        }
        
        const data = await response.json();
        const title = data.choices?.[0]?.message?.content?.trim();
        
        if (title && title.length < 60) {
          return title.replace(/^["']|["']$/g, '').replace(/\.+$/, '');
        }
        return null;
      } catch (err) {
        console.error('LLM title generation failed:', err);
        return null;
      }
    }
    
    // OpenAI API key is injected server-side via /api/openai proxy
    
    async function autoGenerateTitle(key) {
      // Mark as attempted to avoid retries
      state.attemptedTitles.add(key);
      state.generatingTitles.add(key);
      renderSessions();
      
      try {
        const session = state.sessions.find(s => s.key === key);
        if (!session) return;
        
        // Get messages
        const historyResult = await rpcCall('chat.history', { sessionKey: key, limit: 5 });
        const messages = historyResult?.messages || [];
        
        if (messages.length === 0) {
          state.generatingTitles.delete(key);
          renderSessions();
          return;
        }
        
        // Extract conversation
        const conversation = messages.slice(0, 4).map(m => {
          const role = m.role === 'user' ? 'User' : 'Assistant';
          let content = '';
          if (typeof m.content === 'string') {
            content = m.content.slice(0, 150);
          } else if (Array.isArray(m.content)) {
            content = m.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join(' ')
              .slice(0, 150);
          }
          return `${role}: ${content}`;
        }).join('\n');
        
        if (!conversation.trim()) {
          state.generatingTitles.delete(key);
          renderSessions();
          return;
        }
        
        // Generate title
        const title = await generateTitleWithLLM(conversation);
        
        state.generatingTitles.delete(key);
        
        if (title) {
          // Animate the title with typewriter effect
          setCustomSessionName(key, title);
          animateTitle(key, title);
        } else {
          renderSessions();
        }
      } catch (err) {
        console.error('Auto-generate title failed:', err);
        state.generatingTitles.delete(key);
        renderSessions();
      }
    }
    
    function animateTitle(key, title) {
      // Find the session name element and animate it
      const el = document.querySelector(`[data-session-key="${key}"] .item-name`);
      if (el) {
        el.innerHTML = '';
        el.className = 'item-name title-typewriter';
        let i = 0;
        const interval = setInterval(() => {
          if (i < title.length) {
            el.textContent += title[i];
            i++;
          } else {
            clearInterval(interval);
            el.className = 'item-name';
          }
        }, 30);
      } else {
        renderSessions();
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // SESSION SEARCH
    // ═══════════════════════════════════════════════════════════════
    function handleSearchInput(value) {
      state.searchQuery = value.toLowerCase().trim();
      renderSessions();
      renderSessionsGrid();
    }
    
    function clearSearch() {
      state.searchQuery = '';
      document.getElementById('sessionSearchInput').value = '';
      renderSessions();
      renderSessionsGrid();
    }
    
    function handleSearchKeydown(event) {
      if (event.key === 'Escape') {
        clearSearch();
        document.getElementById('sessionSearchInput').blur();
      } else if (event.key === 'Enter') {
        // Select first visible session
        const firstSession = document.querySelector('#sessionsList .session-item');
        if (firstSession) firstSession.click();
      }
    }
    
    function matchesSearch(session) {
      // Text search
      if (state.searchQuery) {
        const q = state.searchQuery;
        const name = getSessionName(session).toLowerCase();
        const key = session.key.toLowerCase();
        const label = (session.label || '').toLowerCase();
        const displayName = (session.displayName || '').toLowerCase();
        if (!name.includes(q) && !key.includes(q) && !label.includes(q) && !displayName.includes(q)) {
          return false;
        }
      }
      
      // Channel filter
      if (state.filterChannel !== 'all') {
        const key = session.key.toLowerCase();
        if (state.filterChannel === 'cron' && !key.includes('cron')) return false;
        if (state.filterChannel === 'subagent' && !key.includes('subagent')) return false;
        if (state.filterChannel === 'telegram' && !key.includes('telegram')) return false;
        if (state.filterChannel === 'discord' && !key.includes('discord')) return false;
        if (state.filterChannel === 'signal' && !key.includes('signal')) return false;
        if (state.filterChannel === 'whatsapp' && !key.includes('whatsapp')) return false;
      }
      
      // Status filter
      if (state.filterStatus !== 'all') {
        const status = getSessionStatusType(session);
        if (state.filterStatus !== status) return false;
      }
      
      return true;
    }
    
    function getSessionStatusType(session) {
      // Check if running (has active run)
      if (state.activeRuns?.has?.(session.key)) {
        return 'running';
      }
      
      // Check if unread
      const lastViewed = state.lastViewedAt[session.key] || 0;
      if (session.updatedAt && session.updatedAt > lastViewed + 1000) {
        return 'unread';
      }
      
      // Check if error (look for error in status)
      const statusInfo = state.sessionBriefStatus[session.key];
      if (statusInfo && statusInfo.text && statusInfo.text.toLowerCase().includes('error')) {
        return 'error';
      }
      
      // Check if recent (updated in last hour)
      const hourAgo = Date.now() - 3600000;
      if (session.updatedAt && session.updatedAt > hourAgo) {
        return 'recent';
      }
      
      return 'idle';
    }
    
    function setFilterChannel(value) {
      state.filterChannel = value;
      renderSessions();
      renderSessionsGrid();
    }
    
    function setFilterStatus(value) {
      state.filterStatus = value;
      renderSessions();
      renderSessionsGrid();
    }
    
    // Keyboard shortcut: Cmd/Ctrl+K to focus search
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('sessionSearchInput')?.focus();
      }
    });
    
    // ═══════════════════════════════════════════════════════════════
    // AUTO-ARCHIVE
    // ═══════════════════════════════════════════════════════════════
    function setAutoArchiveDays(value) {
      state.autoArchiveDays = value;
      lsSet('auto_archive_days', value);
      console.log('[ClawCondos] Auto-archive set to:', value);
      // Apply immediately so the sidebar updates without requiring a manual refresh.
      if (state.sessions && state.sessions.length) {
        checkAutoArchive();
        renderSessions();
        renderSessionsGrid();
      }
    }
    
    

    // ═══════════════════════════════════════════════════════════════
    // ACTIVITY WINDOW PRESET (Albert)
    // Collapse all condos except those with goals modified in the last X.
    // X comes from the preset dropdown.

    function parseDaysValue(v) {
      if (v == null) return null;
      if (v === 'never') return null;
      const n = parseFloat(String(v));
      return Number.isFinite(n) && n > 0 ? n : null;
    }

    function goalLastActivityMs(goal) {
      let t = 0;
      if (goal?.updatedAtMs) t = Math.max(t, Number(goal.updatedAtMs) || 0);
      if (goal?.createdAtMs) t = Math.max(t, Number(goal.createdAtMs) || 0);
      // Also consider the most recently updated session inside the goal.
      if (goal?.sessions && Array.isArray(goal.sessions) && state.sessions && state.sessions.length) {
        for (const k of goal.sessions) {
          const s = state.sessions.find(ss => ss.key === k);
          if (s?.updatedAt) t = Math.max(t, Number(s.updatedAt) || 0);
        }
      }
      return t;
    }

    function isGoalBlocked(goal) {
      if (!goal) return false;
      if (goal.status === 'blocked' || goal.blocked === true) return true;
      const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
      if (!tasks.length) return false;
      const next = tasks.find(t => !(t?.done === true || t?.completed === true));
      if (!next) return false;
      return next.blocked === true || next.status === 'blocked' || next.state === 'blocked';
    }

    function applyActivityWindowPreset() {
      const days = parseDaysValue(state.activityWindowDays);
      if (!days) return;

      const threshold = Date.now() - (days * 24 * 60 * 60 * 1000);

      // Build condo -> goals mapping (pending goals only)
      const recentCondos = new Set();
      for (const g of (state.goals || [])) {
        if (!g || isGoalCompleted(g)) continue;
        const last = goalLastActivityMs(g);
        if (last && last >= threshold) {
          const condoId = g.condoId || 'misc:default';
          recentCondos.add(condoId);
        }
      }

      // Collapse everything except recent condos
      const nextExpanded = {};
      // Keep explicit expansion for current condo if it has recent activity, otherwise collapse it too.
      // (Albert preference: collapse all except recent)
      for (const condoId of Object.keys(state.expandedCondos || {})) {
        nextExpanded[condoId] = false;
      }
      for (const condoId of recentCondos) {
        nextExpanded[condoId] = true;
      }
      state.expandedCondos = nextExpanded;
      lsSet('expanded_condos', JSON.stringify(state.expandedCondos));

      renderGoals();
    }

    function setActivityWindowDays(value) {
      state.activityWindowDays = value;
      lsSet('activity_window_days', String(value));
      // Apply immediately
      applyActivityWindowPreset();
    }
function initAutoArchiveUI() {
      const select = document.getElementById('autoArchiveSelect');
      if (select) {
        select.value = state.autoArchiveDays;
      }
    }
    
    function checkAutoArchive() {
      // Skip if auto-archive is disabled
      if (state.autoArchiveDays === 'never') {
        console.log('[ClawCondos] Auto-archive disabled');
        return;
      }
      
      const days = parseFloat(state.autoArchiveDays);
      if (isNaN(days) || days <= 0) return;
      
      const threshold = Date.now() - (days * 24 * 60 * 60 * 1000);
      let autoArchivedCount = 0;
      
      for (const session of state.sessions) {
        // Skip if already archived
        if (isSessionArchived(session.key)) continue;
        
        // Skip pinned sessions (they're important)
        if (isSessionPinned(session.key)) continue;
        
        // Check if session is inactive beyond threshold
        const updatedAt = session.updatedAt || 0;
        if (updatedAt > 0 && updatedAt < threshold) {
          // Auto-archive this session
          state.archivedSessions.push(session.key);
          autoArchivedCount++;
          console.log('[ClawCondos] Auto-archived:', session.key, 'last updated:', new Date(updatedAt).toISOString());
        }
      }
      
      // Save if any were archived
      if (autoArchivedCount > 0) {
        lsSet('archived_sessions', JSON.stringify(state.archivedSessions));
        showToast(`Auto-archived ${autoArchivedCount} inactive session${autoArchivedCount > 1 ? 's' : ''}`, 'info');
        renderSessions();
        renderSessionsGrid();
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // TOAST NOTIFICATIONS
    // ═══════════════════════════════════════════════════════════════
    function showToast(message, type = 'info', durationMs = 4000) {
      const container = document.getElementById('toastContainer');
      if (!container) return;
      
      const toast = document.createElement('div');
      toast.className = `toast ${type}`;
      
      const icon = type === 'success' ? '✓' : type === 'warning' ? '⚠' : 'ℹ';
      toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
      
      container.appendChild(toast);
      
      // Auto-remove after duration
      setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 300);
      }, durationMs);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // WEBSOCKET CONNECTION
    // ═══════════════════════════════════════════════════════════════
    function connectWebSocket() {
      if (state.ws) {
        state.ws.close();
        state.ws = null;
      }
      
      state.connectNonce = null;
      state.connectSent = false;
      state.wsLastConnectAttemptAt = Date.now();
      setConnectionStatus('connecting');
      
      // Build WebSocket URL
      let wsUrl = state.gatewayUrl.replace(/^http/, 'ws');
      // If connecting through Caddy (not directly to :18789), use the dedicated ClawCondos WS endpoint.
      if (!wsUrl.includes(':18789')) {
        wsUrl = wsUrl.replace(/\/?$/, '/clawcondos-ws');
      }
      console.log('[WS] Connecting to', wsUrl);
      
      try {
        state.ws = new WebSocket(wsUrl);
      } catch (err) {
        console.error('[WS] Failed to create WebSocket:', err);
        setConnectionStatus('error');
        scheduleReconnect();
        return;
      }
      
      state.ws.onopen = () => {
        console.log('[WS] Socket opened, waiting for challenge...');
        state.wsLastMessageAt = Date.now();
      };
      
      state.ws.onmessage = (event) => {
        state.wsLastMessageAt = Date.now();
        resetStaleTimer();
        
        try {
          const msg = JSON.parse(event.data);
          handleWsMessage(msg);
        } catch (err) {
          console.error('[WS] Parse error:', err);
        }
      };
      
      state.ws.onerror = (err) => {
        const msg = (err && (err.message || err.type)) ? String(err.message || err.type) : 'WebSocket error';
        state.wsLastError = msg;
        console.error('[WS] Error:', err);
      };
      
      state.ws.onclose = (event) => {
        state.wsLastClose = { code: event?.code, reason: event?.reason || '', at: Date.now() };
        console.log('[WS] Closed:', event.code, event.reason);
        state.connected = false;
        state.ws = null;
        state.connectNonce = null;
        state.connectSent = false;
        clearWsTimers();
        setConnectionStatus('error');
        finalizeAllStreamingMessages('disconnected');

        // If auth or handshake failed, prompt for token and STOP reconnect loop until user acts.
        if (event?.code === 1008 && /unauthorized|password mismatch|device identity required|invalid connect params/i.test(event?.reason || '')) {
          // Clear stored token to prevent infinite reconnect spam with a bad secret.
          state.token = null;
          lsRemove('token');
          // Legacy cleanup
          localStorage.removeItem('sharp_token');
          localStorage.removeItem('sharp_gateway_token');

          showLoginModal();
          const errorDiv = document.getElementById('loginError');
          if (errorDiv) {
            errorDiv.textContent = event.reason || 'Authentication required';
            errorDiv.style.display = 'block';
          }

          // Also show a toast so it's visible even if modal is dismissed.
          showToast(event.reason || 'Authentication required', 'error', 8000);
          return;
        }
        
        for (const [id, pending] of state.rpcPending) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('WebSocket closed'));
        }
        state.rpcPending.clear();
        
        scheduleReconnect();
      };
    }
    
    function handleWsMessage(msg) {
      // Debug: log all incoming messages
      if (msg.type === 'event') {
        console.log('[ClawCondos] WS Event:', msg.event, msg.payload ? JSON.stringify(msg.payload).slice(0, 200) : '');
      }
      
      // Challenge for auth (comes as event type)
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        state.connectNonce = msg.payload?.nonce;
        // Auto-connect
        sendConnect();
        return;
      }
      
      // RPC response
      if (msg.type === 'res' && msg.id) {
        const pending = state.rpcPending.get(msg.id);
        if (pending) {
          state.rpcPending.delete(msg.id);
          clearTimeout(pending.timeout);
          
          if (msg.error) {
            pending.reject(new Error(msg.error?.message || 'RPC failed'));
          } else {
            pending.resolve(msg.payload ?? msg.result);
          }
        }
        return;
      }
      
      // Chat events (streaming)
      if (msg.type === 'event' && msg.event === 'chat') {
        handleChatEvent(msg.payload);
        return;
      }
      
      // Agent lifecycle events (for typing indicator)
      if (msg.type === 'event' && msg.event === 'agent') {
        handleAgentEvent(msg.payload);
        return;
      }
    }
    
    function sendConnect() {
      if (state.connectSent || !state.ws) return;
      state.connectSent = true;
      
      const connectId = String(++state.rpcIdCounter);
      
      const connectParams = {
        minProtocol: WS_PROTOCOL_VERSION,
        maxProtocol: WS_PROTOCOL_VERSION,
        client: {
          // Must be one of OpenClaw's allowed client IDs (see gateway protocol client-info)
          id: 'webchat-ui',
          displayName: 'ClawCondos Dashboard',
          mode: 'ui',
          version: '2.0.0',
          platform: 'browser'
        }
      };
      
      // Authenticate. Different deployments may require password or token.
      // We send both with the same user-provided secret for maximum compatibility.
      if (state.token) {
        connectParams.auth = { token: state.token, password: state.token };
      }
      
      const connectFrame = {
        type: 'req',
        id: connectId,
        method: 'connect',
        params: connectParams
      };
      
      console.log('[WS] Sending connect request');
      state.ws.send(JSON.stringify(connectFrame));
      
      const timeout = setTimeout(() => {
        state.rpcPending.delete(connectId);
        console.error('[WS] Connect timeout');
        state.ws?.close(1008, 'connect timeout');
      }, 10000);
      
      state.rpcPending.set(connectId, {
        resolve: (result) => {
          console.log('[WS] Connected successfully');
          state.connected = true;
          state.wsReconnectAttempts = 0;
          setConnectionStatus('connected');
          hideReconnectOverlay();
          if (state.token) localStorage.setItem('sharp_token', state.token);
          localStorage.setItem('sharp_gateway', state.gatewayUrl);
          hideLoginModal();
          startKeepalive();
          loadInitialData();

          // If user is currently viewing a session, reload history now that we are connected.
          if (state.currentView === 'chat' && state.currentSession?.key) {
            loadSessionHistory(state.currentSession.key, { preserve: true });
          }
        },
        reject: (err) => {
          console.error('[WS] Connect failed:', err);
          state.connectSent = false;
          setConnectionStatus('error');
          showLoginModal();
          const errorDiv = document.getElementById('loginError');
          if (errorDiv) {
            errorDiv.textContent = err.message || 'Authentication failed';
            errorDiv.style.display = 'block';
          }
        },
        timeout
      });
    }
    
    function handleAgentEvent(data) {
      const { sessionKey, runId, stream, data: eventData } = data;
      
      // Show typing indicator when agent starts working
      if (stream === 'lifecycle' && eventData?.phase === 'start') {
        if (state.currentSession?.key === sessionKey) {
          showTypingIndicator(runId);
        }
        if (state.currentView === 'goal' && state.goalChatSessionKey === sessionKey) {
          showTypingIndicator(runId, 'goal');
        }
        // Also set thinking status
        trackActiveRun(sessionKey, runId);
        state.sessionInputReady.set(sessionKey, false);
        if (state.sessionAgentStatus[sessionKey] !== 'thinking') {
          setSessionStatus(sessionKey, 'thinking');
        }
      }
      
      // Hide typing indicator when agent ends
      if (stream === 'lifecycle' && eventData?.phase === 'end') {
        hideTypingIndicator(runId);
        hideTypingIndicator(runId, 'goal');
      }
      
      // Show tool calls via compact activity indicator
      if (stream === 'tool' && state.currentSession?.key === sessionKey) {
        const toolCallId = eventData?.toolCallId || `${runId}-${eventData?.name}-${Date.now()}`;
        const toolName = eventData?.name || eventData?.tool || 'tool';
        const toolInput = eventData?.input || eventData?.args || '';
        const toolOutput = eventData?.output || eventData?.result || '';
        
        if (eventData?.phase === 'start' || eventData?.type === 'call') {
          trackToolStart(runId, toolCallId, toolName, toolInput);
        } else if (eventData?.phase === 'end' || eventData?.phase === 'result' || eventData?.type === 'result') {
          trackToolEnd(runId, toolCallId, toolName, toolOutput);
        }
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // COMPACT TOOL ACTIVITY INDICATOR
    // ═══════════════════════════════════════════════════════════════
    
    function getToolIcon(toolName) {
      const name = (toolName || '').toLowerCase();
      if (name.includes('read') || name.includes('file')) return '📄';
      if (name.includes('write') || name.includes('edit')) return '✏️';
      if (name.includes('exec') || name.includes('bash') || name.includes('shell')) return '⚡';
      if (name.includes('browser') || name.includes('web')) return '🌐';
      if (name.includes('search')) return '🔍';
      if (name.includes('image')) return '🖼️';
      if (name.includes('message') || name.includes('send')) return '💬';
      if (name.includes('cron') || name.includes('schedule')) return '⏰';
      if (name.includes('memory')) return '🧠';
      return '🔧';
    }
    
    function trackToolStart(runId, toolCallId, toolName, input) {
      hideTypingIndicator(runId);
      
      state.activeTools.set(toolCallId, {
        runId,
        name: toolName,
        args: input,
        output: null,
        startedAt: Date.now(),
        status: 'running'
      });
      
      renderToolActivity();
      scrollChatToBottom();
    }
    
    function trackToolEnd(runId, toolCallId, toolName, output) {
      // Find by toolCallId or by name (fallback)
      let tool = state.activeTools.get(toolCallId);
      if (!tool) {
        // Fallback: find most recent tool with same name
        for (const [id, t] of state.activeTools) {
          if (t.name === toolName && t.status === 'running') {
            toolCallId = id;
            tool = t;
            break;
          }
        }
      }
      
      if (tool) {
        tool.output = output;
        tool.status = 'done';
        tool.endedAt = Date.now();
        state.activeTools.set(toolCallId, tool);
      }
      
      renderToolActivity();
      
      // Clear completed tools after a delay (keep them visible briefly)
      setTimeout(() => {
        cleanupCompletedTools(runId);
      }, 3000);
    }
    
    function cleanupCompletedTools(runId) {
      // Only clean up if all tools for this run are done
      let allDone = true;
      for (const [id, tool] of state.activeTools) {
        if (tool.runId === runId && tool.status === 'running') {
          allDone = false;
          break;
        }
      }
      
      if (allDone) {
        // Remove all tools for this run
        for (const [id, tool] of state.activeTools) {
          if (tool.runId === runId) {
            state.activeTools.delete(id);
          }
        }
        renderToolActivity();
      }
    }
    
    function clearAllTools() {
      state.activeTools.clear();
      state.toolActivityExpanded = false;
      const el = document.getElementById('toolActivityIndicator');
      if (el) el.remove();
    }
    
    function toggleToolActivityExpanded() {
      state.toolActivityExpanded = !state.toolActivityExpanded;
      const el = document.getElementById('toolActivityIndicator');
      if (el) {
        el.classList.toggle('expanded', state.toolActivityExpanded);
      }
    }
    
    function renderToolActivity() {
      const container = document.getElementById('chatMessages');
      if (!container) return;
      
      let el = document.getElementById('toolActivityIndicator');
      
      // If no active tools, remove the indicator
      if (state.activeTools.size === 0) {
        if (el) el.remove();
        return;
      }
      
      // Count running vs done
      let runningCount = 0;
      let doneCount = 0;
      const tools = Array.from(state.activeTools.values());
      tools.forEach(t => t.status === 'running' ? runningCount++ : doneCount++);
      
      // Build pills HTML
      const pillsHtml = tools.slice(-5).map(t => {
        const icon = getToolIcon(t.name);
        const statusClass = t.status === 'done' ? 'done' : '';
        return `<span class="tool-activity-pill ${statusClass}">
          <span class="pill-icon">${icon}</span>
          <span>${escapeHtml(t.name)}</span>
        </span>`;
      }).join('');
      
      // Build details HTML
      const detailsHtml = tools.map(t => {
        const icon = getToolIcon(t.name);
        const statusClass = t.status === 'running' ? 'running' : 'done';
        const statusText = t.status === 'running' ? '⏳ running' : '✓ done';
        const argsStr = t.args ? (typeof t.args === 'string' ? t.args : JSON.stringify(t.args, null, 2)) : '';
        const outputStr = t.output ? (typeof t.output === 'string' ? t.output : JSON.stringify(t.output, null, 2)) : '';
        const contentStr = outputStr ? `${argsStr}\n\n--- Result ---\n${outputStr}` : argsStr;
        
        return `<div class="tool-activity-item">
          <div class="tool-activity-item-header">
            <span class="tool-activity-item-icon">${icon}</span>
            <span class="tool-activity-item-name">${escapeHtml(t.name)}</span>
            <span class="tool-activity-item-status ${statusClass}">${statusText}</span>
          </div>
          ${contentStr ? `<div class="tool-activity-item-content collapsed">${escapeHtml(contentStr)}</div>` : ''}
        </div>`;
      }).join('');
      
      const labelText = runningCount > 0 
        ? `Working... (${runningCount} active${doneCount > 0 ? `, ${doneCount} done` : ''})`
        : `${doneCount} tool${doneCount !== 1 ? 's' : ''} completed`;
      
      const showSpinner = runningCount > 0;
      
      if (!el) {
        el = document.createElement('div');
        el.id = 'toolActivityIndicator';
        el.className = 'tool-activity';
        container.appendChild(el);
      }
      
      if (state.toolActivityExpanded) {
        el.classList.add('expanded');
      }
      
      el.innerHTML = `
        <div class="tool-activity-header" onclick="toggleToolActivityExpanded()">
          ${showSpinner ? '<div class="tool-activity-spinner"></div>' : '<span style="color: var(--green);">✓</span>'}
          <span class="tool-activity-label">${labelText}</span>
          <div class="tool-activity-tools">${pillsHtml}</div>
          <span class="tool-activity-expand">▼</span>
        </div>
        <div class="tool-activity-details">${detailsHtml}</div>
      `;
      
      scrollChatToBottom();
    }
    
    // Legacy function for compatibility - now uses compact indicator
    function addToolCall(runId, toolName, input) {
      const toolCallId = `${runId}-${toolName}-${Date.now()}`;
      trackToolStart(runId, toolCallId, toolName, input);
    }
    
    function updateToolCallResult(runId, toolName, output) {
      // Find most recent tool with this name
      for (const [id, tool] of state.activeTools) {
        if (tool.name === toolName && tool.status === 'running') {
          trackToolEnd(runId, id, toolName, output);
          return;
        }
      }
      // Fallback: legacy behavior
      const toolCalls = document.querySelectorAll('.tool-call');
      for (let i = toolCalls.length - 1; i >= 0; i--) {
        const nameEl = toolCalls[i].querySelector('.tool-call-name');
        if (nameEl && nameEl.textContent === toolName) {
          const contentEl = toolCalls[i].querySelector('.tool-call-content pre');
          if (contentEl) {
            const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
            contentEl.textContent += '\n\n--- Result ---\n' + outputStr;
          }
          break;
        }
      }
    }
    
    async function handleChatEvent(data) {
      const { sessionKey, runId, state: runState, message } = data;
      
      console.log('[ClawCondos] Chat event:', runState, 'for', sessionKey, 'runId:', runId);
      
      // Server sends: 'delta' (streaming), 'final' (done), 'error'
      // Track active runs and update agent status (with persistence)
      if (runState === 'delta') {
        trackActiveRun(sessionKey, runId);
        state.sessionInputReady.set(sessionKey, false);
        if (state.sessionAgentStatus[sessionKey] !== 'thinking') {
          setSessionStatus(sessionKey, 'thinking');
        }

        // Keep Goal session state pill live.
        if (state.currentView === 'goal' && state.goalChatSessionKey === sessionKey) {
          const goal = state.goals.find(g => g.id === state.currentGoalOpenId) || getGoalForSession(sessionKey);
          try { updateGoalSessionStatePill(goal); } catch {}
        }

        // If we haven't received content yet, show typing indicator.
        // (Some providers stream slowly; this keeps UI responsive.)
        if (!message?.content) {
          if (state.currentSession?.key === sessionKey) showTypingIndicator(runId, '');
          if (state.currentView === 'goal' && state.goalChatSessionKey === sessionKey) showTypingIndicator(runId, 'goal');
        }

        // Stream content
        if (message?.content) {
          const text = extractText(message.content);
          if (text) {
            if (state.currentSession?.key === sessionKey) updateStreamingMessage(runId, text, '');
            if (state.currentView === 'goal' && state.goalChatSessionKey === sessionKey) updateStreamingMessage(runId, text, 'goal');
          }
        }
      } else if (runState === 'final') {
        // Response complete
        clearActiveRun(sessionKey);
        state.sessionInputReady.set(sessionKey, true);
        setSessionStatus(sessionKey, 'idle');

        if (state.currentView === 'goal' && state.goalChatSessionKey === sessionKey) {
          const goal = state.goals.find(g => g.id === state.currentGoalOpenId) || getGoalForSession(sessionKey);
          try { updateGoalSessionStatePill(goal); } catch {}
        }
        
        // Check if this is a categorization/wizard response (from main session)
        if (sessionKey === 'agent:main:main' && message?.content) {
          const text = extractText(message.content);
          if (text) {
            // Check wizard first
            if (state.wizardPendingSessionKey && text.includes('"goalId"')) {
              handleWizardResponse(text);
            }
            // Check single-session categorization
            else if (state.suggestingSessionKey && text.includes('"suggestions"')) {
              handleCategorizationResponse(text);
            }
          }
        }
        
        if (state.currentSession?.key === sessionKey) {
          state.isThinking = false;
          updateSendButton();
          
          // Clear tool activity indicator after brief delay
          setTimeout(() => clearAllTools(), 2000);
          
          // Finalize streaming message or add new one
          if (message?.content) {
            const text = extractText(message.content);
            if (text) {
              finalizeStreamingMessage(runId, text, '');
              // Auto-apply goal patches when agent updates tasks/status.
              try { await maybeAutoApplyGoalPatch(sessionKey, text); } catch {}
            }
          } else {
            removeStreamingMessage(runId, '');
          }
        }

        // Finalize in goal view if it's showing the same session
        if (state.currentView === 'goal' && state.goalChatSessionKey === sessionKey) {
          if (message?.content) {
            const text = extractText(message.content);
            if (text) {
              finalizeStreamingMessage(runId, text, 'goal');
              try { await maybeAutoApplyGoalPatch(sessionKey, text); } catch {}
            }
          } else {
            removeStreamingMessage(runId, 'goal');
          }
        }
      } else if (runState === 'error' || runState === 'aborted') {
        clearActiveRun(sessionKey);
        state.sessionInputReady.set(sessionKey, true);
        setSessionStatus(sessionKey, runState === 'error' ? 'error' : 'idle');

        if (state.currentView === 'goal' && state.goalChatSessionKey === sessionKey) {
          const goal = state.goals.find(g => g.id === state.currentGoalOpenId) || getGoalForSession(sessionKey);
          try { updateGoalSessionStatePill(goal); } catch {}
        }
        
        if (state.currentSession?.key === sessionKey) {
          state.isThinking = false;
          updateSendButton();
          removeStreamingMessage(runId, '');
          clearAllTools();  // Clear tool activity on error/abort
          const msg = data.errorMessage || data.stopReason || (runState === 'aborted' ? 'Run aborted' : 'Run failed');
          if (msg) {
            addChatMessageTo('', 'system', `⚠️ ${msg}`);
            showToast(msg, /timeout|rate_limit|429/i.test(msg) ? 'warning' : 'error', 8000);
          }
        }

        if (state.currentView === 'goal' && state.goalChatSessionKey === sessionKey) {
          removeStreamingMessage(runId, 'goal');
          const msg = data.errorMessage || data.stopReason || (runState === 'aborted' ? 'Run aborted' : 'Run failed');
          if (msg) addChatMessageTo('goal', 'system', `⚠️ ${msg}`);
        }
      }
    }
    
    // Typing indicator (bouncing dots)
    function showTypingIndicator(runId, prefix = '') {
      if (document.getElementById(`streaming-${runId}`)) return;

      const typingId = prefix ? `${prefix}-typing-${runId}` : `typing-${runId}`;
      let el = document.getElementById(typingId);
      if (el) return;

      const containerId = prefix ? `${prefix}_chatMessages` : 'chatMessages';
      const container = document.getElementById(containerId);
      if (!container) return;

      el = document.createElement('div');
      el.id = typingId;
      el.className = 'typing-indicator';
      el.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
      container.appendChild(el);

      if (prefix) scrollChatPanelToBottom(prefix);
      else scrollChatToBottom();
    }
    
    function hideTypingIndicator(runId, prefix = '') {
      const typingId = prefix ? `${prefix}-typing-${runId}` : `typing-${runId}`;
      const el = document.getElementById(typingId);
      if (el) el.remove();
    }
    
    // Streaming message management
    function updateStreamingMessage(runId, text, prefix = '') {
      // Hide typing indicator when content arrives
      hideTypingIndicator(runId, prefix);

      // Buffer streaming text and render at most once per animation frame.
      state.streamingBuffers.set(runId, text);
      if (state.streamingRaf.has(runId)) return;

      const raf = requestAnimationFrame(() => {
        state.streamingRaf.delete(runId);
        const latest = state.streamingBuffers.get(runId) || '';

        let el = document.getElementById(`streaming-${runId}`);
        if (!el) {
          // Remove old thinking indicator (scope to container)
          const containerId = prefix ? `${prefix}_chatMessages` : 'chatMessages';
          const container = document.getElementById(containerId);
          if (!container) return;
          const thinking = container.querySelector('.message.thinking');
          if (thinking) thinking.remove();

          el = document.createElement('div');
          el.id = `streaming-${runId}`;
          el.className = 'message assistant streaming';
          el.dataset.startTime = Date.now();
          container.appendChild(el);
        }

        el.innerHTML = `<div class="message-content">${formatMessage(latest)}<span class="streaming-cursor">▊</span></div>`;
        if (prefix) scrollChatPanelToBottom(prefix);
        else scrollChatToBottom();
      });

      state.streamingRaf.set(runId, raf);
    }
    
    function finalizeStreamingMessage(runId, text, prefix = '') {
      // If provider sends only a final frame (no deltas with content), we may have shown
      // a typing indicator. Always clear it when final content arrives.
      hideTypingIndicator(runId, prefix);

      const el = document.getElementById(`streaming-${runId}`);
      if (el) {
        el.classList.remove('streaming');
        const timeStr = formatMessageTime(new Date());
        el.innerHTML = `<div class="message-content">${formatMessage(text)}</div><div class="message-time">${timeStr}</div>`;
      } else if (text) {
        // No streaming element, add final message
        const containerId = prefix ? `${prefix}_chatMessages` : 'chatMessages';
        const container = document.getElementById(containerId);
        const thinking = container ? container.querySelector('.message.thinking') : document.querySelector('.message.thinking');
        if (thinking) thinking.remove();
        addChatMessageTo(prefix, 'assistant', text);
      }
    }

    function finalizeAllStreamingMessages(reason = 'disconnected') {
      const now = new Date();
      const timeStr = formatMessageTime(now);
      const note = reason ? ` (${reason})` : '';

      document.querySelectorAll('.message.assistant.streaming').forEach(el => {
        el.classList.remove('streaming');
        const cursor = el.querySelector('.streaming-cursor');
        if (cursor) cursor.remove();

        let timeEl = el.querySelector('.message-time');
        if (!timeEl) {
          timeEl = document.createElement('div');
          timeEl.className = 'message-time';
          el.appendChild(timeEl);
        }

        if (!timeEl.textContent.includes(note.trim())) {
          timeEl.textContent = `${timeStr}${note}`;
        }
      });

      for (const rafId of state.streamingRaf.values()) {
        cancelAnimationFrame(rafId);
      }
      state.streamingRaf.clear();
      state.streamingBuffers.clear();
    }
    
    function removeStreamingMessage(runId, prefix = '') {
      const el = document.getElementById(`streaming-${runId}`);
      if (el) el.remove();
      hideTypingIndicator(runId, prefix);

      const containerId = prefix ? `${prefix}_chatMessages` : 'chatMessages';
      const container = document.getElementById(containerId);
      const thinking = container ? container.querySelector('.message.thinking') : document.querySelector('.message.thinking');
      if (thinking) thinking.remove();
    }
    
    // ═══════════════════════════════════════════════════════════════
    // RPC
    // ═══════════════════════════════════════════════════════════════
    function rpcCall(method, params = {}, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        if (!state.connected || !state.ws) {
          reject(new Error('WebSocket not connected'));
          return;
        }
        
        const id = String(++state.rpcIdCounter);
        const frame = { type: 'req', id, method, params };
        
        const timeout = setTimeout(() => {
          state.rpcPending.delete(id);
          reject(new Error('RPC timeout'));
        }, timeoutMs);
        
        state.rpcPending.set(id, { resolve, reject, timeout });
        state.ws.send(JSON.stringify(frame));
      });
    }
    
    // ═══════════════════════════════════════════════════════════════
    // TIMERS
    // ═══════════════════════════════════════════════════════════════
    function clearWsTimers() {
      if (state.wsReconnectTimer) {
        clearTimeout(state.wsReconnectTimer);
        state.wsReconnectTimer = null;
      }
      if (state.wsKeepaliveTimer) {
        clearInterval(state.wsKeepaliveTimer);
        state.wsKeepaliveTimer = null;
      }
      if (state.wsStaleTimer) {
        clearTimeout(state.wsStaleTimer);
        state.wsStaleTimer = null;
      }
    }
    
    function scheduleReconnect() {
      if (state.wsReconnectTimer) return;
      
      const delay = RECONNECT_DELAYS[Math.min(state.wsReconnectAttempts, RECONNECT_DELAYS.length - 1)];
      state.wsReconnectAttempts++;
      
      // Show reconnect overlay
      showReconnectOverlay(state.wsReconnectAttempts);
      
      console.log(`[WS] Reconnecting in ${delay}ms (attempt ${state.wsReconnectAttempts})`);
      state.wsReconnectTimer = setTimeout(() => {
        state.wsReconnectTimer = null;
        connectWebSocket();
      }, delay);
    }
    
    function showReconnectOverlay(attempt) {
      const overlay = document.getElementById('reconnectOverlay');
      const attemptEl = document.getElementById('reconnectAttempt');
      if (overlay) {
        overlay.classList.add('visible');
        if (attemptEl) attemptEl.textContent = `Attempt ${attempt}`;
      }
    }
    
    function hideReconnectOverlay() {
      const overlay = document.getElementById('reconnectOverlay');
      if (overlay) overlay.classList.remove('visible');
    }
    
    function startKeepalive() {
      if (state.wsKeepaliveTimer) clearInterval(state.wsKeepaliveTimer);
      
      state.wsKeepaliveTimer = setInterval(() => {
        if (state.connected && state.ws) {
          state.ws.send(JSON.stringify({ type: 'req', id: 'keepalive', method: 'status', params: {} }));
        }
      }, 25000);
    }
    
    function resetStaleTimer() {
      if (state.wsStaleTimer) clearTimeout(state.wsStaleTimer);
      
      state.wsStaleTimer = setTimeout(() => {
        const sinceLastMessage = Date.now() - state.wsLastMessageAt;
        if (sinceLastMessage > 60000) {
          console.log('[WS] Connection stale, reconnecting...');
          state.ws?.close(1000, 'stale');
        }
      }, 65000);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // CONNECTION STATUS
    // ═══════════════════════════════════════════════════════════════
    function setConnectionStatus(status) {
      state.connectionStatus = status;
      const dot = document.getElementById('connectionDot');
      const text = document.getElementById('connectionText');
      
      switch (status) {
        case 'connected':
          dot.style.background = 'var(--green)';
          text.textContent = 'Connected';
          // Clear offline status for all sessions when reconnected
          for (const key of Object.keys(state.sessionAgentStatus)) {
            if (state.sessionAgentStatus[key] === 'offline') {
              state.sessionAgentStatus[key] = 'idle';
            }
          }
          break;
        case 'connecting':
          dot.style.background = 'var(--yellow)';
          text.textContent = 'Connecting...';
          break;
        case 'error':
          dot.style.background = 'var(--red)';
          text.textContent = 'Disconnected';
          // Set all sessions to offline when disconnected
          for (const key of Object.keys(state.sessionAgentStatus)) {
            state.sessionAgentStatus[key] = 'offline';
          }
          renderSessions();
          updateHeaderStatus();
          if (state.currentView === 'goal') {
            const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
            updateGoalSessionStatePill(goal);
          }
          break;
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // AGENT STATUS
    // ═══════════════════════════════════════════════════════════════
    
    // Persist active runs to localStorage so we can restore on page load
    const ACTIVE_RUN_STALE_MS = 5 * 60 * 1000; // 5 minutes - consider run stale if no updates
    
    function saveActiveRuns() {
      const obj = {};
      for (const [key, data] of Object.entries(state.activeRunsStore)) {
        obj[key] = data;
      }
      lsSet('active_runs', JSON.stringify(obj));
    }
    
    function restoreActiveRuns() {
      // Restore from localStorage and clean stale entries
      const now = Date.now();
      const store = state.activeRunsStore;
      let changed = false;
      
      for (const [key, data] of Object.entries(store)) {
        const age = now - (data.startedAt || 0);
        if (age > ACTIVE_RUN_STALE_MS) {
          // Stale run - remove it
          delete store[key];
          changed = true;
          console.log(`[ClawCondos] Cleaned stale run for ${key} (${Math.round(age/1000)}s old)`);
        } else {
          // Valid run - restore to activeRuns Map
          state.activeRuns.set(key, data.runId);
          state.sessionAgentStatus[key] = 'thinking';
          console.log(`[ClawCondos] Restored active run for ${key}`);
        }
      }
      
      if (changed) {
        saveActiveRuns();
      }
    }
    
    function hasFreshActiveRun(sessionKey) {
      const data = state.activeRunsStore?.[sessionKey];
      if (!data?.runId) return false;
      const age = Date.now() - (data.startedAt || 0);
      return age >= 0 && age <= ACTIVE_RUN_STALE_MS;
    }

    function trackActiveRun(sessionKey, runId) {
      state.activeRuns.set(sessionKey, runId);
      state.activeRunsStore[sessionKey] = { runId, startedAt: Date.now() };
      saveActiveRuns();
    }
    
    function clearActiveRun(sessionKey) {
      state.activeRuns.delete(sessionKey);
      delete state.activeRunsStore[sessionKey];
      saveActiveRuns();
    }
    
    function setSessionStatus(key, status) {
      state.sessionAgentStatus[key] = status;
      localStorage.setItem('sharp_session_agent_status', JSON.stringify(state.sessionAgentStatus));
      renderSessions();
      renderSessionsGrid();
      updateHeaderStatus();
      if (state.currentView === 'goal' && state.goalChatSessionKey === key) {
        const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
        updateGoalSessionStatePill(goal);
      }

      // Auto-clear transient statuses
      if (status === 'sent') {
        setTimeout(() => {
          if (state.sessionAgentStatus[key] === 'sent') {
            state.sessionAgentStatus[key] = 'idle';
            localStorage.setItem('sharp_session_agent_status', JSON.stringify(state.sessionAgentStatus));
            renderSessions();
            renderSessionsGrid();
            updateHeaderStatus();
          }
        }, 1500);
      }
    }
    
    function getAgentStatus(key) {
      return state.sessionAgentStatus[key] || 'idle';
    }

    function deriveSessionBlinker(sessionKey, opts = {}) {
      const goalId = opts?.goalId || null;
      // If a goal has no session yet, it should not render as Disconnected.
      // Reserve "Disconnected" for real gateway disconnects or explicit offline session status.
      const agentStatus = sessionKey ? getAgentStatus(sessionKey) : 'idle';
      const isDisconnected = state.connectionStatus === 'error' || (sessionKey && agentStatus === 'offline');
      const hasQueue = !!(sessionKey && state.messageQueue?.some?.(m => m.sessionKey === sessionKey));
      const isRunning = !!(sessionKey && (state.activeRuns?.has?.(sessionKey) || agentStatus === 'thinking' || agentStatus === 'running'));
      const isError = agentStatus === 'error' || agentStatus === 'rate_limited';
      const isNeedsUser = agentStatus === 'needs_user';
      const isBlocked = !!(goalId && isGoalBlocked(state.goals?.find(g => g.id === goalId)));
      const isIdle = ['idle', 'ready', 'canceled', 'sent'].includes(agentStatus);

      // 3-color mapping (Albert preference)
      // - Idle: black
      // - Active (running/thinking/queued): blue
      // - Disconnected OR needs-attention (error/blocked/needs_user): orange

      if (isDisconnected) return { state: 'offline', label: 'Disconnected', colorClass: 'blink-offline' };
      if (isError) return { state: agentStatus, label: agentStatus === 'rate_limited' ? 'Rate limited' : 'Error', colorClass: 'blink-error' };
      if (isBlocked) return { state: 'blocked', label: 'Blocked', colorClass: 'blink-blocked' };
      if (isNeedsUser) return { state: 'needs_user', label: 'Needs input', colorClass: 'blink-needs-user' };

      if (hasQueue) return { state: 'queued', label: 'Queued', colorClass: 'blink-queued' };
      if (isRunning) return { state: agentStatus === 'thinking' ? 'thinking' : 'running', label: agentStatus === 'thinking' ? 'Thinking' : 'Running', colorClass: 'blink-running' };

      if (isIdle) return { state: agentStatus, label: agentStatus === 'canceled' ? 'Canceled' : agentStatus === 'ready' ? 'Ready' : 'Idle', colorClass: 'blink-idle' };
      return { state: agentStatus || 'idle', label: agentStatus || 'Idle', colorClass: 'blink-idle' };
    }
    
    function getStatusTooltip(status) {
      switch (status) {
        case 'idle': return 'Ready';
        case 'thinking': return 'Processing...';
        case 'error': return 'Last request failed';
        case 'offline': return 'Disconnected';
        case 'sent': return 'Sent';
        default: return status;
      }
    }
    
    function updateHeaderStatus() {
      const indicator = document.getElementById('headerStatusIndicator');
      if (!indicator || !state.currentSession) return;
      
      const status = getAgentStatus(state.currentSession.key);
      indicator.className = 'header-status ' + status;
      indicator.setAttribute('data-tooltip', getStatusTooltip(status));
    }
    
    // ═══════════════════════════════════════════════════════════════
    // CONNECTION DIAGNOSTICS
    // ═══════════════════════════════════════════════════════════════
    function computeWsUrlForDiagnostics() {
      let wsUrl = (state.gatewayUrl || '').replace(/^http/, 'ws');
      if (wsUrl && !wsUrl.includes(':18789')) {
        wsUrl = wsUrl.replace(/\/?$/, '/clawcondos-ws');
      }
      return wsUrl;
    }

    function buildConnectionDiagnosticsText() {
      const wsUrl = computeWsUrlForDiagnostics();
      const lines = [];
      lines.push('ClawCondos connection diagnostics');
      lines.push('time: ' + new Date().toISOString());
      lines.push('page: ' + window.location.href);
      lines.push('gatewayUrl: ' + (state.gatewayUrl || '')); 
      lines.push('wsUrl: ' + (wsUrl || ''));
      lines.push('status: ' + (state.connectionStatus || (state.connected ? 'connected' : 'unknown')));
      lines.push('connected: ' + String(!!state.connected));
      lines.push('reconnectAttempts: ' + String(state.wsReconnectAttempts || 0));
      lines.push('lastConnectAttemptAt: ' + (state.wsLastConnectAttemptAt ? new Date(state.wsLastConnectAttemptAt).toISOString() : 'n/a'));
      lines.push('lastMessageAt: ' + (state.wsLastMessageAt ? new Date(state.wsLastMessageAt).toISOString() : 'n/a'));
      if (state.wsLastClose) {
        lines.push('lastClose: ' + JSON.stringify({
          code: state.wsLastClose.code,
          reason: state.wsLastClose.reason,
          at: new Date(state.wsLastClose.at).toISOString()
        }));
      } else {
        lines.push('lastClose: n/a');
      }
      lines.push('lastError: ' + (state.wsLastError || 'n/a'));
      lines.push('protocol: ' + String(WS_PROTOCOL_VERSION));
      lines.push('client: webchat-ui / ClawCondos Dashboard v2.0.0');
      lines.push('tokenPresent: ' + String(!!state.token));
      lines.push('userAgent: ' + (navigator.userAgent || ''));
      return lines.join('\n');
    }

    function showConnectionDetailsModal(ev) {
      // Power users: Shift-click goes straight to login.
      if (ev && ev.shiftKey) {
        showLoginModal();
        return;
      }
      const modal = document.getElementById('connectionDetailsModal');
      const pre = document.getElementById('connectionDetailsText');
      const err = document.getElementById('connectionDetailsError');
      if (!modal || !pre) return;
      if (err) { err.style.display = 'none'; err.textContent = ''; }
      pre.textContent = buildConnectionDiagnosticsText();
      modal.classList.remove('hidden');
    }

    function hideConnectionDetailsModal() {
      const modal = document.getElementById('connectionDetailsModal');
      if (modal) modal.classList.add('hidden');
    }

    async function copyConnectionDetailsToClipboard() {
      const text = buildConnectionDiagnosticsText();
      const err = document.getElementById('connectionDetailsError');
      try {
        await navigator.clipboard.writeText(text);
        showToast('Copied connection details', 'success');
      } catch (e) {
        // Fallback for older browsers / permissions
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          showToast('Copied connection details', 'success');
        } catch (e2) {
          if (err) {
            err.textContent = 'Clipboard copy failed. You can manually select the text and copy.';
            err.style.display = 'block';
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // LOGIN
    // ═══════════════════════════════════════════════════════════════
    function showLoginModal() {
      document.getElementById('loginModal').classList.remove('hidden');
      document.getElementById('loginPassword').focus();
    }
    
    function hideLoginModal() {
      document.getElementById('loginModal').classList.add('hidden');
      document.getElementById('loginError').style.display = 'none';
    }
    
    function doLogin() {
      const password = document.getElementById('loginPassword').value.trim();
      if (!password) return;
      
      state.token = password;
      state.connectSent = false;
      
      // Save to localStorage for future sessions
      localStorage.setItem('sharp_token', password);
      
      if (state.ws && state.connectNonce) {
        sendConnect();
      } else {
        connectWebSocket();
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // DATA LOADING
    // ═══════════════════════════════════════════════════════════════
    async function loadInitialData() {
      console.log('[ClawCondos] loadInitialData starting - v2');
      try {
        // Load persisted session->condo mappings (doesn't require gateway connection)
        await loadSessionCondos();

        // Fetch active runs from server first (authoritative source)
        console.log('[ClawCondos] About to call syncActiveRunsFromServer...');
        await syncActiveRunsFromServer();
        console.log('[ClawCondos] syncActiveRunsFromServer completed');

        await Promise.all([loadGoals(), loadSessions(), loadApps(), loadAgents()]);
        updateOverview();
        updateStatsGrid();
        
        // Restore previous session if any
        const savedSessionKey = localStorage.getItem('sharp_current_session');
        if (savedSessionKey) {
          const session = state.sessions.find(s => s.key === savedSessionKey);
          if (session) {
            console.log('[ClawCondos] Restoring session:', savedSessionKey);
            openSession(savedSessionKey);
          }
        }
      } catch (err) {
        console.error('Failed to load initial data:', err);
      }
    }
    
    async function syncActiveRunsFromServer() {
      try {
        console.log('[ClawCondos] Calling chat.activeRuns...');
        const result = await rpcCall('chat.activeRuns', {});
        console.log('[ClawCondos] chat.activeRuns response:', JSON.stringify(result));
        if (result?.activeRuns) {
          console.log('[ClawCondos] Synced active runs from server:', result.activeRuns.length);
          
          // Clear old state and sync with server
          state.activeRuns.clear();
          state.activeRunsStore = {};
          
          for (const run of result.activeRuns) {
            console.log('[ClawCondos] Setting thinking for:', run.sessionKey);
            state.activeRuns.set(run.sessionKey, run.runId);
            state.activeRunsStore[run.sessionKey] = {
              runId: run.runId,
              startedAt: run.startedAtMs
            };
            state.sessionAgentStatus[run.sessionKey] = 'thinking';
          }
          
          saveActiveRuns();
          renderSessions();
          renderSessionsGrid();
        } else {
          console.log('[ClawCondos] No activeRuns in response, result:', result);
        }
      } catch (err) {
        console.error('[ClawCondos] chat.activeRuns error:', err);
        // Fallback to localStorage restore (for older Clawdbot versions)
        restoreActiveRuns();
      }
    }
    
    async function loadSessionCondos() {
      try {
        const res = await fetch('/api/session-condos');
        if (!res.ok) return;
        const data = await res.json();
        state.sessionCondoIndex = data.sessionCondoIndex || {};
      } catch (err) {
        console.warn('[ClawCondos] Failed to load session condos:', err);
      }
    }

    function isSystemCondoSession(session) {
      const k = String(session?.key || '');
      if (!k.startsWith('agent:')) return false;
      // Heartbeats + internal scheduled runs generally show up as cron sessions.
      if (k.includes(':cron:')) return true;
      if (k.includes(':heartbeat:')) return true;
      return false;
    }

    async function persistSessionCondo(sessionKey, condoId) {
      const key = String(sessionKey || '').trim();
      const cid = String(condoId || '').trim();
      if (!key || !cid) return;
      if (state.sessionCondoIndex?.[key] === cid) return;

      // Optimistic local write
      state.sessionCondoIndex = state.sessionCondoIndex || {};
      state.sessionCondoIndex[key] = cid;

      // Best-effort persist (data-level)
      try {
        await fetch('/api/session-condo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey: key, condoId: cid }),
        });
      } catch (err) {
        console.warn('persistSessionCondo failed:', err.message || err);
      }
    }

    async function loadGoals() {
      try {
        const res = await fetch('/api/goals');
        if (!res.ok) return;
        const data = await res.json();
        state.goals = (data.goals || []).map(g => {
          if (!g.condoId && Array.isArray(g.sessions) && g.sessions.length > 0) {
            g.condoId = getCondoIdForSessionKey(g.sessions[0]);
          }
          return g;
        });
        renderGoals();
        renderGoalsGrid();
        updateUncategorizedCount();

        if (state.pendingRouteGoalId) {
          const pending = state.pendingRouteGoalId;
          state.pendingRouteGoalId = null;
          if (state.goals.find(x => x.id === pending)) {
            openGoal(pending, { fromRouter: true });
          }
        }

        if (state.pendingRouteNewSession) {
          const pending = state.pendingRouteNewSession;
          state.pendingRouteNewSession = null;
          state.newSessionCondoId = pending?.condoId || state.currentCondoId;
          state.attachGoalId = pending?.goalId || null;
          showNewSessionView({ fromRouter: true });
        }

        if (state.pendingRouteNewGoalCondoId !== null) {
          const pending = state.pendingRouteNewGoalCondoId;
          state.pendingRouteNewGoalCondoId = null;
          state.newGoalCondoId = pending || state.currentCondoId;
          showNewGoalView({ fromRouter: true });
        }
      } catch (err) {
        console.error('[ClawCondos] Failed to load goals:', err);
      }
    }
    
    function updateUncategorizedCount() {
      const el = document.getElementById('uncategorizedCount');
      if (!el) return;
      
      const sessions = (state.sessions || []).filter(s => !s.key.includes(':subagent:'));
      const goals = state.goals || [];
      
      const assignedSessions = new Set();
      goals.forEach(g => (g.sessions || []).forEach(s => assignedSessions.add(s)));
      const uncatCount = sessions.filter(s => !assignedSessions.has(s.key)).length;
      
      if (uncatCount > 0) {
        el.textContent = `${uncatCount} uncategorized`;
      } else {
        el.textContent = '';
      }
    }

    // Update stats grid with current counts
    function updateStatsGrid() {
      const sessions = state.sessions || [];
      const goals = state.goals || [];
      const runs = state.runs || {};
      
      // Active sessions: sessions with recent activity or active runs
      const activeRuns = Object.keys(runs).filter(k => runs[k] && runs[k] !== 'done');
      const activeSessions = activeRuns.length;
      
      // Pending goals: goals with status !== 'done'
      const pendingGoals = goals.filter(g => !isGoalCompleted(g)).length;
      
      // Completed goals
      const completedGoals = goals.filter(g => isGoalCompleted(g)).length;
      
      // Errors: sessions with error state
      const errorCount = sessions.filter(s => s.lastError || (runs[s.key] && runs[s.key] === 'error')).length;
      
      // Update DOM
      const elActive = document.getElementById('statActiveSessions');
      const elTrend = document.getElementById('statSessionsTrend');
      const elPending = document.getElementById('statPendingGoals');
      const elCompleted = document.getElementById('statCompletedGoals');
      const elErrors = document.getElementById('statErrors');
      
      if (elActive) elActive.textContent = activeSessions;
      if (elTrend) {
        // Prototype uses a small trend line (e.g. "↑ 3 today").
        // We don't have reliable "today" deltas yet, so keep it empty for now.
        elTrend.textContent = '';
      }
      if (elPending) elPending.textContent = pendingGoals;
      if (elCompleted) elCompleted.textContent = completedGoals;
      if (elErrors) {
        elErrors.textContent = errorCount;
        elErrors.classList.toggle('stat-error', errorCount > 0);
      }
    }

    // Scroll to a section by element ID
    function scrollToSection(sectionId) {
      const el = document.getElementById(sectionId);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Filter goals grid by status (pending/done)
    function filterGoalsByStatus(status) {
      const goalsSection = document.getElementById('goalsSection');
      if (goalsSection) goalsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // TODO: Add actual filtering UI (highlight matching goals)
      showToast(`Showing ${status === 'done' ? 'completed' : 'pending'} goals`, 'info');
    }

    // Show sessions with errors
    function showErrorSessions() {
      const sessions = state.sessions || [];
      const runs = state.runs || {};
      const errorSessions = sessions.filter(s => s.lastError || (runs[s.key] && runs[s.key] === 'error'));
      
      if (errorSessions.length === 0) {
        showToast('No sessions with errors', 'info');
        return;
      }
      
      // Scroll to sessions and show toast with count
      scrollToSection('sessionsGrid');
      showToast(`${errorSessions.length} session(s) with errors`, 'error');
      // TODO: Add visual highlighting of error sessions
    }

    function renderGoals() {
      renderSidebar();
    }

    // Back-compat alias (some helper functions call renderCondos)
    function renderCondos() {
      renderSidebar();
    }

    function setCurrentGoal(goalId, condoId = null) {
      state.currentGoalId = goalId;
      if (condoId) state.currentCondoId = condoId;
      renderSidebar();
      renderSessionsGrid();
      updateOverview();
    }

    function renderSidebar() {
      const container = document.getElementById('sessionsList');
      const archivedToggle = document.getElementById('showArchivedToggle');
      if (!container) return;

      const archivedCount = state.sessions.filter(s => isSessionArchived(s.key)).length;
      if (archivedToggle) {
        archivedToggle.style.display = archivedCount > 0 ? 'flex' : 'none';
        archivedToggle.querySelector('input').checked = state.showArchived;
      }

      const markAllReadBtn = document.getElementById('markAllReadBtn');
      if (markAllReadBtn) {
        const unreadCount = getUnreadCount();
        markAllReadBtn.style.display = unreadCount > 0 ? 'inline-flex' : 'none';
        markAllReadBtn.title = `Mark all read (${unreadCount})`;
      }

      const cutoff = Date.now() - SIDEBAR_HIDE_INACTIVE_MS;
      const visibleSessions = state.sessions.filter(s => {
        if (s.key.includes(':subagent:')) return false;
        if (isSessionArchived(s.key) && !state.showArchived) return false;
        if (!matchesSearch(s)) return false;

        // Hide inactive sessions from sidebar after 15 minutes.
        // Exceptions: pinned sessions, sessions with a fresh active run, and unread sessions.
        const pinned = isSessionPinned(s.key);
        const unread = isSessionUnread(s.key);
        const running = hasFreshActiveRun(s.key) || getAgentStatus(s.key) === 'thinking';
        const updatedAt = Number(s.updatedAt || s.updatedAtMs || 0);

        if (!state.showArchived && !pinned && !unread && !running && updatedAt > 0 && updatedAt < cutoff) {
          return false;
        }

        return true;
      });

      const activeGoals = (state.goals || []).filter(g => !isGoalCompleted(g) && !isGoalDropped(g) && Array.isArray(g.sessions) && g.sessions.length > 0);
      const goalById = new Map(activeGoals.map(g => [g.id, g]));
      const sessionToGoal = new Map();
      for (const g of activeGoals) {
        (g.sessions || []).forEach(s => sessionToGoal.set(s, g.id));
      }

      const condos = new Map();
      const condoNameForId = (condoId, fallbackSession) => {
        if (condoId === 'condo:genlayer') return 'GenLayer';
        if (condoId === 'condo:clawcondos') return 'ClawCondos';
        if (condoId === 'condo:rally') return 'Rally';
        if (condoId === 'condo:moltcourt') return 'MoltCourt';
        if (condoId === 'condo:personal') return 'Personal';
        if (condoId === 'condo:finances') return 'Finances';
        if (condoId === 'condo:subastas') return 'Subastas';
        if (condoId === 'condo:system') return 'SYSTEM';
        if (condoId?.startsWith('condo:')) return condoId.split(':').slice(1).join(':');
        return fallbackSession ? getSessionCondoName(fallbackSession) : 'Condo';
      };

      const sessionByKey = new Map((state.sessions || []).map(s => [s.key, s]));
      for (const g of activeGoals) {
        const condoId = g.condoId || 'misc:default';
        if (!condos.has(condoId)) {
          condos.set(condoId, {
            id: condoId,
            name: g.condoName || condoNameForId(condoId, null),
            sessions: [],
            goals: new Map(),
            latest: g.updatedAtMs || 0,
            sessionKeySet: new Set(),
          });
        }
        const condo = condos.get(condoId);
        condo.goals.set(g.id, g);
        condo.latest = Math.max(condo.latest, goalLastActivityMs(g));
        for (const key of (g.sessions || [])) {
          if (condo.sessionKeySet.has(key)) continue;
          const s = sessionByKey.get(key);
          if (s) {
            condo.sessions.push(s);
            condo.sessionKeySet.add(key);
          }
        }
      }

      // Ensure SYSTEM condo is visible when there are system-tagged sessions,
      // even if it has no active goals (sessions are hidden-by-default, but condo should exist).
      const systemTaggedKeys = Object.entries(state.sessionCondoIndex || {}).filter(([k, v]) => v === 'condo:system').map(([k]) => k);
      const systemSessions = (state.sessions || []).filter(s => getSessionCondoId(s) === 'condo:system');
      if (systemSessions.length > 0 || systemTaggedKeys.length > 0) {
        if (!condos.has('condo:system')) {
          condos.set('condo:system', {
            id: 'condo:system',
            name: 'SYSTEM',
            sessions: [],
            goals: new Map(),
            latest: 0,
            sessionKeySet: new Set(),
          });
        }
        const sys = condos.get('condo:system');

        // Keys from persisted mapping (even if sessions haven't loaded yet)
        for (const key of systemTaggedKeys) {
          if (!key || sys.sessionKeySet.has(key)) continue;
          sys.sessionKeySet.add(key);
        }

        for (const s of systemSessions) {
          if (sys.sessionKeySet.has(s.key)) continue;
          sys.sessions.push(s);
          sys.sessionKeySet.add(s.key);
          const t = Number(s.updatedAt || s.updatedAtMs || 0);
          if (t) sys.latest = Math.max(sys.latest, t);
        }
      }

      const sortedCondos = Array.from(condos.values()).sort((a, b) => (b.latest || 0) - (a.latest || 0));

      if (sortedCondos.length === 0) {
        container.innerHTML = `<div style=\"padding: 16px; color: var(--text-dim); font-size: 0.85rem;\">No active goals yet</div>`;
        return;
      }

      if (!state.currentCondoId && sortedCondos[0]) {
        state.currentCondoId = sortedCondos[0].id;
      }

      let html = '';
      for (const condo of sortedCondos) {
        const condoUnread = condo.sessions.filter(s => isSessionUnread(s.key)).length;
        const condoErrors = condo.sessions.filter(s => s.lastError).length;
        const badge = condoUnread > 0
          ? `<span class=\"badge unread\">${condoUnread}</span>`
          : condoErrors > 0 ? `<span class=\"badge error\">${condoErrors}</span>` : '';
        const activeCondo = state.currentCondoId === condo.id ? 'active' : '';

        // Only active + started goals should be displayed in sidebar
        const pendingGoalsCount = Array.from(condo.goals.values()).filter(g => !isGoalCompleted(g) && !isGoalDropped(g) && Array.isArray(g.sessions) && g.sessions.length > 0).length;

        // Default collapse condos that have "nothing happening" unless user explicitly expanded them before.
        // Heuristic: no pending goals OR no sessions attached to any pending goal and no unassigned sessions.
        if (state.expandedCondos[condo.id] === undefined) {
          const pendingGoals = Array.from(condo.goals.values()).filter(g => !isGoalCompleted(g) && !isGoalDropped(g) && Array.isArray(g.sessions) && g.sessions.length > 0);
          const pendingGoalsSessionsCount = pendingGoals.reduce((acc, g) => acc + (Array.isArray(g.sessions) ? g.sessions.length : 0), 0);
          const hasAnySessions = (condo.sessions?.length || 0) > 0;
          const shouldCollapse = pendingGoals.length === 0 || (!hasAnySessions && pendingGoalsSessionsCount === 0);
          if (shouldCollapse) state.expandedCondos[condo.id] = false;
        }

        const isExpanded = isCondoExpanded(condo.id);
        const toggleIcon = isExpanded ? '▾' : '▸';

        html += `
          <div class=\"condo-item\">
            <a class=\"condo-header ${activeCondo}\" href=\"${escapeHtml(fullHref(`#/condo/${encodeURIComponent(condo.id)}`))}\" onclick=\"return handleCondoLinkClick(event, '${escapeHtml(condo.id)}')\">
              <span class=\"condo-toggle\" title=\"${isExpanded ? 'Collapse' : 'Expand'}\" onclick=\"event.preventDefault(); event.stopPropagation(); toggleCondoExpanded('${escapeHtml(condo.id)}')\">${toggleIcon}</span>
              <span class=\"condo-icon\">🏢</span>
              <span class=\"condo-name\">${escapeHtml(condo.name || 'Condo')}</span>
              ${badge}
              <span class=\"condo-add\" title=\"New goal\" onclick=\"event.preventDefault(); event.stopPropagation(); state.newGoalCondoId = '${escapeHtml(condo.id)}'; showCreateGoalModal()\">+</span>
            </a>
            ${isExpanded ? `<div class=\"condo-goals\">${renderCondoGoals(condo, sessionToGoal, goalById)}</div>` : ''}
          </div>
        `;
      }

      // persist any new default-collapse decisions
      localStorage.setItem('sharp_expanded_condos', JSON.stringify(state.expandedCondos));

      container.innerHTML = html;
    }

    function renderGoalDot(goal, sessionsForGoal) {
      let newest = null;
      for (const key of (sessionsForGoal || [])) {
        const s = state.sessions.find(ss => ss.key === key);
        if (!s) continue;
        if (!newest || (s.updatedAt || 0) > (newest.updatedAt || 0)) newest = s;
      }
      const sessionKey = newest?.key;
      const blinker = deriveSessionBlinker(sessionKey, { goalId: goal?.id });
      const title = blinker?.label || 'Status';
      const cls = blinker?.colorClass || 'blink-idle';
      return `<span class="goal-dot blinker ${cls}" title="${escapeHtml(title)}"></span>`;
    }


    function renderCondoGoals(condo, sessionToGoal, goalById) {
      const goals = Array.from(condo.goals.values()).filter(g => !isGoalCompleted(g) && !isGoalDropped(g) && Array.isArray(g.sessions) && g.sessions.length > 0);
      const goalRows = [];

      for (const goal of goals) {
        const isActive = state.currentGoalId === goal.id ? 'active' : '';
        const sessKeys = Array.isArray(goal.sessions) ? goal.sessions : [];
        const sessionsForGoal = sessKeys.map(k => state.sessions.find(s => s.key === k)).filter(Boolean);
        sessionsForGoal.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        const dot = renderGoalDot(goal, sessKeys);
        const nextTask = (goal.nextTask || '').trim();
        const nextTaskEl = nextTask
          ? `<div style="grid-column: 1 / -1; margin: 2px 0 0 22px; font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Next: ${escapeHtml(nextTask)}</div>`
          : '';
        goalRows.push(`
          <a class=\"goal-item ${isActive}\" href=\"${escapeHtml(goalHref(goal.id))}\" onclick=\"return handleGoalLinkClick(event, '${escapeHtml(goal.id)}')\">\n            ${dot}\n            <div class=\"goal-checkbox\"></div>\n            <span class=\"goal-name\" title=\"${escapeHtml(nextTask || '')}\">${escapeHtml(goal.title || 'Untitled goal')}</span>\n            <span class=\"goal-count\">${sessionsForGoal.length}</span>\n            <span class=\"goal-add\" title=\"New session for this goal\" onclick=\"event.preventDefault(); event.stopPropagation(); openNewSession('${escapeHtml(condo.id)}','${escapeHtml(goal.id)}')\">+</span>\n            ${nextTaskEl}\n          </a>
        `);
      }

      return goalRows.join('');
    }

    function renderSidebarSession(s) {
      const isActive = state.currentSession && state.currentSession.key === s.key;
      const hasUnread = !isActive && isSessionUnread(s.key);
      const agentStatus = getAgentStatus(s.key);
      const statusClass = hasUnread ? 'unread' : agentStatus === 'error' ? 'error' : isActive ? 'active' : '';
      return `
        <a class=\"session-item ${isActive ? 'active' : ''}\" href=\"${escapeHtml(sessionHref(s.key))}\" onclick=\"return handleSessionLinkClick(event, '${escapeHtml(s.key)}')\">\n          <div class=\"session-dot ${statusClass}\"></div>\n          <span>${escapeHtml(getSessionName(s))}</span>\n        </a>
      `;
    }


    function goalTaskStats(goal) {
      const tasks = Array.isArray(goal?.tasks) ? goal.tasks : [];
      let done = 0;
      let total = 0;
      for (const t of tasks) {
        if (!t) continue;
        total++;
        if (t.done) done++;
      }
      return { done, total };
    }

    function getGoalForSession(sessionKey) {
      for (const g of state.goals) {
        if (Array.isArray(g.sessions) && g.sessions.includes(sessionKey)) return g;
      }
      return null;
    }

    function openGoal(goalId, opts = {}) {
      const goal = state.goals.find(g => g.id === goalId);
      if (!goal) return;

      if (!opts.fromRouter) {
        navigateTo(`goal/${encodeURIComponent(goalId)}`);
        return;
      }

      state.currentView = 'goal';
      state.currentGoalOpenId = goalId;
      state.currentGoalId = goalId;
      if (goal.condoId) state.currentCondoId = goal.condoId;
      setView('goalView');
      setActiveNav(null);
      setBreadcrumbs(buildGoalBreadcrumbs(goal));
      document.getElementById('headerAction').style.display = 'none';
      document.getElementById('headerStatusIndicator').style.display = 'none';

      renderGoalView();

      // If we explicitly requested a fresh goal session (via + New inside a goal),
      // clear the selected goal chat session so the kickoff overlay is shown.
      if (state.forceNewGoalSessionGoalId === goalId) {
        state.forceNewGoalSessionGoalId = null;
        state.goalChatSessionKey = null;
        setGoalChatLocked(true);
        const chatMetaEl = document.getElementById('goalChatMeta');
        if (chatMetaEl) chatMetaEl.textContent = 'New session not started';
        renderGoalChat();
      }

      renderDetailPanel();
      updateMobileHeader();
      closeSidebar();
    }

    function setGoalChatLocked(locked) {
      const overlay = document.getElementById('goalKickoffOverlay');
      const composer = document.getElementById('composerMountGoal');
      if (overlay) overlay.style.display = locked ? 'block' : 'none';
      if (composer) composer.style.display = locked ? 'none' : 'block';

      const btns = [
        document.getElementById('goalNewSessionBtn'),
        document.getElementById('goalAttachBtn'),
        document.getElementById('goalOpenBtn'),
      ].filter(Boolean);

      for (const b of btns) {
        b.disabled = !!locked;
        b.style.opacity = locked ? '0.45' : '1';
        b.style.pointerEvents = locked ? 'none' : 'auto';
      }
    }

    async function kickOffGoal() {
      const goalId = state.currentGoalOpenId;
      const goal = state.goals.find(g => g.id === goalId);
      if (!goalId || !goal) {
        showToast('Goal not ready', 'warning', 3000);
        return;
      }

      if (state.goalChatSessionKey) {
        // Already kicked off
        setGoalChatLocked(false);
        return;
      }

      setGoalChatLocked(true);

      const agentId = 'main';
      const timestamp = Date.now();
      const sessionKey = `agent:${agentId}:webchat:${timestamp}`;

      // Build kickoff payload (single message, includes current goal state).
      const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
      const tasksText = tasks.length
        ? tasks.map((t, i) => `${i + 1}. [${t.done ? 'x' : ' '}] ${t.text || ''}`.trim()).join('\n')
        : '(no tasks yet)';
      const def = (goal.notes || goal.description || '').trim() || '(no definition yet)';

      const kickoff = [
        `You are working on this goal in ClawCondos.`,
        ``,
        `GOAL: ${goal.title || goalId}`,
        `STATUS: ${goal.status || 'active'}${goal.priority ? ` · PRIORITY: ${goal.priority}` : ''}`,
        ``,
        `DEFINITION:`,
        def,
        ``,
        `TASKS:`,
        tasksText,
        ``,
        `INSTRUCTIONS:`,
        `1) Pick the best first task to start now (you choose).`,
        `2) Start executing immediately.`,
        `3) FIRST REPLY: output a single-line JSON object of the form {"goalPatch": {...}} updating at least nextTask (and status if needed).`,
        `   - Do NOT wrap it in markdown fences.`,
        `   - Keep it compact (no commentary before/after).`,
        `4) Do NOT use tools unless the user explicitly asks.`,
        `5) As you progress, emit additional {"goalPatch": {...}} updates when you change status/nextTask/complete tasks.`,
        `   Example: {"goalPatch":{"status":"active","nextTask":"…"}}`,
      ].join('\n');

      try {
        // Attach session to goal first so it shows up immediately.
        const attachRes = await fetch(`/api/goals/${encodeURIComponent(goalId)}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey }),
        });
        if (!attachRes.ok) {
          let msg = 'Failed to attach session to goal';
          try {
            const j = await attachRes.json();
            if (j?.error) msg = String(j.error);
          } catch {}
          throw new Error(msg);
        }

        state.goalChatSessionKey = sessionKey;

        // Update meta now
        const chatMetaEl = document.getElementById('goalChatMeta');
        if (chatMetaEl) chatMetaEl.textContent = `${sessionKey} · starting…`;

        // Send kickoff with reliability check.
        await rpcCall('chat.send', {
          sessionKey,
          message: kickoff,
          idempotencyKey: `kickoff-${goalId}-${timestamp}`,
        }, 130000);

        // Verify delivery (best-effort). Don't exact-match content; just confirm we can see a user msg at/after kickoff.
        const kickoffStartedAt = Date.now();
        const deadline = Date.now() + 15000;
        let ok = false;
        while (Date.now() < deadline) {
          try {
            const h = await rpcCall('chat.history', { sessionKey, limit: 30 }, 20000);
            const msgs = h?.messages || [];
            ok = msgs.some(m => m.role === 'user' && Number(m.timestamp || 0) >= kickoffStartedAt - 2000);
          } catch {}
          if (ok) break;
          await new Promise(r => setTimeout(r, 500));
        }
        if (!ok) {
          showToast('Kickoff delivery not confirmed yet. If it stays stuck on “starting…”, click Kick Off again.', 'warning', 7000);
        }

        await loadSessions();
        await loadGoals();

        setGoalChatLocked(false);
        await renderGoalChat();

        // Focus input
        const input = document.getElementById('goal_chatInput');
        if (input) input.focus();
      } catch (err) {
        console.error('Kickoff failed', err);
        showToast(err.message || 'Kickoff failed', 'error', 7000);
        state.goalChatSessionKey = null;
        setGoalChatLocked(true);
      }
    }

    function renderGoalView() {
      const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
      if (!goal) return;

      const completed = isGoalCompleted(goal);
      const status = completed ? 'done' : (goal.status || 'active');
      const pr = goal.priority || '';
      const deadline = goal.deadline || '';

      const titleEl = document.getElementById('goalHeroTitle');
      if (titleEl) titleEl.textContent = goal.title || 'Untitled goal';

      const condoNameEl = document.getElementById('goalCondoName');
      if (condoNameEl) {
        const condoName = (() => {
          const cid = goal.condoId || state.currentCondoId || '';
          if (cid === 'cron') return 'Recurring';
          const s = (state.sessions || []).find(x => getSessionCondoId(x) === cid);
          return s ? getSessionCondoName(s) : (cid.split(':').pop() || 'Condo');
        })();
        condoNameEl.textContent = condoName;
      }

      const lastEl = document.getElementById('goalLastUpdated');
      if (lastEl) lastEl.textContent = formatTimestamp(goal.updatedAtMs || goal.updatedAt || goal.createdAtMs || Date.now());

      const btn = document.getElementById('goalMarkDoneBtn');
      if (btn) btn.textContent = completed ? 'Mark active' : 'Mark done';

      // Goal header meta is shown in the right panel; left chat meta is reserved for session identity.

      // Definition editor uses goal.notes (closest thing we have today)
      const defDisplay = document.getElementById('goalDefDisplay');
      const notes = (goal.notes || goal.description || '').trim();
      if (defDisplay) {
        defDisplay.innerHTML = notes ? `${escapeHtml(notes)} <small>(click to edit)</small>` : `Click to add a definition… <small>(click to edit)</small>`;
      }

      // Goal chat should load the latest session for this goal (unless user chose a history entry)
      const sess = Array.isArray(goal.sessions) ? goal.sessions : [];
      const latestKey = getLatestGoalSessionKey(goal);
      const hasSelection = state.goalChatSessionKey && sess.includes(state.goalChatSessionKey);
      if (!hasSelection) {
        state.goalChatSessionKey = latestKey;
      }
      setGoalChatLocked(!state.goalChatSessionKey);

      updateGoalChatMeta(state.goalChatSessionKey);
      renderGoalHistoryPicker(goal);
      updateGoalSessionStatePill(goal);

      renderGoalChat();

      // Tabs + pane
      if (!state.goalTab) state.goalTab = 'tasks';
      setGoalTab(state.goalTab, { skipRender: true });
      renderGoalPane();
    }

    function getLatestGoalSessionKey(goal) {
      const keys = Array.isArray(goal?.sessions) ? goal.sessions : [];
      if (!keys.length) return null;
      const byKey = new Map((state.sessions || []).map(s => [s.key, s]));
      const scored = keys.map(k => {
        const s = byKey.get(k);
        const t = Number(s?.updatedAt || s?.updatedAtMs || 0);
        return { k, t };
      });
      scored.sort((a, b) => (b.t || 0) - (a.t || 0));
      return scored[0]?.k || keys[0];
    }

    function updateGoalChatMeta(sessionKey) {
      const chatMetaEl = document.getElementById('goalChatMeta');
      if (!chatMetaEl) return;
      if (!sessionKey) {
        chatMetaEl.textContent = 'No session yet';
        return;
      }
      const s = (state.sessions || []).find(x => x.key === sessionKey);
      chatMetaEl.textContent = s ? `${getSessionName(s)} · ${getSessionMeta(s)}` : sessionKey;
    }

    function updateGoalSessionStatePill(goal) {
      const pill = document.getElementById('goalSessionStatePill');
      const dot = document.getElementById('goalSessionStateDot');
      const label = document.getElementById('goalSessionStateLabel');
      if (!pill || !dot || !label) return;

      const goalId = goal?.id || state.currentGoalOpenId || null;
      const key = state.goalChatSessionKey;

      // No session yet: show neutral "Not started".
      if (!key) {
        dot.className = 'session-state-dot blink-idle';
        label.textContent = 'Not started';
        pill.title = 'Not started';
        return;
      }

      const b = deriveSessionBlinker(key, { goalId });
      dot.className = `session-state-dot ${b?.colorClass || 'blink-idle'}`;
      label.textContent = b?.label || 'Idle';
      pill.title = b?.label || 'Status';
    }

    function renderGoalHistoryPicker(goal) {
      const wrap = document.getElementById('goalHistoryWrap');
      const select = document.getElementById('goalHistorySelect');
      if (!wrap || !select) return;
      const sess = Array.isArray(goal?.sessions) ? goal.sessions.slice() : [];
      if (!sess.length) {
        wrap.style.display = 'none';
        return;
      }

      const byKey = new Map((state.sessions || []).map(s => [s.key, s]));
      const rows = sess.map(key => {
        const s = byKey.get(key);
        const updatedAt = Number(s?.updatedAt || s?.updatedAtMs || 0);
        const label = s ? `${getSessionName(s)} · ${getSessionMeta(s)}` : key;
        return { key, label, updatedAt };
      }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      select.innerHTML = rows.map(r => `<option value="${escapeHtml(r.key)}">${escapeHtml(r.label)}</option>`).join('');
      const current = state.goalChatSessionKey && sess.includes(state.goalChatSessionKey) ? state.goalChatSessionKey : rows[0]?.key;
      if (current) select.value = current;

      wrap.style.display = rows.length > 1 ? 'flex' : 'none';
    }

    function handleGoalHistoryChange(value) {
      if (!value || value === state.goalChatSessionKey) return;
      state.goalChatSessionKey = value;
      setGoalChatLocked(false);
      updateGoalChatMeta(value);
      const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
      updateGoalSessionStatePill(goal);
      renderGoalChat();
    }

    async function renderGoalChat() {
      const box = document.getElementById('goal_chatMessages');
      if (!box) return;

      const key = state.goalChatSessionKey;
      if (!key) {
        box.innerHTML = `<div class="message system">Not started yet. Click “Kick Off Goal” to create the first session and begin.</div>`;
        return;
      }

      box.innerHTML = `<div class="message system">Loading history…</div>`;
      try {
        const result = await rpcCall('chat.history', { sessionKey: key, limit: 50 });
        const messages = result?.messages || [];
        renderChatHistoryInto(box, messages);
        scrollChatPanelToBottom('goal');
      } catch (err) {
        box.innerHTML = `<div class="message system">Error loading: ${escapeHtml(err.message)}</div>`;
      }
    }

    function renderChatHistoryInto(container, messages) {
      if (!container) return;
      if (!messages || messages.length === 0) {
        container.innerHTML = '<div class="message system">No messages yet</div>';
        return;
      }

      container.innerHTML = messages.map((m, idx) => {
        if (m.role === 'user') {
          const text = extractText(m.content);
          if (!text) return '';
          const timeHtml = m.timestamp ? `<div class="message-time">${formatMessageTime(new Date(m.timestamp))}</div>` : '';
          return `<div class="message user"><div class="message-content">${formatMessage(text)}</div>${timeHtml}</div>`;
        } else if (m.role === 'assistant') {
          const text = extractText(m.content);
          const spawnCards = extractSpawnCards(m.content, m.timestamp);
          const timeHtml = m.timestamp ? `<div class="message-time">${formatMessageTime(new Date(m.timestamp))}</div>` : '';

          let html = '';
          if (spawnCards.length > 0) html += spawnCards.map(card => renderSpawnCard(card, idx)).join('');
          if (text) html += `<div class="message assistant"><div class="message-content">${formatMessage(text)}</div>${timeHtml}</div>`;
          return html;
        }
        return '';
      }).filter(Boolean).join('');
    }

    function scrollChatPanelToBottom(prefix, force = true) {
      const id = prefix ? `${prefix}_chatMessages` : 'chatMessages';
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollTop = el.scrollHeight;

      // hide jump button
      const jump = document.getElementById(prefix ? `${prefix}_jumpToLatest` : 'jumpToLatest');
      if (jump) jump.style.display = 'none';
      const cnt = document.getElementById(prefix ? `${prefix}_jumpToLatestCount` : 'jumpToLatestCount');
      if (cnt) cnt.style.display = 'none';
    }

    function handleGoalChatKey(event) {
      // Deprecated: goal chat composer is now mounted via mountComposer.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendGoalChatMessage();
      }
    }

    function openGoalChatInFull() {
      const key = state.goalChatSessionKey;
      if (!key) return;
      openSession(key, { fromRouter: true });
    }

    async function sendGoalChatMessage() {
      const input = document.getElementById('goal_chatInput');
      const box = document.getElementById('goal_chatMessages');

      if (!input || !box) {
        showToast('Goal chat not ready', 'warning', 3000);
        return;
      }

      const text = (input.value || '').trim();
      const hasMedia = typeof MediaUpload !== 'undefined' && MediaUpload.hasPendingFiles && MediaUpload.hasPendingFiles();

      if (!text && !hasMedia) {
        showToast('Nothing to send', 'info', 1500);
        return;
      }

      // Goal chat requires explicit kickoff.
      const key = state.goalChatSessionKey;
      if (!key) {
        showToast('Kick off this goal before chatting', 'warning', 3500);
        return;
      }

      // If agent is busy, queue goal messages (including attachments).
      if (state.isThinking) {
        let queuedText = text;
        let queuedAttachments = undefined;

        if (hasMedia) {
          const files = MediaUpload.getPendingFiles();
          const hasAudio = files.some(f => f.fileType === 'audio');

          if (hasAudio) {
            try {
              showToast('Uploading voice note…', 'info', 2000);
              addChatMessageTo('goal', 'system', 'Uploading voice note…');

              const uploaded = await MediaUpload.uploadAllPending(key);
              const lines = [];
              const transcripts = [];

              showToast('Transcribing…', 'info', 2000);
              addChatMessageTo('goal', 'system', 'Transcribing…');

              for (const u of (uploaded || [])) {
                if (!u || !u.ok) continue;
                lines.push(`[attachment: ${u.url}]`);
                const isAudio = String(u.mimeType || '').startsWith('audio/') || String(u.url || '').match(/\.(webm|m4a|mp3|wav|ogg)(\?|$)/i);
                if (isAudio && u.serverPath) {
                  try {
                    const resp = await fetch(`/api/whisper/transcribe?path=${encodeURIComponent(u.serverPath)}&cb=${Date.now()}`);
                    const data = await resp.json();
                    if (data?.ok && data.text) transcripts.push(data.text.trim());
                  } catch (e) {
                    console.error('Whisper transcription failed:', e);
                  }
                }
              }

              const transcriptText = transcripts.filter(Boolean).join('\n\n');
              const voiceBlock = [transcriptText || '', ...lines].filter(Boolean).join('\n\n');
              queuedText = queuedText ? [queuedText, voiceBlock].filter(Boolean).join('\n\n') : voiceBlock;
              queuedAttachments = await buildGatewayAudioAttachmentsFromUploaded(uploaded);
              MediaUpload.clearFiles();
            } catch (err) {
              MediaUpload.clearFiles();
              addChatMessageTo('goal', 'system', `Upload/transcribe error: ${err.message}`);
              return;
            }
          } else {
            // Images are uploaded to ClawCondos and referenced by URL.
            // Avoid sending base64 blobs over WebSocket (can exceed frame limits and close the socket).
            try {
              showToast('Uploading image…', 'info', 2000);
              addChatMessageTo('goal', 'system', 'Uploading image…');

              const uploaded = await MediaUpload.uploadAllPending(key);
              const lines = [];
              for (const u of (uploaded || [])) {
                if (!u || !u.ok) continue;
                lines.push(`[attachment: ${u.url}]`);
              }

              const attachText = lines.filter(Boolean).join('\n');
              queuedText = queuedText ? [queuedText, attachText].filter(Boolean).join('\n\n') : attachText;
              queuedAttachments = undefined;
              MediaUpload.clearFiles();
            } catch (err) {
              MediaUpload.clearFiles();
              addChatMessageTo('goal', 'system', `Upload error: ${err.message}`);
              return;
            }
          }
        }

        state.messageQueue.push({ text: queuedText || '', sessionKey: key, attachments: queuedAttachments });
        updateQueueIndicator();
        input.value = '';
        autoResize(input);
        addChatMessageTo('goal', 'user queued', queuedText || '[attachment]');
        return;
      }

      input.value = '';
      autoResize(input);

      let finalMessage = text;
      let attachments = undefined;

      if (hasMedia) {
        const files = MediaUpload.getPendingFiles();
        const hasAudio = files.some(f => f.fileType === 'audio');

        if (hasAudio) {
          try {
            // Give visible feedback
            showToast('Uploading voice note…', 'info', 2000);
            addChatMessageTo('goal', 'system', 'Uploading voice note…');

            const uploaded = await MediaUpload.uploadAllPending(key);
            const lines = [];
            const transcripts = [];

            showToast('Transcribing…', 'info', 2000);
            addChatMessageTo('goal', 'system', 'Transcribing…');

            for (const u of (uploaded || [])) {
              if (!u || !u.ok) continue;
              lines.push(`[attachment: ${u.url}]`);

              const isAudio = String(u.mimeType || '').startsWith('audio/') || String(u.url || '').match(/\.(webm|m4a|mp3|wav|ogg)(\?|$)/i);
              if (isAudio && u.serverPath) {
                try {
                  const resp = await fetch(`/api/whisper/transcribe?path=${encodeURIComponent(u.serverPath)}&cb=${Date.now()}`);
                  const data = await resp.json();
                  if (data?.ok && data.text) transcripts.push(data.text.trim());
                } catch (e) {
                  console.error('Whisper transcription failed:', e);
                }
              }
            }

            const transcriptText = transcripts.filter(Boolean).join('\n\n');
            const voiceBlock = [transcriptText || '', ...lines].filter(Boolean).join('\n\n');

            if (!finalMessage) finalMessage = voiceBlock;
            else finalMessage = [finalMessage, voiceBlock].filter(Boolean).join('\n\n');

            attachments = await buildGatewayAudioAttachmentsFromUploaded(uploaded);
            MediaUpload.clearFiles();
          } catch (err) {
            MediaUpload.clearFiles();
            box.insertAdjacentHTML('beforeend', `<div class="message system">Upload/transcribe error: ${escapeHtml(err.message)}</div>`);
            box.scrollTop = box.scrollHeight;
            return;
          }
        } else {
          // Images are uploaded to ClawCondos and referenced by URL.
          // Avoid sending base64 blobs over WebSocket (can exceed frame limits and close the socket).
          try {
            showToast('Uploading image…', 'info', 2000);
            addChatMessageTo('goal', 'system', 'Uploading image…');

            const uploaded = await MediaUpload.uploadAllPending(key);
            const lines = [];
            for (const u of (uploaded || [])) {
              if (!u || !u.ok) continue;
              lines.push(`[attachment: ${u.url}]`);
            }

            const attachText = lines.filter(Boolean).join('\n');
            if (!finalMessage) finalMessage = attachText;
            else finalMessage = [finalMessage, attachText].filter(Boolean).join('\n\n');

            attachments = undefined;
            MediaUpload.clearFiles();
          } catch (err) {
            MediaUpload.clearFiles();
            box.insertAdjacentHTML('beforeend', `<div class="message system">Upload error: ${escapeHtml(err.message)}</div>`);
            box.scrollTop = box.scrollHeight;
            return;
          }
        }
      }

      // optimistic render
      if (finalMessage) {
        addChatMessageTo('goal', 'user', finalMessage);
      }

      try {
        const sendStartedAt = Date.now();
        const idempotencyKey = `goalmsg-${key}-${sendStartedAt}`;

        await rpcCall('chat.send', {
          sessionKey: key,
          message: finalMessage || '',
          attachments,
          idempotencyKey,
        }, 130000);

        // Reliability: verify delivery (avoid "phantom" optimistic messages).
        // NOTE: Don't exact-match message text — history can normalize whitespace, and attachments-only sends vary.
        try {
          const sentText = (finalMessage || '').trim();
          if (sentText) {
            const normalize = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const sentNorm = normalize(sentText);
            const deadline = Date.now() + 12000;
            let ok = false;

            while (Date.now() < deadline) {
              try {
                const h = await rpcCall('chat.history', { sessionKey: key, limit: 30 }, 20000);
                const msgs = h?.messages || [];

                ok = msgs.some(m => {
                  if (m.role !== 'user') return false;
                  const ts = Number(m.timestamp || 0);
                  if (ts && ts < sendStartedAt - 2000) return false;
                  const txt = extractText(m.content);
                  if (!txt) return false;
                  const norm = normalize(txt);
                  return norm === sentNorm || norm.includes(sentNorm.slice(0, Math.min(60, sentNorm.length)));
                });
              } catch {}

              if (ok) break;
              await new Promise(r => setTimeout(r, 450));
            }

            if (!ok) {
              // Only warn when we truly couldn't observe it; avoid spurious nags.
              addChatMessageTo('goal', 'system', '⚠️ Delivery not confirmed yet. If you do not see a reply soon, retry once.');
            }
          }
        } catch {}

        // Don't re-fetch history immediately; the WS event will append the response.
        // (Immediate reload causes "message appears then disappears".)
      } catch (err) {
        box.insertAdjacentHTML('beforeend', `<div class="message system">Error: ${escapeHtml(err.message)}</div>`);
        box.scrollTop = box.scrollHeight;
      }
    }

    function formatTimestamp(ms) {
      const d = new Date(Number(ms) || Date.now());
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function startGoalDefEdit() {
      const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
      const disp = document.getElementById('goalDefDisplay');
      const edit = document.getElementById('goalDefEdit');
      const ta = document.getElementById('goalDefTA');
      if (!disp || !edit || !ta) return;

      const val = (goal?.notes || goal?.description || '').trim();
      ta.value = val;
      edit.classList.add('open');
      disp.style.display = 'none';
      ta.focus();
    }

    async function saveGoalDefEdit() {
      const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
      const ta = document.getElementById('goalDefTA');
      if (!goal || !ta) return;
      const val = (ta.value || '').trim();
      await updateGoal(goal.id, { notes: val });
      cancelGoalDefEdit();
      renderGoalView();
    }

    function cancelGoalDefEdit() {
      const disp = document.getElementById('goalDefDisplay');
      const edit = document.getElementById('goalDefEdit');
      if (!disp || !edit) return;
      edit.classList.remove('open');
      disp.style.display = 'block';
    }

    function setGoalTab(which, opts = {}) {
      state.goalTab = which;
      const t1 = document.getElementById('goalTabTasks');
      const t2 = document.getElementById('goalTabFiles');
      if (t1) t1.classList.toggle('active', which === 'tasks');
      if (t2) t2.classList.toggle('active', which === 'files');
      if (!opts.skipRender) renderGoalPane();
    }

    function renderGoalPane() {
      const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
      const pane = document.getElementById('goalPane');
      if (!goal || !pane) return;

      if ((state.goalTab || 'tasks') === 'files') {
        pane.innerHTML = `<div class="empty-state" style="padding:14px;">Files view is coming soon. (We can wire it to a goal “files” field or to session artifacts.)</div>`;
        return;
      }

      const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
      if (!tasks.length) {
        pane.innerHTML = `
          <div class="empty-state" style="padding:14px;">No tasks yet. Add the next physical step.</div>
          <div class="goal-task-compose">
            <input class="form-input" id="goalNewTaskInput" placeholder="Add a task…" onkeypress="if(event.key==='Enter')addGoalTaskFromGoalPane()">
            <button class="ghost-btn" onclick="addGoalTaskFromGoalPane()">Add</button>
          </div>
        `;
        return;
      }

      // Tasks: grouped by stage (prototype direction). If no stage metadata yet, they land in Backlog.
      const stages = [
        { k: 'backlog', l: 'Backlog' },
        { k: 'blocked', l: 'Blocked' },
        { k: 'doing', l: 'Doing' },
        { k: 'review', l: 'Review' },
        { k: 'done', l: 'Done' },
      ];

      const by = new Map(stages.map(s => [s.k, []]));
      for (const t of tasks) {
        const key = t.blocked ? 'blocked' : (t.stage || (t.done ? 'done' : 'backlog'));
        if (!by.has(key)) by.set(key, []);
        by.get(key).push(t);
      }

      pane.innerHTML = `
        ${stages.map(s => {
          const items = by.get(s.k) || [];
          if (!items.length) return '';
          const rows = items.map((t, idx) => {
            const id = escapeHtml(t.id || String(idx));
            const checked = t.done ? 'checked' : '';
            const badge = t.blocked ? 'blocked' : (t.stage || (t.done ? 'done' : 'backlog'));
            const title = t.text || t.title || '';
            return `
              <div class="goal-task-row" onclick="toggleGoalTask('${id}')">
                <input type="checkbox" ${checked} onclick="event.stopPropagation(); toggleGoalTask('${id}')">
                <div class="goal-badge ${escapeHtml(badge)}"></div>
                <div class="goal-rtitle">${escapeHtml(title)}</div>
                <div class="goal-rmeta"><span>${escapeHtml(String(t.id || ''))}</span></div>
              </div>
            `;
          }).join('');

          return `<div class="goal-group"><div class="goal-ghead"><div class="goal-gtitle">${escapeHtml(s.l)}</div><div class="goal-gcount">${items.length}</div></div>${rows}</div>`;
        }).join('')}

        <div class="goal-task-compose">
          <input class="form-input" id="goalNewTaskInput" placeholder="Add a task…" onkeypress="if(event.key==='Enter')addGoalTaskFromGoalPane()">
          <button class="ghost-btn" onclick="addGoalTaskFromGoalPane()">Add</button>
        </div>
      `;
    }

    async function addGoalTaskFromGoalPane() {
      const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
      if (!goal) return;
      const input = document.getElementById('goalNewTaskInput');
      if (!input) return;
      const text = (input.value || '').trim();
      if (!text) return;

      const tasks = Array.isArray(goal.tasks) ? goal.tasks.slice() : [];
      tasks.unshift({ id: uid('task'), text, done: false, stage: 'backlog' });
      input.value = '';
      await updateGoal(goal.id, { tasks });
    }

    async function toggleGoalDone() {
      const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
      if (!goal) return;
      const next = !isGoalCompleted(goal);
      await updateGoal(goal.id, { completed: next, status: next ? 'done' : 'active' });
    }

    async function updateGoal(goalId, patch, opts = {}) {
      try {
        const res = await fetch(`/api/goals/${encodeURIComponent(goalId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        const idx = state.goals.findIndex(g => g.id === goalId);
        if (idx !== -1 && data?.goal) state.goals[idx] = data.goal;

        if (!opts.skipRender) {
          try { renderGoals(); } catch (e) { console.error('renderGoals error:', e); }
          try { renderGoalsGrid(); } catch (e) { console.error('renderGoalsGrid error:', e); }

          // Avoid nuking chat contents when we're in goal view; prefer lighter refresh.
          if (!(opts.skipGoalViewRerender) && state.currentView === 'goal' && state.currentGoalOpenId === goalId) {
            try { renderGoalView(); } catch (e) { console.error('renderGoalView error:', e); }
          } else {
            try { renderDetailPanel(); } catch (e) { console.error('renderDetailPanel error:', e); }
          }
        }

        return data?.goal;
      } catch (e) {
        if (!opts.silent) showToast('Failed to save goal', 'error');
        throw e;
      }
    }

    function extractJsonBlocks(text) {
      const out = [];
      const s = String(text || '');
      const re = /```(?:json)?\s*([\s\S]*?)```/gi;
      let m;
      while ((m = re.exec(s)) !== null) {
        const body = (m[1] || '').trim();
        if (body) out.push(body);
      }
      return out;
    }

    function extractFirstJsonObject(s) {
      const str = String(s || '');
      const start = str.indexOf('{');
      if (start === -1) return null;

      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch === '\\') {
            escape = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (depth === 0) {
          return str.slice(start, i + 1);
        }
      }
      return null;
    }

    function tryParseGoalPatch(text) {
      // Accept either:
      // - fenced ```json ...``` blocks
      // - a raw single-line JSON object
      // - a JSON object embedded inside a longer assistant message
      const blocks = extractJsonBlocks(text);
      const candidates = blocks.length ? blocks : [String(text || '')];

      for (const c of candidates) {
        const trimmed = (c || '').trim();
        const jsonStr = trimmed.startsWith('{') ? trimmed : extractFirstJsonObject(trimmed);
        if (!jsonStr || !jsonStr.trim().startsWith('{')) continue;

        try {
          const obj = JSON.parse(jsonStr);
          const patch = obj?.goalPatch || obj?.clawcondosGoalPatch || obj;
          if (!patch || typeof patch !== 'object') continue;

          // Heuristic: only treat as patch if it looks like one.
          const keys = Object.keys(patch);
          const allowed = new Set(['status','priority','deadline','notes','description','tasks','nextTask','completed','dropped','droppedAtMs','condoId','condoName']);
          const looksLikePatch = keys.some(k => allowed.has(k));
          if (!looksLikePatch) continue;

          return patch;
        } catch {}
      }
      return null;
    }

    async function maybeAutoApplyGoalPatch(sessionKey, assistantText) {
      const text = (assistantText || '').trim();
      if (!text) return;

      const patch = tryParseGoalPatch(text);
      if (!patch) return;

      // Determine goalId from sessionKey mapping.
      let goalId = null;
      try {
        const g = getGoalForSession(sessionKey);
        if (g?.id) goalId = g.id;
      } catch {}
      if (!goalId && state.currentView === 'goal' && state.goalChatSessionKey === sessionKey) {
        goalId = state.currentGoalOpenId;
      }
      if (!goalId) return;

      try {
        await updateGoal(goalId, patch, { silent: true, skipGoalViewRerender: true });
        // Light refresh for goal header + tasks pane.
        if (state.currentView === 'goal' && state.currentGoalOpenId === goalId) {
          try { renderGoalView(); } catch {}
        }
        showToast('Applied goal update', 'info', 1200);
      } catch (e) {
        addChatMessageTo('goal', 'system', `⚠️ Failed to apply goal update: ${e.message}`);
      }
    }

    function uid(prefix='id') {
      return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    }

    async function addGoalTask() {
      const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
      if (!goal) return;
      const input = document.getElementById('goalNewTaskInput');
      const text = (input.value || '').trim();
      if (!text) return;
      const tasks = Array.isArray(goal.tasks) ? goal.tasks.slice() : [];
      tasks.unshift({ id: uid('task'), text, done: false });
      input.value = '';
      await updateGoal(goal.id, { tasks });
    }

    async function toggleGoalTask(taskId) {
      const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
      if (!goal) return;
      const tasks = Array.isArray(goal.tasks) ? goal.tasks.map(t => ({...t})) : [];
      const idx = tasks.findIndex(t => String(t.id) === String(taskId));
      if (idx === -1) return;
      tasks[idx].done = !tasks[idx].done;
      await updateGoal(goal.id, { tasks });
    }

    async function deleteGoalTask(taskId) {
      const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
      if (!goal) return;
      const tasks = Array.isArray(goal.tasks) ? goal.tasks.filter(t => String(t.id) != String(taskId)) : [];
      await updateGoal(goal.id, { tasks });
    }

    let goalSaveTimer = null;
    function debouncedSaveGoal() {
      clearTimeout(goalSaveTimer);
      goalSaveTimer = setTimeout(saveGoalNow, 450);
      const hint = document.getElementById('goalSaveHint');
      if (hint) {
        hint.textContent = 'Saving…';
        hint.classList.add('saving');
      }
    }

    async function saveGoalNow() {
      const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
      if (!goal) return;
      const notes = document.getElementById('goalNotes').value;
      const deadline = document.getElementById('goalDeadlineInput').value.trim();
      const priority = document.getElementById('goalPriorityInput').value || null;
      await updateGoal(goal.id, { notes, deadline: deadline || null, priority });
      const hint = document.getElementById('goalSaveHint');
      if (hint) {
        hint.textContent = 'Saved';
        hint.classList.remove('saving');
      }
    }

    function isGoalDropped(goal) {
      return !!(goal && (goal.dropped || goal.status === 'dropped' || goal.deleted === true));
    }

    function showArchivedGoalsModal() {
      const modal = document.getElementById('archivedGoalsModal');
      if (!modal) return;
      modal.classList.remove('hidden');
      if (!state.archivedTab) state.archivedTab = 'done';
      renderArchivedGoals();
    }

    function hideArchivedGoalsModal() {
      const modal = document.getElementById('archivedGoalsModal');
      if (!modal) return;
      modal.classList.add('hidden');
    }

    function setArchivedTab(tab) {
      state.archivedTab = tab;
      renderArchivedGoals();
    }

    function renderArchivedGoals() {
      const list = document.getElementById('archivedGoalsList');
      if (!list) return;

      const doneBtn = document.getElementById('archTabDone');
      const dropBtn = document.getElementById('archTabDropped');
      if (doneBtn) doneBtn.classList.toggle('active', state.archivedTab === 'done');
      if (dropBtn) dropBtn.classList.toggle('active', state.archivedTab === 'dropped');

      const condoId = state.currentCondoId;
      const all = (state.goals || []).filter(g => (g.condoId || 'misc:default') === condoId);
      const items = (state.archivedTab === 'dropped')
        ? all.filter(g => isGoalDropped(g))
        : all.filter(g => isGoalCompleted(g) && !isGoalDropped(g));

      if (!items.length) {
        list.innerHTML = `<div class="empty-state">Nothing here yet.</div>`;
        return;
      }

      list.innerHTML = items
        .sort((a, b) => Number(b.updatedAtMs || b.updatedAt || 0) - Number(a.updatedAtMs || a.updatedAt || 0))
        .map(g => {
          const updated = formatTimestamp(g.updatedAtMs || g.updatedAt || g.createdAtMs || Date.now());
          const pill = state.archivedTab === 'dropped' ? 'dropped' : 'done';
          return `
            <a class="goal-picker-row" style="cursor:pointer" href="${escapeHtml(goalHref(g.id))}" onclick="return handleGoalLinkClick(event, '${escapeHtml(g.id)}')">
              <div class="goal-picker-title">${escapeHtml(g.title || 'Untitled goal')}</div>
              <div class="goal-picker-meta">${pill} · updated ${escapeHtml(updated)}</div>
              <div style="margin-top:8px; display:flex; gap:8px;">
                ${state.archivedTab === 'dropped' ? `<button class=\"ghost-btn\" onclick=\"event.preventDefault(); event.stopPropagation(); restoreGoal('${escapeHtml(g.id)}')\">Restore</button>` : ''}
                ${state.archivedTab === 'done' ? `<button class=\"ghost-btn\" onclick=\"event.preventDefault(); event.stopPropagation(); markGoalActive('${escapeHtml(g.id)}')\">Mark active</button>` : ''}
              </div>
            </a>
          `;
        }).join('');
    }

    async function restoreGoal(goalId) {
      await updateGoal(goalId, { dropped: false, status: 'active' });
      await loadGoals();
      renderCondoView();
      renderArchivedGoals();
    }

    async function markGoalActive(goalId) {
      await updateGoal(goalId, { completed: false, status: 'active' });
      await loadGoals();
      renderCondoView();
      renderArchivedGoals();
    }

    async function promptDropGoal() {
      const goal = state.goals.find(g => g.id === state.currentGoalOpenId);
      if (!goal) return;
      if (!confirm(`Drop goal "${goal.title}"?`)) return;
      try {
        await updateGoal(goal.id, { dropped: true, status: 'dropped', droppedAtMs: Date.now() });
        await loadGoals();
        navigateTo(`condo/${encodeURIComponent(goal.condoId || state.currentCondoId || 'misc:default')}`);
      } catch {
        showToast('Failed to drop goal', 'error');
      }
    }

    // Attach session modal
    function showAttachSessionModal(sessionKey) {
      const modal = document.getElementById('attachSessionModal');
      const errEl = document.getElementById('attachSessionError');
      errEl.style.display = 'none';
      modal.classList.remove('hidden');

      const key = sessionKey || state.currentSession?.key || null;
      state.attachSessionKey = key;
      document.getElementById('attachSessionPill').textContent = key ? key : 'No session selected';

      if (!state.attachGoalId && state.currentGoalOpenId) state.attachGoalId = state.currentGoalOpenId;

      const picker = document.getElementById('goalPicker');
      const condoId = getCondoIdForSessionKey(key);
      const goals = state.goals.filter(g => !isGoalCompleted(g) && (g.condoId || condoId) === condoId);
      if (!state.attachGoalId && goals[0]) state.attachGoalId = goals[0].id;
      const rows = goals.map(g => {
        const active = state.attachGoalId === g.id ? 'active' : '';
        const { done, total } = goalTaskStats(g);
        const due = g.deadline ? `<span class="goal-picker-due">due ${escapeHtml(g.deadline)}</span>` : '';
        return `
          <div class="goal-picker-row ${active}" onclick="selectAttachGoal('${escapeHtml(g.id)}')">
            <div class="goal-picker-title">${escapeHtml(g.title || 'Untitled goal')}</div>
            <div class="goal-picker-meta">${isGoalCompleted(g) ? 'done' : 'active'} · ${done}/${total} tasks ${due}</div>
          </div>
        `;
      }).join('');
      picker.innerHTML = rows || `<div class="empty-state">No goals yet. Create one first.</div>`;
    }

    function selectAttachGoal(goalId) {
      state.attachGoalId = goalId;
      // re-render picker active state
      showAttachSessionModal(state.attachSessionKey);
    }

    function hideAttachSessionModal() {
      document.getElementById('attachSessionModal').classList.add('hidden');
    }

    async function confirmAttachSession() {
      const errEl = document.getElementById('attachSessionError');
      errEl.style.display = 'none';
      const goalId = state.attachGoalId;
      const sessionKey = state.attachSessionKey;
      if (!goalId) {
        errEl.textContent = 'Pick a goal';
        errEl.style.display = 'block';
        return;
      }
      if (!sessionKey) {
        errEl.textContent = 'No session selected';
        errEl.style.display = 'block';
        return;
      }
      try {
        const res = await fetch(`/api/goals/${encodeURIComponent(goalId)}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey }),
        });
        if (!res.ok) throw new Error('Failed');
        hideAttachSessionModal();
        await loadGoals();
        renderSessions();
        updateOverview();
        if (state.currentView === 'goal') renderGoalView();
        showToast('Session attached', 'success');
      } catch {
        errEl.textContent = 'Failed to attach session';
        errEl.style.display = 'block';
      }
    }

    // Per-session goal suggestion state
    state.suggestingSessionKey = null;
    state.pendingSuggestions = [];

    function showCategorizeSuggestions(sessionKey, event) {
      if (event) event.stopPropagation();
      
      state.suggestingSessionKey = sessionKey;
      state.pendingSuggestions = [];
      
      // Find session info
      const session = state.sessions.find(s => s.key === sessionKey);
      const sessionName = session ? (session.displayName || session.label || sessionKey.split(':').pop()) : sessionKey;
      
      // Update modal
      document.getElementById('suggestSessionPill').textContent = sessionName;
      document.getElementById('suggestGoalDesc').textContent = 'Analyzing session to suggest goals...';
      document.getElementById('suggestGoalLoading').style.display = 'block';
      document.getElementById('suggestGoalResults').style.display = 'none';
      document.getElementById('suggestNewGoalSection').style.display = 'none';
      document.getElementById('suggestGoalError').style.display = 'none';
      document.getElementById('suggestGoalModal').classList.remove('hidden');
      
      // Trigger AI analysis
      analyzeSesssionForGoals(sessionKey, sessionName);
    }
    
    function hideSuggestGoalModal() {
      document.getElementById('suggestGoalModal').classList.add('hidden');
      state.suggestingSessionKey = null;
      state.pendingSuggestions = [];
    }
    
    async function analyzeSesssionForGoals(sessionKey, sessionName) {
      try {
        const goals = state.goals || [];
        
        // Fetch session history - get first 5 (topic) and last 5 (recent) messages
        let firstMessages = '';
        let lastMessages = '';
        try {
          const historyResult = await rpcCall('chat.history', { sessionKey, limit: 50 });
          if (historyResult?.messages) {
            const userMsgs = historyResult.messages.filter(m => m.role === 'user');
            
            // First 5 user messages (understand the original topic)
            const first5 = userMsgs.slice(0, 5);
            firstMessages = first5.map(m => {
              const text = typeof m.content === 'string' ? m.content : 
                (Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '');
              return text.slice(0, 150);
            }).join(' | ');
            
            // Last 5 user messages (recent context)
            const last5 = userMsgs.slice(-5);
            lastMessages = last5.map(m => {
              const text = typeof m.content === 'string' ? m.content : 
                (Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '');
              return text.slice(0, 150);
            }).join(' | ');
          }
        } catch (e) {
          console.log('Could not fetch history:', e);
        }
        
        // Build context string for AI analysis
        const contextForAI = `Session: ${sessionKey}
Name: ${sessionName}
First messages (original topic): ${firstMessages.slice(0, 400) || '(none)'}
Recent messages: ${lastMessages.slice(0, 400) || '(none)'}`;
        
        // If we have goals, ask AI to rank them
        if (goals.length > 0) {
          const goalsList = goals.map(g => `- "${g.title}" (id: ${g.id})`).join('\n');
          
          const message = `[CATEGORIZE-SESSION]
Analyze this session and suggest which goal it belongs to. Respond with ONLY a JSON object, no other text.

${contextForAI}

Available goals:
${goalsList}

Response format:
{"suggestions":[{"goalId":"id-here","title":"Goal Title","reason":"brief reason","confidence":"high|medium|low"}]}

If none fit well, include a suggestion with goalId:null and a proposed new goal title.`;

          // Send to AI and wait for response
          document.getElementById('suggestGoalDesc').textContent = 'AI is analyzing the session...';
          
          try {
            // Send request and listen for response
            const reqId = await sendCategorizationRequest(sessionKey, message);
            // Response will come via WebSocket event - set up listener
            state.pendingCategorizationReqId = reqId;
            state.pendingCategorizationSessionKey = sessionKey;
            
            // Timeout fallback to manual
            setTimeout(() => {
              if (state.suggestingSessionKey === sessionKey) {
                showManualGoalOptions();
              }
            }, 8000);
            
          } catch (e) {
            console.error('AI request failed:', e);
            showManualGoalOptions();
          }
        } else {
          // No goals yet - just show create option
          showManualGoalOptions();
        }
        
      } catch (e) {
        console.error('Analyze session error:', e);
        showManualGoalOptions();
      }
    }
    
    async function sendCategorizationRequest(sessionKey, message) {
      if (!state.ws || !state.connected) throw new Error('Not connected');
      
      const reqId = String(++state.rpcIdCounter);
      
      state.ws.send(JSON.stringify({
        type: 'req',
        id: reqId,
        method: 'chat.send',
        params: {
          sessionKey: 'agent:main:main',
          message: message,
        }
      }));
      
      return reqId;
    }
    
    // Handle categorization response from AI
    function handleCategorizationResponse(text) {
      if (!state.suggestingSessionKey) return;
      
      try {
        // Try to parse JSON from the response
        const jsonMatch = text.match(/\{[\s\S]*"suggestions"[\s\S]*\}/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          if (data.suggestions && Array.isArray(data.suggestions)) {
            showAISuggestions(data.suggestions);
            return;
          }
        }
      } catch (e) {
        console.log('Could not parse AI response:', e);
      }
      
      // Fallback to manual
      showManualGoalOptions();
    }
    
    function showAISuggestions(suggestions) {
      const goals = state.goals || [];
      const container = document.getElementById('goalSuggestions');
      
      document.getElementById('suggestGoalLoading').style.display = 'none';
      document.getElementById('suggestGoalResults').style.display = 'block';
      document.getElementById('suggestNewGoalSection').style.display = 'block';
      document.getElementById('suggestGoalDesc').textContent = 'AI suggestions (click to assign):';
      
      const html = suggestions.map(s => {
        const isNew = !s.goalId;
        const confidence = s.confidence || 'medium';
        const confidenceClass = confidence === 'high' ? 'high' : (confidence === 'low' ? 'low' : 'medium');
        
        if (isNew) {
          return `
            <div class="goal-suggestion-row new-goal" onclick="createAndAssignGoal('${escapeHtml(s.title || 'New Goal')}')">
              <div class="suggestion-icon">✨</div>
              <div class="suggestion-content">
                <div class="suggestion-title">Create: ${escapeHtml(s.title || 'New Goal')}</div>
                <div class="suggestion-reason">${escapeHtml(s.reason || 'Suggested new goal')}</div>
              </div>
              <div class="suggestion-confidence">${confidence}</div>
            </div>
          `;
        } else {
          const goal = goals.find(g => g.id === s.goalId);
          const title = goal?.title || s.title || 'Unknown';
          return `
            <div class="goal-suggestion-row" onclick="assignSessionToGoal('${escapeHtml(s.goalId)}')">
              <div class="suggestion-icon">🏙️</div>
              <div class="suggestion-content">
                <div class="suggestion-title">${escapeHtml(title)}</div>
                <div class="suggestion-reason">${escapeHtml(s.reason || '')}</div>
              </div>
              <div class="suggestion-confidence">${confidence}</div>
            </div>
          `;
        }
      }).join('');
      
      container.innerHTML = html || '<div class="empty-state">No suggestions. Pick manually below.</div>';
    }
    
    async function createAndAssignGoal(title) {
      const sessionKey = state.suggestingSessionKey;
      if (!sessionKey || !title) return;
      
      try {
        const res = await fetch('/api/goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, condoId: getCondoIdForSessionKey(sessionKey) }),
        });
        if (!res.ok) throw new Error('Failed to create goal');
        const data = await res.json();
        
        if (data?.goal?.id) {
          await fetch(`/api/goals/${data.goal.id}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionKey }),
          });
        }
        
        hideSuggestGoalModal();
        await loadGoals();
        renderSessions();
        
      } catch (e) {
        document.getElementById('suggestGoalError').textContent = 'Failed: ' + e.message;
        document.getElementById('suggestGoalError').style.display = 'block';
      }
    }
    
    function showManualGoalOptions() {
      const goals = state.goals || [];
      document.getElementById('suggestGoalLoading').style.display = 'none';
      document.getElementById('suggestGoalResults').style.display = 'block';
      document.getElementById('suggestNewGoalSection').style.display = 'block';
      document.getElementById('suggestGoalDesc').textContent = 'Pick a goal or create a new one:';
      
      // Render existing goals as options
      const container = document.getElementById('goalSuggestions');
      if (goals.length === 0) {
        container.innerHTML = '<div class="empty-state">No goals yet. Create one below.</div>';
      } else {
        container.innerHTML = goals.map(g => `
          <div class="goal-suggestion-row" onclick="assignSessionToGoal('${escapeHtml(g.id)}')">
            <div class="suggestion-icon">🏙️</div>
            <div class="suggestion-content">
              <div class="suggestion-title">${escapeHtml(g.title)}</div>
              <div class="suggestion-reason">${g.sessions?.length || 0} sessions · ${isGoalCompleted(g) ? 'done' : 'active'}</div>
            </div>
          </div>
        `).join('');
      }
    }
    
    async function assignSessionToGoal(goalId) {
      const sessionKey = state.suggestingSessionKey;
      if (!sessionKey) return;
      
      try {
        const res = await fetch(`/api/goals/${goalId}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey }),
        });
        if (!res.ok) throw new Error('Failed to assign');
        
        hideSuggestGoalModal();
        await loadGoals();
        renderSessions();
        
      } catch (e) {
        document.getElementById('suggestGoalError').textContent = 'Failed to assign: ' + e.message;
        document.getElementById('suggestGoalError').style.display = 'block';
      }
    }
    
    async function createGoalFromSuggestion() {
      const title = document.getElementById('suggestNewGoalTitle').value.trim();
      if (!title) {
        document.getElementById('suggestGoalError').textContent = 'Enter a goal title';
        document.getElementById('suggestGoalError').style.display = 'block';
        return;
      }
      
      const sessionKey = state.suggestingSessionKey;
      
      try {
        // Create goal
        const res = await fetch('/api/goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, condoId: getCondoIdForSessionKey(sessionKey) }),
        });
        if (!res.ok) throw new Error('Failed to create goal');
        const data = await res.json();
        
        // Assign session to new goal
        if (sessionKey && data?.goal?.id) {
          await fetch(`/api/goals/${data.goal.id}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionKey }),
          });
        }
        
        hideSuggestGoalModal();
        await loadGoals();
        renderSessions();
        
      } catch (e) {
        document.getElementById('suggestGoalError').textContent = 'Failed: ' + e.message;
        document.getElementById('suggestGoalError').style.display = 'block';
      }
    }
    
    // Keep autoCategorize for bulk operations (optional)
    async function autoCategorize() {
      const sessions = (state.sessions || []).filter(s => !s.key.includes(':subagent:'));
      const goals = state.goals || [];
      
      // Find uncategorized sessions
      const assignedSessions = new Set();
      goals.forEach(g => (g.sessions || []).forEach(s => assignedSessions.add(s)));
      const uncategorized = sessions.filter(s => !assignedSessions.has(s.key));
      
      if (uncategorized.length === 0) {
        showToast('All sessions are already categorized!', 'info');
        return;
      }
      
      showToast(`${uncategorized.length} sessions need categorization. Use the 🏷️ button on each session.`, 'warning', 7000);
    }
    
    async function sendChatMessage(text) {
      if (!state.ws || !state.connected) throw new Error('Not connected');
      
      const reqId = String(++state.rpcIdCounter);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          state.rpcPending.delete(reqId);
          reject(new Error('Request timeout'));
        }, 30000);
        
        state.rpcPending.set(reqId, {
          resolve: (result) => {
            clearTimeout(timeout);
            resolve(result);
          },
          reject: (err) => {
            clearTimeout(timeout);
            reject(err);
          }
        });
        
        state.ws.send(JSON.stringify({
          type: 'req',
          id: reqId,
          method: 'chat.send',
          params: {
            sessionKey: 'agent:main:main',
            message: text,
            idempotencyKey: crypto.randomUUID(),
          }
        }));
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // ORGANIZE WIZARD (Sequential triage)
    // ═══════════════════════════════════════════════════════════════
    
    state.wizardSessions = [];
    state.wizardIndex = 0;
    state.wizardOrganized = 0;
    state.wizardSkipped = 0;
    state.wizardCurrentProposal = null;
    
    function openOrganizeWizard() {
      const sessions = (state.sessions || []).filter(s => !s.key.includes(':subagent:'));
      const goals = state.goals || [];
      
      // Find uncategorized sessions
      const assignedSessions = new Set();
      goals.forEach(g => (g.sessions || []).forEach(s => assignedSessions.add(s)));
      const uncategorized = sessions.filter(s => !assignedSessions.has(s.key));
      
      if (uncategorized.length === 0) {
        showToast('All sessions are already categorized! 🎉', 'success');
        return;
      }
      
      // Initialize wizard state
      state.wizardSessions = uncategorized;
      state.wizardIndex = 0;
      state.wizardOrganized = 0;
      state.wizardSkipped = 0;
      state.wizardCurrentProposal = null;
      
      // Show modal
      document.getElementById('organizeWizardModal').classList.remove('hidden');
      document.getElementById('wizardGoalPicker').classList.add('hidden');
      
      // Load first session
      loadWizardSession();
    }
    
    function closeOrganizeWizard() {
      document.getElementById('organizeWizardModal').classList.add('hidden');
      // Refresh data
      loadGoals();
      renderSessions();
    }
    
    async function loadWizardSession() {
      const sessions = state.wizardSessions;
      const idx = state.wizardIndex;
      
      if (idx >= sessions.length) {
        // Done!
        document.getElementById('wizardContent').innerHTML = `
          <div style="text-align: center; padding: 40px;">
            <div style="font-size: 3rem; margin-bottom: 16px;">🎉</div>
            <h3>All done!</h3>
            <p style="color: var(--text-dim);">
              Organized: ${state.wizardOrganized} sessions<br>
              Skipped: ${state.wizardSkipped} sessions
            </p>
          </div>
        `;
        document.getElementById('wizardAcceptBtn')?.remove();
        return;
      }
      
      const session = sessions[idx];
      const sessionName = session.displayName || session.label || session.key.split(':').pop();
      
      // Update progress
      document.getElementById('wizardProgress').textContent = `${idx + 1} of ${sessions.length}`;
      document.getElementById('wizardProgressBar').style.width = `${((idx + 1) / sessions.length) * 100}%`;
      document.getElementById('wizardStats').textContent = `${state.wizardOrganized} done · ${state.wizardSkipped} skipped`;
      
      // Update session info
      document.getElementById('wizardSessionIcon').textContent = getSessionIcon(session);
      document.getElementById('wizardSessionTitle').textContent = sessionName;
      document.getElementById('wizardSessionKey').textContent = session.key;
      
      // Update content preview
      const summaryEl = document.getElementById('wizardSummary');
      if (summaryEl) {
        summaryEl.innerHTML = 'Loading messages...';
      }
      
      // Update goal suggestion
      const proposalEl = document.getElementById('wizardProposedGoal');
      if (proposalEl) {
        proposalEl.innerHTML = `
          <div class="wiz-goal-name">Analyzing...</div>
          <div class="wiz-goal-reason">Finding the best goal for this session</div>
        `;
      }
      
      document.getElementById('wizardGoalPicker').classList.add('hidden');
      
      // Fetch history and generate summary + proposal
      await analyzeForWizard(session);
    }
    
    async function analyzeForWizard(session) {
      const goals = state.goals || [];
      const sessionKey = session.key;
      const sessionName = session.displayName || session.label || session.key.split(':').pop();
      
      // Fetch history
      let firstMessages = '';
      let lastMessages = '';
      try {
        const historyResult = await rpcCall('chat.history', { sessionKey, limit: 50 });
        if (historyResult?.messages) {
          const userMsgs = historyResult.messages.filter(m => m.role === 'user');
          
          const first5 = userMsgs.slice(0, 5);
          firstMessages = first5.map(m => {
            const text = typeof m.content === 'string' ? m.content : 
              (Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '');
            return text.slice(0, 150);
          }).join(' | ');
          
          const last5 = userMsgs.slice(-5);
          lastMessages = last5.map(m => {
            const text = typeof m.content === 'string' ? m.content : 
              (Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '');
            return text.slice(0, 150);
          }).join(' | ');
        }
      } catch (e) {
        console.log('Could not fetch history:', e);
      }
      
      // Show summary - format nicely
      const summaryText = firstMessages || lastMessages || 'No messages found';
      const formattedSummary = summaryText
        .split(' | ')
        .filter(s => s.trim())
        .map(s => `• ${escapeHtml(s.slice(0, 100))}${s.length > 100 ? '...' : ''}`)
        .slice(0, 5)
        .join('<br>');
      document.getElementById('wizardSummary').innerHTML = formattedSummary || 'No messages found';
      
      // Request AI proposal
      if (goals.length > 0) {
        const goalsList = goals.map(g => `- "${g.title}" (id: ${g.id})`).join('\n');
        
        const message = `[WIZARD-CATEGORIZE]
Analyze this session and suggest the BEST goal. Respond with ONLY JSON, no other text.

Session: ${sessionKey}
Name: ${sessionName}
First messages: ${firstMessages.slice(0, 300)}
Recent messages: ${lastMessages.slice(0, 300)}

Available goals:
${goalsList}

IMPORTANT: 
- Goals should be HIGH-LEVEL projects/initiatives (e.g. "Dashboard Development", "Investor Outreach", "Infrastructure Setup") - NOT granular tasks
- If no existing goal fits well, suggest a NEW high-level goal
- Group related work under broader themes

Response format:
If existing goal fits: {"goalId":"the-id","title":"Goal Title","reason":"why","isNew":false}
If new goal needed: {"goalId":null,"title":"High-Level Project Name","reason":"why new","isNew":true}`;

        try {
          if (!state.ws || !state.connected) {
            throw new Error('WebSocket not connected');
          }
          state.wizardPendingSessionKey = sessionKey;
          console.log('[Wizard] Sending AI request with', goals.length, 'existing goals...');
          await sendChatMessage(message);
          console.log('[Wizard] Request sent, waiting for response...');
          
          // Wait for response (timeout to manual)
          setTimeout(() => {
            if (state.wizardPendingSessionKey === sessionKey && !state.wizardCurrentProposal) {
              console.log('[Wizard] Timeout - showing manual picker');
              showWizardManualProposal();
            }
          }, 10000);
          
        } catch (e) {
          console.error('[Wizard] Error:', e);
          showWizardManualProposal();
        }
      } else {
        // No goals - ask AI to suggest a name for a new goal
        const message = `[WIZARD-CATEGORIZE]
Analyze this session and suggest a NEW high-level goal. Respond with ONLY JSON, no other text.

Session: ${sessionKey}
Name: ${sessionName}
First messages: ${firstMessages.slice(0, 300)}
Recent messages: ${lastMessages.slice(0, 300)}

No existing goals - suggest a HIGH-LEVEL project/initiative name (e.g. "Dashboard Development", "Investor Outreach", "Infrastructure Setup").
NOT a granular task - think broader themes that could contain multiple sessions.

Response format:
{"goalId":null,"title":"High-Level Project Name","reason":"what this project covers","isNew":true}`;

        try {
          if (!state.ws || !state.connected) {
            throw new Error('WebSocket not connected');
          }
          state.wizardPendingSessionKey = sessionKey;
          console.log('[Wizard] Sending AI request for goal suggestion...');
          await sendChatMessage(message);
          console.log('[Wizard] Request sent, waiting for response...');
          
          setTimeout(() => {
            if (state.wizardPendingSessionKey === sessionKey && !state.wizardCurrentProposal) {
              console.log('[Wizard] Timeout - no response received');
              state.wizardCurrentProposal = { goalId: null, title: 'New Goal', reason: 'AI timeout - suggest manually', isNew: true };
              showWizardProposal(state.wizardCurrentProposal);
            }
          }, 10000);
        } catch (e) {
          console.error('[Wizard] Error:', e);
          state.wizardCurrentProposal = { goalId: null, title: 'New Goal', reason: e.message || 'Error analyzing', isNew: true };
          showWizardProposal(state.wizardCurrentProposal);
        }
      }
    }
    
    function handleWizardResponse(text) {
      if (!state.wizardPendingSessionKey) return false;
      
      try {
        const jsonMatch = text.match(/\{[\s\S]*"goalId"[\s\S]*\}/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          state.wizardCurrentProposal = data;
          showWizardProposal(data);
          state.wizardPendingSessionKey = null;
          return true;
        }
      } catch (e) {
        console.log('Could not parse wizard response:', e);
      }
      
      return false;
    }
    
    function showWizardProposal(proposal) {
      const goals = state.goals || [];
      const goal = proposal.goalId ? goals.find(g => g.id === proposal.goalId) : null;
      const title = goal?.title || proposal.title || 'New Goal';
      const reason = proposal.reason || '';
      const isNew = !proposal.goalId || proposal.isNew;
      
      document.getElementById('wizardProposedGoal').innerHTML = `
        <div class="wiz-goal-name">${isNew ? '✨ ' : '📁 '}${escapeHtml(title)}</div>
        <div class="wiz-goal-reason">${escapeHtml(reason)}</div>
      `;
      
      const acceptBtn = document.getElementById('wizardAcceptBtn');
      acceptBtn.textContent = isNew ? '✓ Create Goal' : '✓ Accept';
      acceptBtn.style.display = '';
    }
    
    function showWizardManualProposal() {
      state.wizardCurrentProposal = null;
      document.getElementById('wizardProposedGoal').innerHTML = `
        <div class="wiz-goal-name" style="color: var(--text-dim);">No clear match</div>
        <div class="wiz-goal-reason">Choose a goal below or create new</div>
      `;
      document.getElementById('wizardAcceptBtn').style.display = 'none';
      showWizardGoalPicker();
    }
    
    function showWizardGoalPicker() {
      const goals = state.goals || [];
      const container = document.getElementById('wizardGoalList');
      
      if (goals.length === 0) {
        container.innerHTML = '<div class="empty-state">No goals yet</div>';
      } else {
        container.innerHTML = goals.map(g => `
          <div class="goal-picker-row" onclick="assignWizardGoal('${escapeHtml(g.id)}')">
            <div class="goal-picker-title">🏙️ ${escapeHtml(g.title)}</div>
            <div class="goal-picker-meta">${g.sessions?.length || 0} sessions</div>
          </div>
        `).join('');
      }
      
      document.getElementById('wizardGoalPicker').classList.remove('hidden');
    }
    
    async function acceptWizardProposal() {
      const proposal = state.wizardCurrentProposal;
      if (!proposal) {
        showWizardGoalPicker();
        return;
      }
      
      const sessionKey = state.wizardSessions[state.wizardIndex]?.key;
      if (!sessionKey) return;
      
      try {
        if (proposal.goalId && !proposal.isNew) {
          // Assign to existing goal
          await fetch(`/api/goals/${proposal.goalId}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionKey }),
          });
        } else {
          // Create new goal and assign
          const res = await fetch('/api/goals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: proposal.title || 'New Goal', condoId: getCondoIdForSessionKey(sessionKey) }),
          });
          const data = await res.json();
          if (data?.goal?.id) {
            await fetch(`/api/goals/${data.goal.id}/sessions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionKey }),
            });
            // Refresh goals
            await loadGoals();
          }
        }
        
        state.wizardOrganized++;
        nextWizardSession();
        
      } catch (e) {
        console.error('Failed to assign:', e);
        showToast('Failed to assign: ' + e.message, 'error');
      }
    }
    
    async function assignWizardGoal(goalId) {
      const sessionKey = state.wizardSessions[state.wizardIndex]?.key;
      if (!sessionKey) return;
      
      try {
        await fetch(`/api/goals/${goalId}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey }),
        });
        
        state.wizardOrganized++;
        nextWizardSession();
        
      } catch (e) {
        showToast('Failed to assign: ' + e.message, 'error');
      }
    }
    
    async function createGoalInWizard() {
      const title = document.getElementById('wizardNewGoalTitle').value.trim();
      if (!title) return;
      
      const sessionKey = state.wizardSessions[state.wizardIndex]?.key;
      if (!sessionKey) return;
      
      try {
        const res = await fetch('/api/goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, condoId: getCondoIdForSessionKey(state.wizardPendingSessionKey) }),
        });
        const data = await res.json();
        
        if (data?.goal?.id) {
          await fetch(`/api/goals/${data.goal.id}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionKey }),
          });
          await loadGoals();
        }
        
        document.getElementById('wizardNewGoalTitle').value = '';
        state.wizardOrganized++;
        nextWizardSession();
        
      } catch (e) {
        showToast('Failed: ' + e.message, 'error');
      }
    }
    
    function skipWizardSession() {
      state.wizardSkipped++;
      nextWizardSession();
    }
    
    function nextWizardSession() {
      state.wizardIndex++;
      state.wizardCurrentProposal = null;
      state.wizardPendingSessionKey = null;
      loadWizardSession();
    }

    function showCreateGoalModal() {
      document.getElementById('createGoalModal').classList.remove('hidden');
      document.getElementById('createGoalTitle').value = '';
      document.getElementById('createGoalDeadline').value = '';
      document.getElementById('createGoalError').style.display = 'none';
      setTimeout(() => document.getElementById('createGoalTitle')?.focus(), 0);
    }

    function hideCreateGoalModal() {
      document.getElementById('createGoalModal').classList.add('hidden');
    }

    async function createGoal() {
      const title = document.getElementById('createGoalTitle').value.trim();
      const deadline = document.getElementById('createGoalDeadline').value.trim();
      const errEl = document.getElementById('createGoalError');
      if (!title) {
        errEl.textContent = 'Title is required';
        errEl.style.display = 'block';
        return;
      }
      try {
        const res = await fetch('/api/goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, deadline: deadline || null, condoId: state.currentCondoId || state.newGoalCondoId || null }),
        });
        if (!res.ok) throw new Error('Failed to create goal');
        const data = await res.json();
        hideCreateGoalModal();
        await loadGoals();
        if (data?.goal?.id) setCurrentGoal(data.goal.id);
      } catch (e) {
        errEl.textContent = 'Failed to create goal';
        errEl.style.display = 'block';
      }
    }

    async function refresh() {
      if (!state.connected) return;
      
      // Clean up stale runs periodically (in case we missed 'done' events)
      cleanStaleRuns();
      
      await loadSessions();
      updateOverview();
    }
    
    function cleanStaleRuns() {
      const now = Date.now();
      let changed = false;
      
      for (const [key, data] of Object.entries(state.activeRunsStore)) {
        const age = now - (data.startedAt || 0);
        if (age > ACTIVE_RUN_STALE_MS) {
          console.log(`[ClawCondos] Cleaning stale run for ${key} (${Math.round(age/1000)}s old)`);
          state.activeRuns.delete(key);
          delete state.activeRunsStore[key];
          // Reset status to idle if it was thinking
          if (state.sessionAgentStatus[key] === 'thinking') {
            state.sessionAgentStatus[key] = 'idle';
          }
          changed = true;
        }
      }
      
      if (changed) {
        saveActiveRuns();
        renderSessions();
        renderSessionsGrid();
      }
    }
    
    async function loadSessions() {
      try {
        console.log('[ClawCondos] Loading sessions...');
        const result = await rpcCall('sessions.list', { limit: 50 });
        console.log('[ClawCondos] Sessions result:', result);
        if (result?.sessions) {
          state.sessions = result.sessions;

          // Data-level: funnel heartbeat/cron sessions into SYSTEM condo.
          for (const s of state.sessions) {
            if (isSystemCondoSession(s)) {
              // Fire-and-forget; don't block rendering.
              persistSessionCondo(s.key, 'condo:system');
            }
          }

          // Goals chips depend on total session count
          renderGoals();
          // Initialize/update status for sessions
          for (const s of state.sessions) {
            // Active runs take priority (restored from localStorage or from WebSocket events)
            if (state.activeRuns.has(s.key)) {
              state.sessionAgentStatus[s.key] = 'thinking';
            } else if (!state.sessionAgentStatus[s.key]) {
              // Default to idle for new sessions
              state.sessionAgentStatus[s.key] = 'idle';
            }
          }
          // Check for auto-archiving before rendering
          checkAutoArchive();
          renderSessions();
          renderSessionsGrid();
          updateUncategorizedCount();
          if (state.pendingRouteSessionKey) {
            const pending = state.pendingRouteSessionKey;
            state.pendingRouteSessionKey = null;
            if (state.sessions.find(s => s.key === pending)) {
              openSession(pending, { fromRouter: true });
            }
          }
          if (state.pendingRouteCondoId) {
            const pending = state.pendingRouteCondoId;
            state.pendingRouteCondoId = null;
            openCondo(pending, { fromRouter: true });
          }
          // Agents tree uses sessions for its nested view
          if (state.agents?.length) renderAgents();
        }
      } catch (err) {
        console.error('[ClawCondos] Failed to load sessions:', err);
      }
    }
    
    async function loadCronJobs() {
      if (state.cronJobsLoaded) return;
      try {
        const res = await rpcCall('cron.list', { includeDisabled: true });
        const jobs = res?.jobs || res?.items || (Array.isArray(res) ? res : []);
        if (Array.isArray(jobs)) {
          state.cronJobs = jobs;
          state.cronJobsLoaded = true;
        }
      } catch (e) {
        console.warn('cron.list failed:', e?.message || e);
      }
    }

    function formatRelativeTime(ms) {
      const t = Number(ms || 0);
      if (!t) return '—';
      const delta = Date.now() - t;
      const s = Math.floor(Math.abs(delta) / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      const d = Math.floor(h / 24);
      const fmt = d > 0 ? `${d}d` : h > 0 ? `${h}h` : m > 0 ? `${m}m` : `${s}s`;
      return delta >= 0 ? `${fmt} ago` : `in ${fmt}`;
    }

    function formatSchedule(schedule) {
      if (!schedule) return '—';
      if (schedule.kind === 'cron') {
        const tz = schedule.tz ? ` (${schedule.tz})` : '';
        return `${schedule.expr || 'cron'}${tz}`;
      }
      if (schedule.kind === 'every') {
        const ms = Number(schedule.everyMs || 0);
        if (!ms) return 'every (unknown)';
        const s = Math.round(ms / 1000);
        const m = Math.round(s / 60);
        const h = Math.round(m / 60);
        const d = Math.round(h / 24);
        const every = d >= 1 && d * 86400 === s ? `${d}d` : h >= 1 && h * 3600 === s ? `${h}h` : m >= 1 && m * 60 === s ? `${m}m` : `${s}s`;
        return `every ${every}`;
      }
      if (schedule.kind === 'at') {
        const at = Number(schedule.atMs || 0);
        return at ? `at ${new Date(at).toLocaleString()}` : 'at (unknown)';
      }
      return schedule.kind || '—';
    }

    function getJobModel(payload) {
      if (!payload) return 'main';
      if (payload.kind === 'agentTurn') return payload.model || 'default';
      return 'main';
    }

    function summarizeOutcome(payload) {
      if (!payload) return '';
      const txt = String(payload.message || payload.text || '').trim();
      if (!txt) return '';
      const line = txt.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
      return line.length > 120 ? line.slice(0, 117) + '…' : line;
    }

    function openCronJobDetail(jobId) {
      state.selectedCronJobId = String(jobId || '').trim() || null;
      renderDetailPanel();
    }

    async function ensureCronRuns(jobId) {
      const id = String(jobId || '').trim();
      if (!id) return;
      if (!state.cronRunsByJobId) state.cronRunsByJobId = {};
      const existing = state.cronRunsByJobId[id];
      if (existing && existing.loaded) return;
      state.cronRunsByJobId[id] = { loaded: false, loading: true, runs: [], error: null };
      try {
        const res = await rpcCall('cron.runs', { jobId: id });
        const runs = res?.runs || res?.items || (Array.isArray(res) ? res : []);
        state.cronRunsByJobId[id] = { loaded: true, loading: false, runs: Array.isArray(runs) ? runs : [], error: null };
      } catch (e) {
        state.cronRunsByJobId[id] = { loaded: true, loading: false, runs: [], error: e?.message || String(e) };
      }
    }

    async function loadSkillDetailsForAgent(agentId, skillIds) {
      try {
        const ids = (skillIds || []).map(String).filter(Boolean);
        if (!ids.length) return;
        const res = await fetch(`/api/skills/resolve?ids=${encodeURIComponent(ids.join(','))}`);
        const data = await res.json();
        if (data?.ok && Array.isArray(data.skills)) {
          state.resolvedSkillsByAgent[agentId] = data.skills;
        } else {
          state.resolvedSkillsByAgent[agentId] = ids.map(id => ({ id, name: id, description: '' }));
        }
      } catch {
        state.resolvedSkillsByAgent[agentId] = (skillIds || []).map(id => ({ id, name: id, description: '' }));
      } finally {
        if (state.currentView === 'agents') {
          renderAgentsPage();
        }
      }
    }

    async function loadAgentSummary(agentId) {
      const id = String(agentId || '').trim();
      if (!id) return;
      if (state.agentSummaries?.[id] || state.agentSummaryLoading?.[id]) return;
      state.agentSummaryLoading[id] = true;
      try {
        const res = await fetch(`/api/agents/summary?agentId=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (data && data.ok) state.agentSummaries[id] = data;
      } catch (e) {
        console.warn('agent summary load failed', id, e?.message || e);
      } finally {
        state.agentSummaryLoading[id] = false;
        if (state.currentView === 'agents') {
          renderAgentsPage();
        }
      }
    }

    async function loadAgentFiles(agentId) {
      const id = String(agentId || '').trim();
      if (!id) return;
      if (state.agentFileLoading) return;
      state.agentFileLoading = true;
      try {
        const res = await fetch(`/api/agents/files?agentId=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (data?.ok) {
          state.agentFileEntries = data.entries || [];
        }
      } catch (e) {
        console.warn('agent files load failed', id, e?.message || e);
      } finally {
        state.agentFileLoading = false;
        if (state.currentView === 'agents') renderDetailPanel();
      }
    }

    async function selectAgentFile(relPath) {
      const agent = state.agents?.find(a => a.id === state.selectedAgentId) || state.agents?.[0];
      if (!agent) return;
      state.selectedAgentFile = relPath;
      state.agentFileContent = '';
      try {
        const res = await fetch(`/api/agents/file?agentId=${encodeURIComponent(agent.id)}&path=${encodeURIComponent(relPath)}`);
        const data = await res.json();
        if (data?.ok) state.agentFileContent = data.content || '';
        else state.agentFileContent = data?.error || 'Failed to load file';
      } catch (e) {
        state.agentFileContent = `Failed to load file: ${e?.message || e}`;
      }
      renderDetailPanel();
    }

    function renderAgentsPage() {
      // Ensure agent data caches exist (detail panel used to initialize these)
      if (!state.agentSummaries) state.agentSummaries = {};
      if (!state.agentSummaryLoading) state.agentSummaryLoading = {};
      if (!state.resolvedSkillsByAgent) state.resolvedSkillsByAgent = {};

      const list = document.getElementById('agentsListColumn');
      const body = document.getElementById('agentsMainBody');
      if (!list || !body) return;

      const agents = (state.agents || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const sub = document.getElementById('agentsLeftSub');
      if (sub) sub.textContent = agents.length ? `${agents.length} configured` : '—';

      if (!agents.length) {
        list.innerHTML = `<div style="padding:12px; color: var(--text-dim);">No agents</div>`;
        body.innerHTML = '';
        return;
      }

      if (!state.selectedAgentId) state.selectedAgentId = agents[0].id;

      list.innerHTML = agents.map(a => {
        const name = a.identity?.name || a.name || a.id;
        const active = state.selectedAgentId === a.id;
        const model = a.model || a.models?.primary || '';

        const chips = [
          `<span class="agent-chip">${escapeHtml(String(a.id))}</span>`,
          model ? `<span class="agent-chip">${escapeHtml(String(model))}</span>` : ''
        ].filter(Boolean).join('');

        return `
          <div class="agent-card ${active ? 'active' : ''}" onclick="selectAgentForAgentsPage('${escapeHtml(a.id)}')">
            <div class="agent-card-title">${escapeHtml(String(name))}</div>
            <div class="agent-card-meta">${chips}</div>
          </div>
        `;
      }).join('');

      const agent = agents.find(a => a.id === state.selectedAgentId) || agents[0];
      state.selectedAgentId = agent.id;

      const titleEl = document.getElementById('agentsMainTitle');
      const metaEl = document.getElementById('agentsMainMeta');
      const displayName = agent.identity?.name || agent.name || agent.id;
      const model = agent.model || agent.models?.primary || '';
      if (titleEl) titleEl.textContent = `${agent.identity?.emoji || '🤖'} ${displayName}`;
      if (metaEl) {
        const toolCount = Array.isArray(agent.tools) ? agent.tools.length : (Array.isArray(agent.toolAllowlist) ? agent.toolAllowlist.length : null);
        metaEl.innerHTML = [
          `<span class="agent-chip">id: ${escapeHtml(String(agent.id))}</span>`,
          model ? `<span class="agent-chip">model: ${escapeHtml(String(model))}</span>` : '',
          toolCount != null ? `<span class="agent-chip">tools: ${escapeHtml(String(toolCount))}</span>` : ''
        ].filter(Boolean).join(' ');
      }

      const desc = (agent.description || agent.summary || '').trim();

      const jobsLoaded = state.cronJobsLoaded;
      const allJobs = state.cronJobs || [];
      const agentKey = String(agent.id);
      const agentJobs = jobsLoaded ? allJobs.filter(j => String(j.agentId || '') === agentKey) : [];
      const agentJobSearch = String((state.agentJobsSearchByAgent || {})[agentKey] || '');
      const agentJobEnabledOnly = !!(state.agentJobsEnabledOnlyByAgent || {})[agentKey];

      let filteredAgentJobs = agentJobs.slice();
      const agentSearch = agentJobSearch.trim().toLowerCase();
      if (agentJobEnabledOnly) {
        filteredAgentJobs = filteredAgentJobs.filter(j => j.enabled !== false);
      }
      if (agentSearch) {
        filteredAgentJobs = filteredAgentJobs.filter(j => {
          const name = String(j.name || j.id || '');
          const schedule = formatSchedule(j.schedule);
          const agentId = String(j.agentId || 'main');
          const model = String(getJobModel(j.payload));
          const outcome = summarizeOutcome(j.payload);
          const status = String(j.state?.lastStatus || '');
          const haystack = `${name} ${j.id || ''} ${schedule} ${agentId} ${model} ${outcome} ${status}`.toLowerCase();
          return haystack.includes(agentSearch);
        });
      }

      const jobsHtml = !jobsLoaded
        ? `<div class="grid-card">Loading recurring tasks…</div>`
        : (filteredAgentJobs.length ? filteredAgentJobs.map(j => {
            const name = j.name || j.id;
            const schedule = formatSchedule(j.schedule);
            const model = getJobModel(j.payload);
            const outcome = summarizeOutcome(j.payload);
            const last = j.state || {};
            const lastAt = Number(last.lastRunAtMs || 0);
            const lastStatus = last.lastStatus || '';
            const line2 = `${j.agentId || 'main'} · ${model} · ${j.enabled === false ? 'disabled' : 'enabled'}`;
            const line3 = lastAt ? `last ${formatRelativeTime(lastAt)}${lastStatus ? ` (${lastStatus})` : ''}` : '';
            return `
              <div class="grid-card" onclick="openCronJobDetail('${escapeHtml(String(j.id))}')">
                <div class="grid-card-header">
                  <div class="grid-card-icon">⏰</div>
                  <div class="grid-card-actions">
                    <button class="icon-btn" title="Details" onclick="event.stopPropagation(); openCronJobDetail('${escapeHtml(String(j.id))}')">ℹ️</button>
                  </div>
                </div>
                <div class="grid-card-title">${escapeHtml(String(name))}</div>
                <div class="grid-card-desc">${escapeHtml(schedule)}</div>
                <div class="grid-card-desc">${escapeHtml(line2)}</div>
                ${line3 ? `<div class="grid-card-desc">${escapeHtml(line3)}</div>` : ''}
                ${outcome ? `<div class="grid-card-desc" style="color: var(--text-dim); margin-top:6px;">${escapeHtml(outcome)}</div>` : ''}
              </div>
            `;
          }).join('') : `<div class="grid-card">${agentJobs.length ? 'No recurring tasks match filters' : 'No recurring tasks for this agent'}</div>`);

      body.innerHTML = `
        ${desc ? `<div class="detail-section"><div class="detail-label">Description</div><div class="detail-value" style="white-space: pre-wrap; color: var(--text-dim);">${escapeHtml(desc)}</div></div>` : ''}
        <div class="detail-section">
          <div class="detail-label">Recurring Tasks</div>
          <div class="detail-value">
            <div class="recurring-filters" style="margin: 6px 0 12px;">
              <input type="text" id="agentJobsSearch" class="form-input" placeholder="Search jobs…">
              <label class="recurring-toggle">
                <input type="checkbox" id="agentJobsEnabledOnly">
                Enabled only
              </label>
            </div>
            ${jobsHtml}
          </div>
        </div>
      `;

      const agentSearchInput = document.getElementById('agentJobsSearch');
      const agentEnabledToggle = document.getElementById('agentJobsEnabledOnly');
      if (agentSearchInput) {
        if (agentSearchInput.value !== agentJobSearch) {
          agentSearchInput.value = agentJobSearch;
        }
        agentSearchInput.oninput = () => {
          state.agentJobsSearchByAgent = state.agentJobsSearchByAgent || {};
          state.agentJobsSearchByAgent[agentKey] = agentSearchInput.value || '';
          lsSet('agent_jobs_search', JSON.stringify(state.agentJobsSearchByAgent));
          renderAgentsPage();
        };
      }
      if (agentEnabledToggle) {
        if (agentEnabledToggle.checked !== agentJobEnabledOnly) {
          agentEnabledToggle.checked = agentJobEnabledOnly;
        }
        agentEnabledToggle.onchange = () => {
          state.agentJobsEnabledOnlyByAgent = state.agentJobsEnabledOnlyByAgent || {};
          state.agentJobsEnabledOnlyByAgent[agentKey] = agentEnabledToggle.checked;
          lsSet('agent_jobs_enabled_only', JSON.stringify(state.agentJobsEnabledOnlyByAgent));
          renderAgentsPage();
        };
      }

      // Optional async extras (keep, but don't block usefulness)
      const sum = state.agentSummaries?.[agent.id];
      if (!sum) loadAgentSummary(agent.id);
      const skillIds = Array.isArray(agent.skills) ? agent.skills : (Array.isArray(agent.skillIds) ? agent.skillIds : []);
      if (skillIds.length && !state.resolvedSkillsByAgent?.[agent.id]) loadSkillDetailsForAgent(agent.id, skillIds);
      if (!state.agentFileEntries && !state.agentFileLoading) loadAgentFiles(agent.id);
      if (!state.cronJobsLoaded) loadCronJobs().then(() => { if (state.currentView === 'agents') renderAgentsPage(); });
    }

    function selectAgentForAgentsPage(agentId) {
      state.selectedAgentId = agentId;
      // clear any open cron detail when switching agents
      state.selectedCronJobId = null;
      // reset file viewer for this agent
      state.agentFileEntries = null;
      state.selectedAgentFile = null;
      state.agentFileContent = null;
      renderAgentsPage();
      renderDetailPanel();
    }

    async function loadApps() {
      try {
        const res = await fetch('/api/apps');
        if (!res.ok) return;
        const text = await res.text();
        if (!text) return;
        const data = JSON.parse(text);
        state.apps = (data.apps || []).map(app => ({
          ...app,
          statusClass: app.statusClass || 'idle',
          statusLabel: app.statusLabel || 'Unknown',
        }));
        renderApps();
        if (state.currentView === 'apps') renderAppsGridView();

        if (state.pendingRouteAppId) {
          const pending = state.pendingRouteAppId;
          state.pendingRouteAppId = null;
          if (state.apps.find(a => a.id === pending)) {
            selectApp(pending, { fromRouter: true });
          }
        }

        state.apps.forEach(checkAppStatus);
      } catch (err) {
        console.error('Failed to load apps:', err);
      }
    }
    
    async function loadAgents() {
      try {
        const result = await rpcCall('agents.list', {});
        const agents = result?.agents || result?.items || (Array.isArray(result) ? result : null);
        if (agents && Array.isArray(agents)) {
          state.agents = agents;
          renderAgents();
          if (state.currentView === 'agents') {
            renderAgentsPage();
            renderDetailPanel();
          }
        }
      } catch (err) {
        console.error('Failed to load agents:', err);
      }
    }
    
    function renderAgents() {
      const container = document.getElementById('agentsList');

      if (state.agents.length === 0) {
        container.innerHTML = `<div style="padding: 16px; color: var(--text-dim); font-size: 0.85rem;">No agents configured</div>`;
        return;
      }

      // Build a lightweight tree: Agent -> Sessions -> Subsessions.
      // NOTE: The backend session model does not currently expose parent pointers for subagents,
      // so we group by agentId only.
      const sessionsByAgent = new Map();
      for (const a of state.agents) {
        sessionsByAgent.set(a.id, { sessions: [], subsessions: [] });
      }

      for (const s of (state.sessions || [])) {
        const m = s.key.match(/^agent:([^:]+):/);
        if (!m) continue;
        const agentId = m[1];
        if (!sessionsByAgent.has(agentId)) continue;
        if (s.key.includes(':subagent:')) sessionsByAgent.get(agentId).subsessions.push(s);
        else sessionsByAgent.get(agentId).sessions.push(s);
      }

      // Sort newest first
      for (const group of sessionsByAgent.values()) {
        group.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        group.subsessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      }

      container.innerHTML = state.agents.map(agent => {
        const emoji = agent.identity?.emoji || '🤖';
        const name = agent.identity?.name || agent.name || agent.id;
        const isDefault = agent.isDefault ? ' (default)' : '';
        const expanded = isAgentExpanded(agent.id);
        const group = sessionsByAgent.get(agent.id) || { sessions: [], subsessions: [] };

        const sessionsHtml = group.sessions.length
          ? group.sessions.map(s => renderSessionItem(s, true)).join('')
          : `<div style="padding: 10px 16px 10px 48px; color: var(--text-dim); font-size: 0.8rem;">No sessions</div>`;

        const subsessionsHtml = group.subsessions.length
          ? group.subsessions.map(s => renderSessionItem(s, true)).join('')
          : `<div style="padding: 10px 16px 10px 48px; color: var(--text-dim); font-size: 0.8rem;">No subsessions</div>`;

        return `
          <div class="session-group ${expanded ? 'expanded' : ''}">
            <div class="session-group-header" onclick="toggleAgentExpanded('${escapeHtml(agent.id)}')">
              <span class="group-expand-icon">${expanded ? '▼' : '▶'}</span>
              <span class="group-icon">${escapeHtml(emoji)}</span>
              <span class="group-name">${escapeHtml(name)}${isDefault}</span>
              <span class="group-count">${group.sessions.length + group.subsessions.length}</span>
              <button class="session-action-btn" onclick="event.stopPropagation(); startNewSession('${escapeHtml(agent.id)}')" title="New session">＋</button>
              <button class="session-action-btn" onclick="event.stopPropagation(); showAgentDetails('${escapeHtml(agent.id)}')" title="Details">ℹ</button>
            </div>
            ${expanded ? `
              <div class="session-group-items">
                <div class="session-group-header" style="padding-left: 36px; font-size: 0.78rem; color: var(--text-dim); cursor: default;">
                  <span class="group-expand-icon" style="visibility: hidden;">▶</span>
                  <span class="group-icon">💬</span>
                  <span class="group-name">Sessions</span>
                  <span class="group-count">${group.sessions.length}</span>
                </div>
                ${sessionsHtml}
                <div class="session-group-header" style="padding-left: 36px; font-size: 0.78rem; color: var(--text-dim); cursor: default; border-top: 1px solid var(--border-subtle);">
                  <span class="group-expand-icon" style="visibility: hidden;">▶</span>
                  <span class="group-icon">⚡</span>
                  <span class="group-name">Subsessions</span>
                  <span class="group-count">${group.subsessions.length}</span>
                </div>
                ${subsessionsHtml}
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
    }
    
    function showAgentDetails(agentId) {
      const agent = state.agents.find(a => a.id === agentId);
      if (!agent) return;
      
      const emoji = agent.identity?.emoji || '🤖';
      const name = agent.identity?.name || agent.name || agent.id;
      
      state.currentView = 'agent';
      setView('overviewView');
      setActiveNav(null);
      setBreadcrumbs([
        { label: '🏠', onClick: "navigateTo('dashboard')" },
        { label: `${escapeHtml(emoji)} ${escapeHtml(name)}`, current: true }
      ]);
      
      const contentArea = document.getElementById('overviewArea');
      contentArea.innerHTML = `
        <div class="agent-details" style="padding: 24px;">
          <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 24px;">
            <div style="font-size: 3rem;">${escapeHtml(emoji)}</div>
            <div>
              <h2 style="margin: 0;">${escapeHtml(name)}</h2>
              <div style="color: var(--text-dim);">ID: ${escapeHtml(agent.id)}</div>
              ${agent.isDefault ? '<div style="color: var(--green); font-size: 0.85rem;">Default Agent</div>' : ''}
            </div>
          </div>
          
          <div style="display: grid; gap: 16px; max-width: 600px;">
            <div class="detail-card" style="background: var(--bg-secondary); padding: 16px; border-radius: 8px;">
              <div style="font-weight: 600; margin-bottom: 8px;">Model</div>
              <div style="color: var(--text-dim);">${escapeHtml(agent.model || 'Default')}</div>
            </div>
            
            <div class="detail-card" style="background: var(--bg-secondary); padding: 16px; border-radius: 8px;">
              <div style="font-weight: 600; margin-bottom: 8px;">Workspace</div>
              <div style="color: var(--text-dim);">${escapeHtml(agent.workspace || 'Default')}</div>
            </div>
          </div>
          
          <button onclick="startNewSession('${escapeHtml(agent.id)}')" 
                  style="margin-top: 24px; padding: 12px 24px; background: var(--accent); color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem;">
            Start New Session
          </button>
        </div>
      `;
      
      document.getElementById('overviewArea').style.display = 'block';
      document.getElementById('chatArea').style.display = 'none';
      updateMobileHeader();
      closeSidebar();
    }
    
    async function startNewSession(agentId) {
      const timestamp = Date.now();
      const sessionKey = `agent:${agentId}:webchat:${timestamp}`;
      const idempotencyKey = `new-${agentId}-${timestamp}`;
      try {
        // Initialize session by sending a greeting
        await rpcCall('chat.send', {
          sessionKey,
          message: 'Hello!',
          idempotencyKey
        });
        // Open the new session
        openSession(sessionKey);
      } catch (err) {
        console.error('Failed to start session:', err);
        showToast('Failed to start new session: ' + err.message, 'error');
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // SESSIONS UI
    // ═══════════════════════════════════════════════════════════════
    

    function renderSessionGoalBadge(sessionKey) {
      const g = getGoalForSession(sessionKey);
      if (!g) return '';
      const due = g.deadline ? ` · due ${escapeHtml(g.deadline)}` : '';
      return `<div class="session-goal-badge" onclick="event.stopPropagation(); openGoal('${escapeHtml(g.id)}')" title="Open goal">🏙️ ${escapeHtml(g.title || 'Goal')}${due}</div>`;
    }

    function renderSessionItem(s, isNested = false) {
      const isActive = state.currentSession && state.currentSession.key === s.key;
      const agentStatus = getAgentStatus(s.key);
      const tooltip = getStatusTooltip(agentStatus);
      const isPinned = isSessionPinned(s.key);
      const isArchived = isSessionArchived(s.key);
        const clickHandler = `openSession('${escapeHtml(s.key)}')`;
      const isGenerating = state.generatingTitles.has(s.key);
      const sessionName = getSessionName(s, true);  // This triggers auto-generation
      const hasUnread = !isActive && isSessionUnread(s.key);
      const parsed = parseSessionGroup(s.key);
      
      // For nested items, use full session name (with auto-generated title if available)
      let displayName = sessionName;
      
      return `
        <div class="item status-${agentStatus} ${isActive ? 'active' : ''} ${isArchived ? 'archived-session' : ''} ${hasUnread ? 'unread' : ''} ${isNested ? 'nested-item' : ''}" data-session-key="${escapeHtml(s.key)}" onclick="${clickHandler}">
          <div class="item-icon">${isNested ? '💬' : getSessionIcon(s)}${s.compactionCount > 0 ? '<span class="compaction-badge" title="Compacted ' + s.compactionCount + 'x">📜</span>' : ''}</div>
          <div class="item-content">
            <div class="item-name ${isGenerating ? 'title-generating' : ''}">${escapeHtml(displayName)}</div>
            <div class="item-meta">${escapeHtml(getSessionMeta(s))}</div>
            ${renderSessionGoalBadge(s.key)}
            ${renderSessionStatusLine(s.key)}
          </div>
          <div class="session-actions">
            <button class="session-action-btn ${hasUnread ? 'unread' : ''}" 
                    onclick="${hasUnread ? `markSessionRead('${escapeHtml(s.key)}'); event.stopPropagation(); renderSessions();` : `markSessionUnread('${escapeHtml(s.key)}', event)`}" 
                    title="${hasUnread ? 'Mark read' : 'Mark unread'}">
              ${hasUnread ? '●' : '○'}
            </button>
            <button class="session-action-btn ${isPinned ? 'pinned' : ''}" 
                    onclick="event.stopPropagation(); togglePinSession('${escapeHtml(s.key)}')" 
                    title="${isPinned ? 'Unpin' : 'Pin'}">
              ${isPinned ? '★' : '☆'}
            </button>
            <button class="session-action-btn" 
                    onclick="promptRenameSession('${escapeHtml(s.key)}', event)" 
                    title="Rename">
              ✏️
            </button>
            <button class="session-action-btn" 
                    onclick="generateSessionTitle('${escapeHtml(s.key)}', event)" 
                    title="Auto-generate title">
              ✨
            </button>
            <button class="session-action-btn" 
                    onclick="askSessionForSummary('${escapeHtml(s.key)}', event)" 
                    title="Ask for full summary">
              📋
            </button>
            ${!s.key.includes(':subagent:') ? `<button class="session-action-btn categorize-btn" 
                    onclick="showCategorizeSuggestions('${escapeHtml(s.key)}', event)" 
                    title="Suggest goal for this session">
              🏷️
            </button>` : ''}
            <button class="session-action-btn ${isArchived ? 'archived' : ''}" 
                    onclick="event.stopPropagation(); toggleArchiveSession('${escapeHtml(s.key)}')" 
                    title="${isArchived ? 'Unarchive' : 'Archive'}">
              ${isArchived ? '📤' : '📥'}
            </button>
          </div>
          <div class="agent-status ${agentStatus}" data-tooltip="${tooltip}"></div>
        </div>
      `;
    }
    
    function buildSubagentParentMap(mainSessions, subagentSessions) {
      // Heuristic parenting: we don't have explicit parent pointers.
      // We attach each subagent to the closest-in-time main session for the same agent.
      const byAgent = new Map();
      for (const s of mainSessions) {
        const m = s.key.match(/^agent:([^:]+):/);
        const agentId = m ? m[1] : null;
        if (!agentId) continue;
        if (!byAgent.has(agentId)) byAgent.set(agentId, []);
        byAgent.get(agentId).push(s);
      }
      for (const arr of byAgent.values()) {
        arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      }

      const parentMap = new Map(); // parentSessionKey -> subagent[]
      const unparented = [];

      const MAX_ATTACH_AGE_MS = 2 * 60 * 60 * 1000; // 2h window
      const ALLOW_FUTURE_PARENT_MS = 5 * 60 * 1000; // tolerate slight clock/order skew

      for (const sub of subagentSessions) {
        const m = sub.key.match(/^agent:([^:]+):/);
        const agentId = m ? m[1] : null;
        const candidates = agentId ? (byAgent.get(agentId) || []) : [];

        let best = null;
        let bestScore = Infinity;
        const subTime = sub.updatedAt || 0;

        for (const cand of candidates) {
          const candTime = cand.updatedAt || 0;
          const dt = Math.abs(subTime - candTime);

          // Avoid attaching to something wildly unrelated
          if (dt > MAX_ATTACH_AGE_MS) continue;

          // Prefer candidates not too far "after" the subagent (but allow a bit)
          if (candTime - subTime > ALLOW_FUTURE_PARENT_MS) continue;

          if (dt < bestScore) {
            best = cand;
            bestScore = dt;
          }
        }

        if (best) {
          if (!parentMap.has(best.key)) parentMap.set(best.key, []);
          parentMap.get(best.key).push(sub);
        } else {
          unparented.push(sub);
        }
      }

      // Sort each child list newest-first
      for (const arr of parentMap.values()) {
        arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      }
      unparented.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      return { parentMap, unparented };
    }

    function renderSessions() {
      renderSidebar();
    }
    
    function getSessionIcon(s) {
      if (s.key.includes(':subagent:')) return '⚡';
      if (s.key.includes(':app:')) return '🛠️';
      if (s.key.startsWith('cron:')) return '⏰';
      if (s.key.includes(':group:')) return '👥';
      return '💬';
    }
    
    function getSessionName(s, triggerAutoGen = false) {
      // Check for custom name first
      const customName = getCustomSessionName(s.key);
      if (customName) return customName;
      
      // Check if currently generating
      if (state.generatingTitles.has(s.key)) {
        return '✨ Generating';
      }
      
      // Auto-trigger title generation for sessions with messages
      if (triggerAutoGen && !state.attemptedTitles.has(s.key)) {
        // Only auto-generate for sessions that have messages and aren't special
        const isSpecial = s.key === 'agent:main:main' || 
                         s.key.includes(':subagent:') || 
                         s.key.includes(':app:') ||
                         s.key.startsWith('cron:');
        if (!isSpecial && s.totalTokens > 0) {
          autoGenerateTitle(s.key);
        }
      }
      
      return getDefaultSessionName(s);
    }
    
    function getDefaultSessionName(s) {
      if (!s) return 'Unknown';
      if (s.key === 'agent:main:main') return 'Main';
      if (s.key.includes(':subagent:')) return s.label || 'Sub-agent';
      if (s.key.includes(':app:')) return `App: ${s.key.split(':app:')[1]}`;
      if (s.key.startsWith('cron:')) return s.key.replace('cron:', 'Cron: ');
      // Telegram topics: show "Topic N" or channel info
      if (s.key.includes(':topic:')) {
        const topicMatch = s.key.match(/:topic:(\d+)$/);
        if (topicMatch) return `Topic ${topicMatch[1]}`;
      }
      // Telegram groups without topic
      if (s.key.includes(':telegram:group:')) {
        const groupMatch = s.key.match(/:group:(-?\d+)(?:$|:)/);
        if (groupMatch) return `Group ${groupMatch[1].slice(-4)}`;
      }
      // Telegram DMs
      if (s.key.includes(':telegram:') && !s.key.includes(':group:')) {
        return s.displayName || 'Telegram DM';
      }
      return s.displayName || s.key.split(':').pop();
    }
    
    function getSessionMeta(s) {
      const ago = timeAgo(s.updatedAt);
      const model = s.model ? s.model.split('/').pop().split('-')[0] : '';
      return `${ago}${model ? ' • ' + model : ''}`;
    }
    
    function isSessionCompacted(s) {
      return s.compactionCount > 0;
    }
    
    function getSessionActivityStatus(s) {
      // Check if actively streaming
      if (state.activeRuns.has(s.key)) return 'running';
      if (s.abortedLastRun) return 'error';
      const mins = (Date.now() - s.updatedAt) / 60000;
      if (mins < 2) return 'active';
      return 'idle';
    }
    
    // ═══════════════════════════════════════════════════════════════
    // APPS UI
    // ═══════════════════════════════════════════════════════════════
    function renderApps() {
      const container = document.getElementById('appsList');
      
      if (state.apps.length === 0) {
        container.innerHTML = `<div style="padding: 16px; color: var(--text-dim); font-size: 0.85rem;">No apps configured</div>`;
        return;
      }
      
      container.innerHTML = state.apps.map(app => `
        <a href="/app?id=${escapeHtml(app.id)}" target="_blank" class="item">
          <div class="item-icon">${escapeHtml(app.icon || '📦')}</div>
          <div class="item-content">
            <div class="item-name">${escapeHtml(app.name)}</div>
            <div class="item-meta">:${app.port}</div>
          </div>
          <div class="item-status idle" id="app-status-${escapeHtml(app.id)}"></div>
        </a>
      `).join('');
    }
    
    async function checkAppStatus(app) {
      const dot = document.getElementById(`app-status-${app.id}`);
      if (!dot) return;

      const host = window.location.hostname;
      const isLocal = host === 'localhost' || host === '127.0.0.1';

      // On localhost, some app reverse-proxies may not be running; don't spam the console.
      // Treat unknown/unreachable as 'idle' to keep the UI calm.
      try {
        if (isLocal) {
          dot.className = 'item-status idle';
          app.statusClass = 'unknown';
          app.statusLabel = 'Unknown';
        } else {
          const res = await fetch(`/${app.id}/`, { method: 'HEAD' });
          const ok = res.ok || res.status === 401;
          dot.className = 'item-status ' + (ok ? 'active' : 'error');
          app.statusClass = ok ? 'running' : 'stopped';
          app.statusLabel = ok ? 'Running' : 'Stopped';
        }
      } catch {
        dot.className = 'item-status idle';
        app.statusClass = 'unknown';
        app.statusLabel = 'Unknown';
      }

      if (state.currentView === 'apps') {
        renderAppsGridView();
        renderDetailPanel();
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // MOBILE NAVIGATION
    // ═══════════════════════════════════════════════════════════════
    function toggleSidebar() {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebarOverlay');
      sidebar.classList.toggle('open');
      overlay.classList.toggle('active');
      document.body.style.overflow = sidebar.classList.contains('open') ? 'hidden' : '';
    }
    
    function closeSidebar() {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebarOverlay');
      sidebar.classList.remove('open');
      overlay.classList.remove('active');
      document.body.style.overflow = '';
    }
    
    function updateMobileHeader() {
      const menuBtn = document.getElementById('menuBtn');
      const backBtn = document.getElementById('backBtn');
      const mobileTitle = document.getElementById('mobileTitle');
      
      if (state.currentView === 'chat' && state.currentSession) {
        menuBtn.style.display = 'none';
        backBtn.style.display = 'flex';
        mobileTitle.textContent = getSessionName(state.currentSession);
      } else if (state.currentView === 'agent') {
        menuBtn.style.display = 'none';
        backBtn.style.display = 'flex';
        mobileTitle.textContent = 'Agent';
      } else if (state.currentView === 'goal') {
        menuBtn.style.display = 'none';
        backBtn.style.display = 'flex';
        const g = state.goals.find(x => x.id === state.currentGoalOpenId);
        mobileTitle.textContent = g ? g.title : 'Goal';
      } else if (state.currentView === 'apps' || state.currentView === 'recurring' || state.currentView === 'new-session' || state.currentView === 'new-goal') {
        menuBtn.style.display = 'none';
        backBtn.style.display = 'flex';
        mobileTitle.textContent = state.currentView === 'apps' ? 'Apps'
          : state.currentView === 'recurring' ? 'Recurring'
          : state.currentView === 'new-session' ? 'New Session'
          : 'New Goal';
      } else {
        menuBtn.style.display = 'flex';
        backBtn.style.display = 'none';
        mobileTitle.textContent = 'ClawCondos';
      }
    }
    
    function goBack() {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        navigateTo('dashboard');
      }
    }

    function goBackFromGoal() {
      // Prefer real history back if possible
      if (window.history.length > 1) {
        window.history.back();
        return;
      }

      const goal = state.goals?.find(g => g.id === state.currentGoalOpenId);
      const condoId = goal?.condoId || state.currentCondoId;
      if (condoId) {
        navigateTo(`condo/${encodeURIComponent(condoId)}`);
      } else {
        navigateTo('dashboard');
      }
    }
    
    function setBreadcrumbs(crumbs) {
      const container = document.getElementById('breadcrumbs');
      if (!container) return;
      container.innerHTML = crumbs.map((c, idx) => {
        const sep = idx === 0 ? '' : '<span class="breadcrumb-sep">›</span>';
        const cls = c.current ? 'breadcrumb-current' : 'breadcrumb';
        return `${sep}<span class="${cls}" ${c.onClick ? `onclick="${c.onClick}"` : ''}>${c.label}</span>`;
      }).join('');
    }

    function setActiveNav(route) {
      document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.route === route);
      });
    }

    function setView(viewId) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const view = document.getElementById(viewId);
      if (view) view.classList.add('active');

      // UX: when switching between top-level views (overview/apps/recurring/etc),
      // reset the main scroll container so content doesn't appear "under" the wrapper.
      // Preserve scroll for chat view since it manages its own autoscroll behavior.
      try {
        if (viewId !== 'chatView') {
          const main = document.querySelector('.content-main');
          if (main) main.scrollTop = 0;
        }
      } catch {}
    }

    function navigateTo(path, replace = false) {
      const clean = String(path || '').replace(/^#\/?/, '').replace(/^\//, '');
      const url = `#/${clean}`;

      // Avoid double-pushing identical entries (breaks reliable Back behavior)
      if (window.location.hash === url) {
        handleRoute();
        return;
      }

      if (replace) {
        history.replaceState({ path: clean }, '', url);
      } else {
        history.pushState({ path: clean }, '', url);
      }
      handleRoute();
    }

    function handleRoute() {
      const raw = window.location.hash.replace('#/', '');
      const [route, ...rest] = raw.split('/');
      const payload = rest.join('/');

      switch (route || 'dashboard') {
        case 'apps': {
          if (payload) {
            const appId = decodeURIComponent(payload);
            if (!state.apps?.length) {
              state.pendingRouteAppId = appId;
              showAppsView();
            } else {
              showAppsView({ fromRouter: true });
              selectApp(appId, { fromRouter: true });
            }
          } else {
            showAppsView({ fromRouter: true });
          }
          break;
        }
        case 'recurring': {
          if (payload) {
            const cronJobId = decodeURIComponent(payload);
            state.selectedCronJobId = cronJobId;
            showRecurringView({ fromRouter: true });
            renderDetailPanel();
          } else {
            showRecurringView({ fromRouter: true });
          }
          break;
        }
        case 'condo':
          if (payload) {
            const condoId = decodeURIComponent(payload);
            // If data hasn't loaded yet, defer
            if (!(state.sessions?.length || state.goals?.length)) {
              state.pendingRouteCondoId = condoId;
              showOverview(); // don't navigate; we're already in a router call
            } else {
              openCondo(condoId, { fromRouter: true });
            }
          } else {
            showOverview();
          }
          break;
        case 'goal':
          if (payload) {
            const goalId = decodeURIComponent(payload);
            // If goals not loaded yet, defer
            if (!state.goals?.length) {
              state.pendingRouteGoalId = goalId;
              showOverview();
            } else {
              openGoal(goalId, { fromRouter: true });
            }
          } else {
            showOverview();
          }
          break;
        case 'session':
          if (payload) {
            const sessionKey = decodeURIComponent(payload);
            if (state.sessions.find(s => s.key === sessionKey)) {
              openSession(sessionKey, { fromRouter: true });
            } else {
              state.pendingRouteSessionKey = sessionKey;
            }
          } else {
            showOverview();
          }
          break;
        case 'agents': {
          if (payload) state.pendingRouteAgentId = decodeURIComponent(payload);
          showAgentsView({ fromRouter: true });
          break;
        }
        case 'new-session': {
          // /new-session/<condoId>/<goalId?>
          const parts = payload ? payload.split('/').map(decodeURIComponent) : [];
          const condoId = parts[0] || null;
          const goalId = parts[1] || null;

          // If goals aren't loaded yet, defer so the goal dropdown can populate.
          if (!state.goals?.length) {
            state.pendingRouteNewSession = { condoId, goalId };
            showNewSessionView({ fromRouter: true });
          } else {
            state.newSessionCondoId = condoId || state.currentCondoId;
            state.attachGoalId = goalId || null;
            showNewSessionView({ fromRouter: true });
          }
          break;
        }
        case 'new-goal': {
          // /new-goal/<condoId>
          const parts = payload ? payload.split('/').map(decodeURIComponent) : [];
          const condoId = parts[0] || null;

          if (!state.goals?.length) {
            state.pendingRouteNewGoalCondoId = condoId;
            showNewGoalView({ fromRouter: true });
          } else {
            state.newGoalCondoId = condoId || state.currentCondoId;
            showNewGoalView({ fromRouter: true });
          }
          break;
        }
        case 'dashboard':
        default:
          showOverview();
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // VIEWS
    // ═══════════════════════════════════════════════════════════════
    function showOverview() {
      state.currentView = 'dashboard';
      state.currentSession = null;
      state.currentGoalId = 'all';
      localStorage.removeItem('sharp_current_session');
      
      setView('overviewView');
      setActiveNav('dashboard');
      setBreadcrumbs([
        { label: '🏠', onClick: "navigateTo('dashboard')" },
        { label: 'Dashboard', current: true }
      ]);
      document.getElementById('headerAction').style.display = 'none';
      document.getElementById('headerStatusIndicator').style.display = 'none';
      
      renderSessions();
      updateMobileHeader();
      closeSidebar();
      renderDetailPanel();
    }

    function showAppsView(opts = {}) {
      state.currentView = 'apps';
      setView('appsView');
      setActiveNav('apps');
      setBreadcrumbs([
        { label: '🏠', onClick: "navigateTo('dashboard')" },
        { label: 'Apps', current: true }
      ]);
      document.getElementById('headerAction').style.display = 'none';
      document.getElementById('headerStatusIndicator').style.display = 'none';
      if (!state.selectedAppId && state.apps[0]) state.selectedAppId = state.apps[0].id;

      // If route included an app id and apps were not loaded yet, resolve now
      if (state.pendingRouteAppId && state.apps?.length) {
        const pending = state.pendingRouteAppId;
        state.pendingRouteAppId = null;
        if (state.apps.find(a => a.id === pending)) {
          state.selectedAppId = pending;
        }
      }
      renderAppsGridView();
      renderDetailPanel();
      updateMobileHeader();
      closeSidebar();
    }

    function showRecurringView(opts = {}) {
      state.currentView = 'recurring';
      setView('recurringView');
      setActiveNav('recurring');
      setBreadcrumbs([
        { label: '🏠', onClick: "navigateTo('dashboard')" },
        { label: 'Recurring Tasks', current: true }
      ]);
      document.getElementById('headerAction').style.display = 'none';
      document.getElementById('headerStatusIndicator').style.display = 'none';
      bindRecurringFilters();
      renderRecurringView();
      renderDetailPanel();
      updateMobileHeader();
      closeSidebar();
    }

    function showAgentsView(opts = {}) {
      state.currentView = 'agents';
      setView('agentsView');
      setActiveNav('agents');
      setBreadcrumbs([
        { label: '🏠', onClick: "navigateTo('dashboard')" },
        { label: 'Agents', current: true }
      ]);
      document.getElementById('headerAction').style.display = 'none';
      document.getElementById('headerStatusIndicator').style.display = 'none';

      // Ensure we have agents loaded
      if (!state.agents || state.agents.length === 0) {
        loadAgents();
      }

      if (state.pendingRouteAgentId) {
        const pending = state.pendingRouteAgentId;
        state.pendingRouteAgentId = null;
        if (state.agents?.find(a => a.id === pending)) state.selectedAgentId = pending;
      }

      if (!state.selectedAgentId && state.agents?.length) state.selectedAgentId = state.agents[0].id;

      renderAgentsPage();
      renderDetailPanel();
      updateMobileHeader();
      closeSidebar();
    }

    function showNewSessionView(opts = {}) {
      state.currentView = 'new-session';
      setView('newSessionView');
      setActiveNav(null);
      setBreadcrumbs([
        { label: '🏠', onClick: "navigateTo('dashboard')" },
        { label: 'New Session', current: true }
      ]);
      renderNewSessionForm();
      renderDetailPanel();
      updateMobileHeader();
      closeSidebar();
    }

    function showNewGoalView(opts = {}) {
      state.currentView = 'new-goal';
      setView('newGoalView');
      setActiveNav(null);
      setBreadcrumbs([
        { label: '🏠', onClick: "navigateTo('dashboard')" },
        { label: 'New Goal', current: true }
      ]);
      renderNewGoalForm();
      renderDetailPanel();
      updateMobileHeader();
      closeSidebar();
    }

    function openNewSession(condoId, goalId = null) {
      const c = condoId || state.currentCondoId || '';
      const g = goalId || '';

      // If we're creating a session from within a goal context, don't show the New Session modal.
      // Instead: open the goal view in a "not started" state so the user can click "Kick Off Goal"
      // to create the first message and begin.
      if (g) {
        state.forceNewGoalSessionGoalId = g;
        navigateTo(`goal/${encodeURIComponent(g)}`);
        return;
      }

      const path = `new-session/${encodeURIComponent(c)}`;
      navigateTo(path);
    }

    function openNewGoal(condoId) {
      const c = condoId || state.currentCondoId || '';
      navigateTo(`new-goal/${encodeURIComponent(c)}`);
    }

    function selectCondo(condoId) {
      openCondo(condoId);
    }

    function openCondo(condoId, opts = {}) {
      if (!condoId) return;

      if (!opts.fromRouter) {
        navigateTo(`condo/${encodeURIComponent(condoId)}`);
        return;
      }

      state.currentView = 'condo';
      state.currentCondoId = condoId;
      state.currentSession = null;
      state.currentGoalId = 'all';
      localStorage.removeItem('sharp_current_session');

      setView('condoView');
      setActiveNav(null);

      const condoName = (() => {
        if (condoId === 'cron') return 'Recurring';
        // Try to resolve from existing sessions
        const s = (state.sessions || []).find(x => getSessionCondoId(x) === condoId);
        if (s) return getSessionCondoName(s);
        return condoId.split(':').pop() || 'Condo';
      })();

      setBreadcrumbs([
        { label: '🏠', onClick: "navigateTo('dashboard')" },
        { label: `🏢 ${escapeHtml(condoName)}`, current: true }
      ]);

      document.getElementById('headerAction').style.display = 'none';
      document.getElementById('headerStatusIndicator').style.display = 'none';

      renderCondoView();
      renderDetailPanel();
      updateMobileHeader();
      closeSidebar();
    }

    function renderCondoView() {
      const gridEl = document.getElementById('condoGoalGrid');
      const sessionsEl = document.getElementById('condoSessionsList');
      if (!gridEl) return;

      const condoId = state.currentCondoId;

      const condoName = (() => {
        if (condoId === 'cron') return 'Recurring';
        const s = (state.sessions || []).find(x => getSessionCondoId(x) === condoId);
        return s ? getSessionCondoName(s) : (condoId.split(':').pop() || 'Condo');
      })();

      const titleEl = document.getElementById('condoHeroTitle');
      if (titleEl) titleEl.textContent = condoName;

      const allGoals = (state.goals || []).filter(g => (g.condoId || 'misc:default') === condoId);
      const activeGoals = allGoals.filter(g => !isGoalCompleted(g) && !isGoalDropped(g));
      const completedGoals = allGoals.filter(g => isGoalCompleted(g) && !isGoalDropped(g));
      const droppedGoals = allGoals.filter(g => isGoalDropped(g));

      const doing = activeGoals.filter(g => (g.status || 'active') === 'doing' || (g.priority === 'P0'));
      const blocked = activeGoals.filter(g => (g.status || '').toLowerCase() === 'blocked');

      const statActive = document.getElementById('condoStatActive');
      const statTotal = document.getElementById('condoStatTotal');
      const statDoing = document.getElementById('condoStatDoing');
      const statBlocked = document.getElementById('condoStatBlocked');
      if (statActive) statActive.textContent = String(activeGoals.length);
      if (statTotal) statTotal.textContent = String(allGoals.length);
      const statDropped = document.getElementById('condoStatDropped');
      if (statDropped) statDropped.textContent = String(droppedGoals.length);
      if (statDoing) statDoing.textContent = String(doing.length);
      if (statBlocked) statBlocked.textContent = String(blocked.length);

      const focusEl = document.getElementById('condoStatFocus');
      if (focusEl) {
        const focus = (activeGoals[0]?.title || completedGoals[0]?.title || '—');
        focusEl.textContent = focus;
      }

      const lastEl = document.getElementById('condoLastUpdated');
      if (lastEl) {
        const last = Math.max(0, ...allGoals.map(g => Number(g.updatedAtMs || g.updatedAt || g.createdAtMs || 0)));
        lastEl.textContent = last ? formatTimestamp(last) : '—';
      }

      // Goal grid cards (D1)
      if (!activeGoals.length) {
        gridEl.innerHTML = `<div class="empty-state">No pending goals in this condo.</div>`;
      } else {
        gridEl.innerHTML = activeGoals
          .sort((a, b) => Number(b.updatedAtMs || b.updatedAt || 0) - Number(a.updatedAtMs || a.updatedAt || 0))
          .map(g => {
            const status = (g.status || (isGoalCompleted(g) ? 'done' : 'doing')).toLowerCase();
            const updated = formatTimestamp(g.updatedAtMs || g.updatedAt || g.createdAtMs || Date.now()).split(' ')[1] || '';

            const tasks = Array.isArray(g.tasks) ? g.tasks : [];
            const next = tasks.find(t => !t.done) || tasks[0] || null;
            const nextTitle = next ? (next.text || next.title || 'Next task') : (g.notes ? 'Review definition + set next step' : 'Add the next step');
            const nextId = next ? (next.id || '') : '';
            const nextStage = next ? (next.blocked ? 'blocked' : (next.stage || (next.done ? 'done' : 'doing'))) : (status || 'doing');
            const dotClass = nextStage === 'blocked' ? 'blocked' : (nextStage === 'review' ? 'review' : (nextStage === 'done' ? 'done' : ''));

            const owner = (Array.isArray(g.sessions) && g.sessions.length) ? `${g.sessions.length} session${g.sessions.length===1?'':'s'}` : '—';

            return `
              <a class="condo-goal-card" href="${escapeHtml(goalHref(g.id))}" onclick="return handleGoalLinkClick(event, '${escapeHtml(g.id)}')">
                <div class="condo-card-top">
                  <div>
                    <div class="condo-card-title">${escapeHtml(g.title || 'Untitled goal')}</div>
                    <div class="condo-card-meta">
                      <span class="condo-tag ${escapeHtml(status)}">${escapeHtml(status)}</span>
                      <span>${escapeHtml(owner)}</span>
                    </div>
                  </div>
                  <div style="font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; color: var(--text-muted);">${escapeHtml(updated)}</div>
                </div>

                <div class="condo-card-body">
                  <div class="condo-next-label">Next task</div>
                  <div class="condo-next-task">
                    <div class="condo-dot ${dotClass}"></div>
                    <div>
                      <div class="condo-task-title">${escapeHtml(nextTitle)}</div>
                      <div class="condo-task-sub">${nextId ? `<span style=\"font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; color: rgba(148,163,184,.75);\">${escapeHtml(String(nextId))}</span>` : ''}${g.priority ? `<span>${escapeHtml(g.priority)}</span>` : ''}${g.deadline ? `<span>due ${escapeHtml(g.deadline)}</span>` : ''}</div>
                    </div>
                  </div>
                </div>

                <div class="condo-card-foot"><span>Updated recently</span><span>Open →</span></div>
              </a>
            `;
          }).join('');
      }

      // Keep the sessions list render for now (even if hidden)
      if (sessionsEl) {
        const condoSessions = (state.sessions || [])
          .filter(s => !s.key.includes(':subagent:'))
          .filter(s => getSessionCondoId(s) === condoId)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

        sessionsEl.innerHTML = condoSessions.length ? condoSessions.map(s => {
          const preview = getMessagePreview(s);
          const g = getGoalForSession(s.key);
          const goalPill = g ? `<button type="button" class="card-badge goal" onclick="event.preventDefault(); event.stopPropagation(); openGoal('${escapeHtml(g.id)}', { fromRouter: true })">🏙️ ${escapeHtml(g.title || 'Goal')}</button>` : '';
          return `
            <a class="session-card" href="${escapeHtml(sessionHref(s.key))}" onclick="return handleSessionLinkClick(event, '${escapeHtml(s.key)}')">
              <div class="card-top">
                <div class="card-icon">${getSessionIcon(s)}</div>
                <div class="card-info">
                  <div class="card-name">${escapeHtml(getSessionName(s))}</div>
                  <div class="card-desc">${escapeHtml(s.model?.split('/').pop() || 'unknown model')}</div>
                </div>
              </div>
              ${preview ? `<div class="card-preview">${escapeHtml(preview)}</div>` : ''}
              <div class="card-footer">
                <span>${timeAgo(s.updatedAt)}</span>
                <span class="card-footer-right">${goalPill}</span>
              </div>
            </a>
          `;
        }).join('') : `<div class="empty-state">No sessions in this condo.</div>`;
      }
    }

    function buildSessionBreadcrumbs(session) {
      const condoName = getSessionCondoName(session);
      const condoId = getSessionCondoId(session);
      const goal = getGoalForSession(session.key);
      const crumbs = [
        { label: '🏠', onClick: "navigateTo('dashboard')" },
        { label: `🏢 ${escapeHtml(condoName)}`, onClick: `openCondo('${escapeHtml(condoId)}')` },
      ];
      if (goal) {
        crumbs.push({ label: escapeHtml(goal.title || 'Goal'), onClick: `openGoal('${escapeHtml(goal.id)}')` });
      }
      crumbs.push({ label: escapeHtml(getSessionName(session)), current: true });
      return crumbs;
    }

    function buildGoalBreadcrumbs(goal) {
      const condoId = goal.condoId || state.currentCondoId || 'misc:default';
      const condoName = goal.condoName || 'Condo';
      return [
        { label: '🏠', onClick: "navigateTo('dashboard')" },
        { label: `🏢 ${escapeHtml(condoName)}`, onClick: `openCondo('${escapeHtml(condoId)}')` },
        { label: escapeHtml(goal.title || 'Goal'), current: true }
      ];
    }

    function renderDetailPanel() {
      const panel = document.getElementById('detailPanelContent');
      if (!panel) return;

      // Cron job detail (works from any view)
      if (state.selectedCronJobId) {
        if (!state.cronJobsLoaded) {
          panel.innerHTML = '<div class="detail-section"><div class="detail-label">Recurring</div><div class="detail-value">Loading jobs…</div></div>';
          loadCronJobs().then(() => renderDetailPanel());
          return;
        }
        const job = (state.cronJobs || []).find(j => String(j.id) === String(state.selectedCronJobId) || String(j.jobId) === String(state.selectedCronJobId));
        if (!job) {
          panel.innerHTML = '<div class="detail-section"><div class="detail-label">Recurring</div><div class="detail-value">Job not found</div></div>';
          return;
        }

        const model = getJobModel(job.payload);
        const schedule = formatSchedule(job.schedule);
        const outcome = summarizeOutcome(job.payload);
        const runsState = (state.cronRunsByJobId || {})[String(job.id)] || null;

        if (!runsState || (!runsState.loaded && !runsState.loading)) {
          ensureCronRuns(job.id).then(() => renderDetailPanel());
        }

        const deliver = job.payload?.channel || job.payload?.to ? `${job.payload.channel || ''}${job.payload.to ? ` → ${job.payload.to}` : ''}` : '—';
        const runs = runsState?.runs || [];
        const runsHtml = runs.length ? runs.slice(0, 20).map(r => {
          const at = Number(r.atMs || r.runAtMs || r.startedAtMs || r.timeMs || 0);
          const when = at ? `${new Date(at).toLocaleString()} (${formatRelativeTime(at)})` : '—';
          const dur = r.durationMs != null ? `${Math.round(Number(r.durationMs) / 1000)}s` : '—';
          const status = escapeHtml(String(r.status || r.lastStatus || 'unknown'));
          const err = r.error || r.lastError;
          return `<div style="padding:8px 0; border-top: 1px solid rgba(255,255,255,0.06);">
            <div style="display:flex; justify-content:space-between; gap:10px;"><div><b>${status}</b></div><div style="color: var(--text-dim); font-size: 12px;">${escapeHtml(dur)}</div></div>
            <div style="color: var(--text-dim); font-size: 12px; margin-top:4px;">${escapeHtml(when)}</div>
            ${err ? `<div style="color: var(--accent-red); font-size: 12px; margin-top:4px; white-space: pre-wrap;">${escapeHtml(String(err))}</div>` : ''}
          </div>`;
        }).join('') : `<div style="color: var(--text-dim);">${runsState?.loading ? 'Loading runs…' : 'No runs found'}</div>`;

        panel.innerHTML = `
          <div class="detail-section">
            <div class="detail-label">Recurring Task</div>
            <div class="detail-value">${escapeHtml(job.name || job.id)}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Enabled</div>
            <div class="detail-value">${job.enabled === false ? 'No' : 'Yes'}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Agent</div>
            <div class="detail-value">${escapeHtml(String(job.agentId || 'main'))}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Model</div>
            <div class="detail-value">${escapeHtml(String(model))}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Schedule</div>
            <div class="detail-value">${escapeHtml(String(schedule))}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Outcome</div>
            <div class="detail-value" style="white-space: pre-wrap; color: var(--text-dim);">${outcome ? escapeHtml(outcome) : '—'}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Payload kind</div>
            <div class="detail-value">${escapeHtml(String(job.payload?.kind || 'systemEvent'))}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Deliver</div>
            <div class="detail-value">${escapeHtml(deliver)}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Run log (last 20)</div>
            <div class="detail-value" style="color: var(--text-dim);">${runsState?.error ? `<div style=\"color: var(--accent-red);\">${escapeHtml(runsState.error)}</div>` : ''}${runsHtml}</div>
          </div>
        `;
        return;
      }

      if (state.currentView === 'agents') {
        const agent = state.agents?.find(a => a.id === state.selectedAgentId) || state.agents?.[0];
        if (!agent) {
          panel.innerHTML = '<div class="detail-section"><div class="detail-label">Agents</div><div class="detail-value">No agents configured</div></div>';
          return;
        }

        const emoji = agent.identity?.emoji || '🤖';
        const name = agent.identity?.name || agent.name || agent.id;
        const skillIds = Array.isArray(agent.skills) ? agent.skills : (Array.isArray(agent.skillIds) ? agent.skillIds : []);

        const summary = state.agentSummaries?.[agent.id];
        const resolvedSkills = (state.resolvedSkillsByAgent?.[agent.id] || []).filter(Boolean);

        const jobs = state.cronJobs || [];
        const attachedJobs = jobs.filter(j => {
          if (j.agentId && String(j.agentId) === String(agent.id)) return true;
          const n = String(j.name || '').toLowerCase();
          return n.includes(String(agent.id).toLowerCase());
        });
        const activityItems = attachedJobs
          .map(j => {
            const st = j.state || {};
            const lastAt = Number(st.lastRunAtMs || 0);
            const lastStatus = String(st.lastStatus || '');
            const lastError = st.lastError ? String(st.lastError) : '';
            if (!lastAt && !lastStatus && !lastError) return null;
            const errorSnippet = lastError ? lastError.split('\n')[0].slice(0, 120) : '';
            return {
              name: String(j.name || j.id || 'Job'),
              lastAt,
              status: lastStatus || (lastError ? 'error' : 'unknown'),
              errorSnippet
            };
          })
          .filter(Boolean)
          .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
          .slice(0, 10);

        panel.innerHTML = `
          <div class="detail-section">
            <div class="detail-label">Agent</div>
            <div class="detail-value">${escapeHtml(emoji)} ${escapeHtml(name)}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">High-level</div>
            <div class="detail-value" style="white-space: pre-wrap; color: var(--text-dim);">${summary?.mission ? escapeHtml(summary.mission) : 'Loading summary…'}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Skills</div>
            <div class="detail-value" style="color: var(--text-dim);">
              ${resolvedSkills.length ? resolvedSkills.map(s => `
                <div style="margin:6px 0;">
                  <div style="font-weight:600; color: var(--text);">${escapeHtml(s.name || s.id)}</div>
                  <div>${escapeHtml(s.description || '')}</div>
                </div>
              `).join('') : (skillIds.length ? escapeHtml(skillIds.join(', ')) : '(none)')}
            </div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Heartbeat (outline)</div>
            <div class="detail-value" style="white-space: pre-wrap; color: var(--text-dim);">${summary?.headings?.heartbeat?.length ? escapeHtml(summary.headings.heartbeat.map(h => `${'#'.repeat(h.level)} ${h.text}`).slice(0, 12).join('\n')) : (summary ? '(no HEARTBEAT.md found)' : 'Loading…')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Security audit</div>
            <div class="detail-value" style="color: var(--text-dim);">${summary?.audit?.summary ? `warn: <b>${escapeHtml(String(summary.audit.summary.warn))}</b> · info: ${escapeHtml(String(summary.audit.summary.info))}` : 'Loading…'}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Recent activity</div>
            <div class="detail-value" style="color: var(--text-dim);">
              ${!state.cronJobsLoaded ? 'Loading cron jobs…' : (activityItems.length ? activityItems.map(item => {
                const when = item.lastAt ? formatRelativeTime(item.lastAt) : '—';
                return `<div style="margin:6px 0;">${escapeHtml(when)} · <b>${escapeHtml(item.name)}</b> · ${escapeHtml(item.status)}${item.errorSnippet ? ` · ${escapeHtml(item.errorSnippet)}` : ''}</div>`;
              }).join('') : 'No recent activity')}
            </div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Cron jobs</div>
            <div class="detail-value" style="color: var(--text-dim);">
              ${attachedJobs.length ? attachedJobs.slice(0, 10).map(j => {
                const sch = j.schedule?.kind === 'cron' ? j.schedule.expr : (j.schedule?.kind || '');
                return `<div style="margin-top:6px;"><b>${escapeHtml(j.name || j.id)}</b><div style="color: var(--text-dim); font-size: 0.8rem;">${escapeHtml(sch)}${j.enabled === false ? ' · disabled' : ''}</div></div>`;
              }).join('') : 'None detected'}
            </div>
          </div>
        `;

        // kick off async loads
        if (!state.agentSummaries) state.agentSummaries = {};
        if (!state.agentSummaryLoading) state.agentSummaryLoading = {};
        if (!state.agentSummaries[agent.id] && !state.agentSummaryLoading[agent.id]) loadAgentSummary(agent.id);

        if (!state.resolvedSkillsByAgent) state.resolvedSkillsByAgent = {};
        if (skillIds.length && !state.resolvedSkillsByAgent[agent.id]) loadSkillDetailsForAgent(agent.id, skillIds);

        if (!state.cronJobsLoaded) loadCronJobs();

        return;
      }

      if (state.currentView === 'apps') {
        const app = state.apps.find(a => a.id === state.selectedAppId) || state.apps[0];
        if (!app) {
          panel.innerHTML = '<div class=\"detail-section\"><div class=\"detail-label\">Apps</div><div class=\"detail-value\">No apps configured</div></div>';
          return;
        }
        panel.innerHTML = `
          <div class=\"detail-section\">\n            <div class=\"detail-label\">Status</div>\n            <div class=\"detail-value\">${escapeHtml(app.statusLabel || 'Unknown')}</div>\n          </div>\n          <div class=\"detail-section\">\n            <div class=\"detail-label\">Configuration</div>\n            <div class=\"detail-code\">:${escapeHtml(String(app.port || ''))}\n${escapeHtml(app.service || '')}</div>\n          </div>\n          <div class=\"detail-actions\">\n            <button class=\"btn btn-primary\" onclick=\"openApp('${escapeHtml(app.id)}')\">↗ Open App</button>\n          </div>
        `;
        return;
      }

      if (state.currentView === 'recurring') {
        panel.innerHTML = '<div class=\"detail-section\"><div class=\"detail-label\">Recurring</div><div class=\"detail-value\">Select a recurring task.</div></div>';
        return;
      }

      if (state.currentView === 'chat' && state.currentSession) {
        const goal = getGoalForSession(state.currentSession.key);
        panel.innerHTML = `
          <div class=\"detail-section\">\n            <div class=\"detail-label\">Agent</div>\n            <div class=\"detail-value\">${escapeHtml(state.currentSession.agent || 'main')}</div>\n          </div>\n          <div class=\"detail-section\">\n            <div class=\"detail-label\">Session Key</div>\n            <div class=\"detail-code\">${escapeHtml(state.currentSession.key)}</div>\n          </div>\n          <div class=\"detail-section\">\n            <div class=\"detail-label\">Goal</div>\n            <div class=\"detail-value highlight\">${escapeHtml(goal?.title || 'Unassigned')}</div>\n          </div>\n          <div class=\"detail-actions\">\n            <button class=\"btn btn-secondary\" onclick=\"showAttachSessionModal('${escapeHtml(state.currentSession.key)}')\">Attach Goal</button>\n          </div>
        `;
        return;
      }

      panel.innerHTML = `
        <div class="detail-section">
          <div class="detail-label">Filters</div>
          <div style="display: grid; gap: 8px;">
            <select id="filterChannel" class="form-input" onchange="setFilterChannel(this.value)">
              <option value="all">All channels</option>
              <option value="telegram">📱 Telegram</option>
              <option value="discord">🎮 Discord</option>
              <option value="signal">💬 Signal</option>
              <option value="whatsapp">📞 WhatsApp</option>
              <option value="cron">⏰ Cron</option>
              <option value="subagent">⚡ Subagent</option>
            </select>
            <select id="filterStatus" class="form-input" onchange="setFilterStatus(this.value)">
              <option value="all">All status</option>
              <option value="running">🔴 Running</option>
              <option value="unread">🟠 Unread</option>
              <option value="error">🟡 Error</option>
              <option value="recent">🟢 Recent</option>
              <option value="idle">⚪ Idle</option>
            </select>
          </div>
        </div>
        <div class="detail-section">
          <div class="detail-label">Overview</div>
          <div class="detail-value">Select a session, app, or task.</div>
        </div>
      `;
      const channel = document.getElementById('filterChannel');
      const status = document.getElementById('filterStatus');
      if (channel) channel.value = state.filterChannel;
      if (status) status.value = state.filterStatus;
    }

    function renderAppsGridView() {
      const container = document.getElementById('appsViewGrid');
      if (!container) return;
      if (state.apps.length === 0) {
        container.innerHTML = '<div class="grid-card">No apps configured</div>';
        return;
      }
      container.innerHTML = state.apps.map(app => `
        <div class="grid-card" onclick="selectApp('${escapeHtml(app.id)}')">
          <div class="grid-card-header">
            <div class="grid-card-icon">${escapeHtml(app.icon || '📦')}</div>
            <div class="grid-card-actions">
              <button class="icon-btn" title="Info">ℹ️</button>
              <button class="icon-btn" title="Open" onclick="event.stopPropagation(); openApp('${escapeHtml(app.id)}')">↗</button>
            </div>
          </div>
          <div class="grid-card-title">${escapeHtml(app.name)}</div>
          <div class="grid-card-desc">${escapeHtml(app.description || '')}</div>
          <div class="grid-card-meta">
            <div class="status-indicator">
              <span class="status-dot ${app.statusClass || 'idle'}"></span>
              <span>${escapeHtml(app.statusLabel || 'Unknown')}</span>
            </div>
            <span>${app.port ? ':' + escapeHtml(String(app.port)) : ''}</span>
          </div>
        </div>
      `).join('');
    }

    function bindRecurringFilters() {
      const searchInput = document.getElementById('recurringSearch');
      const agentSelect = document.getElementById('recurringAgentFilter');
      const enabledToggle = document.getElementById('recurringEnabledOnly');
      if (!searchInput || !agentSelect || !enabledToggle) return;
      if (searchInput.dataset.bound) return;

      searchInput.value = state.recurringSearch || '';
      enabledToggle.checked = !!state.recurringEnabledOnly;

      searchInput.addEventListener('input', () => {
        state.recurringSearch = searchInput.value || '';
        lsSet('recurring_search', state.recurringSearch);
        renderRecurringView();
      });
      agentSelect.addEventListener('change', () => {
        state.recurringAgentFilter = agentSelect.value || 'all';
        lsSet('recurring_agent_filter', state.recurringAgentFilter);
        renderRecurringView();
      });
      enabledToggle.addEventListener('change', () => {
        state.recurringEnabledOnly = enabledToggle.checked;
        lsSet('recurring_enabled_only', state.recurringEnabledOnly ? '1' : '0');
        renderRecurringView();
      });

      searchInput.dataset.bound = '1';
    }

    function updateRecurringFilterControls(jobs = []) {
      const searchInput = document.getElementById('recurringSearch');
      const agentSelect = document.getElementById('recurringAgentFilter');
      const enabledToggle = document.getElementById('recurringEnabledOnly');
      if (!searchInput || !agentSelect || !enabledToggle) return;

      if (searchInput.value !== (state.recurringSearch || '')) {
        searchInput.value = state.recurringSearch || '';
      }
      if (enabledToggle.checked !== !!state.recurringEnabledOnly) {
        enabledToggle.checked = !!state.recurringEnabledOnly;
      }

      const agents = Array.from(new Set((jobs || []).map(j => String(j.agentId || 'main')))).sort((a, b) => a.localeCompare(b));
      const options = ['<option value="all">All agents</option>']
        .concat(agents.map(agentId => `<option value="${escapeHtml(agentId)}">${escapeHtml(agentId)}</option>`));
      agentSelect.innerHTML = options.join('');

      if (state.recurringAgentFilter && state.recurringAgentFilter !== 'all' && !agents.includes(state.recurringAgentFilter)) {
        state.recurringAgentFilter = 'all';
        lsSet('recurring_agent_filter', 'all');
      }
      agentSelect.value = state.recurringAgentFilter || 'all';
    }

    function renderRecurringView() {
      const container = document.getElementById('recurringGrid');
      if (!container) return;

      if (!state.cronJobsLoaded) {
        container.innerHTML = '<div class="grid-card">Loading recurring tasks…</div>';
        loadCronJobs().then(() => renderRecurringView());
        return;
      }

      const allJobs = (state.cronJobs || []).slice();
      updateRecurringFilterControls(allJobs);

      let jobs = allJobs.slice();
      if (!jobs.length) {
        container.innerHTML = '<div class="grid-card">No recurring tasks found</div>';
        return;
      }

      container.style.display = 'grid';
      container.style.gridTemplateColumns = '1fr';
      container.style.gap = '10px';

      const agentFilter = state.recurringAgentFilter || 'all';
      const search = (state.recurringSearch || '').trim().toLowerCase();
      const enabledOnly = !!state.recurringEnabledOnly;

      if (agentFilter !== 'all') {
        jobs = jobs.filter(j => String(j.agentId || 'main') === agentFilter);
      }
      if (enabledOnly) {
        jobs = jobs.filter(j => j.enabled !== false);
      }
      if (search) {
        jobs = jobs.filter(j => {
          const name = String(j.name || j.id || '');
          const schedule = formatSchedule(j.schedule);
          const agentId = String(j.agentId || 'main');
          const model = String(getJobModel(j.payload));
          const outcome = summarizeOutcome(j.payload);
          const status = String(j.state?.lastStatus || '');
          const haystack = `${name} ${j.id || ''} ${schedule} ${agentId} ${model} ${outcome} ${status}`.toLowerCase();
          return haystack.includes(search);
        });
      }

      if (!jobs.length) {
        container.innerHTML = '<div class="grid-card">No recurring tasks match filters</div>';
        return;
      }

      jobs.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));

      container.innerHTML = jobs.map(j => {
        const name = j.name || j.id;
        const schedule = formatSchedule(j.schedule);
        const model = getJobModel(j.payload);
        const outcome = summarizeOutcome(j.payload);
        const last = j.state || {};
        const lastAt = Number(last.lastRunAtMs || 0);
        const lastStatus = last.lastStatus || '';
        const line2 = `${j.agentId || 'main'} · ${model} · ${j.enabled === false ? 'disabled' : 'enabled'}`;
        const line3 = lastAt ? `last ${formatRelativeTime(lastAt)}${lastStatus ? ` (${lastStatus})` : ''}` : '';

        return `
          <div class="grid-card" onclick="openCronJobDetail('${escapeHtml(String(j.id))}')">
            <div class="grid-card-header">
              <div class="grid-card-icon">⏰</div>
              <div class="grid-card-actions">
                <button class="icon-btn" title="Details" onclick="event.stopPropagation(); openCronJobDetail('${escapeHtml(String(j.id))}')">ℹ️</button>
              </div>
            </div>
            <div class="grid-card-title">${escapeHtml(String(name))}</div>
            <div class="grid-card-desc">${escapeHtml(schedule)}</div>
            <div class="grid-card-desc">${escapeHtml(line2)}</div>
            ${line3 ? `<div class="grid-card-desc">${escapeHtml(line3)}</div>` : ''}
            ${outcome ? `<div class="grid-card-desc" style="color: var(--text-dim); margin-top:6px;">${escapeHtml(outcome)}</div>` : ''}
          </div>
        `;
      }).join('');
    }

    function selectApp(appId, opts = {}) {
      if (!appId) return;

      if (!opts.fromRouter) {
        navigateTo(`apps/${encodeURIComponent(appId)}`);
        return;
      }

      state.selectedAppId = appId;
      // Keep view consistent when deep-linking
      if (state.currentView !== 'apps') showAppsView({ fromRouter: true });
      renderDetailPanel();
    }

    function selectCron(jobId, opts = {}) {
      if (!jobId) return;

      if (!opts.fromRouter) {
        navigateTo(`recurring/${encodeURIComponent(jobId)}`);
        return;
      }

      state.selectedCronJobId = String(jobId);
      if (state.currentView !== 'recurring') showRecurringView({ fromRouter: true });
      renderDetailPanel();
    }

    function openApp(appId) {
      window.open(`/app?id=${encodeURIComponent(appId)}`, '_blank');
    }

    function renderNewSessionForm() {
      const container = document.getElementById('newSessionAgents');
      const goalSelect = document.getElementById('newSessionGoal');
      if (!container || !goalSelect) return;

      const agents = state.agents.length ? state.agents : [{ id: 'main' }];
      if (!state.newSessionAgentId && agents[0]) state.newSessionAgentId = agents[0].id;

      container.innerHTML = agents.map(agent => {
        const active = state.newSessionAgentId === agent.id ? 'active' : '';
        return `<div class="agent-chip ${active}" onclick="selectNewSessionAgent('${escapeHtml(agent.id)}')">${escapeHtml(agent.id)}</div>`;
      }).join('');

      const condoGoals = state.goals.filter(g => (g.condoId || state.currentCondoId) === state.newSessionCondoId && !isGoalCompleted(g));
      goalSelect.innerHTML = ['<option value="">— Assign later —</option>']
        .concat(condoGoals.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.title)}</option>`))
        .join('');
      if (state.attachGoalId) goalSelect.value = state.attachGoalId;
    }

    function selectNewSessionAgent(agentId) {
      state.newSessionAgentId = agentId;
      renderNewSessionForm();
    }

    async function submitNewSession() {
      const agentId = state.newSessionAgentId || 'main';
      const message = document.getElementById('newSessionMessage').value.trim();
      const goalId = document.getElementById('newSessionGoal').value || null;

      const timestamp = Date.now();
      const sessionKey = `agent:${agentId}:webchat:${timestamp}`;
      const idempotencyKey = `new-${agentId}-${timestamp}`;
      try {
        if (message) {
          await rpcCall('chat.send', { sessionKey, message, idempotencyKey });
        } else {
          await rpcCall('chat.send', { sessionKey, message: 'Hello!', idempotencyKey });
        }
        if (goalId) {
          await fetch(`/api/goals/${encodeURIComponent(goalId)}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionKey }),
          });
        }
        await loadSessions();
        await loadGoals();
        openSession(sessionKey);
      } catch (err) {
        console.error('Failed to start session:', err);
        showToast('Failed to start new session: ' + err.message, 'error');
      }
    }

    function renderNewGoalForm() {
      document.getElementById('newGoalTitle').value = '';
      document.getElementById('newGoalDescription').value = '';
    }

    async function submitNewGoal() {
      const title = document.getElementById('newGoalTitle').value.trim();
      const description = document.getElementById('newGoalDescription').value.trim();
      if (!title) {
        showToast('Enter a goal title', 'warning');
        return;
      }
      try {
        const res = await fetch('/api/goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, notes: description || '', condoId: state.newGoalCondoId || state.currentCondoId || null }),
        });
        if (!res.ok) throw new Error('Failed to create goal');
        const data = await res.json();
        await loadGoals();
        const startSession = document.querySelector('input[name="startGoalSession"]:checked')?.value === 'yes';
        if (startSession && data?.goal?.id) {
          openNewSession(state.newGoalCondoId || state.currentCondoId, data.goal.id);
        } else if (data?.goal?.id) {
          openGoal(data.goal.id);
        } else {
          navigateTo('dashboard');
        }
      } catch (err) {
        showToast('Failed to create goal: ' + err.message, 'error');
      }
    }

    function isModifiedEvent(e) {
      return !!(e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey));
    }

    function isPlainLeftClick(e) {
      return !!(e && e.button === 0 && !isModifiedEvent(e));
    }

    function sessionRouteHash(key) {
      return `#/session/${encodeURIComponent(key)}`;
    }

    function goalRouteHash(id) {
      return `#/goal/${encodeURIComponent(id)}`;
    }

    function fullHref(routeHash) {
      return `${window.location.origin}${window.location.pathname}${window.location.search}${routeHash}`;
    }

    function sessionHref(key) {
      return fullHref(sessionRouteHash(key));
    }

    function goalHref(id) {
      return fullHref(goalRouteHash(id));
    }

    function handleSessionLinkClick(e, key) {
      if (!e) return true;
      e.stopPropagation();
      if (!isPlainLeftClick(e)) return true; // let browser open new tab/window
      e.preventDefault();
      openSession(key, { fromRouter: true });
      return false;
    }

    function handleGoalLinkClick(e, goalId) {
      if (!e) return true;
      e.stopPropagation();
      if (!isPlainLeftClick(e)) return true;
      e.preventDefault();
      openGoal(goalId, { fromRouter: true });
      return false;
    }

    function handleCondoLinkClick(e, condoId) {
      if (!e) return true;
      e.stopPropagation();
      if (!isPlainLeftClick(e)) return true;
      e.preventDefault();
      openCondo(condoId, { fromRouter: true });
      return false;
    }

    function handleRouteLinkClick(e, path) {
      if (!e) return true;
      e.stopPropagation();
      if (!isPlainLeftClick(e)) return true;
      e.preventDefault();
      navigateTo(path);
      return false;
    }

    async function openSession(key, opts = {}) {
      const session = state.sessions.find(s => s.key === key);
      if (!session) return;
      
      // Save to localStorage for restore on refresh
      localStorage.setItem('sharp_current_session', key);
      
      // Mark session as read
      markSessionRead(key);
      
      // Clear tool activity from previous session
      clearAllTools();
      
      state.currentView = 'chat';
      state.currentSession = session;
      state.currentCondoId = getSessionCondoId(session);
      const sessionGoal = getGoalForSession(session.key);
      if (sessionGoal) state.currentGoalId = sessionGoal.id;
      state.chatHistory = [];
      state.isThinking = state.activeRuns.has(key);

      // If we have cached history (e.g. from a previous view), render it immediately
      // to avoid the "history disappeared" feeling while we fetch fresh data.
      const cached = state.sessionHistoryCache.get(key);
      if (cached && Array.isArray(cached) && cached.length) {
        renderChatHistory(cached);
      }
      
      // Initialize session status if not set
      if (!state.sessionAgentStatus[key]) {
        state.sessionAgentStatus[key] = state.connected ? 'idle' : 'offline';
        localStorage.setItem('sharp_session_agent_status', JSON.stringify(state.sessionAgentStatus));
      }
      
      setView('chatView');
      setActiveNav(null);
      setBreadcrumbs(buildSessionBreadcrumbs(session));
      
      // Show header status indicator
      document.getElementById('headerStatusIndicator').style.display = 'block';
      updateHeaderStatus();
      
      document.getElementById('sessionKeyDisplay').textContent = session.key;
      renderSessionModelSelector(session);
      document.getElementById('sessionTokens').textContent = session.totalTokens?.toLocaleString() || '0';
      updateVerboseToggleUI();
      
      const actionBtn = document.getElementById('headerAction');
      if (session.key === 'agent:main:main') {
        actionBtn.textContent = '+ New Session';
        actionBtn.style.display = 'block';
      } else {
        actionBtn.style.display = 'none';
      }
      
      renderSessions();
      renderDetailPanel();
      updateSendButton();
      updateMobileHeader();
      closeSidebar();
      
      await loadSessionHistory(key);
      
      document.getElementById('chatInput').focus();
      if (!opts.fromRouter) {
        history.pushState({ path: `session/${encodeURIComponent(key)}` }, '', `#/session/${encodeURIComponent(key)}`);
      }
    }
    
    async function loadSessionHistory(key, opts = {}) {
      const container = document.getElementById('chatMessages');
      if (!container) return;

      // Guard against races: if user switches sessions quickly, late responses should not clobber the UI.
      const seq = ++state.sessionHistoryLoadSeq;

      // Only show the loading placeholder if we don't already have something to show.
      const hasExisting = container.children && container.children.length > 0;
      if (!opts.preserve && !hasExisting) {
        container.innerHTML = '<div class="message system">Loading history...</div>';
      }

      try {
        const result = await rpcCall('chat.history', { sessionKey: key, limit: 200 });
        if (seq !== state.sessionHistoryLoadSeq) return;
        if (state.currentSession?.key !== key) return;

        const messages = result?.messages || [];
        // Cache so transient disconnects or re-renders don't blank the chat.
        state.sessionHistoryCache.set(key, messages);

        if (messages.length > 0) {
          renderChatHistory(messages);
        } else {
          container.innerHTML = '<div class="message system">No messages yet</div>';
        }
      } catch (err) {
        if (seq !== state.sessionHistoryLoadSeq) return;
        if (state.currentSession?.key !== key) return;

        const cached = state.sessionHistoryCache.get(key);
        if (opts.preserve && cached && cached.length) {
          // Keep whatever was shown.
          showToast(`History load failed (showing cached): ${err.message}`, 'error', 5000);
          return;
        }

        if (cached && cached.length) {
          renderChatHistory(cached);
          showToast(`History load failed (showing cached): ${err.message}`, 'error', 5000);
          return;
        }

        container.innerHTML = `<div class="message system">Error loading history: ${escapeHtml(err.message)}</div>`;
      }
    }
    
    function renderChatHistory(messages) {
      const container = document.getElementById('chatMessages');
      
      if (!messages || messages.length === 0) {
        container.innerHTML = '<div class="message system">No messages yet. Start the conversation!</div>';
        return;
      }
      
      container.innerHTML = messages.map((m, idx) => {
        if (m.role === 'user') {
          const text = extractText(m.content);
          if (!text) return '';
          const timeHtml = m.timestamp ? `<div class="message-time">${formatMessageTime(new Date(m.timestamp))}</div>` : '';
          return `<div class="message user"><div class="message-content">${formatMessage(text)}</div>${timeHtml}</div>`;
        } else if (m.role === 'assistant') {
          const text = extractText(m.content);
          const spawnCards = extractSpawnCards(m.content, m.timestamp);
          const timeHtml = m.timestamp ? `<div class="message-time">${formatMessageTime(new Date(m.timestamp))}</div>` : '';
          
          // Render spawn cards inline with the message
          let html = '';
          if (spawnCards.length > 0) {
            html += spawnCards.map(card => renderSpawnCard(card, idx)).join('');
          }
          if (text) {
            html += `<div class="message assistant"><div class="message-content">${formatMessage(text)}</div>${timeHtml}</div>`;
          }
          return html;
        }
        return '';
      }).filter(Boolean).join('');
      
      scrollChatToBottom();
    }
    
    // Extract sessions_spawn tool calls from message content
    function extractSpawnCards(content, timestamp) {
      if (!Array.isArray(content)) return [];
      
      const cards = [];
      for (const block of content) {
        if (block.type === 'toolCall' && block.name === 'sessions_spawn') {
          const args = block.arguments || {};
          cards.push({
            id: block.id || `spawn-${Date.now()}`,
            task: args.task || 'Sub-agent task',
            label: args.label || null,
            model: args.model || null,
            agentId: args.agentId || null,
            timestamp: timestamp,
            // Result may come in a later tool_result block
            sessionKey: null, 
            status: 'running'
          });
        }
        // Check for tool results that might have spawn outcomes
        if (block.type === 'toolResult' && block.content) {
          try {
            const result = typeof block.content === 'string' ? JSON.parse(block.content) : block.content;
            if (result.sessionKey && result.sessionKey.includes(':subagent:')) {
              // Update corresponding card if we can find it
              const card = cards.find(c => c.id === block.toolCallId);
              if (card) {
                card.sessionKey = result.sessionKey;
                card.status = result.status || 'completed';
              }
            }
          } catch {}
        }
      }
      return cards;
    }
    
    // Render a spawn card HTML
    function renderSpawnCard(card, msgIdx) {
      const cardId = `spawn-${msgIdx}-${card.id}`;
      const statusClass = card.status === 'running' ? 'running' : 'completed';
      const statusText = card.status === 'running' ? '🔄 Running' : '✓ Done';
      const labelText = card.label ? ` (${escapeHtml(card.label)})` : '';
      const timeStr = card.timestamp ? formatMessageTime(new Date(card.timestamp)) : '';
      
      return `
        <div class="spawn-card" id="${cardId}" data-session-key="${escapeHtml(card.sessionKey || '')}">
          <div class="spawn-card-header" onclick="toggleSpawnCard('${cardId}')">
            <span class="spawn-card-icon">⚡</span>
            <span class="spawn-card-title">Sub-agent spawned${labelText}</span>
            <span class="spawn-card-status ${statusClass}">${statusText}</span>
            <span class="spawn-card-expand">▼</span>
          </div>
          <div class="spawn-card-task">${escapeHtml(truncate(card.task, 150))}</div>
          <div class="spawn-card-body">
            <div class="spawn-card-messages" id="${cardId}-messages">
              <div class="spawn-card-loading">Click to load sub-agent transcript...</div>
            </div>
            ${card.sessionKey ? `<a class="spawn-card-link" href="${escapeHtml(sessionHref(card.sessionKey))}" onclick="return handleSessionLinkClick(event, '${escapeHtml(card.sessionKey)}')">Open full session →</a>` : ''}
          </div>
          <div class="message-time">${timeStr}</div>
        </div>
      `;
    }
    
    // Toggle spawn card expansion and load transcript
    async function toggleSpawnCard(cardId) {
      const card = document.getElementById(cardId);
      if (!card) return;
      
      const wasExpanded = card.classList.contains('expanded');
      card.classList.toggle('expanded');
      
      // Load transcript on first expand
      if (!wasExpanded) {
        const sessionKey = card.dataset.sessionKey;
        const messagesEl = document.getElementById(`${cardId}-messages`);
        
        if (sessionKey && messagesEl && messagesEl.querySelector('.spawn-card-loading')) {
          messagesEl.innerHTML = '<div class="spawn-card-loading">Loading transcript...</div>';
          
          try {
            const resp = await rpc('chat.history', { sessionKey, limit: 50 });
            const messages = resp.messages || [];
            
            if (messages.length === 0) {
              messagesEl.innerHTML = '<div class="spawn-card-loading">No messages yet</div>';
            } else {
              messagesEl.innerHTML = messages.map(m => {
                const text = extractText(m.content);
                if (!text) return '';
                const roleClass = m.role === 'user' ? 'user' : 'assistant';
                return `<div class="message ${roleClass}"><div class="message-content">${formatMessage(text)}</div></div>`;
              }).filter(Boolean).join('');
            }
          } catch (err) {
            messagesEl.innerHTML = `<div class="spawn-card-loading">Failed to load: ${escapeHtml(err.message)}</div>`;
          }
        }
      }
    }
    
    function truncate(str, len) {
      if (!str) return '';
      return str.length > len ? str.slice(0, len) + '...' : str;
    }
    
    function extractText(content) {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      
      const textBlocks = content.filter(b => b.type === 'text');
      if (textBlocks.length > 0) {
        return textBlocks.map(b => b.text).join('\n');
      }
      
      if (content[0]?.text) return content[0].text;
      
      return '';
    }
    
    // ═══════════════════════════════════════════════════════════════
    // AUDIO RECORDING
    // ═══════════════════════════════════════════════════════════════
    async function toggleRecording() {
      if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
        stopRecording();
      } else {
        startRecording();
      }
    }
    
    async function startRecording() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Prefer webm/opus, fallback to other formats
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
          ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/webm')
            ? 'audio/webm'
            : 'audio/mp4';
        
        state.mediaRecorder = new MediaRecorder(stream, { mimeType });
        state.audioChunks = [];
        
        state.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            state.audioChunks.push(e.data);
          }
        };
        
        state.mediaRecorder.onstop = async () => {
          // Stop all tracks
          stream.getTracks().forEach(track => track.stop());
          
          // Create blob from chunks
          const audioBlob = new Blob(state.audioChunks, { type: mimeType });
          const ext = mimeType.includes('webm') ? 'webm' : 'm4a';
          const audioFile = new File([audioBlob], `recording-${Date.now()}.${ext}`, { type: mimeType });
          
          // Add to media upload queue
          if (typeof MediaUpload !== 'undefined') {
            MediaUpload.addFiles([audioFile]);
          } else {
            showToast('Audio recorded but MediaUpload not available', 'warning');
          }
          
          // Reset state
          state.mediaRecorder = null;
          state.audioChunks = [];
        };
        
        state.mediaRecorder.start(1000); // Collect data every second
        state.recordingStartTime = Date.now();
        
        // Update UI
        const micBtn = document.getElementById('micBtn');
        const timer = document.getElementById('recordingTimer');
        micBtn.classList.add('recording');
        micBtn.title = 'Stop recording';
        timer.classList.add('visible');
        
        // Start timer display
        updateRecordingTimer();
        state.recordingTimerInterval = setInterval(updateRecordingTimer, 1000);
        
        showToast('Recording started', 'info', 2000);
      } catch (err) {
        console.error('Failed to start recording:', err);
        if (err.name === 'NotAllowedError') {
          showToast('Microphone permission denied', 'error');
        } else {
          showToast('Failed to start recording: ' + err.message, 'error');
        }
      }
    }
    
    function stopRecording() {
      if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
        state.mediaRecorder.stop();
        
        // Update UI
        const micBtn = document.getElementById('micBtn');
        const timer = document.getElementById('recordingTimer');
        micBtn.classList.remove('recording');
        micBtn.title = 'Record audio';
        timer.classList.remove('visible');
        
        // Stop timer
        if (state.recordingTimerInterval) {
          clearInterval(state.recordingTimerInterval);
          state.recordingTimerInterval = null;
        }
        
        showToast('Recording stopped', 'info', 2000);
      }
    }
    
    function updateRecordingTimer() {
      const timer = document.getElementById('recordingTimer');
      if (!timer || !state.recordingStartTime) return;
      
      const elapsed = Math.floor((Date.now() - state.recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      timer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    // ═══════════════════════════════════════════════════════════════
    // CHAT
    // ═══════════════════════════════════════════════════════════════

    // Convert Uint8Array to base64 (browser-safe)
    function bytesToBase64(bytes) {
      const chunkSize = 0x8000;
      let binary = '';
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
      }
      return btoa(binary);
    }

    async function fetchUrlAsBase64(url) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to fetch media: ${resp.status}`);
      const buf = await resp.arrayBuffer();
      return bytesToBase64(new Uint8Array(buf));
    }

    async function buildGatewayAudioAttachmentsFromUploaded(uploaded) {
      const out = [];
      for (const u of (uploaded || [])) {
        if (!u || !u.ok) continue;
        const isAudio = String(u.mimeType || '').startsWith('audio/') || String(u.url || '').match(/\.(webm|m4a|mp3|wav|ogg)(\?|$)/i);
        if (!isAudio) continue;
        if (!u.url) continue;
        const content = await fetchUrlAsBase64(u.url);
        out.push({
          type: 'audio',
          mimeType: u.mimeType || 'audio/webm',
          fileName: u.fileName || String(u.url).split('/').pop() || 'voice.webm',
          content,
        });
      }
      return out;
    }

    async function sendMessage() {
      const input = document.getElementById('chatInput');
      const text = input.value.trim();
      const hasMedia = typeof MediaUpload !== 'undefined' && MediaUpload.hasPendingFiles();
      
      // Need either text or media
      if (!text && !hasMedia) {
        showToast('Nothing to send', 'info', 1500);
        return;
      }
      if (!state.currentSession) {
        showToast('No session selected', 'warning', 3000);
        return;
      }
      
      const sessionKey = state.currentSession.key;
      
      // If agent is busy, queue the message (supports attachments)
      if (state.isThinking) {
        let queuedText = text;
        let queuedAttachments = undefined;

        if (hasMedia) {
          const files = MediaUpload.getPendingFiles();
          const hasAudio = files.some(f => f.fileType === 'audio');

          // If audio is present while agent is busy, we STILL need to upload now.
          // (Otherwise we lose the File object after clearing, and the later queued send can only do base64 attachments.)
          if (hasAudio) {
            try {
              showToast('Uploading voice note…', 'info', 2000);
              addChatMessage('system', 'Uploading voice note…');

              const uploaded = await MediaUpload.uploadAllPending(sessionKey);
              const lines = [];
              const transcripts = [];

              showToast('Transcribing…', 'info', 2000);
              addChatMessage('system', 'Transcribing…');

              for (const u of (uploaded || [])) {
                if (!u || !u.ok) continue;
                lines.push(`[attachment: ${u.url}]`);
                const isAudio = String(u.mimeType || '').startsWith('audio/') || String(u.url || '').match(/\.(webm|m4a|mp3|wav|ogg)(\?|$)/i);
                if (isAudio && u.serverPath) {
                  try {
                    const resp = await fetch(`/api/whisper/transcribe?path=${encodeURIComponent(u.serverPath)}&cb=${Date.now()}`);
                    const data = await resp.json();
                    if (data?.ok && data.text) transcripts.push(data.text.trim());
                  } catch (e) {
                    console.error('Whisper transcription failed:', e);
                  }
                }
              }

              const transcriptText = transcripts.filter(Boolean).join('\n\n');
              const voiceBlock = [transcriptText || '', ...lines].filter(Boolean).join('\n\n');

              if (!queuedText) queuedText = voiceBlock;
              else queuedText = [queuedText, voiceBlock].filter(Boolean).join('\n\n');

              // A+B: include the audio as a real gateway attachment so it can forward to Telegram/etc
              queuedAttachments = await buildGatewayAudioAttachmentsFromUploaded(uploaded);
              MediaUpload.clearFiles();
            } catch (err) {
              MediaUpload.clearFiles();
              addChatMessage('system', `Upload/transcribe error: ${err.message}`);
              showToast(`Upload/transcribe error: ${err.message}`, 'error', 5000);
              return;
            }
          } else {
            // Images: upload to ClawCondos and reference by URL.
            // Avoid base64 attachments (can exceed WebSocket frame limits via reverse proxy and close the socket).
            try {
              showToast('Uploading image…', 'info', 2000);
              addChatMessage('system', 'Uploading image…');

              const uploaded = await MediaUpload.uploadAllPending(sessionKey);
              const lines = [];
              for (const u of (uploaded || [])) {
                if (!u || !u.ok) continue;
                lines.push(`[attachment: ${u.url}]`);
              }

              const attachText = lines.filter(Boolean).join('\n');
              queuedText = queuedText ? [queuedText, attachText].filter(Boolean).join('\n\n') : attachText;
              queuedAttachments = undefined;
              MediaUpload.clearFiles();
            } catch (err) {
              MediaUpload.clearFiles();
              addChatMessage('system', `Upload error: ${err.message}`);
              return;
            }
          }
        }

        if (queuedText || (queuedAttachments && queuedAttachments.length)) {
          state.messageQueue.push({ text: queuedText || '', sessionKey, attachments: queuedAttachments });
          updateQueueIndicator();
          input.value = '';
          input.style.height = 'auto';
          addChatMessage('user queued', queuedText || '[attachment]');
        }
        return;
      }
      
      input.value = '';
      input.style.height = 'auto';
      
      // Attachments:
      // - For images we can still send base64 attachments to gateway.
      // - For audio (voice notes) we MUST persist the file server-side so Whisper can access it.
      let finalMessage = text;
      let attachments = undefined;

      if (hasMedia) {
        const files = MediaUpload.getPendingFiles();
        const hasAudio = files.some(f => f.fileType === 'audio');

        // If any audio is present: upload to ClawCondos first, transcribe locally, then send transcript + link.
        if (hasAudio) {
          // Give immediate user feedback (upload/transcribe can take time, esp. first run while Whisper model downloads)
          state.isThinking = true;
          setSessionStatus(sessionKey, 'thinking');
          updateSendButton();
          showToast('Uploading voice note…', 'info', 2000);
          addChatMessage('system', 'Uploading voice note…');

          try {
            const uploaded = await MediaUpload.uploadAllPending(sessionKey);
            // uploaded entries: { ok, url, serverPath, mimeType, fileName }
            const lines = [];
            const transcripts = [];

            showToast('Transcribing…', 'info', 2000);
            addChatMessage('system', 'Transcribing…');

            for (const u of (uploaded || [])) {
              if (!u || !u.ok) continue;
              lines.push(`[attachment: ${u.url}]`);

              const isAudio = String(u.mimeType || '').startsWith('audio/') || String(u.url || '').match(/\.(webm|m4a|mp3|wav|ogg)(\?|$)/i);
              if (isAudio && u.serverPath) {
                try {
                  const resp = await fetch(`/api/whisper/transcribe?path=${encodeURIComponent(u.serverPath)}&cb=${Date.now()}`);
                  const data = await resp.json();
                  if (data?.ok && data.text) transcripts.push(data.text.trim());
                } catch (e) {
                  console.error('Whisper transcription failed:', e);
                }
              }
            }

            const transcriptText = transcripts.filter(Boolean).join('\n\n');
            if (!finalMessage) {
              finalMessage = [transcriptText || '', ...lines].filter(Boolean).join('\n\n');
            } else {
              // append attachments + transcript under user text
              finalMessage = [finalMessage, transcriptText, ...lines].filter(Boolean).join('\n\n');
            }

            // A+B: attach audio bytes to the outgoing gateway message
            attachments = await buildGatewayAudioAttachmentsFromUploaded(uploaded);

            MediaUpload.clearFiles();
          } catch (err) {
            // Unstick composer state if we fail before reaching processMessage()
            state.isThinking = false;
            setSessionStatus(sessionKey, 'idle');
            updateSendButton();
            addChatMessage('system', `Upload/transcribe error: ${err.message}`);
            showToast(`Upload/transcribe error: ${err.message}`, 'error', 5000);
            return;
          }
        } else {
          // Images: upload to ClawCondos and reference by URL.
          // Avoid base64 attachments (can exceed WebSocket frame limits via reverse proxy and close the socket).
          try {
            showToast('Uploading image…', 'info', 2000);
            addChatMessage('system', 'Uploading image…');

            const uploaded = await MediaUpload.uploadAllPending(sessionKey);
            const lines = [];
            for (const u of (uploaded || [])) {
              if (!u || !u.ok) continue;
              lines.push(`[attachment: ${u.url}]`);
            }

            const attachText = lines.filter(Boolean).join('\n');
            if (!finalMessage) finalMessage = attachText;
            else finalMessage = [finalMessage, attachText].filter(Boolean).join('\n\n');

            attachments = undefined;
            MediaUpload.clearFiles();
          } catch (err) {
            MediaUpload.clearFiles();
            addChatMessage('system', `Upload error: ${err.message}`);
            return;
          }
        }
      }

      if (finalMessage || (attachments && attachments.length > 0)) {
        addChatMessage('user', finalMessage || '[attachment]');
        await processMessage(finalMessage || '', sessionKey, attachments);
      }
    }
    
    async function processMessage(text, sessionKey, attachments) {
      state.isThinking = true;
      setSessionStatus(sessionKey, 'thinking');
      updateSendButton();
      
      try {
        const idempotencyKey = `msg-${sessionKey}-${Date.now()}`;
        const result = await rpcCall('chat.send', {
          sessionKey: sessionKey,
          message: text,
          attachments: attachments,
          idempotencyKey
        }, 130000);

        // Visual ack: mark this session as "sent" briefly so user knows it left the client.
        try {
          state.sessionLastSentAt = state.sessionLastSentAt || {};
          state.sessionLastSentAt[sessionKey] = Date.now();
          setSessionStatus(sessionKey, 'sent');
        } catch {
          setSessionStatus(sessionKey, 'idle');
        }

        if (result?.reply) {
          addChatMessage('assistant', result.reply);
        }

        refresh();
        
      } catch (err) {
        addChatMessage('system', `Error: ${err.message}`);
        setSessionStatus(sessionKey, 'error');
      } finally {
        state.isThinking = false;
        updateSendButton();
        processNextInQueue();
      }
    }
    
    function processNextInQueue() {
      if (state.messageQueue.length === 0) return;
      
      const next = state.messageQueue.shift();
      updateQueueIndicator();
      
      // Convert queued message to regular
      const queuedMsgs = document.querySelectorAll('.message.user.queued');
      if (queuedMsgs.length > 0) {
        queuedMsgs[0].classList.remove('queued');
      }
      
      processMessage(next.text, next.sessionKey, next.attachments);
    }
    
    function updateQueueIndicator() {
      const count = state.messageQueue.length;

      // main
      const indicator = document.getElementById('queueIndicator');
      const countEl = document.getElementById('queueCount');
      if (indicator && countEl) {
        countEl.textContent = count;
        indicator.classList.toggle('visible', count > 0);
      }

      // goal composer
      const gInd = document.getElementById('goal_queueIndicator');
      const gCnt = document.getElementById('goal_queueCount');
      if (gInd && gCnt) {
        gCnt.textContent = count;
        gInd.classList.toggle('visible', count > 0);
      }
    }
    
    function clearMessageQueue() {
      // Remove queued messages from UI
      document.querySelectorAll('.message.user.queued').forEach(el => el.remove());
      state.messageQueue = [];
      updateQueueIndicator();
    }
    
    function addChatMessage(role, content, timestamp = null) {
      return addChatMessageTo('', role, content, timestamp);
    }

    function addChatMessageTo(prefix, role, content, timestamp = null) {
      const containerId = prefix ? `${prefix}_chatMessages` : 'chatMessages';
      const container = document.getElementById(containerId);
      if (!container) return null;

      const parts = String(role || '').split(/\s+/).filter(Boolean);
      const base = parts[0] || 'system';
      const normalizedContent = String(content ?? '').replace(/\s+/g, '');
      const fingerprint = `${prefix}|${base}|${normalizedContent}`;
      const now = Date.now();
      const recent = state.recentMessageFingerprints.get(fingerprint);
      if (recent && (now - recent) <= 15000) {
        return null;
      }
      state.recentMessageFingerprints.set(fingerprint, now);

      if ((now - state.recentMessageFingerprintPruneAt) > 5000) {
        state.recentMessageFingerprintPruneAt = now;
        for (const [key, ts] of state.recentMessageFingerprints) {
          if ((now - ts) > 30000) state.recentMessageFingerprints.delete(key);
        }
      }

      const msg = document.createElement('div');
      // Normalize role strings like "user queued" → classes: message user queued
      const extra = parts.slice(1);
      msg.className = `message ${base}${extra.length ? ' ' + extra.join(' ') : ''}`;

      // Format content
      let contentHtml;
      const features = (config && config.features) ? config.features : {};
      const formatUserMessages = features.formatUserMessages === true;
      const baseRole = base;
      // Always format assistant messages.
      // Format user messages only if enabled OR if they contain attachment markers (so they render as pills/players).
      const shouldFormat = baseRole === 'assistant' || (baseRole === 'user' && (formatUserMessages || /\[attachment:/i.test(String(content||''))));
      if (shouldFormat && !role.includes('thinking')) {
        contentHtml = formatMessage(content);
      } else {
        contentHtml = escapeHtml(content);
      }

      // Add timestamp
      const time = timestamp ? new Date(timestamp) : new Date();
      const timeStr = formatMessageTime(time);

      msg.innerHTML = `<div class="message-content">${contentHtml}</div><div class="message-time">${timeStr}</div>`;
      container.appendChild(msg);

      // Unseen tracking
      if (prefix === 'goal') {
        if (!state.goalChatAutoScroll && !isNearChatBottom(container)) {
          state.goalChatUnseenCount = (state.goalChatUnseenCount || 0) + 1;
          const jump = document.getElementById('goal_jumpToLatest');
          if (jump) jump.style.display = 'flex';
          const cnt = document.getElementById('goal_jumpToLatestCount');
          if (cnt) {
            cnt.textContent = String(state.goalChatUnseenCount);
            cnt.style.display = 'inline-flex';
          }
        }
        scrollChatPanelToBottom('goal');
      } else {
        if (!state.chatAutoScroll && !isNearChatBottom(container)) {
          state.chatUnseenCount = (state.chatUnseenCount || 0) + 1;
          setJumpToLatestVisible(true);
        }
        scrollChatToBottom();
      }

      return msg;
    }
    
    function formatMessageTime(date) {
      const now = new Date();
      const isToday = date.toDateString() === now.toDateString();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const isYesterday = date.toDateString() === yesterday.toDateString();
      
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      
      if (isToday) {
        return timeStr;
      } else if (isYesterday) {
        return `Yesterday ${timeStr}`;
      } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + timeStr;
      }
    }
    
    function isNearChatBottom(container) {
      if (!container) return true;
      const threshold = 120; // px
      return (container.scrollHeight - (container.scrollTop + container.clientHeight)) <= threshold;
    }

    function setJumpToLatestVisible(visible) {
      const btn = document.getElementById('jumpToLatest');
      const badge = document.getElementById('jumpToLatestCount');
      if (!btn) return;

      btn.classList.toggle('visible', !!visible);
      if (badge) {
        const n = state.chatUnseenCount || 0;
        badge.textContent = n > 9 ? '9+' : String(n);
        badge.style.display = n > 0 ? 'inline-flex' : 'none';
      }
    }

    function scrollChatToBottom(force = false) {
      const container = document.getElementById('chatMessages');
      if (!container) return;

      const should = force || state.chatAutoScroll || isNearChatBottom(container);
      if (!should) {
        // User is reading above; just surface the jump button.
        setJumpToLatestVisible(true);
        return;
      }

      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
        state.chatAutoScroll = true;
        state.chatUnseenCount = 0;
        setJumpToLatestVisible(false);
      });
    }
    
    const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.webm', '.m4a', '.mp4'];

    function sanitizeMediaUrl(rawUrl) {
      if (!rawUrl) return null;
      const trimmed = rawUrl.trim();

      // Always allow local uploads paths
      if (trimmed.startsWith('/apps/uploads/')) {
        return trimmed;
      }

      // Back-compat: /uploads/* served by OpenClaw apps → rewrite
      if (trimmed.startsWith('/uploads/')) {
        return `/apps${trimmed}`;
      }

      // External media is optional (off by default for safer fresh installs)
      const features = (config && config.features) ? config.features : {};
      const allowExternalMedia = features.allowExternalMedia === true;

      if (/^https?:\/\//i.test(trimmed)) {
        if (!allowExternalMedia) return null;
        try {
          const parsed = new URL(trimmed);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.href;
          }
        } catch (err) {
          return null;
        }
      }

      return null;
    }

    function isAudioName(name) {
      if (!name) return false;
      const clean = name.split('?')[0].split('#')[0].toLowerCase();
      return AUDIO_EXTS.some(ext => clean.endsWith(ext));
    }

    function tokenizeMediaMarkdown(text) {
      const tokens = [];
      const addToken = (html) => {
        const token = `@@MEDIA_${tokens.length}@@`;
        tokens.push(html);
        return token;
      };

      let processed = text;

      const audioReplacement = (match, url) => {
        const safeUrl = sanitizeMediaUrl(url);
        if (!safeUrl) return match;
        if (!isAudioName(safeUrl)) return match;
        return addToken(`<audio class="chat-audio" controls src="${escapeHtml(safeUrl)}"></audio>`);
      };

      processed = processed.replace(/!\[audio[^\]]*\]\(([^)]+)\)/gi, audioReplacement);
      processed = processed.replace(/!audio\(([^)]+)\)/gi, audioReplacement);

      processed = processed.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, altText, url) => {
        const safeUrl = sanitizeMediaUrl(url);
        if (!safeUrl) return match;
        const safeAlt = escapeHtml(altText || '');
        return addToken(`<img class="chat-image" src="${escapeHtml(safeUrl)}" alt="${safeAlt}" loading="lazy">`);
      });

      // Audio links: [label](url)
      processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
        const safeUrl = sanitizeMediaUrl(url);
        if (!safeUrl) return match;
        if (isAudioName(safeUrl)) {
          return addToken(`<audio class="chat-audio" controls src="${escapeHtml(safeUrl)}"></audio>`);
        }
        return addToken(`<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`);
      });

      // Attachment placeholders: [attachment: filename]
      processed = processed.replace(/\[attachment:\s*([^\]]+)\]/gi, (match, name) => {
        const trimmed = name.trim();
        if (isAudioName(trimmed)) {
          const safeUrl = sanitizeMediaUrl(trimmed);
          if (safeUrl) {
            return addToken(`<audio class="chat-audio" controls src="${escapeHtml(safeUrl)}"></audio>`);
          }
          return addToken(`<span class="chat-attachment audio">🎵 ${escapeHtml(trimmed)}</span>`);
        }
        return addToken(`<span class="chat-attachment">📎 ${escapeHtml(trimmed)}</span>`);
      });

      return { processed, tokens };
    }
    
    function formatMessage(text) {
      const { processed, tokens } = tokenizeMediaMarkdown(text);
      let html = escapeHtml(processed)
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\n/g, '<br>');

      // ClawCondos formatting helpers:
      // If a line is ONLY a bold title and is surrounded by blank lines in the source,
      // render it as a block heading with consistent spacing.
      // Pattern from our recommended template: **Title**\n\n...
      html = html
        .replace(/(^|<br>)(<strong>[^<]+<\/strong>)(<br>){2}/g, '$1<div class="msg-heading">$2</div><div class="msg-gap"></div>');
      
      tokens.forEach((tokenHtml, idx) => {
        html = html.replace(`@@MEDIA_${idx}@@`, tokenHtml);
      });
      
      return html;
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      // Also escape single quotes for use in single-quoted attributes (onclick handlers)
      return div.innerHTML.replace(/'/g, '&#39;');
    }
    
    function handleChatKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
      if (e.key === 'Escape' && state.isThinking) {
        e.preventDefault();
        stopAgent();
      }
    }

    function autoResize(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }

    function updateSendButton() {
      // Primary chat composer
      const sendBtn = document.getElementById('sendBtn');
      if (sendBtn) sendBtn.disabled = state.isThinking;

      const stopBtn = document.getElementById('stopBtn');
      if (stopBtn) {
        const canStop = state.isThinking && !!(state.currentSession?.key);
        stopBtn.disabled = !canStop;
      }

      // Goal composer uses separate ids
      const sendGoal = document.getElementById('goal_sendBtn');
      if (sendGoal) sendGoal.disabled = state.isThinking;

      const stopGoal = document.getElementById('goal_stopBtn');
      if (stopGoal) {
        const canStopGoal = state.isThinking && !!(state.goalChatSessionKey);
        stopGoal.disabled = !canStopGoal;
      }
    }

    function composerTemplate(prefix) {
      const p = prefix ? `${prefix}_` : '';
      const inputId = prefix ? `${prefix}_chatInput` : 'chatInput';
      const fileId = prefix ? `${prefix}_mediaFileInput` : 'mediaFileInput';
      const prevId = prefix ? `${prefix}_mediaPreviewContainer` : 'mediaPreviewContainer';
      const dropId = prefix ? `${prefix}_dropOverlay` : 'dropOverlay';
      const queueId = prefix ? `${prefix}_queueIndicator` : 'queueIndicator';
      const queueCountId = prefix ? `${prefix}_queueCount` : 'queueCount';
      const voiceId = prefix ? `${prefix}_voiceRecordBtn` : 'voiceRecordBtn';
      const timerId = prefix ? `${prefix}_voiceTimer` : 'voiceTimer';
      const stopId = prefix ? `${prefix}_stopBtn` : 'stopBtn';
      const sendId = prefix ? `${prefix}_sendBtn` : 'sendBtn';

      return `
        <div class="chat-input-area">
          <div class="queue-indicator" id="${queueId}">
            <span>📨</span>
            <span class="queue-count" id="${queueCountId}">0</span>
            <span>queued</span>
            <button class="clear-queue" onclick="clearMessageQueue()" title="Clear queue">✕</button>
          </div>

          <div id="${prevId}"></div>

          <input type="file" id="${fileId}" accept="image/*,audio/*" multiple>

          <div class="chat-input-wrapper">
            <button class="attach-btn" onclick="document.getElementById('${fileId}').click()" title="Attach files" aria-label="Attach files">
              <!-- clean paperclip -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 11.5 12.6 18.9a5 5 0 0 1-7.1-7.1l8.5-8.5a3.5 3.5 0 1 1 5 5l-8.5 8.5a2 2 0 0 1-2.8-2.8l7.8-7.8"/>
              </svg>
            </button>
            <textarea class="chat-input" id="${inputId}" placeholder="Type a message..." rows="1" onkeydown="${prefix ? "if(event.key==='Enter' && !event.shiftKey){event.preventDefault(); sendGoalChatMessage();} if(event.key==='Escape' && state.isThinking){event.preventDefault(); stopAgent(null,'goal');}" : "handleChatKey(event)"}" oninput="autoResize(this)"></textarea>
            <button class="stop-btn" id="${stopId}" onclick="stopAgent(null, '${prefix || ''}')" disabled title="Stop">⏹</button>
            <button class="voice-btn" id="${voiceId}" title="Record voice" aria-pressed="false">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zm5 11a5 5 0 01-10 0H5a7 7 0 0014 0h-2zm-5 9a7.001 7.001 0 006.93-6H19a8.99 8.99 0 01-14 0H5.07A7.001 7.001 0 0012 21z"/>
              </svg>
              <span class="voice-btn-text">Rec</span>
              <span class="recording-timer" id="${timerId}">0:00</span>
            </button>
            <button class="send-btn" id="${sendId}" onclick="${prefix ? 'sendGoalChatMessage()' : 'sendMessage()'}">Send</button>
          </div>

          <div class="drop-overlay" id="${dropId}">
            <div class="drop-overlay-content">
              <div class="drop-overlay-icon">📎</div>
              <div class="drop-overlay-text">Drop files here</div>
              <div class="drop-overlay-hint">Images and audio supported</div>
            </div>
          </div>
        </div>
      `;
    }

    function mountComposer(mountId, prefix, opts = {}) {
      const mount = document.getElementById(mountId);
      if (!mount) return;

      mount.innerHTML = composerTemplate(prefix);

      const inputId = prefix ? `${prefix}_chatInput` : 'chatInput';

      // NOTE: We deliberately do NOT attach send/keydown listeners here.
      // The composer markup includes inline handlers as a hard fallback.
      // Attaching listeners here can double-fire (send twice + "Nothing to send").

      // Mount MediaUpload + VoiceRecorder onto this composer if supported
      try {
        if (window.MediaUpload && typeof window.MediaUpload.mount === 'function') {
          window.MediaUpload.mount({
            prefix,
            viewId: (prefix === 'goal') ? 'goalChatPanel' : 'chatView',
            inputId: inputId,
            fileInputId: prefix ? `${prefix}_mediaFileInput` : 'mediaFileInput',
            previewContainerId: prefix ? `${prefix}_mediaPreviewContainer` : 'mediaPreviewContainer',
            dropOverlayId: prefix ? `${prefix}_dropOverlay` : 'dropOverlay',
          });
        }
        if (window.VoiceRecorder && typeof window.VoiceRecorder.mount === 'function') {
          window.VoiceRecorder.mount({
            prefix,
            btnId: prefix ? `${prefix}_voiceRecordBtn` : 'voiceRecordBtn',
            timerId: prefix ? `${prefix}_voiceTimer` : 'voiceTimer',
          });
        }
      } catch {}
    }
    
    function updateVerboseToggleUI() {
      const wrap = document.getElementById('verboseToggle');
      if (!wrap) return;
      const key = state.currentSession?.key;
      const level = (key && state.verboseBySession[key]) ? state.verboseBySession[key] : 'off';
      wrap.querySelectorAll('.verbose-btn').forEach(btn => {
        const v = btn.getAttribute('data-verbose');
        btn.classList.toggle('active', v === level);
      });
    }

    async function setVerboseMode(level) {
      const sessionKey = state.currentSession?.key;
      if (!sessionKey) return;
      const normalized = (level === 'full' || level === 'on' || level === 'off') ? level : 'off';

      state.verboseBySession[sessionKey] = normalized;
      lsSet('verbose_by_session', JSON.stringify(state.verboseBySession));
      updateVerboseToggleUI();

      try {
        const idempotencyKey = `verbose-${sessionKey}-${Date.now()}`;
        await rpcCall('chat.send', {
          sessionKey: sessionKey,
          message: `/verbose ${normalized}`,
          idempotencyKey
        }, 10000);
        addChatMessageTo('', 'system', `Verbose → ${normalized}`);
      } catch (err) {
        addChatMessageTo('', 'system', `Failed to set verbose: ${err.message}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // MODEL SELECTOR (per session)
    // ═══════════════════════════════════════════════════════════════

    function availableModelChoices() {
      // MVP list: core aliases + any configured agent models.
      const base = [
        { value: 'default', label: 'default' },
        { value: 'gpt', label: 'gpt (gpt-5.2 alias)' },
        { value: 'opus', label: 'opus (Claude Opus alias)' },
      ];

      const seen = new Set(base.map(x => x.value));
      for (const a of (state.agents || [])) {
        const m = String(a?.model || a?.models?.primary || '').trim();
        if (!m) continue;
        if (seen.has(m)) continue;
        seen.add(m);
        base.push({ value: m, label: m });
      }

      // Keep deterministic ordering: aliases first, then full model strings.
      const head = base.slice(0, 3);
      const tail = base.slice(3).sort((a, b) => a.label.localeCompare(b.label));
      return head.concat(tail).concat([{ value: '__custom__', label: 'Custom…' }]);
    }

    function effectiveSessionModel(session) {
      if (!session?.key) return session?.model || null;
      return state.sessionModelOverrides?.[session.key] || session.model || null;
    }

    function renderSessionModelSelector(session) {
      const sel = document.getElementById('sessionModelSelect');
      if (!sel) return;

      const choices = availableModelChoices();
      const current = effectiveSessionModel(session);
      const currentValue = current || 'default';

      sel.innerHTML = choices.map(c => {
        const selected = (c.value === currentValue) ? ' selected' : '';
        return `<option value="${escapeHtml(String(c.value))}"${selected}>${escapeHtml(String(c.label))}</option>`;
      }).join('');

      // If the current model is not in the list, inject it at the top.
      if (current && !choices.some(c => c.value === current)) {
        const opt = document.createElement('option');
        opt.value = String(current);
        opt.textContent = String(current);
        opt.selected = true;
        sel.insertBefore(opt, sel.firstChild);
      }
    }

    async function handleSessionModelChange(value) {
      const sessionKey = state.currentSession?.key;
      if (!sessionKey) return;

      let chosen = String(value || '').trim();
      if (!chosen) return;

      if (chosen === '__custom__') {
        const custom = prompt('Enter model alias or full model id (e.g. opus, gpt, anthropic/claude-opus-4-5):', 'opus');
        if (!custom) {
          // Re-render to reset selection
          renderSessionModelSelector(state.currentSession);
          return;
        }
        chosen = String(custom).trim();
      }

      // No-op
      const prev = effectiveSessionModel(state.currentSession) || 'default';
      if (chosen === prev) return;

      // NOTE: OpenClaw supports `/new <model>` which *resets* the session and switches model.
      const ok = confirm(`Switch model to "${chosen}"?\n\nThis will reset the session (equivalent to sending: /new ${chosen}).`);
      if (!ok) {
        renderSessionModelSelector(state.currentSession);
        return;
      }

      // Optimistically update UI
      state.sessionModelOverrides[sessionKey] = chosen;
      lsSet('session_model_overrides', JSON.stringify(state.sessionModelOverrides));
      renderSessionModelSelector(state.currentSession);

      try {
        const idempotencyKey = `model-${sessionKey}-${Date.now()}`;
        await rpcCall('chat.send', {
          sessionKey,
          message: `/new ${chosen}`,
          idempotencyKey,
        }, 15000);
        showToast(`Model → ${chosen} (session reset)`, 'success', 2500);

        // Refresh session metadata soon after.
        setTimeout(async () => {
          try {
            await loadSessions();
            const updated = state.sessions.find(s => s.key === sessionKey);
            if (updated) state.currentSession = updated;
            renderSessionModelSelector(state.currentSession);
            renderSessions();
          } catch {}
        }, 1200);
      } catch (err) {
        showToast(`Failed to switch model: ${err.message}`, 'error');
      }
    }

    async function stopAgent(sessionKeyOverride = null, prefix = '') {
      if (!state.isThinking) return;

      const sessionKey = sessionKeyOverride || state.currentSession?.key || (state.currentView === 'goal' ? state.goalChatSessionKey : null);
      if (!sessionKey) return;

      try {
        const idempotencyKey = `stop-${sessionKey}-${Date.now()}`;
        await rpcCall('chat.send', {
          sessionKey,
          message: '/stop',
          idempotencyKey
        }, 10000);
        addChatMessageTo(prefix, 'system', '⏹ Stop requested');
      } catch (err) {
        addChatMessageTo(prefix, 'system', `Failed to stop: ${err.message}`);
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // EXPORT
    // ═══════════════════════════════════════════════════════════════
    async function exportChatAsMarkdown() {
      if (!state.currentSession) return;
      
      try {
        // Fetch fresh history
        const result = await rpcCall('chat.history', { 
          sessionKey: state.currentSession.key, 
          limit: 500 
        });
        const messages = result?.messages || [];
        
        if (messages.length === 0) {
          showToast('No messages to export', 'info');
          return;
        }
        
        // Build markdown
        const sessionName = getSessionName(state.currentSession);
        const timestamp = new Date().toISOString();
        const dateStr = new Date().toISOString().split('T')[0];
        
        let md = `# Chat Export: ${sessionName}\n`;
        md += `Exported: ${timestamp}\n\n`;
        md += `---\n\n`;
        
        for (const msg of messages) {
          const role = msg.role === 'user' ? 'User' : 'Assistant';
          md += `## ${role}\n\n`;
          
          // Handle content
          if (typeof msg.content === 'string') {
            md += msg.content + '\n\n';
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text') {
                md += block.text + '\n\n';
              } else if (block.type === 'tool_use') {
                md += `\`\`\`tool_call: ${block.name}\n`;
                md += JSON.stringify(block.input, null, 2) + '\n';
                md += `\`\`\`\n\n`;
              } else if (block.type === 'tool_result') {
                const content = typeof block.content === 'string' 
                  ? block.content 
                  : JSON.stringify(block.content, null, 2);
                const preview = content.length > 500 
                  ? content.slice(0, 500) + '...' 
                  : content;
                md += `\`\`\`tool_result\n${preview}\n\`\`\`\n\n`;
              } else if (block.type === 'image') {
                md += `[Image: ${block.source?.media_type || 'image'}]\n\n`;
              }
            }
          }
          
          md += `---\n\n`;
        }
        
        // Sanitize session key for filename
        const safeKey = state.currentSession.key
          .replace(/[^a-zA-Z0-9-_]/g, '-')
          .replace(/-+/g, '-')
          .slice(0, 50);
        const filename = `chat-${safeKey}-${dateStr}.md`;
        
        // Trigger download
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
      } catch (err) {
        console.error('Export failed:', err);
        showToast('Export failed: ' + err.message, 'error');
      }
    }
    
    function headerAction() {
      if (state.currentSession?.key === 'agent:main:main') {
        if (confirm('Start a new session? This will reset the conversation.')) {
          sendMessage('/new');
        }
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // OVERVIEW
    // ═══════════════════════════════════════════════════════════════
    function updateOverview() {
      renderGoalsGrid();
      renderSessionsGrid();
      renderAppsGrid();
      renderSubagentsGrid();
      updateStatsGrid();
    }
    

    function renderGoalsGrid() {
      const container = document.getElementById('goalsGrid');
      if (!container) return;

      // Dashboard "Condos Overview" (prototype): render condos with a few goal rows inside each card.
      const visibleSessions = (state.sessions || []).filter(s => !s.key.includes(':subagent:'));

      const condos = new Map();
      for (const s of visibleSessions) {
        const condoId = getSessionCondoId(s);
        if (!condos.has(condoId)) {
          condos.set(condoId, {
            id: condoId,
            name: getSessionCondoName(s),
            sessions: [],
            goals: [],
            latest: 0,
          });
        }
        const c = condos.get(condoId);
        c.sessions.push(s);
        c.latest = Math.max(c.latest, s.updatedAt || 0);
      }

      const goals = Array.isArray(state.goals) ? state.goals : [];
      for (const g of goals) {
        // If condoId is missing but the goal already has sessions, infer condoId from the first session.
        // This makes the dashboard "Condos Overview" populate correctly even for legacy goals.
        const inferredCondoId = (!g.condoId && Array.isArray(g.sessions) && g.sessions[0])
          ? getCondoIdForSessionKey(g.sessions[0])
          : null;
        const condoId = g.condoId || inferredCondoId || 'misc:default';
        if (!condos.has(condoId)) {
          condos.set(condoId, {
            id: condoId,
            name: g.condoName || (condoId.includes(':') ? condoId.split(':').pop() : condoId),
            sessions: [],
            goals: [],
            latest: g.updatedAtMs || 0,
          });
        }
        condos.get(condoId).goals.push(g);
      }

      const sorted = Array.from(condos.values()).sort((a, b) => (b.latest || 0) - (a.latest || 0));

      if (!sorted.length) {
        container.innerHTML = `
          <div class="condo-card" style="opacity:.7">
            <div class="condo-card-header">
              <span style="font-size:18px">🏢</span>
              <span class="condo-card-title">No condos yet</span>
            </div>
            <div class="condo-card-goals">
              <div class="condo-goal-row">
                <div class="condo-goal-status pending"></div>
                <span class="condo-goal-name">Create a goal to get started</span>
                <span class="condo-goal-meta">+</span>
              </div>
            </div>
          </div>
        `;
        return;
      }

      // Prototype shows a tight grid; start with up to 8 cards.
      const maxCards = 8;
      const cards = sorted.slice(0, maxCards).map(condo => {
        const condoUnread = condo.sessions.filter(s => isSessionUnread(s.key)).length;
        const condoErrors = condo.sessions.filter(s => s.lastError).length;
        const badge = condoUnread > 0
          ? `<span class="badge unread">${condoUnread}</span>`
          : condoErrors > 0 ? `<span class="badge error">${condoErrors}</span>` : '';

        // Pick up to 3 non-completed goals (prototype shows a few rows)
        const goalsForCondo = (condo.goals || []).filter(g => !isGoalCompleted(g)).slice(0, 3);
        const rows = goalsForCondo.map(g => {
          const sessionCount = Array.isArray(g.sessions) ? g.sessions.length : 0;
          const meta = sessionCount ? `${sessionCount} session${sessionCount === 1 ? '' : 's'}` : '';
          return `
            <a class="condo-goal-row" href="${escapeHtml(goalHref(g.id))}" onclick="return handleGoalLinkClick(event, '${escapeHtml(g.id)}')">
              <div class="condo-goal-status pending"></div>
              <span class="condo-goal-name">${escapeHtml(g.title || 'Untitled goal')}</span>
              <span class="condo-goal-meta">${escapeHtml(meta || '—')}</span>
            </a>
          `;
        }).join('');

        const fallback = !rows
          ? `
            <a class="condo-goal-row" href="${escapeHtml(fullHref(`#/new-goal/${encodeURIComponent(condo.id)}`))}" onclick="return handleRouteLinkClick(event, 'new-goal/${encodeURIComponent(condo.id)}')">
              <div class="condo-goal-status pending"></div>
              <span class="condo-goal-name">New goal…</span>
              <span class="condo-goal-meta">+</span>
            </a>
          `
          : '';

        // NOTE: condo cards must NOT be <a> tags because they contain goal-row <a> links.
        // Nested anchors are invalid HTML and can explode the grid layout in some browsers.
        return `
          <div class="condo-card" role="link" tabindex="0"
               onclick="openCondo('${escapeHtml(condo.id)}', { fromRouter: true })"
               onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); openCondo('${escapeHtml(condo.id)}', { fromRouter: true });}">
            <div class="condo-card-header">
              <span style="font-size:18px">🏢</span>
              <span class="condo-card-title">${escapeHtml(condo.name || 'Condo')}</span>
              ${badge}
            </div>
            <div class="condo-card-goals">
              ${rows || fallback}
            </div>
          </div>
        `;
      }).join('');

      container.innerHTML = `<div class="condos-grid">${cards}</div>`;
    }

    function renderSessionsGrid() {
      const goal = state.currentGoalId !== 'all' && state.currentGoalId !== 'unassigned'
        ? state.goals.find(g => g.id === state.currentGoalId)
        : null;
      const goalSessionSet = goal?.sessions ? new Set(goal.sessions) : null;
      
      // Build set of ALL sessions in ANY goal
      const allSessionsInGoals = new Set();
      state.goals.forEach(g => (g.sessions || []).forEach(s => allSessionsInGoals.add(s)));
      
      const mainSessions = state.sessions.filter(s => {
        if (s.key.includes(':subagent:')) return false;
        if (!matchesSearch(s)) return false;
        // When viewing specific goal, only show its sessions
        if (goalSessionSet && !goalSessionSet.has(s.key)) return false;
        if (state.currentGoalId === 'unassigned' && allSessionsInGoals.has(s.key)) return false;
        // When viewing "all" (Overview), hide sessions in any goal - they show under Goals
        if (state.currentGoalId === 'all' && allSessionsInGoals.has(s.key)) return false;
        return true;
      });
      const container = document.getElementById('sessionsGrid');
      document.getElementById('sessionCount').textContent = mainSessions.length;
      
      if (mainSessions.length === 0) {
        container.innerHTML = `
          <div class="session-card" style="border-style: dashed; opacity: 0.6;">
            <div class="card-top">
              <div class="card-icon">💬</div>
              <div class="card-info">
                <div class="card-name">No active sessions</div>
                <div class="card-desc">Start a conversation to see it here</div>
              </div>
            </div>
          </div>
        `;
        return;
      }
      
      container.innerHTML = mainSessions.map(s => {
        const preview = getMessagePreview(s);
        const agentStatus = getAgentStatus(s.key);
        const tooltip = getStatusTooltip(agentStatus);
        const g = getGoalForSession(s.key);
        const goalPill = g ? `<button type="button" class="card-badge goal" onclick="event.preventDefault(); event.stopPropagation(); openGoal('${escapeHtml(g.id)}', { fromRouter: true })">🏙️ ${escapeHtml(g.title || 'Goal')}</button>` : '';
        return `
          <a class="session-card" href="${escapeHtml(sessionHref(s.key))}" onclick="return handleSessionLinkClick(event, '${escapeHtml(s.key)}')">
            <div class="card-top">
              <div class="card-icon">${getSessionIcon(s)}</div>
              <div class="card-info">
                <div class="card-name">${escapeHtml(getSessionName(s))}</div>
                <div class="card-desc">${escapeHtml(s.model?.split('/').pop() || 'unknown model')}</div>
              </div>
              <div class="agent-status ${agentStatus}" data-tooltip="${tooltip}" style="width: 10px; height: 10px;"></div>
            </div>
            ${preview ? `<div class="card-preview">${escapeHtml(preview)}</div>` : ''}
            <div class="card-footer">
              <span>${timeAgo(s.updatedAt)}</span>
              <span class="card-footer-right">${goalPill}<span class="card-badge">${(s.totalTokens || 0).toLocaleString()} tokens</span></span>
            </div>
          </a>
        `;
      }).join('');
    }
    
    function renderAppsGrid() {
      const container = document.getElementById('appsGrid');
      document.getElementById('appCount').textContent = state.apps.length;
      
      if (state.apps.length === 0) {
        container.innerHTML = `
          <div class="app-card" style="border-style: dashed; opacity: 0.6;">
            <div class="card-top">
              <div class="card-icon">📦</div>
              <div class="card-info">
                <div class="card-name">No apps configured</div>
                <div class="card-desc">Add apps to apps.json</div>
              </div>
            </div>
          </div>
        `;
        return;
      }
      
      container.innerHTML = state.apps.map(app => `
        <a href="/app?id=${escapeHtml(app.id)}" target="_blank" class="app-card" style="text-decoration: none; color: inherit;">
          <div class="card-top">
            <div class="card-icon">${escapeHtml(app.icon || '📦')}</div>
            <div class="card-info">
              <div class="card-name">${escapeHtml(app.name)}</div>
              <div class="card-desc">${escapeHtml(app.description || '')}</div>
            </div>
            <div class="card-status-dot idle" id="app-grid-status-${escapeHtml(app.id)}"></div>
          </div>
          <div class="card-footer">
            <span>Port ${app.port}</span>
            <span class="card-badge">${escapeHtml(app.id)}</span>
          </div>
        </a>
      `).join('');
      
      state.apps.forEach(app => {
        checkAppGridStatus(app);
      });
    }
    
    async function checkAppGridStatus(app) {
      const dot = document.getElementById(`app-grid-status-${app.id}`);
      if (!dot) return;
      
      try {
        const res = await fetch(`/${app.id}/`, { method: 'HEAD' });
        dot.className = 'card-status-dot ' + (res.ok || res.status === 401 ? 'active' : 'error');
      } catch {
        dot.className = 'card-status-dot error';
      }
    }
    
    function renderSubagentsGrid() {
      const subagents = state.sessions.filter(s => s.key.includes(':subagent:'));
      const section = document.getElementById('subagentsSection');
      const container = document.getElementById('subagentsGrid');
      document.getElementById('taskCount').textContent = subagents.length;
      
      if (subagents.length === 0) {
        section.style.display = 'none';
        return;
      }
      
      section.style.display = 'block';
      
      container.innerHTML = subagents.map(s => {
        const preview = getMessagePreview(s);
        const agentStatus = getAgentStatus(s.key);
        const tooltip = getStatusTooltip(agentStatus);
        return `
          <a class="session-card" href="${escapeHtml(sessionHref(s.key))}" onclick="return handleSessionLinkClick(event, '${escapeHtml(s.key)}')">
            <div class="card-top">
              <div class="card-icon">⚡</div>
              <div class="card-info">
                <div class="card-name">${escapeHtml(s.label || 'Sub-agent')}</div>
                <div class="card-desc">${escapeHtml(s.model?.split('/').pop() || 'unknown')}</div>
              </div>
              <div class="agent-status ${agentStatus}" data-tooltip="${tooltip}" style="width: 10px; height: 10px;"></div>
            </div>
            ${preview ? `<div class="card-preview">${escapeHtml(preview)}</div>` : ''}
            <div class="card-footer">
              <span>${timeAgo(s.updatedAt)}</span>
            </div>
          </a>
        `;
      }).join('');
    }
    
    function getMessagePreview(s) {
      if (s.messages?.[0]) {
        const msg = s.messages[0];
        const text = extractText(msg.content);
        if (text) return text.slice(0, 100) + (text.length > 100 ? '...' : '');
      }
      return '';
    }
    
    // ═══════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════
    function timeAgo(ts) {
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      const hours = Math.floor(diff / 3600000);
      const days = Math.floor(diff / 86400000);
      
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      if (hours < 24) return `${hours}h ago`;
      return `${days}d ago`;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // KEYBOARD SHORTCUTS
    // ═══════════════════════════════════════════════════════════════
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (false) {
          exitMultiSelect();
        } else if (state.currentView === 'chat') {
          navigateTo('dashboard');
        }
      }
    });
    
    // ═══════════════════════════════════════════════════════════════
    // INIT
    // ═══════════════════════════════════════════════════════════════
    function initChatUX() {
      // Main session chat
      const container = document.getElementById('chatMessages');
      if (container && !container.dataset.scrollListenerAttached) {
        container.dataset.scrollListenerAttached = '1';
        container.addEventListener('scroll', () => {
          const nearBottom = isNearChatBottom(container);
          state.chatAutoScroll = nearBottom;
          if (nearBottom) {
            state.chatUnseenCount = 0;
            setJumpToLatestVisible(false);
          }
        }, { passive: true });
      }

      const jumpBtn = document.getElementById('jumpToLatest');
      if (jumpBtn && !jumpBtn.dataset.clickAttached) {
        jumpBtn.dataset.clickAttached = '1';
        jumpBtn.addEventListener('click', (e) => {
          e.preventDefault();
          state.chatAutoScroll = true;
          state.chatUnseenCount = 0;
          scrollChatToBottom(true);
        });
      }

      // Goal chat (reuse same UX)
      const g = document.getElementById('goal_chatMessages');
      if (g && !g.dataset.scrollListenerAttached) {
        g.dataset.scrollListenerAttached = '1';
        g.addEventListener('scroll', () => {
          const nearBottom = isNearChatBottom(g);
          state.goalChatAutoScroll = nearBottom;
          if (nearBottom) {
            state.goalChatUnseenCount = 0;
            const jump = document.getElementById('goal_jumpToLatest');
            if (jump) jump.style.display = 'none';
            const cnt = document.getElementById('goal_jumpToLatestCount');
            if (cnt) cnt.style.display = 'none';
          }
        }, { passive: true });
      }

      const gj = document.getElementById('goal_jumpToLatest');
      if (gj && !gj.dataset.clickAttached) {
        gj.dataset.clickAttached = '1';
        gj.addEventListener('click', (e) => {
          e.preventDefault();
          state.goalChatAutoScroll = true;
          state.goalChatUnseenCount = 0;
          scrollChatPanelToBottom('goal', true);
        });
      }

      // Compat for shared modules
      if (typeof window.showNotification !== 'function' && typeof window.showToast === 'function') {
        window.showNotification = (msg, type) => window.showToast(msg, type || 'info', 4000);
      }

      // Mount reusable composers (chat + goal)
      // The composer mounts dynamically, so MediaUpload sometimes runs before the elements exist.
      // We retry the mount a few times to guarantee the file input is wired.
      try {
        const ensureMounted = (mountId, prefix, opts) => {
          let attempts = 0;
          const maxAttempts = 30; // ~3s
          const tick = () => {
            attempts++;
            try {
              mountComposer(mountId, prefix, opts);
              // If MediaUpload exposes a boolean return, use it to detect missing DOM.
              if (window.MediaUpload && typeof window.MediaUpload.mount === 'function') {
                const ok = window.MediaUpload.mount({
                  prefix,
                  viewId: (prefix === 'goal') ? 'goalChatPanel' : 'chatView',
                  inputId: prefix ? `${prefix}_chatInput` : 'chatInput',
                  fileInputId: prefix ? `${prefix}_mediaFileInput` : 'mediaFileInput',
                  previewContainerId: prefix ? `${prefix}_mediaPreviewContainer` : 'mediaPreviewContainer',
                  dropOverlayId: prefix ? `${prefix}_dropOverlay` : 'dropOverlay',
                });
                if (ok) return;
              }
            } catch {}
            if (attempts < maxAttempts) setTimeout(tick, 100);
          };
          tick();
        };

        ensureMounted('composerMountChat', '', {
          onSend: () => sendMessage(),
          onKeyDown: (e) => handleChatKey(e),
        });

        ensureMounted('composerMountGoal', 'goal', {
          onSend: () => sendGoalChatMessage(),
          onKeyDown: (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendGoalChatMessage();
              return;
            }
            if (e.key === 'Escape' && state.isThinking) {
              e.preventDefault();
              stopAgent();
            }
          },
        });
      } catch {}
    }

    async function init() {
      // Prevent browser from restoring scroll positions between hash routes.
      // ClawCondos manages its own scroll behavior per-view.
      try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch {}

      // Best-effort: load config.json (async) and allow it to provide an auth token for localhost.
      try {
        if (window.ClawCondosConfig?.initConfig) {
          const cfg = await window.ClawCondosConfig.initConfig();
          const tok = cfg?.authToken || cfg?.gatewayToken || cfg?.token || null;
          if (!state.token && tok) state.token = tok;
          if (cfg?.gatewayWsUrl) state.gatewayUrl = cfg.gatewayWsUrl;
        }
      } catch {}

      // Restore active runs from localStorage (before connecting)
      restoreActiveRuns();

      // Initialize auto-archive dropdown UI
      initAutoArchiveUI();

      // Attach chat UX listeners (safe to call early)
      initChatUX();

      // If no stored token, try a best-effort connect on localhost (common dev setup = no auth).
      // If auth is required, the socket will close with 1008 and we’ll prompt.
      const host = window.location.hostname;
      const isLocal = host === 'localhost' || host === '127.0.0.1';
      if (!state.token && !isLocal) {
        setConnectionStatus('error');
        showLoginModal();
      } else {
        connectWebSocket();
      }

      // Hash-router: rely on hashchange (popstate can double-fire on back/forward in some browsers)
      window.addEventListener('hashchange', () => {
        handleRoute();
        // Route changes can swap views; re-attach if needed
        initChatUX();
        // Ensure main scroll container doesn't preserve a stale offset between routes.
        try { const main = document.querySelector('.content-main'); if (main) main.scrollTop = 0; } catch {}
      });
      handleRoute();
      // Initial route may render with a stale scrollTop (browser restore). Reset.
      try { const main = document.querySelector('.content-main'); if (main) main.scrollTop = 0; } catch {}

      // Auto-refresh sessions every 30s
      setInterval(() => {
        if (state.connected) {
          refresh();
        }
      }, 30000);
    }
    
    try { console.log('[ClawCondos] build', window.__v2_build); } catch {}
    init().catch((e) => console.error('[init] failed', e));
