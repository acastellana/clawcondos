# Cron Rationalization Map — 2026-02-22

## Current snapshot
- Total jobs: 33
- Enabled: 30
- Disabled: 3

Disabled jobs (already parked):
- `8986f898-6150-496f-a7e5-b8ecb076955b` (duplicate ecosystem monitor)
- `cd72cc86-d2de-4275-85b9-a36622e88a92` (old caffeine highlights)
- `ea4154e6-b377-4a71-bd9d-c1e9f4d5b27c` (overlapping ecosystem crawl)

---

## Keep as-is (core, non-overlapping)
- `961b5bfd-6e3f-4773-82e7-373c9c6bca89` Claude quota monitor
- `b7e6e80a-5632-4010-923b-428cf653362a` Gateway exposure check
- `e471aca4-31ae-4096-a003-842f3c1b5bf3` Daily CLI updates
- `2b525029-9935-470c-a260-b3d8a46e5408` Morning briefing
- `c9f7935d-bb8f-4608-bcad-4277788eb163` Subastas daily
- `baeed751-8f18-4246-b9ec-c11368c4788a` Subastas evening
- `45a35d3e-761e-4aaa-8ee7-ed7c269e07bd` CRM reminders
- `1196382e-0f85-4233-aa98-679b748d3f68` Arguefun daily report
- `ebf70f6b-edef-4511-8fcd-712b5bd70831` Librarian weekly suspicious review

## Keep, but monitor delivery/errors
- `22e5fadb-2562-4ccf-a775-0acb2bb0a592` Agent weekly reflection
  - model mismatch fixed, but recent failures are announce-delivery related.

---

## Consolidate candidates (high overlap)

### A) Ecosystem pipeline (good base; minor cleanup left)
Current active chain:
- `98038e28-2063-462e-bd67-52579499075f` artifact harvest (3h)
- `e8e415ea-d1cb-4883-af7c-872fc7d11325` trend scorer (hourly)
- `66749a02-f084-4207-a2c4-bc42f6172d8c` librarian ingest (hourly)
- `62f38a99-970f-4133-af2a-1782a1efd9ba` ecosystem curation (hourly)
- `6f773dd3-6eac-4f3f-9228-bfffbdc51ae5` ecosystem monitor (6h)
- `11ba6233-fc11-4a5d-8b3d-2a81b934fbf7` daily ecosystem digest
- `4f45ac47-d0da-4909-a90a-5a0e0e44a088` daily awesome sync

Recommendation:
- Keep all for now (they are pipeline-distinct), but reduce message fanout to one daily digest + one weekly summary.

### B) Self-improvement cluster (potentially redundant)
Active:
- `58393b37-724d-46f2-8c0b-ab31dd855bc5` error sweep (2h)
- `5688029b-799b-4c9b-853b-65da63f1710a` conversation review (3x/day)
- `0a3ef659-1014-4767-b6b2-fddf4d09362d` agent sync (2x/day)
- `dfc0a20d-7559-4c51-b71b-e0ec598af085` promotion review (daily)
- `ba987541-3fb9-4133-9239-08d7592d9c3e` weekly synthesis
- `22e5fadb-2562-4ccf-a775-0acb2bb0a592` weekly agent reflection
- `6b7746fc-35e9-423b-b1f2-506f361ed307` tool audit (daily)

Recommendation:
- Merge `5688029b` + `0a3ef659` into one twice-daily “learning sync”.
- Keep weekly jobs but ensure only one posts to topic 30 and one to topic 36.

### C) Caffeine campaign cadence (intentionally parallel)
Active:
- `7ec0f71a...` arguefun lane (q4h)
- `a1107049...` genlayer lane (q4h)
- `18936922...` internetcourt lane (q4h)
- `4b96a3a0...` rally lane (q4h)
- plus alignment/report jobs

Recommendation:
- Keep as-is (business objective aligned), but consider reducing to q6h if quality drops.

---

## Suggested next execution batch (safe)
1) Keep disabled jobs disabled (no re-enable).
2) Merge self-improvement overlap:
   - retire one of: `5688029b` or `0a3ef659` after creating unified replacement.
3) Resolve announce-delivery failures for `22e5fadb`:
   - validate target topic route, or set delivery mode `none` and send explicitly in-task via message tool.
4) Normalize models:
   - replace `google-gemini-cli/gemini-3-flash-preview` (`4f45ac47...`) with `google-gemini-cli/gemini-2.5-flash` unless preview is intentionally needed.

---

## Expected impact after next batch
- 1–2 fewer recurring jobs
- lower notification noise in topic 36/30
- reduced repeated analysis work
- fewer cron “announce delivery failed” incidents
