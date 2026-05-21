import { Channel, NewMessage, SendMessageOptions } from './types.js';
import { formatLocalTime } from './timezone.js';
import { storeOutboundMessage } from './db.js';
import { logger } from './logger.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export async function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  opts?: SendMessageOptions,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  // SEND first — any throw here means the user didn't receive the message; propagate
  // so the caller's streamingSendFailed/cursor-rollback machinery does the right thing.
  const result = await channel.sendMessage(jid, text, opts);
  // STORE in an isolated try — the user already saw the message; a DB error here must
  // NOT propagate, otherwise the caller will roll back the cursor and re-deliver the
  // same agent output on the next poll (user sees duplicates).
  try {
    const messageId =
      result && typeof result === 'object' && 'messageId' in result
        ? (result.messageId ?? undefined)
        : undefined;
    const senderId = channel.botSenderId?.();
    storeOutboundMessage(jid, text, messageId, senderId);
  } catch (err) {
    logger.error(
      { jid, err },
      'storeOutboundMessage failed (message was delivered)',
    );
  }
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
