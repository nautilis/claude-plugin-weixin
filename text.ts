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

/**
 * The message this one quotes, rendered as a `[引用: ...]` line.
 * Empty when there is no quote or nothing in it worth showing.
 */
function renderQuote(ref: any): string {
  if (!ref) return ''
  const parts: string[] = []
  if (ref.title) parts.push(String(ref.title))
  const body = renderItem(ref.message_item)
  if (body) parts.push(body)
  return parts.length > 0 ? `[引用: ${parts.join(' | ')}]\n` : ''
}

export function extractText(msg: any): string {
  const parts: string[] = []
  for (const item of msg?.item_list ?? []) {
    const rendered = renderItem(item)
    if (rendered) parts.push(renderQuote(item?.ref_msg) + rendered)
  }
  return parts.join('\n') || '(empty message)'
}
