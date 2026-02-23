/**
 * Chat transcript indexing and search.
 * Indexes conversation messages fetched via gateway RPCs into a local SQLite DB.
 * Supports FTS5 (BM25) + sqlite-vec (vector similarity) hybrid search.
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const CHUNK_TARGET_CHARS = 1600;  // ~400 tokens
const CHUNK_OVERLAP_CHARS = 320;  // ~80 tokens
const DEFAULT_LIMIT = 20;
const CANDIDATE_MULTIPLIER = 4;
const PREVIEW_BATCH_SIZE = 64;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL UNIQUE,
  display_name TEXT,
  content_hash TEXT,
  indexed_at INTEGER NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  role TEXT,
  token_count INTEGER
);

CREATE TABLE IF NOT EXISTS embedding_cache (
  text_hash TEXT PRIMARY KEY,
  embedding BLOB,
  provider TEXT,
  created_at INTEGER
);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content);
`;

export function createChatIndex({ dbPath, embeddingProvider, logger }) {
  const log = logger || console;
  let db = null;
  let hasVec = false;
  let syncTimer = null;
  let syncing = false;

  function init() {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create FTS table first (before triggers reference it)
    db.exec(FTS_SQL);
    db.exec(SCHEMA_SQL);

    // Create vec table if possible
    try {
      sqliteVec.load(db);
      const dims = embeddingProvider?.getDimensions() || 1536;
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
          id INTEGER PRIMARY KEY,
          embedding FLOAT[${dims}]
        );
      `);
      hasVec = true;
    } catch (err) {
      log.error('[chat-index] sqlite-vec not available:', err.message);
    }

    log.log(`[chat-index] Initialized at ${dbPath} (vec=${hasVec})`);
  }

  function indexSession(key, messages, metadata = {}) {
    if (!db) throw new Error('Chat index not initialized');
    if (!messages || messages.length === 0) return;

    const contentHash = hashContent(messages);

    // Check if already indexed with same content
    const existing = db.prepare('SELECT id, content_hash FROM sessions WHERE session_key = ?').get(key);
    if (existing && existing.content_hash === contentHash) return;

    const insertOrUpdate = db.transaction(() => {
      let sessionId;
      if (existing) {
        // Delete old FTS entries, then old chunks
        const oldChunks = db.prepare('SELECT id, content FROM chunks WHERE session_id = ?').all(existing.id);
        const delFts = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
        for (const oc of oldChunks) delFts.run(oc.id);
        db.prepare('DELETE FROM chunks WHERE session_id = ?').run(existing.id);
        db.prepare('UPDATE sessions SET content_hash = ?, indexed_at = ?, display_name = ?, metadata = ? WHERE id = ?')
          .run(contentHash, Date.now(), metadata.displayName || null, JSON.stringify(metadata), existing.id);
        sessionId = existing.id;
      } else {
        const result = db.prepare('INSERT INTO sessions (session_key, display_name, content_hash, indexed_at, metadata) VALUES (?, ?, ?, ?, ?)')
          .run(key, metadata.displayName || null, contentHash, Date.now(), JSON.stringify(metadata));
        sessionId = result.lastInsertRowid;
      }

      // Chunk messages
      const chunks = chunkMessages(messages);

      const insertChunk = db.prepare('INSERT INTO chunks (session_id, chunk_index, content, role, token_count) VALUES (?, ?, ?, ?, ?)');
      const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)');

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const result = insertChunk.run(sessionId, i, chunk.content, chunk.role, chunk.tokenCount);
        insertFts.run(result.lastInsertRowid, chunk.content);
      }
    });

    insertOrUpdate();
  }

  async function indexSessionWithEmbeddings(key, messages, metadata = {}) {
    if (!db) throw new Error('Chat index not initialized');
    if (!messages || messages.length === 0) return;

    const contentHash = hashContent(messages);

    const existing = db.prepare('SELECT id, content_hash FROM sessions WHERE session_key = ?').get(key);
    if (existing && existing.content_hash === contentHash) return;

    const chunks = chunkMessages(messages);

    // Embed chunks if provider available
    if (hasVec && embeddingProvider?.isAvailable() && chunks.length > 0) {
      const textsToEmbed = [];
      const textsToEmbedIndices = [];

      for (let i = 0; i < chunks.length; i++) {
        const hash = crypto.createHash('sha256').update(chunks[i].content).digest('hex');
        const cached = db.prepare('SELECT embedding FROM embedding_cache WHERE text_hash = ?').get(hash);
        if (cached) {
          chunks[i]._cachedEmbedding = cached.embedding;
        } else {
          textsToEmbed.push(chunks[i].content);
          textsToEmbedIndices.push(i);
        }
      }

      if (textsToEmbed.length > 0) {
        try {
          const newEmbeddings = await embeddingProvider.embed(textsToEmbed);
          if (newEmbeddings && newEmbeddings.length === textsToEmbedIndices.length) {
            for (let j = 0; j < textsToEmbedIndices.length; j++) {
              const idx = textsToEmbedIndices[j];
              chunks[idx]._newEmbedding = newEmbeddings[j];
            }
          } else if (newEmbeddings) {
            log.warn('[chat-index] Embedding count mismatch:', newEmbeddings.length, 'vs', textsToEmbedIndices.length);
          }
        } catch (err) {
          log.error('[chat-index] Embedding failed:', err.message);
        }
      }
    }

    // Write to DB
    const insertOrUpdate = db.transaction(() => {
      let sessionId;
      if (existing) {
        // Delete old FTS + vec entries, then old chunks
        const oldChunks = db.prepare('SELECT id FROM chunks WHERE session_id = ?').all(existing.id);
        const delFts = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
        for (const oc of oldChunks) {
          delFts.run(oc.id);
          if (hasVec) { try { db.prepare('DELETE FROM chunks_vec WHERE id = ?').run(oc.id); } catch {} }
        }
        db.prepare('DELETE FROM chunks WHERE session_id = ?').run(existing.id);
        db.prepare('UPDATE sessions SET content_hash = ?, indexed_at = ?, display_name = ?, metadata = ? WHERE id = ?')
          .run(contentHash, Date.now(), metadata.displayName || null, JSON.stringify(metadata), existing.id);
        sessionId = existing.id;
      } else {
        const result = db.prepare('INSERT INTO sessions (session_key, display_name, content_hash, indexed_at, metadata) VALUES (?, ?, ?, ?, ?)')
          .run(key, metadata.displayName || null, contentHash, Date.now(), JSON.stringify(metadata));
        sessionId = result.lastInsertRowid;
      }

      const insertChunk = db.prepare('INSERT INTO chunks (session_id, chunk_index, content, role, token_count) VALUES (?, ?, ?, ?, ?)');
      const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)');
      const insertVec = hasVec ? db.prepare('INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)') : null;
      const insertCache = db.prepare('INSERT OR REPLACE INTO embedding_cache (text_hash, embedding, provider, created_at) VALUES (?, ?, ?, ?)');

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const result = insertChunk.run(sessionId, i, chunk.content, chunk.role, chunk.tokenCount);
        const chunkId = result.lastInsertRowid;
        insertFts.run(chunkId, chunk.content);

        if (insertVec) {
          let embeddingBuf = chunk._cachedEmbedding || null;
          if (!embeddingBuf && chunk._newEmbedding) {
            embeddingBuf = float32ArrayToBuffer(chunk._newEmbedding);
            const hash = crypto.createHash('sha256').update(chunk.content).digest('hex');
            insertCache.run(hash, embeddingBuf, embeddingProvider.getProviderName(), Date.now());
          }
          if (embeddingBuf) {
            try { insertVec.run(chunkId, embeddingBuf); } catch {}
          }
        }
      }
    });

    insertOrUpdate();
  }

  async function sync(gatewayClient) {
    if (!db || syncing) return;
    syncing = true;

    try {
      log.log('[chat-index] Starting sync...');

      // Fetch session list from gateway
      let sessions;
      try {
        const result = await gatewayClient.rpcCall('sessions.list', { limit: 500 });
        sessions = result?.sessions;
        if (!Array.isArray(sessions)) {
          log.warn('[chat-index] sessions.list returned unexpected shape');
          return;
        }
        if (sessions.length >= 500) {
          log.warn('[chat-index] Fetched 500 sessions (limit reached), some sessions may not be indexed');
        }
      } catch (err) {
        log.error('[chat-index] Failed to fetch sessions:', err.message);
        return;
      }

      // Fetch previews in batches
      let indexed = 0;
      for (let i = 0; i < sessions.length; i += PREVIEW_BATCH_SIZE) {
        const batch = sessions.slice(i, i + PREVIEW_BATCH_SIZE);
        const keys = batch.map(s => s.key);

        try {
          const previewResult = await gatewayClient.rpcCall('sessions.preview', {
            keys,
            limit: 5,
            maxChars: 2000,
          }, 30000);

          const previews = previewResult?.previews;
          if (!previews || typeof previews !== 'object') continue;

          for (const s of batch) {
            const messages = previews[s.key];
            if (!Array.isArray(messages) || messages.length === 0) continue;

            const metadata = {
              displayName: s.displayName || s.label || '',
              goalTitle: s.goalTitle || '',
              condoName: s.condoName || '',
              isSubagent: s.key.includes(':subagent:') || s.key.includes(':webchat:task-'),
            };

            try {
              await indexSessionWithEmbeddings(s.key, messages, metadata);
              indexed++;
            } catch (err) {
              log.error(`[chat-index] Failed to index ${s.key}:`, err.message);
            }
          }
        } catch (err) {
          log.error('[chat-index] Preview batch failed:', err.message);
        }
      }

      // Update last sync time
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_sync', String(Date.now()));

      log.log(`[chat-index] Sync complete: ${indexed} sessions indexed/updated`);
    } finally {
      syncing = false;
    }
  }

  function startBackgroundSync(gatewayClient, intervalMs) {
    if (syncTimer) return;
    const interval = intervalMs || 300000; // 5 minutes default

    syncTimer = setInterval(() => {
      sync(gatewayClient).catch(err => {
        log.error('[chat-index] Background sync failed:', err.message);
      });
    }, interval);

    log.log(`[chat-index] Background sync scheduled every ${interval / 1000}s`);
  }

  async function search(query, opts = {}) {
    if (!db) return [];

    const limit = opts.limit || DEFAULT_LIMIT;
    const candidateLimit = limit * CANDIDATE_MULTIPLIER;
    const scored = new Map(); // chunk.id -> { score, chunk, sessionKey }

    // FTS5 search
    try {
      const terms = query.trim().split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`);
      const ftsQuery = terms.join(' ');
      if (ftsQuery) {
        const ftsResults = db.prepare(`
          SELECT c.id, c.content, c.role, c.session_id, c.chunk_index,
                 s.session_key, s.display_name, s.metadata,
                 chunks_fts.rank AS fts_rank
          FROM chunks_fts
          JOIN chunks c ON c.id = chunks_fts.rowid
          JOIN sessions s ON s.id = c.session_id
          WHERE chunks_fts MATCH ?
          ORDER BY chunks_fts.rank
          LIMIT ?
        `).all(ftsQuery, candidateLimit);

        if (ftsResults.length > 0) {
          const minRank = Math.min(...ftsResults.map(r => r.fts_rank));
          const maxRank = Math.max(...ftsResults.map(r => r.fts_rank));
          const range = maxRank - minRank || 1;

          for (const r of ftsResults) {
            scored.set(r.id, {
              ftsScore: 1 - (r.fts_rank - minRank) / range,
              vecScore: 0,
              sessionKey: r.session_key,
              displayName: r.display_name,
              content: r.content,
              role: r.role,
              metadata: r.metadata,
            });
          }
        }
      }
    } catch (err) {
      log.error('[chat-index] FTS search failed:', err.message);
    }

    // Vector search
    if (hasVec && embeddingProvider?.isAvailable()) {
      try {
        const embeddings = await embeddingProvider.embed([query]);
        if (embeddings && embeddings.length > 0) {
          const buf = float32ArrayToBuffer(embeddings[0]);
          const vecResults = db.prepare(`
            SELECT id, distance FROM chunks_vec
            WHERE embedding MATCH ?
            ORDER BY distance
            LIMIT ?
          `).all(buf, candidateLimit);

          if (vecResults.length > 0) {
            const maxDist = Math.max(...vecResults.map(r => r.distance)) || 1;

            for (const r of vecResults) {
              const normalizedScore = 1 - r.distance / maxDist;
              const existing = scored.get(r.id);
              if (existing) {
                existing.vecScore = normalizedScore;
              } else {
                const chunk = db.prepare(`
                  SELECT c.id, c.content, c.role, s.session_key, s.display_name, s.metadata
                  FROM chunks c JOIN sessions s ON s.id = c.session_id
                  WHERE c.id = ?
                `).get(r.id);
                if (chunk) {
                  scored.set(r.id, {
                    ftsScore: 0,
                    vecScore: normalizedScore,
                    sessionKey: chunk.session_key,
                    displayName: chunk.display_name,
                    content: chunk.content,
                    role: chunk.role,
                    metadata: chunk.metadata,
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        log.error('[chat-index] Vector search failed:', err.message);
      }
    }

    // Merge scores
    const useVector = embeddingProvider?.isAvailable() && hasVec;
    const results = [];
    for (const [, entry] of scored) {
      const score = useVector
        ? 0.7 * entry.vecScore + 0.3 * entry.ftsScore
        : entry.ftsScore;

      let meta = {};
      try { meta = JSON.parse(entry.metadata || '{}'); } catch {}

      results.push({
        sessionKey: entry.sessionKey,
        displayName: entry.displayName || meta.displayName || '',
        snippet: truncateSnippet(entry.content, query, 300),
        role: entry.role,
        score,
        source: 'chat',
        metadata: meta,
      });
    }

    // Deduplicate by sessionKey (keep highest score per session)
    const bySession = new Map();
    for (const r of results) {
      const existing = bySession.get(r.sessionKey);
      if (!existing || r.score > existing.score) {
        bySession.set(r.sessionKey, r);
      }
    }

    const deduplicated = Array.from(bySession.values());
    deduplicated.sort((a, b) => b.score - a.score);
    return deduplicated.slice(0, limit);
  }

  function getStats() {
    if (!db) return { initialized: false };
    const sessionCount = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get()?.cnt || 0;
    const chunkCount = db.prepare('SELECT COUNT(*) as cnt FROM chunks').get()?.cnt || 0;
    const lastSync = db.prepare("SELECT value FROM meta WHERE key = 'last_sync'").get()?.value || null;
    return {
      initialized: true,
      sessionCount,
      chunkCount,
      hasVec,
      lastSync: lastSync ? parseInt(lastSync) : null,
      syncing,
    };
  }

  function close() {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    if (db) {
      try { db.close(); } catch {}
      db = null;
    }
  }

  return { init, indexSession, indexSessionWithEmbeddings, sync, startBackgroundSync, search, getStats, close };
}

// --- Helpers ---

function chunkMessages(messages) {
  const chunks = [];
  let currentContent = '';
  let currentRole = null;
  let currentTokens = 0;

  function pushChunk() {
    if (currentContent.trim()) {
      chunks.push({
        content: currentContent.trim(),
        role: currentRole,
        tokenCount: currentTokens,
      });
    }
    currentContent = '';
    currentTokens = 0;
  }

  for (const msg of messages) {
    const role = msg.role || 'unknown';
    const text = typeof msg.content === 'string' ? msg.content : (msg.text || '');
    if (!text.trim()) continue;

    const prefixed = `[${role}] ${text}`;
    const approxTokens = Math.ceil(prefixed.length / 4);

    if (currentContent.length + prefixed.length > CHUNK_TARGET_CHARS && currentContent.length > 0) {
      pushChunk();

      // Add overlap from previous chunk
      if (chunks.length > 0) {
        const prev = chunks[chunks.length - 1].content;
        if (prev.length > CHUNK_OVERLAP_CHARS) {
          currentContent = prev.slice(-CHUNK_OVERLAP_CHARS) + '\n';
          currentTokens = Math.ceil(CHUNK_OVERLAP_CHARS / 4);
        }
      }
    }

    currentContent += (currentContent ? '\n' : '') + prefixed;
    currentRole = role;
    currentTokens += approxTokens;
  }

  pushChunk();
  return chunks;
}

function hashContent(messages) {
  const h = crypto.createHash('sha256');
  for (const msg of messages) {
    const text = typeof msg.content === 'string' ? msg.content : (msg.text || '');
    h.update(msg.role || '');
    h.update(text);
  }
  return h.digest('hex');
}

function truncateSnippet(text, query, maxLen) {
  if (!text) return '';
  const lower = text.toLowerCase();
  const terms = (query || '').toLowerCase().split(/\s+/).filter(Boolean);

  let bestPos = 0;
  if (terms.length > 0) {
    const firstIdx = terms.reduce((best, term) => {
      const idx = lower.indexOf(term);
      return idx >= 0 && (best < 0 || idx < best) ? idx : best;
    }, -1);
    if (firstIdx > 0) bestPos = Math.max(0, firstIdx - 40);
  }

  let snippet = text.slice(bestPos, bestPos + maxLen);
  if (bestPos > 0) snippet = '...' + snippet;
  if (bestPos + maxLen < text.length) snippet += '...';
  return snippet.replace(/\n+/g, ' ').trim();
}

function float32ArrayToBuffer(arr) {
  const fa = new Float32Array(arr);
  return Buffer.from(fa.buffer);
}
