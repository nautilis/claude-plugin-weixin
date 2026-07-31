/**
 * Turning an inbound message's item_list into the text body Claude sees.
 *
 * Non-text items become placeholders — the bytes reach Claude through the
 * inbox (see inbox.ts), the body only says what kind of thing arrived.
 */

import { MessageItemType } from './api.ts'

/** One item rendered for the body. Returns '' for items with nothing to show. */
function renderItem(item: any): string {
  switch (item?.type) {
    case MessageItemType.TEXT:
      return item.text_item?.text ?? ''
    case MessageItemType.IMAGE:
      return '(image)'
    case MessageItemType.VOICE:
      // The server fills in a transcript; the audio itself is not fetched.
      return item.voice_item?.text ?? '(voice)'
    case MessageItemType.FILE:
      return `(file: ${item.file_item?.file_name ?? 'unknown'})`
    case MessageItemType.VIDEO:
      return '(video)'
    default:
      return ''
  }
}

/** Looks a quoted message up by id — see ledger.ts. */
export type ResolveQuote = (msgId: string) => string | undefined

/**
 * The message this one quotes, rendered as a `[引用: ...]` line.
 *
 * The server sends `type: 0` with nothing but a msg_id, so the content
 * normally comes from the ledger. Inline content is still preferred — it
 * costs nothing to honour and would win if the server ever fills it in.
 */
function renderQuote(ref: any, resolve?: ResolveQuote): string {
  if (!ref) return ''
  const parts: string[] = []
  if (ref.title) parts.push(String(ref.title))

  const inline = renderItem(ref.message_item)
  const msgId = ref.message_item?.msg_id
  if (inline) parts.push(inline)
  else if (msgId) parts.push(resolve?.(String(msgId)) ?? '一条更早的消息（无法还原）')

  return parts.length > 0 ? `[引用: ${parts.join(' | ')}]\n` : ''
}

export function extractText(msg: any, resolve?: ResolveQuote): string {
  const parts: string[] = []
  for (const item of msg?.item_list ?? []) {
    const rendered = renderItem(item)
    if (rendered) parts.push(renderQuote(item?.ref_msg, resolve) + rendered)
  }
  return parts.join('\n') || '(empty message)'
}
