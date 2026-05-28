/**
 * LLM-based Telegram forum topic titler.
 *
 * Generates a meaningful topic name from the user's first message by asking
 * Claude Haiku for a short summary. Falls back to string-trim
 * (`generateTopicTitle`) when the API call fails — never blocks delivery.
 *
 * Why a separate API call (not piggy-back on the agent run)?
 *   - The agent run is long (10-60s with tool use); we need the title BEFORE
 *     the topic looks like garbage in Telegram's thread list.
 *   - Decoupling lets the titler use a small/cheap model (Haiku) while the
 *     agent uses whatever the user configured (often Sonnet/Opus).
 *   - A failure in the titler must NOT taint the agent's session.
 *
 * Privacy: the message content goes to Anthropic. This is no worse than the
 * agent run itself which sends the same content anyway. Logs never contain
 * the content — only success/failure status and model name.
 */

import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { generateTopicTitle } from './topic-naming.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.TITLER_MODEL || 'claude-haiku-4-5';
const TIMEOUT_MS = 8000;
const SYSTEM_PROMPT = [
  'You generate Telegram forum topic titles from a user message.',
  'Output ONLY the title — no quotes, no markdown, no trailing punctuation.',
  '3 to 7 words. Match the message language (Russian, English, etc).',
  'Be specific and concrete — capture what the message is about, not its tone.',
  'For questions: use a noun phrase, not a question. For tasks: imperative noun phrase.',
  'Strip any leading @-mention trigger from the input before titling.',
].join(' ');

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
}

/**
 * Read Anthropic credentials the same way credential-proxy does: prefer
 * x-api-key when ANTHROPIC_API_KEY is set, otherwise OAuth Bearer token.
 * Returns null when no usable credential is present.
 */
function readAnthropicAuthHeader(): Record<string, string> | null {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  if (secrets.ANTHROPIC_API_KEY) {
    return { 'x-api-key': secrets.ANTHROPIC_API_KEY };
  }
  const oauth = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  if (oauth) {
    return { authorization: `Bearer ${oauth}` };
  }
  return null;
}

/**
 * Strip whitespace, surrounding quotes, trailing punctuation from the
 * model's raw output. Conservative — preserves emoji and Cyrillic.
 */
function cleanModelTitle(raw: string): string {
  let t = raw.trim();
  // Strip wrapping quotes (single, double, fancy)
  t = t.replace(/^['"«»"'`]+/, '').replace(/['"«»"'`]+$/, '');
  // Strip trailing punctuation (.,;!? but NOT — or … which can be intentional)
  t = t.replace(/[.,;!?]+$/, '');
  // Collapse internal whitespace
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Generate a topic title for `content` via the Anthropic Messages API.
 * Returns null when the result is unusable (API failure, empty output,
 * or no credential available). Caller should use `generateTopicTitle`
 * as fallback.
 */
export async function titleFromMessage(
  content: string,
): Promise<string | null> {
  if (!content || content.trim().length === 0) return null;
  const authHeader = readAnthropicAuthHeader();
  if (!authHeader) {
    logger.debug('topic-titler: no Anthropic credential, skipping LLM call');
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        ...authHeader,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 48,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      logger.warn(
        { status: res.status, body: body.slice(0, 200), model: MODEL },
        'topic-titler: Anthropic API non-ok',
      );
      return null;
    }

    const json = (await res.json()) as AnthropicMessagesResponse;
    if (json.error) {
      logger.warn(
        { error: json.error.message, model: MODEL },
        'topic-titler: Anthropic API error',
      );
      return null;
    }

    const textBlock = json.content?.find((b) => b.type === 'text');
    const raw = textBlock?.text;
    if (!raw) {
      logger.warn(
        { model: MODEL },
        'topic-titler: Anthropic response had no text content',
      );
      return null;
    }

    const cleaned = cleanModelTitle(raw);
    if (!cleaned) return null;

    // Reuse the string-trim helper to enforce length caps (64 visual /
    // 128 hard). Haiku rarely overshoots 7 words but we still cap for safety.
    return generateTopicTitle(cleaned);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn({ model: MODEL }, 'topic-titler: Anthropic call timed out');
    } else {
      logger.warn(
        { err: String(err), model: MODEL },
        'topic-titler: Anthropic call failed',
      );
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
