// Shared message shaping/normalization for ClawCondos
//
// OpenClaw reserves a few inline tags/tokens in assistant text:
// - [[reply_to_current]]
// - [[reply_to:<id>]] (whitespace allowed)
// - NO_REPLY (silent)
// - HEARTBEAT_OK (heartbeat ack)
//
// This module extracts reply metadata, strips reply tags from the displayed text,
// and marks sentinel-only messages as suppressed so the UI can hide them.

(function attachMessageShaping(global) {
  const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;
  const SENTINELS = new Set(["NO_REPLY", "HEARTBEAT_OK"]);

  /**
   * @typedef {{ kind: 'current' } | { kind: 'id', id: string }} ReplyTo
   */

  /**
   * @typedef {{
   *   text: string,
   *   replyTo: ReplyTo|null,
   *   suppressed: boolean,
   *   suppressedReason: null | 'NO_REPLY' | 'HEARTBEAT_OK'
   * }} ShapedMessage
   */

  /**
   * Shape a message's raw text for rendering.
   * - Extracts reply tag (first occurrence wins)
   * - Removes all reply tags from displayed text
   * - Suppresses sentinel-only payloads (NO_REPLY, HEARTBEAT_OK)
   *
   * @param {string} rawText
   * @returns {ShapedMessage}
   */
  function shapeMessageText(rawText) {
    const input = String(rawText ?? "");

    /** @type {ReplyTo|null} */
    let replyTo = null;

    // Extract + strip reply tags
    const stripped = input.replace(REPLY_TAG_RE, (_m, id) => {
      if (!replyTo) {
        if (id && String(id).trim()) replyTo = { kind: 'id', id: String(id).trim() };
        else replyTo = { kind: 'current' };
      }
      return "";
    });

    // Normalize whitespace after tag removal
    const text = stripped.replace(/\r\n/g, "\n").trim();

    const upper = text.trim();
    const suppressed = SENTINELS.has(upper) && upper.length === text.length;

    return {
      text,
      replyTo,
      suppressed,
      suppressedReason: suppressed ? /** @type any */ (upper) : null,
    };
  }

  global.messageShaping = {
    shapeMessageText,
    REPLY_TAG_RE,
    SENTINELS,
  };
})(window);
