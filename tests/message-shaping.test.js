import { describe, it, expect, beforeEach } from 'vitest';
import './setup.js';

// Import attaches window.messageShaping
import '../lib/message-shaping.js';

describe('messageShaping.shapeMessageText', () => {
  beforeEach(() => {
    // Ensure module attached
    expect(window.messageShaping).toBeTruthy();
  });

  it('strips [[reply_to_current]] and returns replyTo.current', () => {
    const r = window.messageShaping.shapeMessageText('[[reply_to_current]] Hello');
    expect(r.replyTo).toEqual({ kind: 'current' });
    expect(r.text).toBe('Hello');
    expect(r.suppressed).toBe(false);
  });

  it('strips [[reply_to:<id>]] (with whitespace) and returns replyTo.id', () => {
    const r = window.messageShaping.shapeMessageText('[[ reply_to :  msg-123 ]]\nHi');
    expect(r.replyTo).toEqual({ kind: 'id', id: 'msg-123' });
    expect(r.text).toBe('Hi');
  });

  it('removes multiple reply tags, first one wins', () => {
    const r = window.messageShaping.shapeMessageText('[[reply_to:one]] [[reply_to:two]] test');
    expect(r.replyTo).toEqual({ kind: 'id', id: 'one' });
    expect(r.text).toBe('test');
  });

  it('suppresses NO_REPLY-only messages', () => {
    const r = window.messageShaping.shapeMessageText('NO_REPLY');
    expect(r.suppressed).toBe(true);
    expect(r.suppressedReason).toBe('NO_REPLY');
  });

  it('suppresses HEARTBEAT_OK-only messages (even if wrapped in reply tag)', () => {
    const r = window.messageShaping.shapeMessageText('[[reply_to_current]]\nHEARTBEAT_OK');
    expect(r.suppressed).toBe(true);
    expect(r.suppressedReason).toBe('HEARTBEAT_OK');
  });

  it('does not suppress when sentinel has additional text', () => {
    const r = window.messageShaping.shapeMessageText('NO_REPLY but also hello');
    expect(r.suppressed).toBe(false);
  });
});
