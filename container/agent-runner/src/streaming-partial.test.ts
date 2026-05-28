/**
 * Pure helper tests for token-level streaming on the container side.
 *
 * `extractPartialTextChunk` is the runQuery loop's branch predicate:
 * given an SDK message, return the text fragment if it is a
 * `stream_event` carrying a `content_block_delta` of `text_delta`,
 * otherwise null. Centralising the shape check in a pure function lets
 * the runQuery loop stay small and lets us lock the behaviour with
 * unit tests instead of spinning up a real query().
 */
import { describe, expect, it } from 'vitest';

import { extractPartialTextChunk } from './streaming-partial.js';

describe('extractPartialTextChunk', () => {
  it('returns the text fragment for a content_block_delta text_delta', () => {
    const msg = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      },
    };
    expect(extractPartialTextChunk(msg)).toBe('hello');
  });

  it('returns null for a content_block_delta of non-text (e.g. input_json_delta)', () => {
    // Tool-use blocks emit input_json_delta as their input streams in. We
    // explicitly DO NOT want to forward those as visible Telegram text.
    const msg = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
      },
    };
    expect(extractPartialTextChunk(msg)).toBeNull();
  });

  it('returns null for content_block_start / content_block_stop events', () => {
    const start = {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    };
    const stop = {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    };
    expect(extractPartialTextChunk(start)).toBeNull();
    expect(extractPartialTextChunk(stop)).toBeNull();
  });

  it('returns null for message_start / message_delta / message_stop events', () => {
    expect(
      extractPartialTextChunk({
        type: 'stream_event',
        event: { type: 'message_start' },
      }),
    ).toBeNull();
    expect(
      extractPartialTextChunk({
        type: 'stream_event',
        event: { type: 'message_delta' },
      }),
    ).toBeNull();
    expect(
      extractPartialTextChunk({
        type: 'stream_event',
        event: { type: 'message_stop' },
      }),
    ).toBeNull();
  });

  it('returns null for non-stream_event messages (assistant / result / system)', () => {
    expect(extractPartialTextChunk({ type: 'assistant' })).toBeNull();
    expect(extractPartialTextChunk({ type: 'result', result: 'x' })).toBeNull();
    expect(
      extractPartialTextChunk({ type: 'system', subtype: 'init' }),
    ).toBeNull();
  });

  it('returns null when text_delta is missing or empty (no marker for empty)', () => {
    // Empty-string deltas are no-ops; let the host-side parser skip them
    // rather than emit a marker carrying ''.
    expect(
      extractPartialTextChunk({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '' },
        },
      }),
    ).toBeNull();
    expect(
      extractPartialTextChunk({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta' },
        },
      }),
    ).toBeNull();
  });

  it('tolerates malformed / undefined payloads without throwing', () => {
    expect(extractPartialTextChunk(undefined)).toBeNull();
    expect(extractPartialTextChunk(null)).toBeNull();
    expect(extractPartialTextChunk({})).toBeNull();
    expect(extractPartialTextChunk({ type: 'stream_event' })).toBeNull();
    expect(
      extractPartialTextChunk({ type: 'stream_event', event: null }),
    ).toBeNull();
    expect(
      extractPartialTextChunk({
        type: 'stream_event',
        event: { type: 'content_block_delta' },
      }),
    ).toBeNull();
  });

  // Bug-C regression: subagent / agent-team token deltas surface in the parent
  // query stream with parent_tool_use_id set. They must NOT be forwarded —
  // they would interleave token-by-token with the main assistant and garble
  // the single Telegram message we render into.
  it('returns null for subagent partials (parent_tool_use_id set)', () => {
    const subagentDelta = {
      type: 'stream_event',
      parent_tool_use_id: 'toolu_abc123',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'subagent thinking out loud' },
      },
    };
    expect(extractPartialTextChunk(subagentDelta)).toBeNull();
  });

  it('still returns text when parent_tool_use_id is explicitly null (main assistant)', () => {
    const mainDelta = {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'main reply' },
      },
    };
    expect(extractPartialTextChunk(mainDelta)).toBe('main reply');
  });
});
