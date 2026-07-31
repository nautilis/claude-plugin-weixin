/**
 * Inbound media: download, decrypt, land it in the inbox, keep the inbox bounded.
 *
 * Layout and meta conventions follow the official telegram channel plugin
 * (claude-plugins-official/telegram 0.0.6): media lives under STATE_DIR/inbox
 * and is referenced from notification meta, never from message content.
 */

import { randomBytes } from 'crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
import { INBOX_DIR } from './api.ts'
import { downloadAndDecrypt } from './cdn.ts'
import type { MediaRef } from './media.ts'

/** Matches the outbound cap; the whole payload is held in memory. */
export const MAX_INBOUND_BYTES = 20 * 1024 * 1024

export const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const SAFE_FILE_EXTS = new Set([
  '.pdf', '.txt', '.csv', '.md', '.json', '.zip', '.tar', '.gz',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
])

/** Trust the bytes, not the sender's claim about them. */
export function sniffImageExt(buf: Buffer): string {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii').startsWith('GIF8')) return '.gif'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF'
    && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  if (buf.length >= 2 && buf.subarray(0, 2).toString('ascii') === 'BM') return '.bmp'
  return '.bin'
}

export function safeExtFromName(name: string | undefined): string {
  const ext = extname(name ?? '').toLowerCase()
  return SAFE_FILE_EXTS.has(ext) ? ext : '.bin'
}

/** Sender-controlled text: strip anything that could forge meta or markup. */
export function safeDisplayName(name: string | undefined): string | undefined {
  if (!name) return undefined
  return name.replace(/[<>\[\]\r\n;/\\]/g, '_')
}

/** Delete inbox files older than maxAgeMs. Returns how many were removed. */
export function pruneInbox(maxAgeMs = INBOX_MAX_AGE_MS): number {
  let files: string[]
  try {
    files = readdirSync(INBOX_DIR)
  } catch {
    return 0
  }
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const f of files) {
    const p = join(INBOX_DIR, f)
    try {
      if (statSync(p).mtimeMs < cutoff) {
        rmSync(p, { force: true })
        removed++
      }
    } catch { /* raced with another prune; nothing to do */ }
  }
  return removed
}

export type SavedAttachment = {
  kind: 'image' | 'file'
  path: string
  name?: string
  size: number
}

function saveToInbox(buf: Buffer, ref: MediaRef): string {
  const ext = ref.kind === 'image' ? sniffImageExt(buf) : safeExtFromName(ref.name)
  // The filename is ours alone — ref.name never touches the filesystem path.
  const path = join(INBOX_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(path, buf, { mode: 0o600 })
  return path
}

/**
 * Download every ref that fits the cap. One failure never costs us the others,
 * and never costs the caller the message itself.
 */
export async function fetchInboundMedia(
  refs: MediaRef[],
): Promise<{ saved: SavedAttachment[]; errors: string[] }> {
  const saved: SavedAttachment[] = []
  const errors: string[] = []

  for (const ref of refs) {
    const label = `inbound ${ref.kind}`
    try {
      if (ref.declaredSize != null && ref.declaredSize > MAX_INBOUND_BYTES) {
        throw new Error(
          `too large (${ref.declaredSize} bytes, limit ${MAX_INBOUND_BYTES})`,
        )
      }
      const buf = await downloadAndDecrypt({
        encryptedParam: ref.encryptedParam,
        fullUrl: ref.fullUrl,
        aesKeyBase64: ref.aesKeyBase64,
        label,
      })
      if (buf.length > MAX_INBOUND_BYTES) {
        throw new Error(`too large (${buf.length} bytes, limit ${MAX_INBOUND_BYTES})`)
      }
      saved.push({
        kind: ref.kind,
        path: saveToInbox(buf, ref),
        name: safeDisplayName(ref.name),
        size: buf.length,
      })
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { saved, errors }
}
