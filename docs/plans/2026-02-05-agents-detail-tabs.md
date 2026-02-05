# Agents Detail Tabs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a three-tab interface (Overview, Files, Tasks) to the agents page, showing full agent information: mission summary, skills, heartbeat, file browser, and recurring tasks.

**Architecture:** Replace the current single-section body in `renderAgentsPage()` with a tab bar + tab content renderer. Each tab renders its content into `agentsMainBody`. Tab state tracked in `state.agentTab`. All backend endpoints already exist (`/api/agents/summary`, `/api/skills/resolve`, `/api/agents/files`). The `loadAgentFiles` function needs to re-trigger on agent switch and render into the Files tab instead of the removed detail panel.

**Tech Stack:** Vanilla JS, CSS custom properties, existing fetch-based data loading functions.

---

## Task 1: Add tab bar CSS to `styles/agents.css`

**Files:**
- Modify: `styles/agents.css` (insert before the `@media` query at line 144)

**Step 1: Add tab bar and section styles**

Append these styles to `styles/agents.css` before the existing `@media (max-width: 1000px)` block:

- `.agents-tab-bar` — flex row, border-bottom, padding 0 18px, bg var(--bg-dark)
- `.agents-tab` — padding 10px 16px, font-size 12px, font-weight 600, color var(--text-muted), border-bottom 2px transparent, cursor pointer
- `.agents-tab:hover` — color var(--text-secondary)
- `.agents-tab.active` — color var(--text-primary), border-bottom-color var(--accent-blue)
- `.agent-detail-section` — margin-bottom 20px
- `.agent-detail-section-label` — font-size 11px, font-weight 700, uppercase, letter-spacing 0.06em, color var(--text-muted), margin-bottom 8px
- `.agent-detail-section-body` — color var(--text-secondary), font-size 13px, line-height 1.5
- `.agent-skill-item` — padding 8px 0, border-bottom 1px solid var(--border-subtle); last-child no border
- `.agent-skill-name` — font-size 12px, font-weight 600, color var(--text-primary)
- `.agent-skill-desc` — font-size 11px, color var(--text-muted), margin-top 2px
- `.agent-heartbeat-item` — padding 3px 0, font-size 12px, color var(--text-secondary)
- `.agent-file-list` — flex column, gap 2px
- `.agent-file-item` — flex row, align center, gap 8px, padding 6px 10px, border-radius 6px, cursor pointer, font-size 12px
- `.agent-file-item:hover` — bg var(--bg-hover)
- `.agent-file-item.dir` — color var(--text-muted), font-weight 600
- `.agent-file-icon` — font-size 14px, width 18px, text-align center
- `.agent-file-name` — flex 1, overflow hidden, text-overflow ellipsis, nowrap
- `.agent-file-size` — font-size 10px, color var(--text-muted)
- `.agent-file-viewer` — bg var(--bg-card), border 1px solid var(--border), border-radius 8px, overflow hidden
- `.agent-file-viewer-header` — flex row, gap 8px, padding 8px 12px, border-bottom, font-size 12px, font-weight 600
- `.agent-file-viewer-content` — padding 12px, JetBrains Mono, font-size 11px, pre-wrap, max-height 500px, overflow auto

Also change `.agents-main-body` padding from `16px 18px` to `0` (the tab content div provides its own padding).

**Step 2: Commit**

```
git add styles/agents.css
git commit -m "feat(agents): add tab bar and detail section CSS"
```

---

## Task 2: Add `selectAgentTab()` global function and tab state

**Files:**
- Modify: `public/app.js`

**Step 1: Add `selectAgentTab` function**

Add immediately after the `selectAgentForAgentsPage` function (after line ~4861):

```js
function selectAgentTab(tab) {
  state.agentTab = tab;
  renderAgentsPage();
}
```

Expose globally alongside `selectAgentForAgentsPage`:

```js
window.selectAgentTab = selectAgentTab;
```

**Step 2: Reset tab on agent switch**

In `selectAgentForAgentsPage`, add `state.agentTab = 'overview';` after existing state resets.

**Step 3: Commit**

```
git add public/app.js
git commit -m "feat(agents): add selectAgentTab function and tab state"
```

---

## Task 3: Rewrite `renderAgentsPage()` body to use tabs

**Files:**
- Modify: `public/app.js:4744-4848` (body rendering section of `renderAgentsPage`)

**Step 1: Replace body rendering**

Keep the agent list rendering (lines 4687-4742) unchanged. Replace everything from line 4744 (`const desc = ...`) through line 4848 with:

1. Build tab bar HTML — three tabs (Overview, Files, Tasks), active class from `state.agentTab || 'overview'`, onclick calls `selectAgentTab(id)`
2. Switch on `activeTab`:
   - `'overview'` -> call `renderAgentOverviewTab(agent)`
   - `'files'` -> call `renderAgentFilesTab(agent)`
   - `'tasks'` -> call `renderAgentTasksTab(agent)`
3. Set `body.innerHTML` to tabBarHtml + content wrapped in a div with padding 16px 18px
4. If tasks tab, call `wireAgentTasksTabHandlers(agent)` to bind search/toggle events
5. Keep the existing async data loading kicks at the end (loadAgentSummary, loadSkillDetailsForAgent, loadAgentFiles, loadCronJobs)

**Step 2: Commit**

```
git add public/app.js
git commit -m "feat(agents): add tab bar to agents detail area"
```

---

## Task 4: Implement `renderAgentOverviewTab()`

**Files:**
- Modify: `public/app.js` (add new function before `renderAgentsPage`)

**Step 1: Add the Overview tab renderer**

`renderAgentOverviewTab(agent)` returns an HTML string with three sections:

1. **Mission** — from `state.agentSummaries[agent.id].mission` (fall back to `agent.description || agent.summary`). Show "Loading..." if summary not loaded yet. Use `escapeHtml()` on all values. Wrap in `.agent-detail-section` with label "Mission".

2. **Skills** — from `state.resolvedSkillsByAgent[agent.id]`. Only show if agent has `skills` or `skillIds` array. Each skill rendered as `.agent-skill-item` with `.agent-skill-name` and `.agent-skill-desc`. Count shown in label. Use `escapeHtml()` on all values. If skills not resolved yet, show skill IDs as names.

3. **Heartbeat** — from `state.agentSummaries[agent.id].headings.heartbeat`. Each heading rendered as `.agent-heartbeat-item` with left padding = `(level - 1) * 16px`. Use `escapeHtml()`. Skip section if summary loaded but no heartbeat data.

If nothing to show, render "No additional details available for this agent."

**Step 2: Commit**

```
git add public/app.js
git commit -m "feat(agents): implement Overview tab with mission, skills, heartbeat"
```

---

## Task 5: Implement `renderAgentFilesTab()`

**Files:**
- Modify: `public/app.js` (add new function, update existing functions)

**Step 1: Add the Files tab renderer**

`renderAgentFilesTab(agent)` returns an HTML string:

- If loading (`state.agentFileLoading` and no entries): show "Loading files..."
- If no entries: show "No browsable files in this agent's workspace."
- If `state.selectedAgentFile` is set: render file viewer with back button, file name header, and content in `.agent-file-viewer` / `.agent-file-viewer-content`. Back button sets `state.selectedAgentFile = null` and calls `renderAgentsPage()`.
- Otherwise: render `.agent-file-list` with directories (non-clickable, icon folder) then files (clickable via `selectAgentFile(path)`, icon file, show size via `formatFileSize()`).

Add `formatFileSize(bytes)` helper: B/KB/MB formatting.

**Step 2: Update `selectAgentFile` (line ~4684)**

Change `renderDetailPanel()` to `if (state.currentView === 'agents') renderAgentsPage()`.

**Step 3: Update `loadAgentFiles` (line ~4667)**

Change `if (state.currentView === 'agents') renderDetailPanel()` to `if (state.currentView === 'agents') renderAgentsPage()`.

**Step 4: Expose `selectAgentFile` globally**

Add `window.selectAgentFile = selectAgentFile;` alongside other window exposures.

**Step 5: Commit**

```
git add public/app.js
git commit -m "feat(agents): implement Files tab with file browser"
```

---

## Task 6: Implement `renderAgentTasksTab()` and `wireAgentTasksTabHandlers()`

**Files:**
- Modify: `public/app.js` (add new functions)

**Step 1: Extract tasks rendering into `renderAgentTasksTab(agent)`**

This is the existing recurring tasks code from `renderAgentsPage` extracted verbatim. Returns HTML string containing:
- Filter bar (`.recurring-filters` with search input `#agentJobsSearch` and checkbox `#agentJobsEnabledOnly`)
- Grid cards for filtered jobs (same markup as current)

All logic for filtering by search/enabled, formatting schedule/model/outcome/lastRun stays the same. Uses `escapeHtml()` on all values.

**Step 2: Extract event handlers into `wireAgentTasksTabHandlers(agent)`**

Binds `oninput` on `#agentJobsSearch` and `onchange` on `#agentJobsEnabledOnly` — same logic as current code, updating `state.agentJobsSearchByAgent` and `state.agentJobsEnabledOnlyByAgent`, saving to localStorage, and calling `renderAgentsPage()`.

**Step 3: Commit**

```
git add public/app.js
git commit -m "feat(agents): implement Tasks tab with recurring jobs"
```

---

## Task 7: Manual smoke test

**Step 1: Start the dev server**

```
node serve.js
```

**Step 2: Verify in browser at localhost:9000**

1. Navigate to Agents page
2. Tab bar visible with Overview / Files / Tasks
3. Overview shows mission (or loading), skills list, heartbeat outline
4. Files tab shows file list, clicking opens viewer, back button works
5. Tasks tab shows recurring tasks with search/filter
6. Switching agents resets to Overview tab
7. Mobile responsive check at narrow viewport

**Step 3: Final commit (if any fixes needed)**

```
git add -A
git commit -m "feat(agents): three-tab agent detail page"
```

---

## File Summary

| File | Action | What Changes |
|------|--------|-------------|
| `styles/agents.css` | Modify | Add ~130 lines of CSS: tab bar, detail sections, skill items, heartbeat items, file browser, file viewer. Change `.agents-main-body` padding to 0. |
| `public/app.js` | Modify | Rewrite `renderAgentsPage()` body section (~100 lines replaced with tab logic). Add 6 new functions: `selectAgentTab`, `renderAgentOverviewTab`, `renderAgentFilesTab`, `renderAgentTasksTab`, `wireAgentTasksTabHandlers`, `formatFileSize`. Update `selectAgentFile` and `loadAgentFiles` to render into agents page. Expose new globals. |
