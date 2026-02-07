# Intelligent Session Classification & Goal Auto-Creation

> **Status:** Ready for Implementation  
> **Date:** 2026-02-07  
> **Authors:** Bob (agent swarm synthesis)  
> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

---

## Executive Summary

When a new Telegram session starts, automatically classify it to the right condo (project) and optionally create goals with tasks. This eliminates manual session organization.

**Goal:** Zero manual triage - sessions auto-file themselves by project.

**Architecture:** Two-tier classification (fast patterns → LLM fallback) injected at `before_agent_start` hook.

**Tech Stack:** JavaScript, OpenClaw goals plugin, Gateway LLM proxy.

---

## Design Decisions (Locked)

| Question | Decision | Rationale |
|----------|----------|-----------|
| LLM call location | Gateway proxy | Reuse existing routing, no extra credentials |
| Initial keywords | Auto-seed from goal titles + manual tune | Bootstrap with data we have |
| Telegram topics | Bind to matching condos | Simplest mental model |
| Rate limiting | First message classifies, rest inherit | No debounce complexity |
| Confidence threshold | Start at 0.92, relax to 0.85 after 2 weeks | Conservative launch |
| Backfill old sessions | No - new sessions only | Simpler, avoid noisy reclassification |
| Latency budget | 3s max for Tier 2, else fallback | Don't block agent startup |

---

## What This Does (User Perspective)

### Scenario 1: Telegram Topic
```
You: [in "Subastas" topic] "Check for new auctions in Murcia"

→ Instantly routed to condo:subastas
→ Shows in ClawCondos sidebar under Subastas project
```

### Scenario 2: Keyword Match
```
You: "Update the investor pipeline with new VC contacts"

→ Words "investor" + "pipeline" trigger match
→ Auto-route to condo:investor-crm
→ Work is tracked
```

### Scenario 3: Task Detected
```
You: "Build a landing page for MoltCourt - design, implement, deploy"

→ Classified to condo:moltcourt
→ Detects task language
→ Asks: "Create goal with 3 tasks? [Yes] [No]"
→ Goal created if confirmed
```

### Scenario 4: Ambiguous
```
You: "How's progress on that thing?"

→ LLM checks recent context
→ Routes with 0.7 confidence
→ Shows confirm button, auto-accepts in 5s
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    INCOMING MESSAGE                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              SESSION CREATION (resolveSession)                   │
│              isNewSession = true                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TIER 1: FAST PATTERN MATCHER                     │
│  • Telegram topic → condo name match                            │
│  • Explicit @condo:name syntax                                  │
│  • Keyword/trigger scoring per condo                            │
│  • Confidence ≥0.92 → Route immediately                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                    confidence < 0.92
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TIER 2: LLM CLASSIFIER                           │
│  • Semantic analysis via Gateway proxy                          │
│  • Match against condo descriptions + recent goals              │
│  • 3s timeout, fallback to uncategorized                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 DECISION ENGINE                                  │
│  • confidence ≥ 0.85 → Auto-route (small indicator)             │
│  • confidence 0.5-0.85 → Confirm buttons (5s auto-accept)       │
│  • confidence < 0.5 → Uncategorized                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 GOAL DETECTION (Phase 2)                         │
│  • Detect task-like language patterns                           │
│  • LLM extracts title + subtasks                                │
│  • Suggest goal creation with confirm                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Tier 1 Classification (3 days) ← START HERE

Ship fast pattern matching with zero LLM latency. Gets 60-70% of sessions auto-classified.

### Phase 2: Tier 2 LLM (1 week)

Add LLM fallback for ambiguous messages.

### Phase 3: Goal Auto-Creation (1 week)

Detect task language and suggest goal creation.

### Phase 4: Learning (ongoing)

Collect corrections, auto-tune keywords.

---

# Phase 1 Implementation Plan

## Task 1: Add Classification Fields to Condo Schema

**Files:**
- Modify: `condo-management/store.js`
- Modify: `condo-management/types.d.ts` (if exists)

**Step 1.1: Update condo schema**

Add to condo object definition in `store.js`:

```javascript
// In createCondo() or condo schema
{
  id: string,
  name: string,
  description: string,
  emoji: string,
  
  // NEW: Classification hints
  keywords: [],           // ["investor", "crm", "pipeline", "fundraising"]
  triggers: [],           // ["/investor\\s+\\w+/i", "/pipeline/i"] - regex strings
  excludePatterns: [],    // ["/test/i"] - patterns to skip
  telegramTopicIds: [],   // [106, 352] - bound Telegram topics
}
```

**Step 1.2: Add helper to parse regex strings**

```javascript
function parseRegexString(str) {
  const match = str.match(/^\/(.+)\/([gimsu]*)$/);
  if (match) {
    return new RegExp(match[1], match[2]);
  }
  return new RegExp(str, 'i');
}
```

**Step 1.3: Commit**

```bash
git add condo-management/store.js
git commit -m "feat(classification): add keywords/triggers to condo schema"
```

---

## Task 2: Create Classifier Module

**Files:**
- Create: `condo-management/classifier.js`

**Step 2.1: Create classifier.js with Tier 1 logic**

```javascript
// condo-management/classifier.js

const CONFIG = {
  tier1ConfidenceThreshold: 0.92,
  autoRouteThreshold: 0.85,
  softConfirmThreshold: 0.5,
};

/**
 * Parse regex strings from condo triggers/excludes
 */
function parseRegex(str) {
  const match = str.match(/^\/(.+)\/([gimsu]*)$/);
  if (match) return new RegExp(match[1], match[2]);
  return new RegExp(str, 'i');
}

/**
 * Tier 1: Fast pattern classification
 * Returns: { condo, confidence, reasoning, alternatives, needsTier2 }
 */
function tier1Classify(message, context, condos) {
  const result = {
    condo: null,
    confidence: 0,
    reasoning: null,
    alternatives: [],
    needsTier2: false,
  };

  // 1. Explicit @condo:name mention (highest priority)
  const explicit = message.match(/@condo:(\S+)/i);
  if (explicit) {
    const target = explicit[1].toLowerCase();
    const condo = condos.find(c => 
      c.id.toLowerCase().includes(target) || 
      c.name.toLowerCase().includes(target)
    );
    if (condo) {
      return {
        condo: condo.id,
        confidence: 1.0,
        reasoning: 'Explicit @condo mention',
        alternatives: [],
        needsTier2: false,
      };
    }
  }

  // 2. Telegram topic binding
  if (context.telegramTopicId) {
    const boundCondo = condos.find(c => 
      (c.telegramTopicIds || []).includes(context.telegramTopicId)
    );
    if (boundCondo) {
      return {
        condo: boundCondo.id,
        confidence: 0.95,
        reasoning: 'Telegram topic binding',
        alternatives: [],
        needsTier2: false,
      };
    }
    
    // Try fuzzy match topic name to condo name
    if (context.telegramTopicName) {
      const topicLower = context.telegramTopicName.toLowerCase();
      const matchedCondo = condos.find(c => 
        c.name.toLowerCase().includes(topicLower) ||
        topicLower.includes(c.name.toLowerCase())
      );
      if (matchedCondo) {
        return {
          condo: matchedCondo.id,
          confidence: 0.90,
          reasoning: `Topic name "${context.telegramTopicName}" matches condo`,
          alternatives: [],
          needsTier2: false,
        };
      }
    }
  }

  // 3. Keyword/trigger scoring
  const scores = new Map();
  const messageLower = message.toLowerCase();

  for (const condo of condos) {
    let score = 0;
    const reasons = [];

    // Keyword hits (+0.15 each, max 0.6)
    const keywords = condo.keywords || [];
    const keywordHits = keywords.filter(k => messageLower.includes(k.toLowerCase()));
    if (keywordHits.length > 0) {
      score += Math.min(keywordHits.length * 0.15, 0.6);
      reasons.push(`keywords: ${keywordHits.join(', ')}`);
    }

    // Trigger pattern hits (+0.3 each)
    const triggers = (condo.triggers || []).map(parseRegex);
    const triggerHits = triggers.filter(t => t.test(message));
    if (triggerHits.length > 0) {
      score += triggerHits.length * 0.3;
      reasons.push(`${triggerHits.length} trigger(s)`);
    }

    // Exclude pattern penalty (-0.5 each)
    const excludes = (condo.excludePatterns || []).map(parseRegex);
    const excludeHits = excludes.filter(e => e.test(message));
    score -= excludeHits.length * 0.5;

    // Recency boost (+0.1 if active in last 24h)
    if (condo.updatedAtMs && Date.now() - condo.updatedAtMs < 86400000) {
      score += 0.1;
      reasons.push('recent activity');
    }

    if (score > 0) {
      scores.set(condo.id, { 
        score: Math.min(score, 1.0), 
        reasoning: reasons.join(', ') 
      });
    }
  }

  // Sort by score descending
  const sorted = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score);

  if (sorted.length > 0) {
    const [topId, topData] = sorted[0];
    result.condo = topId;
    result.confidence = topData.score;
    result.reasoning = topData.reasoning;
    result.alternatives = sorted.slice(1, 4).map(([id, data]) => ({
      condo: id,
      confidence: data.score,
    }));
  }

  // Determine if Tier 2 is needed
  result.needsTier2 = result.confidence < CONFIG.tier1ConfidenceThreshold;

  return result;
}

/**
 * Check if message is a one-off that shouldn't be classified
 */
function isOneOffMessage(message) {
  const ONE_OFF_PATTERNS = [
    /^(what|when|where|who|how)\s+(is|are|was|were|time|day)/i,
    /^(hi|hello|hey|thanks|ok|sure|yes|no|yep|nope)\s*[.!?]*$/i,
    /^(remind|tell) me\b/i,
  ];
  if (message.length > 150) return false;
  return ONE_OFF_PATTERNS.some(p => p.test(message.trim()));
}

/**
 * Main classification entry point
 */
async function classifySession(message, context, condos, options = {}) {
  // Skip one-off messages
  if (isOneOffMessage(message)) {
    return { condo: null, confidence: 0, reasoning: 'One-off message', skip: true };
  }

  // Tier 1: Fast pattern matching
  const tier1Result = tier1Classify(message, context, condos);

  if (!tier1Result.needsTier2 || options.tier1Only) {
    return tier1Result;
  }

  // Tier 2: LLM classification (Phase 2)
  // For now, return Tier 1 result
  return tier1Result;
}

module.exports = {
  classifySession,
  tier1Classify,
  isOneOffMessage,
  CONFIG,
};
```

**Step 2.2: Commit**

```bash
git add condo-management/classifier.js
git commit -m "feat(classification): add Tier 1 classifier module"
```

---

## Task 3: Wire Classifier into before_agent_start Hook

**Files:**
- Modify: `condo-management/handlers.js`

**Step 3.1: Import classifier**

At top of `handlers.js`:

```javascript
const { classifySession, CONFIG } = require('./classifier');
```

**Step 3.2: Extend before_agent_start hook**

Find the `before_agent_start` hook registration and add classification logic:

```javascript
api.registerHook('before_agent_start', async (event) => {
  const sessionKey = event.context?.sessionKey;
  const message = event.context?.message;
  const data = store.load();

  // Skip if already bound to a condo or goal
  if (data.sessionCondoIndex?.[sessionKey] || data.sessionIndex?.[sessionKey]) {
    return existingCondoContextInjection(sessionKey, data);
  }

  // Skip if no message (shouldn't happen, but safety)
  if (!message) return null;

  // Build context for classifier
  const context = {
    telegramTopicId: event.context?.telegramTopicId,
    telegramTopicName: event.context?.telegramTopicName,
    sessionKey,
  };

  // Get active condos
  const condos = data.condos || [];

  // Classify
  const classification = await classifySession(message, context, condos, { tier1Only: true });

  // Skip if one-off or no match
  if (classification.skip || !classification.condo) {
    return null;
  }

  // Auto-route if confident enough
  if (classification.confidence >= CONFIG.autoRouteThreshold) {
    // Bind session to condo
    if (!data.sessionCondoIndex) data.sessionCondoIndex = {};
    data.sessionCondoIndex[sessionKey] = classification.condo;
    store.save(data);

    const condo = condos.find(c => c.id === classification.condo);
    const condoName = condo?.name || classification.condo;

    // Return context injection with small indicator
    return {
      prependContext: buildCondoContext(classification.condo, data),
      systemNote: `📁 Routed to ${condoName}`,
    };
  }

  // Medium confidence - would show buttons (Phase 2)
  // For now, skip
  return null;
});
```

**Step 3.3: Add buildCondoContext helper if missing**

```javascript
function buildCondoContext(condoId, data) {
  const condo = (data.condos || []).find(c => c.id === condoId);
  if (!condo) return '';

  const goals = (data.goals || [])
    .filter(g => g.condoId === condoId && g.status === 'active')
    .slice(0, 5);

  let context = `## Current Project: ${condo.name}\n`;
  context += `${condo.description || ''}\n\n`;

  if (goals.length > 0) {
    context += `### Active Goals\n`;
    for (const goal of goals) {
      context += `- ${goal.title}`;
      if (goal.nextTask) context += ` (Next: ${goal.nextTask})`;
      context += '\n';
    }
  }

  return context;
}
```

**Step 3.4: Commit**

```bash
git add condo-management/handlers.js
git commit -m "feat(classification): wire classifier into before_agent_start hook"
```

---

## Task 4: Auto-Seed Keywords from Existing Goals

**Files:**
- Create: `condo-management/scripts/seed-keywords.js`

**Step 4.1: Create seed script**

```javascript
#!/usr/bin/env node
// condo-management/scripts/seed-keywords.js

const fs = require('fs');
const path = require('path');

const STORE_PATH = process.env.CONDO_STORE_PATH || 
  path.join(process.env.HOME, 'clawd/data/condo-management.json');

function extractKeywords(text) {
  if (!text) return [];
  
  // Remove common words
  const stopwords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
    'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
    'we', 'us', 'our', 'you', 'your', 'i', 'me', 'my', 'he', 'she',
    'his', 'her', 'test', 'testing', 'new', 'add', 'create', 'update',
    'fix', 'implement', 'build', 'make', 'get', 'set',
  ]);

  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w));

  // Count frequency
  const freq = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }

  // Return top keywords
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

function seedKeywords() {
  const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  
  for (const condo of (data.condos || [])) {
    // Gather text from condo name, description, and goal titles
    const texts = [condo.name, condo.description];
    
    const condoGoals = (data.goals || []).filter(g => g.condoId === condo.id);
    for (const goal of condoGoals) {
      texts.push(goal.title);
      texts.push(goal.description);
    }
    
    const combinedText = texts.filter(Boolean).join(' ');
    const keywords = extractKeywords(combinedText);
    
    // Merge with existing keywords (don't overwrite manual ones)
    const existing = new Set(condo.keywords || []);
    for (const kw of keywords) {
      existing.add(kw);
    }
    condo.keywords = [...existing].slice(0, 15);
    
    console.log(`${condo.name}: ${condo.keywords.join(', ')}`);
  }
  
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
  console.log('\nKeywords seeded successfully.');
}

seedKeywords();
```

**Step 4.2: Make executable and commit**

```bash
chmod +x condo-management/scripts/seed-keywords.js
git add condo-management/scripts/seed-keywords.js
git commit -m "feat(classification): add keyword seeding script"
```

---

## Task 5: Add Telegram Topic Binding

**Files:**
- Modify: `condo-management/store.js` (add binding function)

**Step 5.1: Add topic binding helper**

```javascript
function bindTelegramTopic(condoId, topicId) {
  const data = load();
  const condo = (data.condos || []).find(c => c.id === condoId);
  if (!condo) return false;
  
  if (!condo.telegramTopicIds) condo.telegramTopicIds = [];
  if (!condo.telegramTopicIds.includes(topicId)) {
    condo.telegramTopicIds.push(topicId);
    save(data);
  }
  return true;
}

function getCondoForTopic(topicId) {
  const data = load();
  return (data.condos || []).find(c => 
    (c.telegramTopicIds || []).includes(topicId)
  );
}

// Export these
module.exports = {
  // ... existing exports
  bindTelegramTopic,
  getCondoForTopic,
};
```

**Step 5.2: Commit**

```bash
git add condo-management/store.js
git commit -m "feat(classification): add Telegram topic binding helpers"
```

---

## Task 6: Add RPC Method for Manual Keyword Tuning

**Files:**
- Modify: `condo-management/handlers.js`

**Step 6.1: Add RPC methods**

```javascript
api.registerMethod('goals.updateCondoKeywords', async ({ condoId, keywords, triggers, excludePatterns }) => {
  const data = store.load();
  const condo = (data.condos || []).find(c => c.id === condoId);
  if (!condo) throw new Error(`Condo not found: ${condoId}`);
  
  if (keywords !== undefined) condo.keywords = keywords;
  if (triggers !== undefined) condo.triggers = triggers;
  if (excludePatterns !== undefined) condo.excludePatterns = excludePatterns;
  
  store.save(data);
  return { ok: true, condo };
});

api.registerMethod('goals.bindTelegramTopic', async ({ condoId, topicId }) => {
  const result = store.bindTelegramTopic(condoId, topicId);
  if (!result) throw new Error(`Failed to bind topic ${topicId} to condo ${condoId}`);
  return { ok: true };
});
```

**Step 6.2: Commit**

```bash
git add condo-management/handlers.js
git commit -m "feat(classification): add RPC methods for keyword/topic management"
```

---

## Task 7: Test Classification Manually

**Step 7.1: Run keyword seeding**

```bash
cd ~/clawd/projects/clawcondos
node condo-management/scripts/seed-keywords.js
```

**Step 7.2: Restart ClawCondos service**

```bash
systemctl --user restart clawcondos
```

**Step 7.3: Test in Telegram**

1. Send message in "Subastas" topic → should auto-route
2. Send "@condo:investor-crm check pipeline" → should auto-route
3. Send message with keywords like "investor meeting" → should auto-route to investor-crm

**Step 7.4: Verify in ClawCondos UI**

Check that new sessions appear under correct condos in sidebar.

---

## Success Criteria (Phase 1)

- [ ] Sessions in bound Telegram topics auto-route to correct condo
- [ ] `@condo:name` syntax works for explicit routing
- [ ] Keyword matches work for common terms
- [ ] ClawCondos sidebar shows sessions under correct condos
- [ ] No regression in existing functionality

---

# Phase 2: LLM Classification (Future)

After Phase 1 is stable, add:

1. Gateway LLM proxy call for ambiguous messages
2. Confidence-based UI (buttons vs auto-accept)
3. 3s timeout with fallback

# Phase 3: Goal Auto-Creation (Future)

After Phase 2:

1. Task language detection heuristics
2. LLM subtask extraction
3. Goal suggestion UI with confirm/edit/skip

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `condo-management/store.js` | Modify | Add keyword fields + topic binding |
| `condo-management/classifier.js` | Create | Tier 1 classification logic |
| `condo-management/handlers.js` | Modify | Hook integration + RPC methods |
| `condo-management/scripts/seed-keywords.js` | Create | Bootstrap keywords from goals |

---

## Execution

**Plan complete and saved.**

**Ready to implement Phase 1?**

Options:
1. **Subagent-Driven** - I dispatch fresh subagent per task, review between tasks
2. **I implement directly** - Walk through tasks in this session
