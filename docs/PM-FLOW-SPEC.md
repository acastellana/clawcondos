# PM Flow Spec — ClawCondos

**Status:** Approved for implementation  
**Date:** 2026-03-01  
**Author:** Bob (spec), Albert (design)

---

## Overview

ClawCondos operates with three agent levels:

1. **Bob** (main agent) — cross-cutting assistant. Available in Telegram and anywhere. Creates condos/goals, gives briefings, relays PM Q&A inline in Telegram.
2. **Condo PM** — one PM per condo. Plans goals, asks clarifying Q&A, kicks off workers, monitors execution. Lives in ClawCondos middle column.
3. **Workers** — one session per task. Execute and report. No UI chat needed.

---

## Architecture

### Session types

| Session key format | Role | Created by |
|---|---|---|
| `agent:main:telegram:group:...:topic:...` | Bob (Telegram) | OpenClaw gateway |
| `agent:main:webchat:pm-<condoId>` | Condo PM | `getOrCreatePmSessionForCondo` |
| `agent:main:webchat:task-<suffix>` | Worker | `internalKickoff` via plugin |

**One PM session per condo.** PM session key stored in `condo.pmSessionKey` (already exists in model).  
**Workers** stored in `goal.tasks[n].sessionKey` (already exists).  
**`goal.pmSessionKey` is deprecated** — PM is at condo level, not goal level.

---

## Entry Points

### Entry 1: ClawCondos UI (new goal via form)

```
User fills goal form → goals.create RPC
  → UI opens goal detail view (Tasks tab default)
  → UI calls pm.condoChat(condoId, message="[NEW_GOAL] title: '...' description: '...'", focusGoalId=goalId)
  → PM receives context, starts Q&A in middle column
  → Middle column becomes active with PM's first question
```

### Entry 2: Telegram (via Bob)

```
Albert: "Create a goal for X in [condo]"
  → Bob calls condo_create_goal tool
  → Bob calls pm.condoChat (internal) with NEW_GOAL trigger + goalId focus
  → pm.condoChat returns enrichedMessage + pmSessionKey
  → Bob calls chat.send to pmSessionKey with enrichedMessage
  → PM agent responds
  → Bob reads PM's response (via sessions.history or event)
  → Bob relays PM's first question back to Albert in Telegram
  → Albert replies in Telegram
  → Bob relays answer to PM via pm.condoChat
  → Loop until Albert says "kick it off"
  → Bob sends "kick it off" to pm.condoChat
  → PM uses condo_pm_kickoff tool
```

Bob manages the relay loop. Albert never needs to open ClawCondos for the Q&A phase if he prefers Telegram.

---

## Middle Column Chat

**What it is:** Direct chat with the condo PM session.

**Context rule:**
- No goal selected → `pm.condoChat(condoId, message)` — condo-level context
- Goal open in detail view → `pm.condoChat(condoId, message, focusGoalId=goalId)` — condo context + "currently focused on goal X"

**Focus goal injection** (added to enrichedMessage when focusGoalId is set):
```
[CURRENT FOCUS] Goal: "<title>" (ID: <goalId>)
Status: <status> | Tasks: <N> | Created: <date>
Task list:
- [pending] Task A
- [in-progress] Task B (worker: agent:main:webchat:task-xyz)
```

This means `pm.condoChat` needs a `focusGoalId` optional param. The backend enriches the message with goal state when it's provided.

**RPC flow for middle column send:**
1. Frontend calls `pm.condoChat({ condoId, message, focusGoalId? })`
2. Backend returns `{ enrichedMessage, pmSession, history }`
3. Frontend calls `chat.send({ sessionKey: pmSession, message: enrichedMessage })`
4. PM agent responds via WebSocket event → frontend renders in middle column

**RPC flow for middle column load:**
1. Frontend calls `pm.condoGetHistory({ condoId })` on condo open
2. Renders history in middle column

---

## Goal Detail View

**Tabs:** Tasks | Files  
**No PM Chat tab.** PM lives in the middle column.

**Tasks tab shows:**
- Each task: text, status, assigned worker session key, last `goal_update` summary, last active timestamp
- No spawn button needed for normal flow (PM kicks off). Keep a manual "Spawn" escape hatch for power users.

**Files tab:** unchanged.

**Kick Off button:** Removed from goal detail overlay.  
**Replaced by:** Natural language in middle column — "kick it off" → PM uses `condo_pm_kickoff` tool.

If user needs a UI shortcut: a "▶ Start" button in the Tasks tab that sends `"Please kick off goal [title] now."` to `pm.condoChat` with `focusGoalId` set. PM decides.

---

## Goal Creation Flow (detail)

### New goal → PM Q&A trigger

After `goals.create` succeeds:

```js
// Frontend sends NEW_GOAL trigger to PM
await rpcCall('pm.condoChat', {
  condoId: goal.condoId,
  message: `[NEW_GOAL] Goal created: "${goal.title}". ${goal.notes ? 'Description: "' + goal.notes + '".' : 'No description yet.'}`,
  focusGoalId: goal.id,
});
// Then: call chat.send to pmSession with enrichedMessage
// Middle column shows PM's first Q&A question
```

PM receives enriched context and is instructed (via PM skill context) to:
- If no description/tasks → ask 1-2 clarifying questions at a time (max 5-7 total)
- If description + tasks exist → confirm readiness and wait
- Do NOT create tasks yet
- Wait for "kick it off" signal

### "Kick it off" signal

User types "kick it off" (or any equivalent) in middle column → PM detects intent → calls `condo_pm_kickoff` tool with `goalId` → workers spawn.

The PM skill context should include explicit instructions to recognize kick-off intent ("kick it off", "start", "go ahead", "let's go") and respond by calling `condo_pm_kickoff`.

---

## Worker Monitoring

### PM notification on goal_update

When a worker calls `goal_update` tool, the plugin hook (in `goal-update-tool.js`) should:

1. Update task status as today
2. **Notify the condo PM:** append a system event to `condo.pmChatHistory` and call `sendToSession(condo.pmSessionKey, notificationMessage)` if available

Notification message format:
```
[WORKER UPDATE] Goal: "<title>" | Task: "<task text>" (ID: <taskId>)
Status: <new status> | Worker: <sessionKey>
Summary: <summary from goal_update>
Next: <nextTask if set>
```

PM receives this as a user message and can:
- Acknowledge silently (if progress is normal)
- Intervene (re-send task context, spawn replacement worker)
- Report to user ("Task X is done, moving to Y")

### Stale worker detection

Existing stale session cleanup in `serve.js` already runs. PM should also be notified when a worker session goes stale (no heartbeat for >15 min on an in-progress task). Add a check to the existing cleanup loop.

---

## Backend changes required

### 1. `pm.condoChat` — add `focusGoalId` param

```js
// New param: focusGoalId (optional)
const { condoId, message, focusGoalId } = params || {};

// When focusGoalId is set, inject goal context into enrichedMessage:
if (focusGoalId) {
  const goal = data.goals.find(g => g.id === focusGoalId);
  if (goal) {
    const focusBlock = buildFocusGoalBlock(goal); // new helper
    // prepend to enrichedMessage after SESSION IDENTITY block
  }
}
```

### 2. `goal-update-tool.js` — notify condo PM

After saving task status update, call `sendToSession` on the condo PM session:

```js
const condo = data.condos.find(c => c.id === goal.condoId);
if (condo?.pmSessionKey && sendToSession) {
  sendToSession(condo.pmSessionKey, workerUpdateMessage);
}
```

### 3. No other backend changes needed

`pm.condoGetHistory`, `getOrCreatePmSessionForCondo`, `condo_pm_kickoff` tool, `goals.kickoff`, `goals.create` — all exist and work.

---

## Frontend changes required

### 1. Middle column wired to `pm.condoChat`

Replace current middle column chat logic:
- On condo open: call `pm.condoGetHistory({ condoId })`, render in middle column
- On send: call `pm.condoChat({ condoId, message, focusGoalId: state.currentGoalOpenId || null })`, get back `{ enrichedMessage, pmSession }`, then `chat.send({ sessionKey: pmSession, message: enrichedMessage })`
- WebSocket events from pmSession render as PM responses in middle column

### 2. Goal detail — remove PM Chat tab, Kick Off overlay

- Remove tab: PM Chat (and all `startPmQA`, `kickOffGoal` logic added this week)
- Remove: kickoff overlay from goal detail
- Keep: Tasks tab, Files tab
- Add: optional "▶ Start" button in Tasks tab header (sends kick-off message to PM)

### 3. Goal creation → trigger PM Q&A

After `goals.create` success, before opening goal detail:
```js
await rpcCall('pm.condoChat', { condoId, message: newGoalTrigger, focusGoalId: goalId });
// then chat.send to pmSession
// then open goal detail (Tasks tab)
// middle column shows PM's first question
```

### 4. Add `focusGoalId` context indicator in middle column header

When a goal is open, show a small pill in the middle column header: `● Focused: <goal title>` so user knows the PM is contextualised to that goal.

### 5. Delete `public/index.html` and `public/app.js`

These are stale built files. Source of truth is `index.html`. Delete and remove any references in `serve.js`.

---

## Revert / cleanup from this week's patches

| Change | Action |
|---|---|
| `startPmQA()` function | Remove entirely |
| `setGoalChatLocked()` changes | Revert to original |
| `kickOffGoal()` PM session reuse logic | Remove (kickoff via PM chat instead) |
| `goalKickoffOverlay` / `goalKickoffText` | Remove from HTML |
| PM Chat tab in goal detail | Remove (was never in source anyway) |
| `public/app.js`, `public/index.html` | Delete |

---

## PM Skill Context (what the PM agent is told)

The `getCondoPmSkillContext` function (already exists in `skill-injector.js`) provides PM role instructions. It needs to be updated/confirmed to include:

```
You are the PM for condo "<name>". Your responsibilities:
1. When a new goal is created: ask 1-2 clarifying questions at a time to define it (max 5-7 total). Do not create tasks yet.
2. When the user says to kick it off (or similar): call condo_pm_kickoff with the goalId to spawn workers.
3. When workers report: acknowledge, monitor, intervene if blocked.
4. When focused on a specific goal: treat that goal as the current context for all messages.
5. Keep responses concise. You are a PM, not a chatbot.
```

---

## What is NOT changing

- Backend plugin structure — no refactor needed
- `goals.create`, `goals.list`, `goals.update` — unchanged
- Worker session format (`agent:main:webchat:task-*`) — unchanged
- `goals.spawnTaskSession` — unchanged (used by `condo_pm_kickoff`)
- Task detail, file tracking — unchanged
- Condo sidebar, condo list — unchanged
- Test suite — all 532 tests must still pass after changes

---

## Implementation order

1. **Backend:** Add `focusGoalId` to `pm.condoChat` + goal focus block builder
2. **Backend:** Add PM notification in `goal-update-tool.js`
3. **Frontend:** Wire middle column to `pm.condoChat` / `pm.condoGetHistory`
4. **Frontend:** Goal creation → PM Q&A trigger
5. **Frontend:** Remove kickoff overlay, PM Chat tab from goal detail, add Start button
6. **Frontend:** Focus goal pill in middle column header
7. **Cleanup:** Revert this week's patches, delete `public/` files
8. **Test:** `npm test` must pass; manual smoke test of full flow

---

## Open questions (resolved)

- ~~Per-goal PM or per-condo PM?~~ → **Per-condo PM**
- ~~Where does Q&A happen in Telegram?~~ → **Bob relays inline, PM session is always the source**
- ~~What does middle column do?~~ → **PM chat, context-aware to focused goal**
- ~~Where is Kick Off?~~ → **Natural language to PM, or "Start" button sends message to PM**
