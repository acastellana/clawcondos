# PORT_PLAN.md — Helix → ClawCondos Feature Port

## Goal
Port valuable features from `helix/master` into `port/helix-features` branch.
- Keep ClawCondos branding (condo, not strand; ClawCondos, not Helix)
- Skip all rebrand, docs-only, and CSS color-system commits
- After port: cherry-pick our 2 local commits on top, then merge to master

## Branch setup
- Base: `9178232` (feat: H key to go home/dashboard) — the exact divergence point
- Source: `helix/master`
- Target branch: `port/helix-features`

## Naming substitutions (apply to every ported file)
| Helix name     | ClawCondos name |
|----------------|-----------------|
| strand         | condo           |
| Strand         | Condo           |
| strands        | condos          |
| Strands        | Condos          |
| helix          | clawcondos      |
| Helix          | ClawCondos      |
| HELIX          | CLAWCONDOS      |
| strand-tools   | condo-tools     |
| strands-handlers | condos-handlers |

## Commits to SKIP (branding/docs/duplicates)
- 1ea528d — check if it's actually useful (WebSocket auth) — EVALUATE FIRST
- b284c47 — docs only
- 8ad126e, 857d8cc, ac5fdbf, 7aa760b — duplicate feature-branch commits (pre-merge)
- 94e8387, eed8fbd — docs QA reports
- 93e9d99, 15e5a45, 01579e9, 68000aa, dce6d51 — merge commits (no new content)
- 3b2c8ce, dbe1f30, d70824f, ee57316, d86c70c, a94e871, a95e430 — merge commits
- 809ae7b, 993f480, 638f41d, 36003b1 — SKILL.md / docs updates
- 0cdf6a7 — remove adrian-website folder (irrelevant)
- d0e8075 — rebrand SKIP
- 0302b18 — Helix CSS palette SKIP
- 3ddcb9a, c6572ad — screenshot docs SKIP
- 4b6f974, 27374c5, 7d9214c, 08a88ab — rebrand/docs SKIP

## Feature clusters (implement in this order)

### Cluster 1 — Plans integration (CSS + data model + UI)
Commits (oldest→newest, skip duplicates):
- 586182b — feat(css): add plan integration components → public/styles/plans.css (NEW FILE)
- 5ea045e — feat(plans): Phase 1 - Data model & basic RPC
- fe721be — feat: Phase 2 & 3 - Approval flow + Real-time events
- f43e089 — feat: Add plan display to task rows (Phase 4)
- 9b72108 — feat: Add plan interactions (Phase 5)

### Cluster 2 — PM Mode backend + frontend
Commits:
- b7face6 — feat(condo-management): Add PM Mode backend features
- 99c4e8c — feat(pm-mode): Add PM Mode frontend for ClawCondos
- e478dfb — feat: configurable PM agent and agent role mapping
- e41497d — feat: Replace PM modal with in-goal tabs (PM/Team)
- 0e19b65 — feat: skill injection hooks for ClawCondos
- 036b240 — fix: PM chat textarea word-wrap and auto-grow
- 5438d22 — feat(pm): add PM chat history persistence
- 0e80348 — fix(pm-chat): use pm.getHistory + optimistic UI
- 8b0cfae — feat: add PM plan action buttons (Create Tasks / Start Goal)
- f33fea9 — feat(pm): add plan parser and createTasksFromPlan RPC
- 189a93c — fix(pm): move pmChatHistory from condo to goal
- ec931cf — fix: + button in CONDOS section now creates condo, not goal
- c6ff402 — fix: show empty condos in ClawCondos dashboard
- 8f580c1 — feat: add + and delete buttons to condo cards
- 4733e45 — fix: show empty condos in sidebar (renderGoals)
- e1cc9d0 — feat: add delete button to condos in sidebar
- 8804983 — fix: use correct param name for condos.delete
- a6b5da9 — fix(pm-chat): add missing goalId to RPC call and broadcast goal.deleted event

### Cluster 3 — Roles system
Commits:
- d9083d6 — feat(roles): Add role assignment UI for agents
- 280c549 — Fix role dropdown not closing after assignment
- 02e7daf — Fix role dropdown: use permanent global click listener
- 72e15f0 — fix(roles): add missing .hidden style for role dropdown
- c459a77 — fix(ui): prevent role dropdown from going off-screen
- 43ae40b — feat(roles-ui): Add role descriptions, auto-detect, and tooltips
- 194f758 — feat(roles): add descriptions and auto-detect for agent roles

### Cluster 4 — PM task + goal improvements
Commits:
- 0051467 — feat: improve PM task planning, agent assignment, and task management
- 13738be — fix: prevent parser from creating duplicate tasks
- 329a3a0 — fix: always show condo action buttons and expand uncategorized
- c1eec85 — feat: add condo workspaces and git worktrees for parallel goal development
- 5e689ef — fix: kickoff respects task dependencies
- ae4cefb — feat: sequential task deps, goal autonomy, and task_completed broadcast
- 6ec4f43 — feat: start agents via chat.send after kickoff

### Cluster 5 — Production readiness + cascade
Commits:
- 59829cf — fix: cascade delete goals on condo delete and add gateway scope auth
- 4de951d — feat: add production-readiness features, agents overview, condo context, and E2E tests
- 05514b0 — feat: phased goal execution, cross-goal dependencies, and kill stale sessions
- 8819f40 — fix: kill stale sessions using client-side hiding

### Cluster 6 — GitHub + Git worktrees
Commits:
- 2cb6c0f — feat: GitHub auto-repo creation, services config tab, and UI micro-interactions
- 1fea2a4 — fix(cascade): backend calls chat.send directly for auto-kickoffs
- 73f0e2e — feat(cascade): backend-first PM cascade architecture
- e0b64c4 — feat(cascade): fix auto-merge in agent_end + three-level full auto cascade
- 92ddb46 — fix(cascade): propagate autonomyMode='full' to goals in full auto mode
- fb7aadb — fix(merge): auto-commit worktree changes before merging goal branch
- f89ef06 — feat(git): push goal branches to remote on creation and before merge
- bedae8f — feat(github): add token verification + fix clone-mode auth
- ab56f5c — feat(tools): expose PM cascade to external agents via 4 new tools
- c3bc9a5 — fix(goals): complete goals even when workspaces are disabled

## Key files changed (for reference)
### NEW files in Helix (copy + rename):
- public/styles/plans.css
- public/styles/roles.css
- public/lib/config.js (evaluate — may conflict)

### Major modified files (manual diff + apply):
- serve.js (PM backend, cascade, GitHub, git worktrees, roles RPC)
- public/app.js (PM UI, roles UI, plans UI, cascade UI)
- public/index.html (PM tabs, roles, plans)
- public/app.css (plans + roles styles)
- lib/gateway-client.js (cascade, auth)
- lib/serve-helpers.js (workspaces, git worktrees)
- lib/config.js (new config fields)
- package.json (new deps)

## Success criteria
- All feature clusters integrated with condo/ClawCondos naming
- `serve.js` runs without errors (`node --check serve.js`)
- Service starts (`systemctl --user restart clawcondos`)
- No Helix/strand references in user-facing strings
- Our 2 local commits (92bc51a session fix, 80cf0f9 Agents Hub) applied on top
