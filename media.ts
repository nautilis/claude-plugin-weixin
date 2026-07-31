/**
 * Attachment handling: MIME routing, message item assembly, safety checks.
 *
 * Item field layout ported from Tencent/openclaw-weixin v2.4.6 (MIT) —
 * src/messaging/send.ts, src/messaging/send-media.ts, src/media/mime.ts.
 */

import { statSync, realpathSync } from 'fs'
import { basename, extname, isAbsolute, sep } from 'path'
import {
  MessageItemType, UploadMediaType, STATE_DIR, INBOX_DIR, sendItem,
  type ApiOptions, type MessageItem,
} from './api.ts'
import { uploadMediaToCdn, type UploadedFileInfo } from './cdn.ts'

/** The whole file is read into memory and encrypted there. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function getMimeFromFilename(filename: string): string {
  return EXT_TO_MIME[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

export function isImageFile(filename: string): boolean {
  return getMimeFromFilename(filename).startsWith('image/')
}

function cdnMedia(u: UploadedFileInfo): object {
  return {
    encrypt_query_param: u.downloadEncryptedQueryParam,
    // Upstream quirk: base64 of the hex STRING, not of the raw key bytes.
    aes_key: Buffer.from(u.aeskey).toString('base64'),
    encrypt_type: 1,
  }
}

export function buildImageItem(u: UploadedFileInfo): MessageItem {
  return {
    type: MessageItemType.IMAGE,
    image_item: { media: cdnMedia(u), mid_size: u.fileSizeCiphertext },
  }
}

export function buildFileItem(u: UploadedFileInfo, fileName: string): MessageItem {
  return {
    type: MessageItemType.FILE,
    file_item: { media: cdnMedia(u), file_name: fileName, len: String(u.fileSize) },
  }
}

/**
 * Never let an attachment exfiltrate the channel's own credentials. The inbox
 * is deliberately exempt — it holds media the sender just sent us, and echoing
 * that back is a legitimate reply.
 */
function assertNotChannelState(filePath: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(filePath)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  if (real !== stateReal && !real.startsWith(stateReal + sep)) return

  let inboxReal: string
  try {
    inboxReal = realpathSync(INBOX_DIR)
  } catch {
    throw new Error(`refusing to send channel state: ${filePath}`)
  }
  if (real.startsWith(inboxReal + sep)) return
  throw new Error(`refusing to send channel state: ${filePath}`)
}

export function validateAttachment(filePath: string): void {
  if (!isAbsolute(filePath)) throw new Error(`file path must be absolute: ${filePath}`)
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(filePath)
  } catch {
    throw new Error(`file not found: ${filePath}`)
  }
  if (!st.isFile()) throw new Error(`not a regular file: ${filePath}`)
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`file too large (${st.size} bytes, limit ${MAX_FILE_BYTES}): ${filePath}`)
  }
  assertNotChannelState(filePath)
}

export function formatReplyResult(chunks: number, files: number, failed: string[]): string {
  const parts = [`sent ${chunks} chunk(s)`]
  if (files > 0) parts.push(`${files} file(s)`)
  let out = parts.join(', ')
  if (failed.length > 0) out += `; failed: ${failed.join('; ')}`
  return out
}

/** Upload one local file and send it as its own message. */
export async function sendMediaFile(
  opts: ApiOptions,
  p: { filePath: string; to: string; contextToken: string },
): Promise<void> {
  const image = isImageFile(p.filePath)
  const uploaded = await uploadMediaToCdn(opts, {
    filePath: p.filePath,
    toUserId: p.to,
    mediaType: image ? UploadMediaType.IMAGE : UploadMediaType.FILE,
  })
  const item = image ? buildImageItem(uploaded) : buildFileItem(uploaded, basename(p.filePath))
  await sendItem(opts, { to: p.to, item, contextToken: p.contextToken })
}

export type MediaRef = {
  kind: 'image' | 'file'
  encryptedParam?: string
  fullUrl?: string
  /** CDNMedia.aes_key encoding; see cdn.ts parseAesKey. */
  aesKeyBase64?: string
  /** Sender-declared byte count — images report ciphertext, files plaintext. */
  declaredSize?: number
  name?: string
}

/**
 * Pull downloadable media out of an inbound message. Pure — no I/O — so the
 * wire-format quirks stay testable.
 *
 * Ported from Tencent/openclaw-weixin src/media/media-download.ts.
 */
export function extractMediaRefs(msg: any): MediaRef[] {
  const refs: MediaRef[] = []
  for (const item of msg?.item_list ?? []) {
    // The item's own media first: image_path takes the first ref, and a freshly
    // attached photo is the subject even when the message also quotes one.
    collectMediaRef(refs, item)
    // A quote carries its own media — "这个怎么改" about a photo needs the bytes.
    collectMediaRef(refs, item?.ref_msg?.message_item)
  }
  return refs
}

function collectMediaRef(refs: MediaRef[], item: any): void {
  if (item?.type === MessageItemType.IMAGE) {
    const img = item.image_item
    const media = img?.media
    if (!media?.encrypt_query_param && !media?.full_url) return
    refs.push({
      kind: 'image',
      encryptedParam: media.encrypt_query_param,
      fullUrl: media.full_url,
      // image_item.aeskey is hex and takes precedence over media.aes_key.
      aesKeyBase64: img.aeskey
        ? Buffer.from(img.aeskey, 'hex').toString('base64')
        : media.aes_key,
      declaredSize: img.hd_size ?? img.mid_size,
    })
  } else if (item?.type === MessageItemType.FILE) {
    const f = item.file_item
    const media = f?.media
    if (!media?.encrypt_query_param && !media?.full_url) return
    refs.push({
      kind: 'file',
      encryptedParam: media.encrypt_query_param,
      fullUrl: media.full_url,
      aesKeyBase64: media.aes_key,
      declaredSize: f.len != null ? Number(f.len) : undefined,
      name: f.file_name,
    })
  }
}
