# PM Flow Spec — ClawCondos

**Status:** Approved for implementation  
**Date:** 2026-03-01  
**Author:** Bob (spec), Albert (design)

---

## ⚠️ Prerequisites (must exist before implementation)

### `docs/SKILL-PM-STRAND.md` — MISSING, must be created

`getCondoPmSkillContext` appends this file to every PM message. Without it, the PM agent receives only a dynamic header (condo name + goals list) but **zero role instructions** — no Q&A behavior, no kickoff recognition, no monitoring guidance. The PM is just the raw main agent.

This file must be created as the **first step** of implementation. It defines the PM's entire behavior. Contents:

```markdown
# Condo PM Role

You are a Project Manager for this condo. Your responsibilities depend on the current phase:

## Phase 1: Goal Definition (Q&A)
When a new goal is created or you receive a [NEW_GOAL] trigger:
- Ask 1-2 clarifying questions at a time (scope, success criteria, constraints, deadline, dependencies)
- Do NOT create tasks yet
- Continue Q&A until the user signals readiness ("kick it off", "start", "go ahead", "let's go", "begin")

## Phase 2: Kickoff
When the user signals readiness:
1. Confirm the goal is sufficiently defined
2. Create tasks using `condo_add_task` for each work item
3. Call `condo_pm_kickoff` with `{ condoId, goalId }` to spawn workers
4. If kickoff returns `requiresAgentSpawn: true`: iterate `spawnInstructions` and call `sessions_spawn` for each task with the provided `taskContext`
5. Confirm to the user which workers were spawned

## Phase 3: Monitoring
When you receive a [WORKER UPDATE] notification:
- Acknowledge if progress is normal
- Intervene if a worker is blocked: re-send task context or escalate to user
- Report completion when all tasks are done

## Rules
- Always know which goal is in focus ([CURRENT FOCUS] block in your messages)
- Keep responses concise — you are a PM, not a chatbot
- Never plan tasks for goals you haven't been asked about
- When blocked on a decision, ask the user one specific question
```

---

## Design Goals

1. Creating a goal immediately starts a PM Q&A — no empty state, no manual setup
2. PM is a real agent (Sonnet), not a UI widget
3. PM decides to kick off workers — user just says "go" or clicks Start
4. PM monitors workers autonomously, user only watches
5. Same PM session is accessible from Telegram (via Bob) and from ClawCondos
6. One PM per condo — manages all goals within it

---

## Architecture

### Session types

| Session key format | Role | Created by |
|---|---|---|
| `agent:main:telegram:group:...:topic:...` | Bob (Telegram) | OpenClaw gateway |
| `agent:main:webchat:pm-condo-<condoId>` | Condo PM | `getOrCreatePmSessionForCondo` |
| `agent:main:webchat:task-<suffix>` | Worker | `internalKickoff` via `goals.kickoff` |

**One PM session per condo.** Key stored at `condo.pmCondoSessionKey` (field already exists in model).  
**Workers** stored in `goal.tasks[n].sessionKey` (already exists).  
**`goal.pmSessionKey`** — no longer used for new goals; existing per-goal PM sessions still work but are not created for new goals.

### Context injection

`before_agent_start` plugin hook:
- Detects `isPmSession(sessionKey)` → returns early, injects nothing
- PM sessions get ALL their context via enriched messages from `pm.condoChat`
- This is correct: `agent:main:webchat:pm-condo-<id>` contains `:webchat:pm-` → `isPmSession` returns true ✅

`agent_end` plugin hook:
- Condo PM sessions are in `sessionCondoIndex` → hook updates condo timestamp → returns
- Per-goal cascade (`cascadeState`) does NOT fire for condo PM sessions — this is intentional
- PM uses explicit tools (`condo_pm_kickoff`) not free-text plans

---

## UI Layout

ClawCondos layout: **sidebar** (left) + **main area** (right, switches views).

The main area can be:
- `chatView` — regular chat with selected session (Bob / any session)
- `goalView` — two panels: `goalChatPanel` (left) + `goalRightPanel` (right)
- `overviewView`, etc.

**The PM chat lives in `goalChatPanel`** — no new column needed.

When a goal is open in goalView:
- `goalChatPanel` (left) = PM chat, wired to `condo.pmCondoSessionKey`, with goal focus context
- `goalRightPanel` (right) = goal detail: definition, Tasks tab, Files tab

When no goal is open:
- PM is accessible by clicking the PM session in the sidebar (regular chatView)
- Or by opening any goal

---

## How `chat.send` Creates Sessions

**webchat sessions are auto-created by the gateway on first `chat.send`.** Confirmed in `task-spawn.js`: "Uses `webchat` session type so chat.send auto-creates the session on the gateway."

This means: no separate `sessions.create` call is needed before using the PM session. Calling `chat.send({ sessionKey: 'agent:main:webchat:pm-condo-X', message: ... })` will create and start the session if it doesn't exist yet.

---

## The 3-Step PM Chat Flow

Every message sent to the PM (from UI or from Bob) follows this pattern:

```
Step 1: pm.condoChat({ condoId, message, focusGoalId? })
        → returns { enrichedMessage, pmSession: condo.pmCondoSessionKey, history }

Step 2: chat.send({ sessionKey: pmSession, message: enrichedMessage })
        → PM agent runs, sends response via WebSocket event

Step 3 (on PM response event): pm.condoSaveResponse({ condoId, content: pmResponse })
        → saves PM response to condo.pmChatHistory for fast retrieval
```

**Step 3 is mandatory.** Without it, `pm.condoGetHistory` returns stale data.

Frontend must detect when a WebSocket `chat` event arrives for `pmCondoSessionKey` with `role=assistant` → immediately call `pm.condoSaveResponse`.

---

## goalChatPanel Wiring

Currently `goalChatPanel` uses `state.goalChatSessionKey` to identify which session to render and listen to.

**Change:** when a goal is opened (`openGoal(goalId)`):
1. Get or create condo PM session: `pm.condoChat({ condoId, message: '' })` — or just `getOrCreatePmSessionForCondo` equivalent via RPC
2. Set `state.goalChatSessionKey = condo.pmCondoSessionKey`
3. Load PM history: `pm.condoGetHistory({ condoId })` → render in `goal_chatMessages`
4. Set `state.goalFocusId = goalId` (new state field) for focus context

On send (composer in goalChatPanel):
- Calls 3-step flow with `focusGoalId = state.goalFocusId`

On WebSocket event for `state.goalChatSessionKey`:
- Render in `goal_chatMessages` as before
- If event is `role=assistant` → call `pm.condoSaveResponse`

---

## Goal Creation → PM Q&A Trigger

### Via UI form

After `goals.create` succeeds:

```js
const triggerMsg = `[NEW_GOAL] Goal created: "${goal.title}".` +
  (goal.notes ? ` Description: "${goal.notes}".` : ' No description yet.') +
  ` Please start by asking me 1-2 clarifying questions to define this goal properly.`;

// Step 1
const pmResult = await rpcCall('pm.condoChat', {
  condoId: goal.condoId,
  message: triggerMsg,
  focusGoalId: goal.id,
});

// Step 2
await rpcCall('chat.send', {
  sessionKey: pmResult.pmSession,
  message: pmResult.enrichedMessage,
});

// Step 3 happens automatically when PM responds via WebSocket

// Open goal view — goalChatPanel will show PM's first question
openGoal(goal.id);
```

If goal already has notes AND tasks on creation → send "confirm readiness" trigger instead of Q&A trigger.

### Via Telegram (Bob)

Bob creates goal via `condo_create_goal` tool → then uses `condo_pm_chat` tool to notify PM:

```
condo_pm_chat({
  condoId: <id>,
  message: "[NEW_GOAL] Goal created: '<title>'. <desc>. Please begin defining it."
})
```

Bob then tells Albert: *"Goal created and PM session is ready. Continue in ClawCondos PM chat, or tell me your requirements and I'll pass them on."*

Bob does NOT run a full relay loop. If Albert asks Bob questions about the goal, Bob uses `condo_pm_chat` tool to query/update the PM. But primary Q&A happens in ClawCondos.

---

## Focus Goal Context in pm.condoChat

When `focusGoalId` is provided, `pm.condoChat` injects a focus block into `enrichedMessage`:

```
[CURRENT FOCUS] Goal: "<title>" (ID: <goalId>)
Status: <status> | Tasks: <N>
Task list:
  - [pending] Task A
  - [in-progress] Task B → worker: agent:main:webchat:task-xyz
  - [done] Task C
```

This block is prepended after the SESSION IDENTITY line in enrichedMessage.

**Backend change:** add `focusGoalId` optional param to `pm.condoChat` handler. Build focus block from `data.goals.find(g => g.id === focusGoalId)`.

---

## Kickoff UX

**No "Kick Off" overlay.** Removed from goalChatPanel.

**"▶ Start" button** in `goalRightPanel` Tasks tab header:
- Visible when: goal has tasks but no worker sessions yet
- Click → sends message to PM: `"Please kick off this goal now."` via 3-step flow with `focusGoalId`
- PM receives it, calls `condo_pm_kickoff` tool → workers spawn
- Button hides once workers are active

**Natural language also works:** typing "kick it off" in goalChatPanel → PM recognizes it → calls tool.

### Kickoff fallback: `requiresAgentSpawn`

`condo_pm_kickoff` calls `startSpawnedSessions` internally (backend `chat.send` per worker). This often fails because `api.callMethod` is not available to plugins. When it fails, the tool returns:

```json
{
  "requiresAgentSpawn": true,
  "spawnInstructions": [{ "taskId", "taskText", "sessionKey", "taskContext", "agentId" }, ...]
}
```

**PM must handle this.** The SKILL-PM-STRAND.md instructs the PM to: if `requiresAgentSpawn` is true, call `sessions_spawn` for each entry in `spawnInstructions` using `taskContext` as the task. This is the normal path in practice.

The `▶ Start` button and the PM skill context must account for this — PM does the actual spawning as a follow-up tool call.

The PM skill context (`getCondoPmSkillContext`) must include:

```
When the user asks you to "kick it off", "start", "go ahead", "begin", or similar:
- Call the condo_pm_kickoff tool with the goalId currently in focus.
- Confirm to the user which workers you are spawning and for which tasks.
```

---

## Worker Monitoring (PM notification)

When a worker calls `goal_update` tool, the plugin should notify the condo PM:

```js
// In goal-update-tool.js, after saving task status:
const condo = data.condos.find(c => c.id === goal.condoId);
if (condo?.pmCondoSessionKey && sendToSession) {
  const notif = `[WORKER UPDATE] Goal: "${goal.title}" | Task: "${task.text}" (${taskId})\n` +
    `Status: ${newStatus} | Summary: ${summary || 'none'}`;
  sendToSession(condo.pmCondoSessionKey, notif);
}
```

**Important:** `api.sendToSession` may not be available in all gateway versions. This is best-effort. If unavailable, a warning is logged and PM is not notified. PM can still check status by looking at goal context in its next enriched message.

Stale worker detection: existing cleanup loop in `serve.js` handles stale `webchat:task-*` sessions. PM gets notified implicitly on next user interaction (task shows as stale in focus block).

---

## goalRightPanel Changes

**Keep:**
- Goal definition (editable)
- Tasks tab: task list with status, worker session key, last summary
- Files tab: unchanged

**Remove:**
- Kick Off overlay (`#goalKickoffOverlay`, `#goalKickoffText`)
- PM Chat tab (it was in stale `public/` files only, never in source)

**Add:**
- "▶ Start" button in Tasks tab header (see Kickoff UX above)
- Focus pill in goalChatPanel header: `● PM — <condoName>` with goal title when focused

---

## pm.condoChat Backend Changes

Add `focusGoalId` optional param:

```js
const { condoId, message, focusGoalId } = params || {};

// After building base enrichedMessage, if focusGoalId:
if (focusGoalId) {
  const goal = data.goals.find(g => g.id === focusGoalId && g.condoId === condoId);
  if (goal) {
    const tasks = (goal.tasks || []).map(t =>
      `  - [${t.status || 'pending'}] ${t.text}${t.sessionKey ? ' → worker: ' + t.sessionKey : ''}`
    ).join('\n');
    const focusBlock = [
      `[CURRENT FOCUS] Goal: "${goal.title}" (ID: ${goal.id})`,
      `Status: ${goal.status || 'active'} | Tasks: ${(goal.tasks || []).length}`,
      tasks ? `Task list:\n${tasks}` : 'No tasks yet.',
    ].join('\n');
    // Prepend focus block immediately after SESSION IDENTITY line
    enrichedMessage = enrichedMessage.replace(
      '[SESSION IDENTITY]',
      focusBlock + '\n\n[SESSION IDENTITY]'
    );
  }
}
```

---

## goal-update-tool.js Changes

After saving task status update, attempt PM notification (best-effort):

```js
try {
  const condo = data.condos?.find(c => c.id === goal.condoId);
  if (condo?.pmCondoSessionKey && typeof sendToSession === 'function') {
    const notif = buildWorkerUpdateNotification(goal, task, params);
    sendToSession(condo.pmCondoSessionKey, notif);
  }
} catch (e) {
  // silent — PM notification is non-critical
}
```

---

## goals.kickoff Double-Send Risk

serve.js has TWO code paths that send `chat.send` to workers after kickoff:
1. Line ~1731: Special-case gateway route for `goals.kickoff` — calls gateway RPC then bridges `chat.send`
2. Line ~1779: General local goals RPC path — if `goals.kickoff` ever reaches here, also sends `chat.send`

In normal flow, path 1 fires and `return`s before path 2. But if the gateway route for `goals.kickoff` is somehow unavailable and it falls through to the local handler, both paths could fire and workers would receive duplicate first messages.

**Mitigation:** The PM-driven kickoff uses `condo_pm_kickoff` tool (which uses `internalKickoff` then `startSpawnedSessions`), not the serve.js bridge path. If `requiresAgentSpawn: true`, the PM calls `sessions_spawn` directly — bypassing the bridge entirely. So in practice, the double-send risk is low for PM-driven kickoffs.

**Document this in serve.js** with a comment to prevent future confusion.

---

## Cleanup / Revert

| Item | Action |
|---|---|
| `startPmQA()` function in index.html | Remove |
| `kickOffGoal()` PM session reuse logic | Revert to original OR remove entirely (kickoff via PM) |
| `setGoalChatLocked()` changes | Revert — overlay removal handles this |
| `#goalKickoffOverlay`, `#goalKickoffText` | Remove from HTML |
| `public/app.js` | Delete — stale built file |
| `public/index.html` | Delete — stale built file |
| References to `public/` in serve.js (if any) | Remove |

---

## What is NOT Changing

- Backend plugin structure
- `goals.create`, `goals.list`, `goals.update`, `goals.delete`
- `goals.kickoff`, `goals.spawnTaskSession`
- `pm.chat` (per-goal PM — still registered, still works for backwards compat)
- `pm.saveResponse`, `pm.getHistory` (per-goal)
- Worker session format
- Sidebar session list rendering
- Condo creation/management
- Test suite — all 532 tests must pass

---

## Implementation Order

0. **Create `docs/SKILL-PM-STRAND.md`** — PM role instructions (Q&A, kickoff, monitoring, `requiresAgentSpawn` handling). **Must be done first.** Everything else is wiring; without this the PM has no behavior.
1. **Backend — `pm.condoChat` `focusGoalId`:** Add param, build focus block, inject into enrichedMessage. Unit test.
2. **Backend — `goal-update-tool.js` PM notification:** Add best-effort `sendToSession` call. Guard carefully.
3. **Backend — `getCondoPmSkillContext`:** Add kickoff recognition instructions.
4. **Frontend — `openGoal()`:** Set `state.goalChatSessionKey` to `pmCondoSessionKey`, load PM history via `pm.condoGetHistory`.
5. **Frontend — goalChatPanel send:** Wire composer to 3-step pm.condoChat flow with `focusGoalId`.
6. **Frontend — WebSocket event handler:** Detect PM session events → call `pm.condoSaveResponse`.
7. **Frontend — goal creation:** After `goals.create`, send NEW_GOAL trigger to PM, then `openGoal()`.
8. **Frontend — goalRightPanel:** Remove kickoff overlay, add "▶ Start" button in Tasks tab.
9. **Frontend — goalChatPanel header:** Add PM focus pill.
10. **Cleanup:** Remove `startPmQA`, revert `kickOffGoal`/`setGoalChatLocked`, delete `public/` files.
11. **Test:** `npm test` must pass. Manual smoke: create goal → PM asks questions → say "start" → workers spawn → goal_update → PM gets notified.

---

## Open Questions (resolved)

- ~~Per-goal or per-condo PM?~~ → **Per-condo** (`condo.pmCondoSessionKey`)
- ~~Three-column layout or existing?~~ → **Existing goalView layout** (`goalChatPanel` = PM chat)
- ~~Where does Bob do Q&A relay?~~ → **Bob creates + notifies PM, primary Q&A in ClawCondos**
- ~~Is sendToSession reliable?~~ → **Best-effort only, non-critical**
- ~~Does cascade run for condo PM?~~ → **No, and that's fine — PM uses tools**
- ~~Does isPmSession catch condo PM sessions?~~ → **Yes** (`:webchat:pm-` prefix matches)
