// classifier.js — Tier 1 pattern-based session classifier

export const CLASSIFIER_CONFIG = {
  autoRouteThreshold: 0.8,
  ambiguityGap: 0.15,          // Top must beat runner-up by this much
  keywordWeight: 0.15,          // Per keyword hit
  keywordMax: 0.45,             // Max from keywords
  nameMatchWeight: 0.3,         // Condo name in message
  enabled: (process.env.HELIX_CLASSIFICATION) !== 'off',
};

/**
 * Extract the last user message text from event.messages
 */
export function extractLastUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content.find(c => c.type === 'text');
      if (text?.text) return text.text;
    }
  }
  return null;
}

/**
 * Parse Telegram context from session key.
 * Session keys look like: agent:main:telegram:group:-100xxx:topic:2212
 */
export function parseTelegramContext(sessionKey) {
  if (!sessionKey?.includes(':telegram:')) return null;
  const topicMatch = sessionKey.match(/:topic:(\d+)/);
  const groupMatch = sessionKey.match(/:group:([-\d]+)/);
  return {
    isTelegram: true,
    topicId: topicMatch ? parseInt(topicMatch[1], 10) : null,
    groupId: groupMatch ? groupMatch[1] : null,
  };
}

/**
 * Check if message is too short/generic to classify.
 */
export function isSkippableMessage(message) {
  if (!message || typeof message !== 'string') return false;
  const trimmed = message.trim();
  if (!trimmed) return false;

  // Pure emoji
  if (/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]+$/u.test(trimmed)) return true;

  // Short greetings/acks (standalone words, not part of a longer message)
  if (trimmed.length <= 20) {
    const GREETINGS = /^(hi|hello|hey|yo|thanks|thank you|thx|ok|okay|sure|yes|no|yep|nope|cool|nice|great|lol|haha|bye|gm|gn)\s*[.!?]*$/i;
    if (GREETINGS.test(trimmed)) return true;
  }

  return false;
}

/**
 * Tier 1: Fast pattern classification.
 * Returns { condoId, confidence, reasoning, alternatives, tier }
 */
export function tier1Classify(message, context, condos) {
  const result = { condoId: null, confidence: 0, reasoning: null, alternatives: [], tier: 1 };

  if (!message || !condos?.length) return result;

  // 1. Explicit @condo:name mention (highest priority)
  const explicit = message.match(/@condo:(\S+)/i);
  if (explicit) {
    const target = explicit[1].toLowerCase();
    const match = condos.find(c => {
      const id = c.id.toLowerCase();
      const name = c.name.toLowerCase().replace(/\s+/g, '-');
      // Exact match on id suffix (e.g. @condo:investor-crm matches condo:investor-crm)
      // or exact match on name slug
      return id === target || id.endsWith(':' + target) || name === target;
    });
    if (match) {
      return { condoId: match.id, confidence: 1.0, reasoning: 'explicit @condo mention', alternatives: [], tier: 1 };
    }
  }

  // 2. Telegram topic binding
  if (context.topicId != null) {
    const match = condos.find(c =>
      Array.isArray(c.telegramTopicIds) && c.telegramTopicIds.includes(context.topicId)
    );
    if (match) {
      return { condoId: match.id, confidence: 0.95, reasoning: `topic:${context.topicId}`, alternatives: [], tier: 1 };
    }
  }

  // 3. Keyword scoring
  const messageLower = message.toLowerCase();
  const scores = [];

  for (const condo of condos) {
    let score = 0;
    const reasons = [];

    // Keyword hits
    const keywords = (condo.keywords || []).filter(k => k && k.length > 0);
    const hits = keywords.filter(k => messageLower.includes(k.toLowerCase()));
    if (hits.length > 0) {
      const kwScore = Math.min(hits.length * CLASSIFIER_CONFIG.keywordWeight, CLASSIFIER_CONFIG.keywordMax);
      score += kwScore;
      reasons.push(`kw:${hits.slice(0, 3).join(',')}`);
    }

    // Condo name in message
    if (condo.name && messageLower.includes(condo.name.toLowerCase())) {
      score += CLASSIFIER_CONFIG.nameMatchWeight;
      reasons.push('name');
    }

    if (score > 0) {
      scores.push({ condoId: condo.id, score: Math.min(score, 1.0), reasoning: reasons.join(' + ') });
    }
  }

  if (scores.length === 0) return result;

  // Sort descending
  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const runnerUp = scores[1];

  // Enforce ambiguity gap: if runner-up is too close, reduce confidence
  let confidence = top.score;
  if (runnerUp && (top.score - runnerUp.score) < CLASSIFIER_CONFIG.ambiguityGap) {
    confidence = Math.min(confidence, CLASSIFIER_CONFIG.autoRouteThreshold - 0.01);
  }

  return {
    condoId: top.condoId,
    confidence,
    reasoning: top.reasoning,
    alternatives: scores.slice(1, 4).map(s => ({ condoId: s.condoId, confidence: s.score })),
    tier: 1,
  };
}

const GOAL_THRESHOLD = 0.5;
const GOAL_MIN_LENGTH = 50;

/**
 * Detect if a message looks like a goal/task request.
 * Conservative: only triggers for substantial, structured messages.
 */
export function detectGoalIntent(message) {
  if (!message || typeof message !== 'string' || message.length < GOAL_MIN_LENGTH) {
    return { isGoal: false, score: 0 };
  }

  let score = 0;

  // Bullet points or numbered lists (strong signal)
  const bulletMatches = message.match(/^[-*]\s+\w/gm);
  if (bulletMatches) {
    score += 0.3;
    if (bulletMatches.length >= 3) score += 0.2; // Multiple items = structured goal
  }
  const numberMatches = message.match(/^\d+\.\s+\w/gm);
  if (numberMatches) {
    score += 0.3;
    if (numberMatches.length >= 3) score += 0.2;
  }

  // Sequential language (first, then, after, finally)
  const seqMatches = message.match(/\b(first|then|after that|finally|next|step)\b/gi);
  if (seqMatches) {
    score += 0.2;
    if (seqMatches.length >= 3) score += 0.2; // Multiple sequential words = structured plan
  }

  // Urgency/deadline language
  if (/\b(by|before|deadline|urgent|asap|priority|blocking)\b/i.test(message)) score += 0.15;

  // Length bonus (longer = more likely a goal description)
  if (message.length > 100) score += 0.1;
  if (message.length > 200) score += 0.1;

  return {
    isGoal: score >= GOAL_THRESHOLD,
    score: Math.min(score, 1.0),
  };
}
