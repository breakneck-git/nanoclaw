import type { Message } from 'grammy/types';

export function escapeXmlAttr(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;') // MUST be first to avoid double-escape
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function escapeXmlText(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the structured <m>...</m> XML block from a Telegram Message.
 * Returns the raw block (no enclosing root). Caller stores in messages.meta column.
 *
 * Task 8a scope: minimal skeleton — <m id date media_group_id edited>, <from> vs
 * <sender_chat> mutex. Full Bot API 7.0+ tag coverage lands in Tasks 8b-1/2/3.
 */
export function buildMetaBlock(message: Message): string {
  const parts: string[] = [];
  const mAttrs: string[] = [`id="${message.message_id}"`];
  mAttrs.push(`date="${new Date(message.date * 1000).toISOString()}"`);
  if ('media_group_id' in message && message.media_group_id) {
    mAttrs.push(`media_group_id="${escapeXmlAttr(message.media_group_id)}"`);
  }
  if ('edit_date' in message && message.edit_date) {
    mAttrs.push(`edited="${new Date(message.edit_date * 1000).toISOString()}"`);
  }
  parts.push(`<m ${mAttrs.join(' ')}>`);

  // <from> vs <sender_chat> mutex per spec line 193-194
  if ('sender_chat' in message && message.sender_chat) {
    const sc = message.sender_chat;
    const scAttrs = [`id="${sc.id}"`, `kind="${sc.type}"`];
    if ('title' in sc && sc.title)
      scAttrs.push(`title="${escapeXmlAttr(sc.title)}"`);
    if ('username' in sc && sc.username)
      scAttrs.push(`un="${escapeXmlAttr(sc.username)}"`);
    parts.push(`<sender_chat ${scAttrs.join(' ')}/>`);
  } else if (message.from) {
    const f = message.from;
    const fAttrs = [`id="${f.id}"`, `is_bot="${f.is_bot ? 1 : 0}"`];
    if (f.username) fAttrs.push(`un="${escapeXmlAttr(f.username)}"`);
    if (f.first_name)
      fAttrs.push(
        `name="${escapeXmlAttr(f.first_name)}${f.last_name ? ' ' + escapeXmlAttr(f.last_name) : ''}"`,
      );
    if (f.is_premium) fAttrs.push(`premium="1"`);
    if (f.language_code)
      fAttrs.push(`lang="${escapeXmlAttr(f.language_code)}"`);
    parts.push(`<from ${fAttrs.join(' ')}/>`);
  }

  parts.push(`</m>`);
  return parts.join('');
}
