# ClawCondos + Telegram Agent E2E Test Results

**Date:** 2026-02-07 14:18-14:20
**Tester:** Bob (AI Agent)
**Environment:** localhost:9011 (ClawCondos on port 9011)

---

## Test Summary

| # | Test Case | Result | Notes |
|---|-----------|--------|-------|
| 1 | Create condo via condo_bind | ⚠️ PARTIAL | Condo created, but sidebar shows only after goal exists |
| 2 | Create goal with tasks | ✅ PASS | 5 tasks created and visible after refresh |
| 3 | Update task to in-progress | ⚠️ PARTIAL | Status updates but stage=null (bug) |
| 4 | Mark task done | ❌ FAIL | Status updates but UI stage grouping broken |
| 5 | Track files | ✅ PASS | Files tracked correctly in data |

---

## Critical Bugs Found

### BUG-001: Stage grouping broken for non-done statuses
- **Severity:** HIGH
- **Location:** `goal-update-tool.js`
- **Description:** When setting status="in-progress", the `stage` field is not updated. Only status="done" sets `stage="done"`.
- **Impact:** UI shows all non-done tasks in "Backlog" regardless of status
- **Fix:** Add stage assignment for in-progress:
```javascript
if (status === 'in-progress') {
  task.stage = 'in-progress';
}
```

### BUG-002: Condo name not displayed
- **Severity:** MEDIUM
- **Location:** `public/app.js` (renderGoalPane)
- **Description:** Condo shows as ID (condo_xxx) instead of name in breadcrumb and detail view
- **Impact:** User sees confusing IDs instead of readable names

### BUG-003: No real-time sync for direct port access
- **Severity:** MEDIUM  
- **Description:** Real-time file watcher implemented but only broadcasts to clients connected directly to serve.js (port 9011). Caddy proxy (port 9000) bypasses this.
- **Impact:** Updates require manual refresh

---

## What's Working

1. **condo_bind** creates condos correctly
2. **goal_update** with **addTasks** creates tasks correctly
3. **goal_update** with **status=done** marks tasks done correctly
4. **goal_update** with **files** tracks files correctly
5. **goal_update** with **notes** appends notes correctly
6. **goal_update** with **nextTask** sets next task correctly (data)
7. Data persistence working correctly
8. UI rendering of tasks after refresh

---

## Recommendations

1. **Fix stage assignment** in goal-update-tool.js for all statuses
2. **Fix condo name lookup** in UI rendering
3. **Consider polling fallback** for real-time sync when file watcher doesn't reach clients

---

## Test Artifacts

- Test condo: `condo_e4f760e8dc69986d598e58e2` ("E2E Integration Test")
- Test goal: `goal_e2e_main` ("E2E Test: Full Workflow")
- 5 test tasks created
- 2 test files tracked
