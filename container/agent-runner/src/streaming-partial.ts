/**
 * Token-level streaming helpers for the container-side agent runner.
 *
 * The Claude Agent SDK can emit `SDKPartialAssistantMessage` events while a
 * turn is still in progress when `includePartialMessages: true` is passed to
 * `query()`. Those messages carry standard Anthropic streaming events
 * (`BetaRawMessageStreamEvent`) — the ones we care about for visible text
 * are `content_block_delta` with `delta.type === 'text_delta'`.
 *
 * Anything else (input_json_delta on tool_use blocks, content_block_start,
 * message_start, message_delta, message_stop) is intentionally ignored so we
 * don't leak tool inputs or empty frames into the Telegram chat.
 */

/**
 * Shape of an SDK partial assistant message we care about. The narrow type
 * mirrors `SDKPartialAssistantMessage` from `@anthropic-ai/claude-agent-sdk`
 * without importing it — keeps the helper unit-testable without instantiating
 * the SDK.
 */
type PartialMessageShape = {
  type?: unknown;
  // Set to the spawning tool_use id when the partial comes from a subagent /
  // agent-team member; null for the main assistant. We only stream the main
  // assistant — see the guard in extractPartialTextChunk.
  parent_tool_use_id?: unknown;
  event?: {
    type?: unknown;
    delta?: {
      type?: unknown;
      text?: unknown;
    };
  } | null;
};

/**
 * Return the visible text fragment if `msg` is a `stream_event` carrying a
 * `content_block_delta` of `text_delta` with non-empty `delta.text`,
 * otherwise null.
 *
 * Returns null for:
 *   - non-stream_event messages (assistant / result / system / etc.)
 *   - subagent / agent-team partials (parent_tool_use_id != null) — these
 *     interleave token-by-token with the main assistant's stream and would
 *     garble the single Telegram message we render into; the main turn's
 *     final result still contains the relevant text
 *   - stream_events that are not `content_block_delta`
 *   - content_block_delta whose delta is not `text_delta`
 *     (e.g. `input_json_delta` carrying tool_use input fragments)
 *   - empty / missing `delta.text`
 *   - malformed payloads (undefined, null, missing fields)
 */
export function extractPartialTextChunk(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as PartialMessageShape;
  if (m.type !== 'stream_event') return null;
  // Drop subagent/team deltas — only the main assistant streams to the user.
  if (m.parent_tool_use_id != null) return null;
  const event = m.event;
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'content_block_delta') return null;
  const delta = event.delta;
  if (!delta || typeof delta !== 'object') return null;
  if (delta.type !== 'text_delta') return null;
  const text = delta.text;
  if (typeof text !== 'string' || text.length === 0) return null;
  return text;
}
