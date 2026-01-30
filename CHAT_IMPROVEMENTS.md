# Sharp Chat Interface - Improvement Proposal

**Date:** January 30, 2026  
**Status:** In Progress

## Summary

Comprehensive review of Sharp's chat interface compared to Clawdbot's webchat, with fixes implemented and remaining improvements identified.

---

## Issues Fixed ✅

### 1. Wrong Event State Names
**Problem:** Sharp was checking for `'streaming'`/`'done'` but server sends `'delta'`/`'final'`  
**Impact:** Agent status never updated, thinking indicator never shown  
**Fix:** Updated `handleChatEvent()` to use correct state names

### 2. No Streaming Display
**Problem:** Only showed final message, no live streaming  
**Fix:** Added `updateStreamingMessage()` with blinking cursor `▊`

### 3. No Typing Indicator
**Problem:** No visual feedback when agent starts working  
**Fix:** Added bouncing dots animation that appears on `agent` lifecycle `start` event

### 4. Active Runs Lost on Refresh
**Problem:** Page refresh lost track of which sessions were "thinking"  
**Fix:** 
- Added `chat.activeRuns` RPC method to Clawdbot (patched)
- Added localStorage fallback for persistence
- Sync from server on connect

### 5. Session Not Restored on Refresh
**Problem:** Refreshing page always went to overview  
**Fix:** Save current session to localStorage, restore on load

### 6. No Auto-Scroll During Streaming
**Problem:** Chat didn't scroll to show new content  
**Fix:** Added `scrollChatToBottom()` with `requestAnimationFrame` for reliable scrolling

### 7. Stop Button Position
**Problem:** Stop button was above the input area  
**Fix:** Moved to circular button next to send button

---

## Remaining Improvements 🔧

### High Priority

#### 1. Message Queueing
**Current:** Messages can be sent while agent is still responding  
**Needed:** 
- Visual queue indicator showing pending messages
- Ability to cancel queued messages
- Clear feedback that message is queued vs being processed

```javascript
// Proposed state
state.messageQueue = [];
state.queuedMessageCount = 0;

// UI: Show "2 messages queued" indicator
```

#### 2. Reconnection Robustness
**Current:** Reconnects but loses context  
**Needed:**
- Visual indicator during reconnection (pulsing connection dot)
- Preserve message queue across disconnects
- Resume streaming display after reconnect
- Show "Reconnecting..." overlay

#### 3. Clawdbot Patch Persistence
**Current:** `chat.activeRuns` patch lost on npm update  
**Solutions:**
- Submit PR to upstream Clawdbot
- Or: Add to post-update script (already created at `~/clawd/scripts/apply-clawdbot-patches.sh`)

### Medium Priority

#### 4. Tool Use Display
**Current:** Tool calls not shown in chat  
**Needed:** Show tool invocations with expandable details

```html
<div class="tool-call">
  <div class="tool-header">🔧 exec: ls -la</div>
  <div class="tool-output collapsed">...</div>
</div>
```

#### 5. Thinking/Reasoning Display
**Current:** Extended thinking not shown  
**Needed:** Collapsible "Thinking..." block when verbose mode is on

#### 6. Multi-Part Content
**Current:** Only text content rendered  
**Needed:** Support for images, code blocks with syntax highlighting

#### 7. Read Receipts / Delivery Status
**Current:** No feedback after sending  
**Needed:**
- ✓ Sent
- ✓✓ Delivered
- 👁 Read

### Low Priority

#### 8. Message Actions
- Reply to specific message
- Copy message
- Delete message
- Resend failed message

#### 9. Performance
- Virtualized message list for long chats
- Lazy-load history
- Throttle rapid re-renders during streaming

#### 10. Search
- Search within current chat
- Jump to message

---

## Files Changed

### Sharp (`/home/albert/clawd/projects/sharp/index.html`)
- `handleChatEvent()` - Fixed state names, added status tracking
- `handleAgentEvent()` - New, handles lifecycle events
- `showTypingIndicator()` / `hideTypingIndicator()` - New
- `updateStreamingMessage()` / `finalizeStreamingMessage()` - New  
- `scrollChatToBottom()` - New, reliable scrolling
- `syncActiveRunsFromServer()` - New, fetches active runs on connect
- `openSession()` / `showOverview()` - Session persistence
- CSS: Typing indicator, streaming cursor, stop button styling

### Clawdbot Patches (need reapply after updates)
- `dist/gateway/server-bridge-methods-chat.js` - Added `chat.activeRuns`
- `dist/gateway/server-methods.js` - Registered method
- `dist/gateway/server-methods-list.js` - Registered method

---

## Scripts Created

| Script | Purpose |
|--------|---------|
| `~/clawd/scripts/clawdbot-update-check.sh` | Verify patches after update |
| `~/clawd/scripts/apply-clawdbot-patches.sh` | Auto-apply patches |
| `~/clawd/config/clawdbot-patches.md` | Patch documentation |

---

## Testing Checklist

- [x] Typing indicator (bouncing dots) appears when agent starts
- [x] Streaming text with cursor shows during response
- [x] Orange status dot in sidebar during thinking
- [x] Status changes to green when idle
- [x] Session persists across page refresh
- [x] Stop button next to send button
- [ ] Auto-scroll follows streaming content
- [ ] Message queue shows pending count
- [ ] Reconnection maintains state
- [ ] Tool calls displayed

---

## Next Steps

1. **Test auto-scroll** - Verify scrolling works reliably
2. **Add message queue UI** - Show queued message count
3. **Submit Clawdbot PR** - For `chat.activeRuns` method
4. **Add reconnection overlay** - Visual feedback during reconnect
