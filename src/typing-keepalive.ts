/**
 * Telegram (and other channels) drop the "typing" chat-action ~5 seconds
 * after it's sent. To keep showing the indicator while the agent is doing
 * long work, we re-send it on a 4-second interval and stop the moment
 * the bot starts producing output or the run finishes.
 *
 * Usage:
 *   const stop = startTypingKeepalive(channel, chatJid, threadId);
 *   try {
 *     await agentRun(...);
 *   } finally {
 *     stop();
 *   }
 *
 * stop() is idempotent — safe to call multiple times. The interval fires
 * immediately on start so the user sees "typing…" without waiting up to 4s.
 */

import type { Channel } from './types.js';
import { logger } from './logger.js';

const REFRESH_MS = 4000;

export interface TypingKeepaliveHandle {
  /** Stop the keepalive. Idempotent. */
  stop: () => void;
}

export function startTypingKeepalive(
  channel: Channel | undefined,
  chatJid: string,
  threadId?: string,
): TypingKeepaliveHandle {
  if (!channel?.setTyping) {
    return { stop: () => {} };
  }

  let stopped = false;
  const ping = (): void => {
    if (stopped) return;
    // Fire-and-forget — channel.setTyping does its own error swallowing.
    channel.setTyping!(chatJid, true, { threadId }).catch((err) =>
      logger.debug(
        { chatJid, threadId, err: String(err) },
        'typing keepalive ping failed',
      ),
    );
  };

  ping();
  const handle = setInterval(ping, REFRESH_MS);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
    },
  };
}
