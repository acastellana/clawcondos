# PORT_IMPL.md — Definitive Helix → ClawCondos Port Implementation Guide

Scope used for this guide:
- `PORT_PLAN.md`
- `/tmp/helix-diff-serve.patch`
- `/tmp/helix-diff-appjs.patch`
- `/tmp/helix-diff-appcss.patch`
- `/tmp/helix-diff-helpers.patch`
- `/tmp/helix-plans.css`
- `/tmp/helix-roles.css`
- Current `serve.js`, `public/app.js`, `public/app.css`, `lib/serve-helpers.js`

Conflict status:
- No hard patch conflicts detected in these files (`git apply --check` is clean for all four patch files).
- No real line-level conflicts to flag from the provided diffs against current files.

## Cluster 1 — Plans integration (CSS + data model + UI)

**serve.js**: No non-rebrand additions in provided `serve.js` diff for this cluster.

**public/app.js**: No net new function/route blocks in provided `app.js` diff (all hunks are rename/rebrand swaps only).

**public/app.css**: No non-rebrand additions in provided `app.css` diff for this cluster.

**lib/serve-helpers.js**: No additions for this cluster.

**New files**

- Add `public/styles/plans.css` with full content (already renamed Helix→ClawCondos, strand→condo, etc.):

```css
/* ═══════════════════════════════════════════════════════════════
   PLAN INTEGRATION CSS - Claude Code Plan Mode UI
   Part of ClawCondos Design System
   ═══════════════════════════════════════════════════════════════ */

/* Plan accent color - Apple Blue */
:root {
  --plan-accent: #818CF8;
  --plan-accent-dim: rgba(129, 140, 248, 0.12);
  --plan-accent-muted: rgba(129, 140, 248, 0.20);
  --plan-accent-glow: rgba(129, 140, 248, 0.15);

  /* Status colors */
  --plan-draft: #6B7280;
  --plan-draft-dim: rgba(107, 114, 128, 0.12);
  --plan-awaiting: #FFD60A;
  --plan-awaiting-dim: rgba(255, 214, 10, 0.12);
  --plan-approved: #30D158;
  --plan-approved-dim: rgba(48, 209, 88, 0.12);
  --plan-executing: #818CF8;
  --plan-executing-dim: rgba(129, 140, 248, 0.12);
  --plan-completed: #30D158;
  --plan-completed-dim: rgba(48, 209, 88, 0.12);
  --plan-rejected: #FF453A;
  --plan-rejected-dim: rgba(255, 69, 58, 0.12);
}

/* ═══════════════════════════════════════════════════════════════
   1. PLAN BADGE — Inline status pill on task row
   ═══════════════════════════════════════════════════════════════ */
.plan-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
  transition: all var(--transition-fast);
  border: 1px solid transparent;
}

.plan-badge::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* 2. Status color variants */
.plan-badge-draft {
  background: var(--plan-draft-dim);
  color: #9CA3AF;
  border-color: rgba(107, 114, 128, 0.3);
}
.plan-badge-draft::before {
  background: var(--plan-draft);
}

.plan-badge-awaiting {
  background: var(--plan-awaiting-dim);
  color: #FBBF24;
  border-color: rgba(245, 158, 11, 0.3);
  animation: badgePulse 2s ease-in-out infinite;
}
.plan-badge-awaiting::before {
  background: var(--plan-awaiting);
  box-shadow: 0 0 6px var(--plan-awaiting);
}

.plan-badge-approved {
  background: var(--plan-approved-dim);
  color: #34D399;
  border-color: rgba(16, 185, 129, 0.3);
}
.plan-badge-approved::before {
  background: var(--plan-approved);
}

.plan-badge-executing {
  background: var(--plan-executing-dim);
  color: #818CF8;
  border-color: rgba(129, 140, 248, 0.3);
}
.plan-badge-executing::before {
  background: var(--plan-executing);
  animation: executingPulse 1.2s ease-in-out infinite;
}

.plan-badge-completed {
  background: var(--plan-completed-dim);
  color: #4ADE80;
  border-color: rgba(34, 197, 94, 0.3);
}
.plan-badge-completed::before {
  background: var(--plan-completed);
  box-shadow: 0 0 4px var(--plan-completed);
}

.plan-badge-rejected {
  background: var(--plan-rejected-dim);
  color: #F87171;
  border-color: rgba(239, 68, 68, 0.3);
}
.plan-badge-rejected::before {
  background: var(--plan-rejected);
}

@keyframes badgePulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

@keyframes executingPulse {
  0%, 100% { 
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(129, 140, 248, 0.4);
  }
  50% {
    transform: scale(1.3);
    box-shadow: 0 0 8px 2px rgba(129, 140, 248, 0.3);
  }
}

/* ═══════════════════════════════════════════════════════════════
   3. PLAN DETAIL — Expandable plan panel container
   ═══════════════════════════════════════════════════════════════ */
.plan-detail {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  margin: var(--space-md) 0;
  overflow: hidden;
  transition: all var(--transition-smooth);
}

.plan-detail.expanded {
  border-color: var(--plan-accent-muted);
  box-shadow: 0 0 20px var(--plan-accent-dim);
}

.plan-detail-header {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-md) var(--space-lg);
  cursor: pointer;
  background: linear-gradient(90deg, var(--plan-accent-dim) 0%, transparent 60%);
  border-bottom: 1px solid var(--border-subtle);
  transition: background var(--transition-fast);
}

.plan-detail-header:hover {
  background: linear-gradient(90deg, var(--plan-accent-muted) 0%, var(--bg-hover) 60%);
}

.plan-detail-icon {
  font-size: 1.1rem;
  color: var(--plan-accent);
  flex-shrink: 0;
}

.plan-detail-title {
  flex: 1;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text);
}

.plan-detail-toggle {
  font-size: 0.8rem;
  color: var(--text-dim);
  transition: transform var(--transition-fast);
}

.plan-detail.expanded .plan-detail-toggle {
  transform: rotate(180deg);
}

.plan-detail-body {
  max-height: 0;
  overflow: hidden;
  transition: max-height var(--transition-smooth);
}

.plan-detail.expanded .plan-detail-body {
  max-height: 2000px;
}

.plan-detail-inner {
  padding: var(--space-lg);
}

/* ═══════════════════════════════════════════════════════════════
   4. PLAN STEPS — Step list container
   ═══════════════════════════════════════════════════════════════ */
.plan-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: var(--space-lg);
}

.plan-steps-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-md);
}

.plan-steps-title {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.plan-steps-count {
  font-size: 0.72rem;
  color: var(--text-dim);
  font-family: var(--font-mono);
}

/* ═══════════════════════════════════════════════════════════════
   5. PLAN STEP — Individual step item
   ═══════════════════════════════════════════════════════════════ */
.plan-step {
  display: flex;
  align-items: flex-start;
  gap: var(--space-md);
  padding: var(--space-md) var(--space-lg);
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
  position: relative;
}

.plan-step:hover {
  border-color: var(--border);
  background: var(--bg-hover);
}

.plan-step-indicator {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 600;
  flex-shrink: 0;
  border: 2px solid var(--border);
  background: var(--bg);
  color: var(--text-dim);
  transition: all var(--transition-fast);
}

.plan-step-content {
  flex: 1;
  min-width: 0;
}

.plan-step-title {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text);
  margin-bottom: 2px;
}

.plan-step-meta {
  font-size: 0.72rem;
  color: var(--text-dim);
  font-family: var(--font-mono);
}

/* 6. Step status states */
.plan-step.pending {
  opacity: 0.7;
}
.plan-step.pending .plan-step-indicator {
  border-color: var(--border);
  color: var(--text-muted);
}

.plan-step.in-progress {
  background: linear-gradient(90deg, var(--plan-executing-dim) 0%, var(--bg-input) 50%);
  border-color: rgba(129, 140, 248, 0.4);
}
.plan-step.in-progress .plan-step-indicator {
  border-color: var(--plan-executing);
  background: var(--plan-executing-dim);
  color: var(--plan-executing);
  animation: stepPulse 1.5s ease-in-out infinite;
}
.plan-step.in-progress .plan-step-title {
  color: #22D3EE;
}

.plan-step.done {
  opacity: 0.85;
}
.plan-step.done .plan-step-indicator {
  border-color: var(--plan-completed);
  background: var(--plan-completed);
  color: white;
}
.plan-step.done .plan-step-indicator::after {
  content: '✓';
  font-size: 0.65rem;
}
.plan-step.done .plan-step-title {
  text-decoration: line-through;
  text-decoration-color: var(--text-dim);
  color: var(--text-secondary);
}

.plan-step.skipped {
  opacity: 0.5;
}
.plan-step.skipped .plan-step-indicator {
  border-color: var(--text-muted);
  background: transparent;
  color: var(--text-muted);
}
.plan-step.skipped .plan-step-indicator::after {
  content: '—';
}
.plan-step.skipped .plan-step-title {
  text-decoration: line-through;
  color: var(--text-muted);
}

@keyframes stepPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(129, 140, 248, 0.4); }
  50% { box-shadow: 0 0 0 4px rgba(129, 140, 248, 0.15); }
}

/* ═══════════════════════════════════════════════════════════════
   7. PLAN CONTENT — Markdown content area
   ═══════════════════════════════════════════════════════════════ */
.plan-content {
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-lg);
  margin-bottom: var(--space-lg);
  font-size: 0.875rem;
  line-height: 1.65;
  color: var(--text-secondary);
  max-height: 400px;
  overflow-y: auto;
}

.plan-content h1, 
.plan-content h2, 
.plan-content h3, 
.plan-content h4 {
  color: var(--text);
  margin-top: var(--space-lg);
  margin-bottom: var(--space-sm);
  font-weight: 600;
}

.plan-content h1 { font-size: 1.25rem; }
.plan-content h2 { font-size: 1.1rem; }
.plan-content h3 { font-size: 1rem; }
.plan-content h4 { font-size: 0.9rem; }

.plan-content h1:first-child,
.plan-content h2:first-child {
  margin-top: 0;
}

.plan-content p {
  margin-bottom: var(--space-md);
}

.plan-content ul, 
.plan-content ol {
  margin-left: var(--space-lg);
  margin-bottom: var(--space-md);
}

.plan-content li {
  margin-bottom: var(--space-xs);
}

.plan-content code {
  background: var(--bg);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 0.82rem;
  color: var(--plan-accent);
}

.plan-content pre {
  background: var(--bg);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: var(--space-md);
  overflow-x: auto;
  margin-bottom: var(--space-md);
}

.plan-content pre code {
  background: transparent;
  padding: 0;
  color: var(--text-secondary);
}

.plan-content blockquote {
  border-left: 3px solid var(--plan-accent);
  padding-left: var(--space-md);
  color: var(--text-dim);
  font-style: italic;
  margin-bottom: var(--space-md);
}

/* ═══════════════════════════════════════════════════════════════
   8. PLAN ACTIONS — Button group for approve/reject/comment
   ═══════════════════════════════════════════════════════════════ */
.plan-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-subtle);
}

.plan-actions-primary {
  display: flex;
  gap: var(--space-sm);
  flex: 1;
}

.plan-actions-secondary {
  display: flex;
  gap: var(--space-sm);
}

.plan-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 18px;
  border-radius: var(--radius-md);
  font-family: var(--font-sans);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--transition-fast);
  border: none;
  outline: none;
}

.plan-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.plan-btn-approve {
  background: linear-gradient(135deg, #10B981 0%, #059669 100%);
  color: white;
  box-shadow: 0 2px 10px rgba(16, 185, 129, 0.3);
}

.plan-btn-approve:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(16, 185, 129, 0.4);
}

.plan-btn-reject {
  background: rgba(239, 68, 68, 0.15);
  color: #F87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.plan-btn-reject:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.25);
  border-color: rgba(239, 68, 68, 0.5);
}

.plan-btn-comment {
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border);
}

.plan-btn-comment:hover:not(:disabled) {
  background: var(--bg-active);
  border-color: var(--border-hover);
  color: var(--text);
}

/* Comment input */
.plan-comment-input {
  width: 100%;
  margin-top: var(--space-md);
  display: none;
}

.plan-comment-input.visible {
  display: block;
}

.plan-comment-textarea {
  width: 100%;
  min-height: 80px;
  padding: var(--space-md);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 0.875rem;
  resize: vertical;
  transition: border-color var(--transition-fast);
}

.plan-comment-textarea:focus {
  outline: none;
  border-color: var(--plan-accent);
  box-shadow: 0 0 0 3px var(--plan-accent-dim);
}

.plan-comment-textarea::placeholder {
  color: var(--text-muted);
}

/* ═══════════════════════════════════════════════════════════════
   9. PLAN LOGS — Log viewer container
   ═══════════════════════════════════════════════════════════════ */
.plan-logs {
  background: #0D0F12;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.6;
  max-height: 300px;
  overflow-y: auto;
  margin-top: var(--space-md);
}

.plan-logs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md);
  background: rgba(0, 0, 0, 0.3);
  border-bottom: 1px solid var(--border-subtle);
  position: sticky;
  top: 0;
  z-index: 1;
}

.plan-logs-title {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.plan-logs-actions {
  display: flex;
  gap: var(--space-xs);
}

.plan-logs-btn {
  padding: 4px 8px;
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  color: var(--text-dim);
  font-size: 0.68rem;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.plan-logs-btn:hover {
  background: var(--bg-hover);
  border-color: var(--border);
  color: var(--text);
}

.plan-logs-content {
  padding: var(--space-sm) var(--space-md);
}

.plan-logs-empty {
  padding: var(--space-xl);
  text-align: center;
  color: var(--text-muted);
  font-style: italic;
}

/* ═══════════════════════════════════════════════════════════════
   10. PLAN LOG ENTRY — Individual log line
   ═══════════════════════════════════════════════════════════════ */
.plan-log-entry {
  display: flex;
  gap: var(--space-sm);
  padding: 3px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.plan-log-entry:last-child {
  border-bottom: none;
}

.plan-log-time {
  color: var(--text-muted);
  flex-shrink: 0;
  min-width: 70px;
}

.plan-log-type {
  flex-shrink: 0;
  min-width: 60px;
  font-weight: 500;
}

.plan-log-type.tool { color: var(--plan-accent); }
.plan-log-type.edit { color: #F59E0B; }
.plan-log-type.exec { color: #818CF8; }
.plan-log-type.info { color: var(--text-dim); }
.plan-log-type.error { color: #EF4444; }
.plan-log-type.success { color: #22C55E; }

.plan-log-message {
  color: var(--text-secondary);
  word-break: break-word;
  flex: 1;
}

.plan-log-message code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 4px;
  border-radius: 3px;
  color: var(--plan-accent);
}

/* New log entry animation */
.plan-log-entry.new {
  animation: logEntryIn 0.3s ease;
  background: linear-gradient(90deg, var(--plan-accent-dim) 0%, transparent 50%);
}

@keyframes logEntryIn {
  from {
    opacity: 0;
    transform: translateX(-10px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* ═══════════════════════════════════════════════════════════════
   11. PLAN PROGRESS BAR — Thin progress bar for aggregate view
   ═══════════════════════════════════════════════════════════════ */
.plan-progress-bar {
  height: 4px;
  background: var(--bg-input);
  border-radius: 2px;
  overflow: hidden;
  position: relative;
}

.plan-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--plan-accent) 0%, var(--plan-completed) 100%);
  border-radius: 2px;
  transition: width var(--transition-smooth);
  position: relative;
}

.plan-progress-fill::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 20px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3));
}

/* Animated variant for executing state */
.plan-progress-bar.executing .plan-progress-fill {
  background: linear-gradient(
    90deg,
    var(--plan-executing) 0%,
    var(--plan-accent) 50%,
    var(--plan-executing) 100%
  );
  background-size: 200% 100%;
  animation: progressShimmer 2s linear infinite;
}

@keyframes progressShimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Progress with labels */
.plan-progress-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}

.plan-progress-label {
  font-size: 0.72rem;
  color: var(--text-dim);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.plan-progress-bar-wrap {
  flex: 1;
}

/* ═══════════════════════════════════════════════════════════════
   12. NOTIFICATION BELL — Bell icon styling
   ═══════════════════════════════════════════════════════════════ */
.notification-bell {
  position: relative;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.notification-bell:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.notification-bell.active {
  color: var(--plan-accent);
}

.notification-bell-icon {
  font-size: 1.15rem;
  transition: transform var(--transition-fast);
}

/* Bell ring animation for new notifications */
.notification-bell.ringing .notification-bell-icon {
  animation: bellRing 0.5s ease;
}

@keyframes bellRing {
  0%, 100% { transform: rotate(0); }
  20% { transform: rotate(15deg); }
  40% { transform: rotate(-15deg); }
  60% { transform: rotate(10deg); }
  80% { transform: rotate(-10deg); }
}

/* ═══════════════════════════════════════════════════════════════
   13. NOTIFICATION BADGE — Unread count badge
   ═══════════════════════════════════════════════════════════════ */
.notification-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  background: var(--plan-accent);
  border-radius: 9px;
  font-size: 0.68rem;
  font-weight: 700;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px var(--plan-accent-glow);
  animation: badgePop 0.3s ease;
}

.notification-badge:empty {
  display: none;
}

.notification-badge.urgent {
  background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%);
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.5);
  animation: urgentPulse 1.5s ease-in-out infinite;
}

@keyframes badgePop {
  0% { transform: scale(0); }
  50% { transform: scale(1.2); }
  100% { transform: scale(1); }
}

@keyframes urgentPulse {
  0%, 100% { 
    transform: scale(1);
    box-shadow: 0 2px 8px rgba(239, 68, 68, 0.5);
  }
  50% { 
    transform: scale(1.1);
    box-shadow: 0 2px 12px rgba(239, 68, 68, 0.7);
  }
}

/* ═══════════════════════════════════════════════════════════════
   14. NOTIFICATION DROPDOWN — Notification panel
   ═══════════════════════════════════════════════════════════════ */
.notification-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 360px;
  max-height: 480px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  z-index: 1000;
  display: none;
  animation: dropdownIn 0.2s ease;
}

.notification-dropdown.open {
  display: flex;
  flex-direction: column;
}

@keyframes dropdownIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.notification-dropdown-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md) var(--space-lg);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-panel);
}

.notification-dropdown-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text);
}

.notification-dropdown-actions {
  display: flex;
  gap: var(--space-xs);
}

.notification-mark-read {
  padding: 6px 10px;
  background: transparent;
  border: none;
  color: var(--text-dim);
  font-size: 0.75rem;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.notification-mark-read:hover {
  background: var(--bg-hover);
  color: var(--plan-accent);
}

.notification-dropdown-list {
  flex: 1;
  overflow-y: auto;
  max-height: 400px;
}

.notification-dropdown-empty {
  padding: var(--space-2xl);
  text-align: center;
  color: var(--text-muted);
}

.notification-dropdown-empty-icon {
  font-size: 2rem;
  margin-bottom: var(--space-sm);
  opacity: 0.5;
}

/* Individual notification item */
.notification-item {
  display: flex;
  gap: var(--space-md);
  padding: var(--space-md) var(--space-lg);
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.notification-item:hover {
  background: var(--bg-hover);
}

.notification-item:last-child {
  border-bottom: none;
}

.notification-item.unread {
  background: linear-gradient(90deg, var(--plan-accent-dim) 0%, transparent 40%);
}

.notification-item.unread::before {
  content: '';
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  background: var(--plan-accent);
  border-radius: 50%;
}

.notification-item {
  position: relative;
}

.notification-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  font-size: 0.9rem;
  flex-shrink: 0;
}

.notification-icon.plan_ready { color: var(--plan-awaiting); }
.notification-icon.agent_question { color: var(--plan-accent); }
.notification-icon.phase_completed { color: var(--plan-approved); }
.notification-icon.error { color: var(--plan-rejected); }
.notification-icon.task_done { color: var(--plan-completed); }

.notification-content {
  flex: 1;
  min-width: 0;
}

.notification-title {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text);
  margin-bottom: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.notification-desc {
  font-size: 0.78rem;
  color: var(--text-dim);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.notification-time {
  font-size: 0.68rem;
  color: var(--text-muted);
  margin-top: 4px;
  font-family: var(--font-mono);
}

.notification-dismiss {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 0.9rem;
  cursor: pointer;
  border-radius: var(--radius-sm);
  opacity: 0;
  transition: all var(--transition-fast);
  flex-shrink: 0;
}

.notification-item:hover .notification-dismiss {
  opacity: 1;
}

.notification-dismiss:hover {
  background: var(--bg-active);
  color: var(--text);
}

/* ═══════════════════════════════════════════════════════════════
   TOAST NOTIFICATIONS (plan-specific)
   ═══════════════════════════════════════════════════════════════ */
.toast.plan {
  border-left-color: var(--plan-accent);
  background: linear-gradient(90deg, var(--plan-accent-dim) 0%, var(--bg-elevated) 20%);
}

.toast.plan-awaiting {
  border-left-color: var(--plan-awaiting);
  background: linear-gradient(90deg, var(--plan-awaiting-dim) 0%, var(--bg-elevated) 20%);
}

.toast.plan-error {
  border-left-color: var(--plan-rejected);
  background: linear-gradient(90deg, var(--plan-rejected-dim) 0%, var(--bg-elevated) 20%);
}

/* ═══════════════════════════════════════════════════════════════
   RESPONSIVE ADJUSTMENTS
   ═══════════════════════════════════════════════════════════════ */
@media (max-width: 768px) {
  .notification-dropdown {
    width: calc(100vw - 32px);
    right: -8px;
  }
  
  .plan-actions {
    flex-direction: column;
  }
  
  .plan-actions-primary,
  .plan-actions-secondary {
    width: 100%;
  }
  
  .plan-btn {
    flex: 1;
  }
}

/* ═══════════════════════════════════════════════════════════════
   PM CHAT MODAL — Chat with PM Agent
   ═══════════════════════════════════════════════════════════════ */
.pm-chat-modal {
  display: flex;
  flex-direction: column;
  min-height: 400px;
}

.pm-chat-header {
  position: relative;
  padding-bottom: var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: var(--space-md);
}

.pm-chat-goal-label {
  font-size: 0.8rem;
  color: var(--text-dim);
  margin-top: var(--space-xs);
}

.pm-chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-md);
  background: var(--bg-input);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-md);
  min-height: 200px;
  max-height: 400px;
}

.pm-chat-empty {
  color: var(--text-muted);
  text-align: center;
  padding: var(--space-xl);
  font-style: italic;
}

.pm-chat-message {
  display: flex;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  animation: pmMessageIn 0.2s ease;
}

@keyframes pmMessageIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.pm-chat-message.user {
  background: var(--plan-accent-dim);
  margin-left: 20%;
}

.pm-chat-message.assistant {
  background: rgba(255, 255, 255, 0.05);
  margin-right: 20%;
}

.pm-chat-message-icon {
  font-size: 1.2rem;
  flex-shrink: 0;
}

.pm-chat-message-content {
  flex: 1;
  font-size: 0.9rem;
  line-height: 1.5;
}

.pm-chat-message-time {
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-top: var(--space-xs);
}

.pm-chat-composer {
  display: flex;
  gap: var(--space-sm);
  align-items: flex-end;
}

.pm-chat-input {
  flex: 1;
  min-height: 60px;
  resize: none;
}

.pm-chat-send {
  padding: 12px 16px;
}

.pm-chat-hint {
  font-size: 0.72rem;
  color: var(--text-muted);
  text-align: right;
  margin-top: var(--space-xs);
}

.pm-chat-typing {
  display: flex;
  gap: 4px;
  padding: var(--space-sm);
}

.pm-chat-typing-dot {
  width: 6px;
  height: 6px;
  background: var(--text-muted);
  border-radius: 50%;
  animation: pmTypingBounce 1.4s ease-in-out infinite;
}

.pm-chat-typing-dot:nth-child(2) { animation-delay: 0.2s; }
.pm-chat-typing-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes pmTypingBounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}

/* ═══════════════════════════════════════════════════════════════
   GOAL PLAN DISPLAY — Goal-level plan in Plans tab
   ═══════════════════════════════════════════════════════════════ */
.goal-plan-section {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-lg);
  margin-bottom: var(--space-xl);
}

.goal-plan-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-lg);
  padding-bottom: var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
}

.goal-plan-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.goal-plan-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 16px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.goal-plan-status.awaiting_approval {
  background: var(--plan-awaiting-dim);
  color: #FBBF24;
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.goal-plan-status.approved {
  background: var(--plan-approved-dim);
  color: #34D399;
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.goal-plan-status.executing {
  background: var(--plan-executing-dim);
  color: #818CF8;
  border: 1px solid rgba(129, 140, 248, 0.3);
}

.goal-plan-status.draft {
  background: var(--plan-draft-dim);
  color: #9CA3AF;
  border: 1px solid rgba(107, 114, 128, 0.3);
}

.goal-plan-content {
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-lg);
  margin-bottom: var(--space-lg);
  max-height: 300px;
  overflow-y: auto;
}

.goal-plan-content h1,
.goal-plan-content h2,
.goal-plan-content h3 {
  color: var(--text);
  margin-top: var(--space-md);
  margin-bottom: var(--space-sm);
}

.goal-plan-content h1:first-child,
.goal-plan-content h2:first-child {
  margin-top: 0;
}

.goal-plan-content p {
  margin-bottom: var(--space-md);
  line-height: 1.6;
}

.goal-plan-content ul,
.goal-plan-content ol {
  margin-left: var(--space-lg);
  margin-bottom: var(--space-md);
}

.goal-plan-content code {
  background: rgba(129, 140, 248, 0.15);
  color: var(--plan-accent);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 0.85em;
}

/* Task breakdown table in goal plan */
.goal-plan-tasks {
  margin-top: var(--space-lg);
}

.goal-plan-tasks-header {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: var(--space-md);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.goal-plan-task-row {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-md) var(--space-lg);
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-sm);
  transition: all var(--transition-fast);
}

.goal-plan-task-row:hover {
  border-color: var(--border);
  background: var(--bg-hover);
}

.goal-plan-task-status {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  flex-shrink: 0;
}

.goal-plan-task-status.pending {
  border: 2px solid var(--border);
  color: var(--text-muted);
}

.goal-plan-task-status.in-progress {
  border: 2px solid var(--plan-executing);
  background: var(--plan-executing-dim);
  color: var(--plan-executing);
}

.goal-plan-task-status.done {
  border: 2px solid var(--plan-completed);
  background: var(--plan-completed);
  color: white;
}

.goal-plan-task-name {
  flex: 1;
  font-size: 0.9rem;
  color: var(--text);
}

.goal-plan-task-agent {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: var(--bg);
  border-radius: 12px;
  font-size: 0.75rem;
  color: var(--text-secondary);
  white-space: nowrap;
}

.goal-plan-task-agent-emoji {
  font-size: 0.9rem;
}

/* Task agent label inline on task rows */
.task-agent-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: rgba(129, 140, 248, 0.1);
  border-radius: 10px;
  font-size: 0.7rem;
  color: var(--plan-accent);
  margin-left: var(--space-sm);
  white-space: nowrap;
}

.task-agent-label-emoji {
  font-size: 0.8rem;
}

.task-agent-label.unassigned {
  background: rgba(245, 158, 11, 0.1);
  color: var(--yellow, #F59E0B);
}

/* Goal plan action buttons */
.goal-plan-actions {
  display: flex;
  gap: var(--space-md);
  padding-top: var(--space-lg);
  border-top: 1px solid var(--border-subtle);
  flex-wrap: wrap;
}

.goal-plan-btn {
  padding: 10px 20px;
  border-radius: var(--radius-md);
  font-weight: 600;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all var(--transition-fast);
  border: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.goal-plan-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.goal-plan-btn-approve {
  background: linear-gradient(135deg, #10B981 0%, #059669 100%);
  color: white;
  box-shadow: 0 2px 10px rgba(16, 185, 129, 0.3);
}

.goal-plan-btn-approve:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(16, 185, 129, 0.4);
}

.goal-plan-btn-kickoff {
  background: linear-gradient(135deg, var(--plan-accent) 0%, #4F46E5 100%);
  color: white;
  box-shadow: 0 2px 10px var(--plan-accent-glow);
}

.goal-plan-btn-kickoff:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px var(--plan-accent-glow);
}

.goal-plan-btn-reject {
  background: rgba(239, 68, 68, 0.15);
  color: #F87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.goal-plan-btn-reject:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.25);
  border-color: rgba(239, 68, 68, 0.5);
}

.goal-plan-btn-pm {
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border);
}

.goal-plan-btn-pm:hover:not(:disabled) {
  background: var(--bg-active);
  border-color: var(--plan-accent);
  color: var(--plan-accent);
}

/* Kickoff progress indicator */
.kickoff-progress {
  margin-top: var(--space-lg);
  padding: var(--space-md) var(--space-lg);
  background: linear-gradient(90deg, var(--plan-accent-dim) 0%, transparent 50%);
  border: 1px solid var(--plan-accent-muted);
  border-radius: var(--radius-md);
  animation: kickoffPulse 2s ease-in-out infinite;
}

@keyframes kickoffPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.8; }
}

.kickoff-progress-header {
  font-weight: 600;
  color: var(--text);
  margin-bottom: var(--space-sm);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.kickoff-progress-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--plan-accent-muted);
  border-top-color: var(--plan-accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.kickoff-agent-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
}

.kickoff-agent-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: var(--bg-input);
  border-radius: 12px;
  font-size: 0.8rem;
}

.kickoff-agent-item.spawning {
  animation: agentSpawnPulse 1s ease-in-out infinite;
}

.kickoff-agent-item.spawned {
  background: var(--plan-approved-dim);
  color: #34D399;
}

@keyframes agentSpawnPulse {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}

/* Chat with PM button in goal header - DEPRECATED, now using tabs */
.goal-pm-chat-btn {
  display: none; /* Hidden - replaced by goal chat tabs */
}

/* ═══════════════════════════════════════════════════════════════
   GOAL CHAT TABS — PM vs Team chat modes
   ═══════════════════════════════════════════════════════════════ */

.goal-chat-tabs {
  display: flex;
  gap: 0;
  padding: 0;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-subtle);
}

.goal-chat-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px 16px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-dim);
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.goal-chat-tab:hover {
  color: var(--text-secondary);
  background: var(--bg-hover);
}

.goal-chat-tab.active {
  color: var(--plan-accent);
  border-bottom-color: var(--plan-accent);
  background: linear-gradient(180deg, transparent 0%, var(--plan-accent-dim) 100%);
}

.goal-chat-tab-icon {
  font-size: 1rem;
}

.goal-chat-tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  background: var(--red);
  color: white;
  font-size: 0.7rem;
  font-weight: 600;
  border-radius: 9px;
  margin-left: 4px;
}

.goal-chat-mode-label {
  font-weight: 600;
  color: var(--text);
}

/* Goal chat header adjustments for tabs */
.goal-chat-header {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-subtle);
}

/* PM chat styles - reused from modal, now inline */
.goal-chat .pm-chat-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-dim);
  font-size: 0.9rem;
}

/* Team session indicator */
.goal-chat-session-info {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--bg-hover);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 0.8rem;
  color: var(--text-dim);
}

.goal-chat-session-label {
  font-weight: 500;
  color: var(--text-secondary);
}

/* ═══════════════════════════════════════════════════════════════
   PM PLAN ACTION BUTTONS — Shown when PM proposes a plan
   ═══════════════════════════════════════════════════════════════ */

.pm-plan-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  margin-top: var(--space-md);
  padding: var(--space-md);
  background: linear-gradient(135deg, var(--plan-accent-dim) 0%, rgba(129, 140, 248, 0.05) 100%);
  border: 1px solid var(--plan-accent-muted);
  border-radius: var(--radius-md);
  animation: planActionsIn 0.3s ease;
}

@keyframes planActionsIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.pm-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 18px;
  border-radius: var(--radius-md);
  font-family: var(--font-sans);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--transition-fast);
  border: 1px solid var(--border);
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.pm-action-btn:hover:not(:disabled) {
  background: var(--bg-active);
  border-color: var(--border-hover);
  color: var(--text);
  transform: translateY(-1px);
}

.pm-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.pm-action-btn.primary {
  background: linear-gradient(135deg, var(--plan-accent) 0%, #4F46E5 100%);
  color: white;
  border-color: transparent;
  box-shadow: 0 2px 10px var(--plan-accent-glow);
}

.pm-action-btn.primary:hover:not(:disabled) {
  box-shadow: 0 4px 16px var(--plan-accent-glow);
  transform: translateY(-2px);
}

.pm-action-btn.success {
  background: linear-gradient(135deg, #10B981 0%, #059669 100%);
  color: white;
  border-color: transparent;
  box-shadow: 0 2px 10px rgba(16, 185, 129, 0.3);
}

.pm-action-btn.success:hover:not(:disabled) {
  box-shadow: 0 4px 16px rgba(16, 185, 129, 0.4);
  transform: translateY(-2px);
}

.pm-action-btn.warning {
  background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%);
  color: white;
  border-color: transparent;
  box-shadow: 0 2px 10px rgba(245, 158, 11, 0.3);
}

.pm-action-btn.warning:hover:not(:disabled) {
  box-shadow: 0 4px 16px rgba(245, 158, 11, 0.4);
  transform: translateY(-2px);
}

.pm-action-btn .btn-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* State classes for action buttons */
.pm-plan-actions.hidden {
  display: none;
}

.pm-plan-actions.tasks-created .pm-action-btn[data-action="create-tasks"] {
  background: var(--plan-completed-dim);
  color: var(--plan-completed);
  border-color: rgba(34, 197, 94, 0.3);
}

.pm-plan-actions.tasks-created .pm-action-btn[data-action="create-tasks"]::before {
  content: '✓ ';
}

/* Compact variant for inline messages */
.pm-plan-actions.compact {
  padding: var(--space-sm) var(--space-md);
  margin-top: var(--space-sm);
}

.pm-plan-actions.compact .pm-action-btn {
  padding: 8px 14px;
  font-size: 0.8rem;
}

/* Status text under buttons */
.pm-plan-status {
  width: 100%;
  font-size: 0.75rem;
  color: var(--text-dim);
  margin-top: var(--space-sm);
  text-align: center;
}

.pm-plan-status.success {
  color: var(--plan-completed);
}

.pm-plan-status.error {
  color: var(--plan-rejected);
}
```

## Cluster 2 — PM Mode backend + frontend

**serve.js**: No cluster-2-specific net-new function/route blocks in provided diff.

**public/app.js**: No net new function/route blocks in provided `app.js` diff (rename/rebrand-only hunks).

**public/app.css**

- ADD: PM chat thinking/error indicator styles.
- Insertion point: immediately after `.message.assistant .message-time { ... }` block, before `.message pre { ... }`.

```css
/* PM Chat thinking indicator */
.message.thinking-indicator {
  background: var(--bg-hover);
  border: 1px solid var(--border-subtle);
  padding: 12px 16px;
  border-radius: var(--radius-md);
  margin: 8px 0;
}

.thinking-dots {
  display: inline-flex;
  gap: 2px;
}

.thinking-dots span {
  animation: thinking-bounce 1.4s ease-in-out infinite;
  font-weight: bold;
}

.thinking-dots span:nth-child(1) { animation-delay: 0s; }
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes thinking-bounce {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}

.message.error {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: var(--red);
}
```

- ADD: sidebar condo quick-add button styles.
- Insertion point: inside `/* SIDEBAR CONDO GROUPS */` section, after `.condo-active-badge` and before `.condo-group-items`.

```css
.condo-add-goal-btn {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 0.9rem;
  padding: 2px 6px;
  cursor: pointer;
  border-radius: 4px;
  opacity: 0;
  transition: opacity var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
  margin-left: auto;
}

.condo-group-header:hover .condo-add-goal-btn {
  opacity: 1;
}

.condo-add-goal-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
```

- ADD: condo status-card action buttons (`+` / delete) styles.
- Insertion point: inside `/* DASHBOARD CONDO STATUS BOARD */` section, after `.condo-status-count` and before `.condo-status-goals`.

```css
.condo-status-header-right {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.condo-action-btn {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--transition-fast), color var(--transition-fast);
  opacity: 0.6;
}

.condo-action-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
  opacity: 1;
}

.condo-delete-btn:hover {
  background: rgba(239, 68, 68, 0.15);
  color: var(--red);
}
```

**lib/serve-helpers.js**: No cluster-2 additions from provided diff.

**New files**: None.

## Cluster 3 — Roles system

**serve.js**: No additions in provided `serve.js` diff for this cluster.

**public/app.js**: No role-UI function additions present in provided `app.js` diff (this diff is rename/rebrand only).

**public/app.css**: No role styles added directly in provided `app.css` diff.

**lib/serve-helpers.js**: No additions for this cluster.

**New files**

- Add `public/styles/roles.css` with full content (renaming applied where needed):

```css
/* ═══════════════════════════════════════════════════════════════
   ROLES UI — Agent role assignment and team management
   ═══════════════════════════════════════════════════════════════ */

/* --- Role Badge in Sidebar --- */
.agent-role-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-muted);
  border: 1px solid rgba(255, 255, 255, 0.08);
  cursor: pointer;
  transition: all 0.15s ease;
}

.agent-role-badge:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.15);
  color: var(--text-secondary);
}

.agent-role-badge .role-emoji {
  font-size: 11px;
}

/* Role colors */
.agent-role-badge.role-pm {
  background: rgba(99, 102, 241, 0.15);
  border-color: rgba(99, 102, 241, 0.3);
  color: #c084fc;
}

.agent-role-badge.role-frontend {
  background: rgba(59, 130, 246, 0.15);
  border-color: rgba(59, 130, 246, 0.3);
  color: #60a5fa;
}

.agent-role-badge.role-backend {
  background: rgba(16, 185, 129, 0.15);
  border-color: rgba(16, 185, 129, 0.3);
  color: #34d399;
}

.agent-role-badge.role-designer {
  background: rgba(236, 72, 153, 0.15);
  border-color: rgba(236, 72, 153, 0.3);
  color: #f472b6;
}

.agent-role-badge.role-tester {
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.3);
  color: #fbbf24;
}

.agent-role-badge.role-devops {
  background: rgba(99, 102, 241, 0.15);
  border-color: rgba(99, 102, 241, 0.3);
  color: #818cf8;
}

/* --- Role Dropdown --- */
.role-dropdown {
  position: absolute;
  z-index: 9999;
  min-width: 180px;
  background: rgba(18, 21, 26, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(12px);
}

.role-dropdown.hidden {
  display: none;
}

.role-dropdown-header {
  padding: 8px 10px 6px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  margin-bottom: 4px;
}

.role-dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.12s ease;
}

.role-dropdown-item:hover {
  background: rgba(129, 140, 248, 0.12);
  color: var(--text);
}

.role-dropdown-item.active {
  background: rgba(129, 140, 248, 0.18);
  color: var(--text);
}

.role-dropdown-item .role-emoji {
  font-size: 14px;
  width: 20px;
  text-align: center;
}

.role-dropdown-item .role-name {
  flex: 1;
}

.role-dropdown-item .role-check {
  font-size: 12px;
  color: var(--green);
}

.role-dropdown-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  margin: 4px 0;
}

.role-dropdown-custom {
  padding: 8px 10px;
}

.role-dropdown-custom input {
  width: 100%;
  padding: 6px 10px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: var(--text);
  outline: none;
  font-family: var(--font-sans);
}

.role-dropdown-custom input:focus {
  border-color: rgba(129, 140, 248, 0.4);
}

.role-dropdown-custom input::placeholder {
  color: var(--text-muted);
}

/* Role dropdown item with description */
.role-dropdown-item-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.role-dropdown-item-content .role-name {
  font-weight: 500;
}

.role-dropdown-item-content .role-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.role-dropdown-item:hover .role-desc {
  color: var(--text-dim);
}

/* --- Role Tooltip --- */
.role-tooltip {
  position: fixed;
  z-index: 10000;
  max-width: 280px;
  padding: 10px 14px;
  background: rgba(18, 21, 26, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(12px);
  pointer-events: none;
  animation: tooltipFadeIn 0.15s ease;
}

.role-tooltip.hidden {
  display: none;
}

@keyframes tooltipFadeIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.role-tooltip-role {
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.role-tooltip-role:empty {
  display: none;
}

.role-tooltip-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

/* --- Agents Panel in Sidebar --- */
.agents-panel {
  padding: 4px 0;
}

.agent-panel-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.agent-panel-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

.agent-panel-item.active {
  background: rgba(129, 140, 248, 0.08);
}

.agent-panel-emoji {
  font-size: 16px;
  width: 24px;
  text-align: center;
}

.agent-panel-info {
  flex: 1;
  min-width: 0;
}

.agent-panel-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-panel-role {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 1px;
}

.agent-panel-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
}

.agent-panel-status.active {
  background: var(--green);
  box-shadow: 0 0 8px rgba(74, 222, 128, 0.4);
}

.agent-panel-status.working {
  background: var(--yellow);
  animation: pulse-glow 1.5s ease-in-out infinite;
}

@keyframes pulse-glow {
  0%, 100% { opacity: 1; box-shadow: 0 0 4px rgba(250, 204, 21, 0.3); }
  50% { opacity: 0.7; box-shadow: 0 0 12px rgba(250, 204, 21, 0.6); }
}

/* --- Role Config Modal --- */
.role-config-modal {
  max-width: 800px;
}

.role-config-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 8px;
}

.role-config-header .modal-title {
  margin-bottom: 4px;
}

.role-config-header .modal-desc {
  margin-bottom: 0;
}

.auto-detect-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(34, 211, 238, 0.2));
  border: 1px solid rgba(99, 102, 241, 0.4);
  color: #c084fc;
}

.auto-detect-btn:hover {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.3), rgba(34, 211, 238, 0.3));
  border-color: rgba(99, 102, 241, 0.6);
}

.auto-detect-icon {
  font-size: 14px;
}

/* --- Auto-detect Preview --- */
.auto-detect-preview {
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.25);
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 16px;
}

.auto-detect-preview.hidden {
  display: none;
}

.auto-detect-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 600;
  color: #c084fc;
}

.auto-detect-header .form-btn.small {
  padding: 4px 12px;
  font-size: 11px;
}

.auto-detect-header .ghost-btn.small {
  padding: 4px 8px;
  font-size: 12px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  margin-left: auto;
}

.auto-detect-loading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  color: var(--text-muted);
  font-size: 13px;
}

.auto-detect-loading.hidden {
  display: none;
}

.auto-detect-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.auto-detect-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  font-size: 13px;
  transition: background 0.15s ease;
}

.auto-detect-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.auto-detect-checkbox {
  width: 16px;
  height: 16px;
  accent-color: #c084fc;
}

.auto-detect-item .auto-detect-icon {
  font-size: 14px;
  width: 20px;
  text-align: center;
}

.auto-detect-item.confidence-high .auto-detect-icon {
  color: var(--green);
}

.auto-detect-item.confidence-medium .auto-detect-icon {
  color: var(--yellow);
}

.auto-detect-item.confidence-low .auto-detect-icon {
  color: var(--red);
}

.auto-detect-agent {
  font-weight: 600;
  color: var(--text);
  min-width: 80px;
}

.auto-detect-arrow {
  color: var(--text-muted);
}

.auto-detect-role {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  font-weight: 500;
}

.auto-detect-confidence {
  font-size: 11px;
  color: var(--text-muted);
}

.auto-detect-reason {
  flex: 1;
  font-size: 12px;
  color: var(--text-dim);
  font-style: italic;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.auto-detect-empty,
.auto-detect-error {
  padding: 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.auto-detect-error {
  color: var(--red);
}

.role-config-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 16px;
}

.role-config-table th {
  text-align: left;
  padding: 10px 12px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.role-config-table td {
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.role-config-table tr:hover td {
  background: rgba(255, 255, 255, 0.02);
}

.role-config-row-emoji {
  font-size: 16px;
  text-align: center;
}

.role-config-row-name {
  font-weight: 600;
  color: var(--text);
}

.role-config-row-agent {
  font-family: var(--font-mono);
  font-size: 12px;
}

.role-config-row-agent.default {
  color: var(--text-muted);
  font-style: italic;
}

.role-config-row-input {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text);
  width: 140px;
  outline: none;
}

.role-config-row-input:focus {
  border-color: rgba(129, 140, 248, 0.4);
}

.role-config-row-input::placeholder {
  color: var(--text-muted);
}

/* Description textarea in role config */
.role-config-row-desc {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 11px;
  font-family: var(--font-sans);
  color: var(--text-secondary);
  width: 100%;
  min-width: 180px;
  resize: vertical;
  outline: none;
  line-height: 1.4;
}

.role-config-row-desc:focus {
  border-color: rgba(129, 140, 248, 0.4);
  color: var(--text);
}

.role-config-row-desc::placeholder {
  color: var(--text-muted);
}

.role-config-actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
  justify-content: flex-end;
}

/* --- Team Tab Improvements --- */
.team-message {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  margin-bottom: 8px;
  transition: background 0.12s ease;
}

.team-message:hover {
  background: rgba(255, 255, 255, 0.04);
}

.team-message-avatar {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}

.team-message-content {
  flex: 1;
  min-width: 0;
}

.team-message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.team-message-agent {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.team-message-role {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-muted);
  text-transform: uppercase;
}

.team-message-time {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: auto;
}

.team-message-text {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.team-message-task {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* --- Team Working Indicator --- */
.team-working-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(250, 204, 21, 0.08);
  border: 1px solid rgba(250, 204, 21, 0.2);
  border-radius: 8px;
  font-size: 12px;
  color: var(--yellow);
  margin-bottom: 12px;
}

.team-working-indicator .working-dots {
  display: flex;
  gap: 3px;
}

.team-working-indicator .working-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--yellow);
  animation: team-bounce 1.4s ease-in-out infinite;
}

.team-working-indicator .working-dot:nth-child(2) {
  animation-delay: 0.2s;
}

.team-working-indicator .working-dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes team-bounce {
  0%, 80%, 100% { transform: scale(0.8); opacity: 0.5; }
  40% { transform: scale(1.2); opacity: 1; }
}

.team-working-agents {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.team-working-agent {
  font-size: 14px;
}

/* --- Empty State --- */
.team-empty-state {
  padding: 40px 20px;
  text-align: center;
}

.team-empty-icon {
  font-size: 40px;
  margin-bottom: 12px;
}

.team-empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 6px;
}

.team-empty-desc {
  font-size: 13px;
  color: var(--text-muted);
  max-width: 280px;
  margin: 0 auto;
}
```

## Cluster 4 — PM task + goal improvements

Skipped for this guide: in the provided diffs/files, this cluster surfaces as rename/rebrand-only changes in `app.js` with no net new addable function/route blocks.

## Cluster 5 — Production readiness + cascade

**serve.js**

- ADD: kickoff event relay file watcher + broadcaster.
- Insertion point:
1. Add constant declarations immediately after existing goals watcher constants (`GOALS_FILE`, `lastGoalsMtime`).
2. Add both functions immediately after `initGoalsWatcher();` and before `getGatewayWsUrl()`.

```js
// ── Kickoff event relay: plugin writes events to a file, serve.js broadcasts to clients ──
const KICKOFF_FILE = join(__dirname, 'plugins/clawcondos-goals/.data/kickoff-events.json');
let lastKickoffMtime = 0;

function broadcastKickoffEvents() {
  try {
    const raw = readFileSync(KICKOFF_FILE, 'utf-8').trim();
    if (!raw) return;
    const events = JSON.parse(raw);
    if (!Array.isArray(events) || events.length === 0) return;
    for (const evt of events) {
      const msg = JSON.stringify({ type: 'event', event: evt.event || 'goal.kickoff', payload: evt });
      let count = 0;
      for (const ws of connectedClients) {
        try {
          if (ws.readyState === WebSocket.OPEN) { ws.send(msg); count++; }
        } catch {}
      }
      console.log(`[kickoff-relay] Broadcast ${evt.event || 'goal.kickoff'} to ${count} clients (goal=${evt.goalId})`);
    }
    // Clear the file after broadcasting
    writeFileSync(KICKOFF_FILE, '[]', 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[kickoff-relay] Error: ${err.message}`);
  }
}

function initKickoffWatcher() {
  // Create file if missing
  const dir = dirname(KICKOFF_FILE);
  if (!existsSync(dir)) return;
  if (!existsSync(KICKOFF_FILE)) writeFileSync(KICKOFF_FILE, '[]', 'utf-8');
  try {
    lastKickoffMtime = statSync(KICKOFF_FILE).mtimeMs;
    watchFile(KICKOFF_FILE, { interval: 300 }, (curr) => {
      if (curr.mtimeMs !== lastKickoffMtime) {
        lastKickoffMtime = curr.mtimeMs;
        broadcastKickoffEvents();
      }
    });
    console.log(`[kickoff-relay] Watching ${KICKOFF_FILE} for events`);
  } catch (err) {
    console.error(`[kickoff-relay] Failed to watch: ${err.message}`);
  }
}
initKickoffWatcher();
```

- MODIFY (not new route, but required behavior): subagent detection in search enrichment to include `:webchat:task-` sessions.
- Insertion point: inside local `enrichSession(s)` function in `/api/search` handler.

```js
// Match both legacy subagent format and new webchat:task- format
s.isSubagent = s.key.includes(':subagent:') || s.key.includes(':webchat:task-');
if (s.isSubagent) {
  const parts = s.key.split(':');
  if (parts.length >= 4 && (parts[2] === 'subagent' || (parts[2] === 'webchat' && parts[3]?.startsWith('task-')))) {
    s.parentKey = parts[0] + ':' + parts[1] + ':main';
  }
}
```

- Required imports for above additions:
- Insertion point: top import section.

```js
import https from 'https';
import { join, dirname, extname, resolve as resolvePath } from 'path';
```

**public/app.js**: No net new addable function blocks in provided diff.

**public/app.css**: No additional cluster-5-specific net-new styles beyond those listed in Cluster 2.

**lib/serve-helpers.js**

- ADD: enforce `operator.admin` scope in rewritten connect frames.
- Insertion point: inside `rewriteConnectFrame(raw, gatewayAuth)`, after auth injection logic and before `frame.params = p;`.

```js
// Ensure operator.admin scope for full method access
if (!Array.isArray(p.scopes)) p.scopes = [];
if (!p.scopes.includes('operator.admin')) p.scopes.push('operator.admin');
```

**New files**: None.

## Cluster 6 — GitHub + Git worktrees

**serve.js**

- ADD: local service config RPC handler for:
- `config.getServices`
- `config.setService`
- `config.deleteService`
- `config.verifyGitHub`

- Insertion point: after `createServer(...)` block closes (after static-file serving), before `server.on('upgrade', ...)`.

```js
// ── Local service config RPC handler ──
// Handles config.getServices, config.setService, config.deleteService locally
// so they work even if the gateway plugin hasn't been restarted.
function tryHandleLocalServiceRpc(raw, clientWs) {
  let frame;
  try { frame = JSON.parse(raw); } catch { return false; }
  if (!frame || frame.type !== 'req') return false;

  const LOCAL_METHODS = ['config.getServices', 'config.setService', 'config.deleteService', 'config.verifyGitHub'];
  if (!LOCAL_METHODS.includes(frame.method)) return false;

  const respond = (ok, payload, error) => {
    const res = ok
      ? { type: 'res', id: frame.id, ok: true, payload }
      : { type: 'res', id: frame.id, ok: false, error: typeof error === 'string' ? { message: error } : error };
    try { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(res)); } catch {}
  };

  try {
    const goalsPath = GOALS_FILE;
    const loadData = () => {
      if (!existsSync(goalsPath)) return { config: {}, condos: [] };
      return JSON.parse(readFileSync(goalsPath, 'utf-8'));
    };
    const persistData = (d) => {
      const dir = join(__dirname, 'plugins/clawcondos-goals/.data');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(goalsPath, JSON.stringify(d, null, 2));
    };

    const params = frame.params || {};

    // ── Token masking ──
    const SENSITIVE = ['token', 'apiKey', 'secret', 'password', 'accessToken', 'agentToken'];
    const maskSvc = (svc) => {
      if (!svc || typeof svc !== 'object') return svc;
      const m = { ...svc };
      for (const k of SENSITIVE) {
        if (m[k] && typeof m[k] === 'string') {
          const v = m[k];
          m[k] = v.length > 8 ? v.slice(0, 4) + '****' + v.slice(-4) : '****';
          m[k + 'Configured'] = true;
        }
      }
      return m;
    };
    const maskAll = (svcs) => {
      const r = {};
      for (const [n, s] of Object.entries(svcs || {})) r[n] = maskSvc(s);
      return r;
    };

    if (frame.method === 'config.getServices') {
      const data = loadData();
      const globalSvcs = data.config?.services || {};
      if (params.condoId) {
        const condo = (data.condos || []).find(c => c.id === params.condoId);
        if (!condo) return respond(false, null, 'Condo not found'), true;
        const overrides = condo.services || {};
        const merged = { ...globalSvcs };
        for (const [n, o] of Object.entries(overrides)) merged[n] = { ...(merged[n] || {}), ...o };
        respond(true, { services: maskAll(merged), overrides: maskAll(overrides) });
      } else {
        respond(true, { services: maskAll(globalSvcs) });
      }
      return true;
    }

    if (frame.method === 'config.setService') {
      const { service, config: svcCfg, condoId } = params;
      if (!service || typeof service !== 'string') return respond(false, null, 'service name is required'), true;
      if (!svcCfg || typeof svcCfg !== 'object') return respond(false, null, 'config object is required'), true;
      const data = loadData();
      if (condoId) {
        const condo = (data.condos || []).find(c => c.id === condoId);
        if (!condo) return respond(false, null, 'Condo not found'), true;
        if (!condo.services) condo.services = {};
        condo.services[service] = { ...(condo.services[service] || {}), ...svcCfg };
        condo.updatedAtMs = Date.now();
      } else {
        if (!data.config) data.config = {};
        if (!data.config.services) data.config.services = {};
        data.config.services[service] = { ...(data.config.services[service] || {}), ...svcCfg };
        data.config.updatedAtMs = Date.now();
      }
      persistData(data);
      respond(true, { ok: true });
      return true;
    }

    if (frame.method === 'config.deleteService') {
      const { service, condoId } = params;
      if (!service || typeof service !== 'string') return respond(false, null, 'service name is required'), true;
      const data = loadData();
      if (condoId) {
        const condo = (data.condos || []).find(c => c.id === condoId);
        if (!condo) return respond(false, null, 'Condo not found'), true;
        if (condo.services) {
          delete condo.services[service];
          if (Object.keys(condo.services).length === 0) delete condo.services;
        }
        condo.updatedAtMs = Date.now();
      } else {
        if (data.config?.services) {
          delete data.config.services[service];
          if (Object.keys(data.config.services).length === 0) delete data.config.services;
        }
        if (data.config) data.config.updatedAtMs = Date.now();
      }
      persistData(data);
      respond(true, { ok: true });
      return true;
    }

    if (frame.method === 'config.verifyGitHub') {
      const { token: rawToken, condoId, repoUrl } = params;

      // Resolve token
      let tokenToVerify = rawToken;
      if (!tokenToVerify) {
        const data = loadData();
        if (condoId) {
          const condo = (data.condos || []).find(c => c.id === condoId);
          const condoGh = condo?.services?.github;
          if (condoGh?.agentToken) tokenToVerify = condoGh.agentToken;
          else if (condoGh?.token) tokenToVerify = condoGh.token;
        }
        if (!tokenToVerify) {
          const gh = data.config?.services?.github;
          if (gh?.agentToken) tokenToVerify = gh.agentToken;
          else if (gh?.token) tokenToVerify = gh.token;
        }
      }

      if (!tokenToVerify) {
        respond(true, { valid: false, error: 'No GitHub token configured' });
        return true;
      }

      // Async: make GitHub API calls and respond when done
      const ghApiCall = (method, path) => new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.github.com', path, method,
          headers: {
            'Authorization': `Bearer ${tokenToVerify}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'ClawCondos/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }, (res) => {
          let raw = '';
          res.on('data', chunk => raw += chunk);
          res.on('end', () => {
            let data = null;
            try { data = JSON.parse(raw); } catch {}
            resolve({ data, headers: res.headers, statusCode: res.statusCode });
          });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
      });

      (async () => {
        try {
          const { data, headers: hdrs, statusCode } = await ghApiCall('GET', '/user');
          if (statusCode === 401 || statusCode === 403) {
            return respond(true, { valid: false, error: `Authentication failed (${statusCode}): ${data?.message || 'Invalid token'}` });
          }
          if (statusCode < 200 || statusCode >= 300) {
            return respond(true, { valid: false, error: `GitHub API returned ${statusCode}: ${data?.message || 'Unknown error'}` });
          }

          const scopesHeader = hdrs['x-oauth-scopes'];
          const scopes = scopesHeader ? scopesHeader.split(',').map(s => s.trim()).filter(Boolean) : [];
          const tokenType = scopesHeader !== undefined ? 'classic' : 'fine-grained';
          const result = { valid: true, login: data.login, name: data.name || null, scopes, tokenType };

          if (repoUrl && typeof repoUrl === 'string') {
            const ghMatch = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
            if (ghMatch) {
              const [, owner, repo] = ghMatch;
              try {
                const repoResp = await ghApiCall('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
                if (repoResp.statusCode >= 200 && repoResp.statusCode < 300) {
                  result.repoAccess = { accessible: true, permissions: repoResp.data?.permissions || {} };
                } else {
                  result.repoAccess = { accessible: false, error: `${repoResp.statusCode}: ${repoResp.data?.message || 'Cannot access repo'}` };
                }
              } catch (repoErr) {
                result.repoAccess = { accessible: false, error: repoErr.message };
              }
            } else {
              result.repoAccess = { accessible: null, note: 'Non-GitHub URL' };
            }
          }

          respond(true, result);
        } catch (err) {
          respond(true, { valid: false, error: err.message });
        }
      })();

      return true;
    }
  } catch (err) {
    respond(false, null, err.message);
    return true;
  }

  return false;
}
```

- ADD: local RPC interception on client websocket messages.
- Insertion point: inside `server.on('upgrade'...)`, in `clientWs.on('message', ...)`, immediately after `raw` computation and before `rewriteConnectFrame(...)`.

```js
// ── Local intercept for service config RPC ──
// These methods may not yet be registered on the gateway (requires restart),
// so handle them locally against the same goals.json store.
const localResult = tryHandleLocalServiceRpc(raw, clientWs);
if (localResult) return; // Handled locally, don't forward
```

**public/app.js**: No net-new addable functions/routes in provided diff.

**public/app.css**: No cluster-6-specific additions from provided diff.

**lib/serve-helpers.js**: No additional cluster-6 code beyond cluster-5 scope injection.

**New files**: None.

---

## Explicit skips from provided diffs

The following are intentionally excluded from implementation instructions because they are rebrand/palette/string-only in provided patches:
- `public/app.js` bulk `condo↔strand`, `ClawCondos↔Helix`, key-prefix and route-label swaps
- `public/app.css` brand-accent/palette replacements and heading comment renames
- `serve.js` comment-string/env-var rename-only lines unrelated to feature logic

## Notes for coding agents

- Keep all naming as ClawCondos/condo in implementation (`strand*`/`Helix*` identifiers in source diff are already normalized above).
- Do not port the duplicated helix config-route typo from source patch (`'/helix-lib/config.js' || '/helix-lib/config.js'`).
- Use insertion points exactly as specified above; they match current file structure.
