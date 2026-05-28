/**
 * Telegram forum topic title generation.
 *
 * Telegram clients (macOS at least) create topics with a placeholder name
 * ("New Chat") and do NOT rename them on the first message. To make the
 * thread list usable we generate a meaningful title from the user's first
 * message and call `editForumTopic` to apply it.
 *
 * Constraints:
 *   - Telegram hard limit: 128 chars for topic name.
 *   - Visual readable cap: ~64 chars (rest gets truncated in most clients).
 *   - Single-line: newlines and tabs collapse to a single space.
 *   - Strip the agent trigger prefix (`@Andy …`, `@bot_username …`) so the
 *     title is the actual subject, not the call sign.
 */

const TELEGRAM_TOPIC_NAME_HARD_LIMIT = 128;
const VISUAL_SOFT_LIMIT = 64;

/**
 * Turn a raw inbound message body into a topic title.
 *
 * - Strips a leading @-mention (trigger prefix).
 * - Collapses internal whitespace.
 * - Trims to a word boundary near VISUAL_SOFT_LIMIT when the message is long,
 *   appends "…". Falls back to a hard cut at SOFT_LIMIT when there is no
 *   useable word boundary in the last 40% of the slice.
 * - Hard-caps at 128 chars regardless (Telegram rejects longer names).
 *
 * Returns null when the cleaned text is empty — caller should not attempt
 * to rename in that case (e.g. voice with empty transcript, sticker-only
 * message).
 */
export function generateTopicTitle(content: string): string | null {
  if (!content) return null;

  // Strip leading @-mention. Matches `@Foo`, `@foo_bot`, etc. Single token only.
  let text = content.replace(/^@[A-Za-z0-9_]+\s+/, '');

  // Collapse all whitespace (including newlines) to single spaces, trim.
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;

  if (text.length <= VISUAL_SOFT_LIMIT) {
    return text.slice(0, TELEGRAM_TOPIC_NAME_HARD_LIMIT);
  }

  // Try to cut at a word boundary in the back half of the slice.
  const slice = text.slice(0, VISUAL_SOFT_LIMIT);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace >= VISUAL_SOFT_LIMIT * 0.6) {
    return (slice.slice(0, lastSpace) + '…').slice(
      0,
      TELEGRAM_TOPIC_NAME_HARD_LIMIT,
    );
  }
  // No reasonable boundary — hard cut + ellipsis.
  return (slice + '…').slice(0, TELEGRAM_TOPIC_NAME_HARD_LIMIT);
}
