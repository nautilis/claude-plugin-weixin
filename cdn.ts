/**
 * Weixin CDN upload pipeline: AES-128-ECB encrypt, POST to CDN, hand the
 * download param back for the outgoing message item.
 *
 * Ported from Tencent/openclaw-weixin v2.4.6 (MIT) —
 * src/cdn/aes-ecb.ts, src/cdn/cdn-url.ts, src/cdn/cdn-upload.ts, src/cdn/upload.ts.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { readFile } from 'fs/promises'
import { getUploadUrl, type ApiOptions } from './api.ts'

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

const UPLOAD_MAX_RETRIES = 3

/** Encrypt with AES-128-ECB (PKCS7 padding is the default). */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** Decrypt with AES-128-ECB (PKCS7 padding). */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl = CDN_BASE_URL): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

/**
 * CDNMedia.aes_key arrives in two encodings — the wire format is ambiguous, so
 * the decoded length is what tells them apart:
 *   base64(raw 16 bytes)           → images
 *   base64(32-char hex string)     → file / voice / video
 *
 * Ported from Tencent/openclaw-weixin src/cdn/pic-decrypt.ts.
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(
    `aes_key must decode to 16 raw bytes or a 32-char hex string, got ${decoded.length} bytes`,
  )
}

/**
 * Download one CDN object and decrypt it. Without a key the bytes are returned
 * as-is — the CDN serves some media unencrypted.
 */
export async function downloadAndDecrypt(p: {
  encryptedParam?: string
  fullUrl?: string
  aesKeyBase64?: string
  label: string
}): Promise<Buffer> {
  const url = p.fullUrl?.trim() || buildCdnDownloadUrl(p.encryptedParam ?? '')
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(
      `${p.label}: CDN download ${res.status} ${res.statusText} url=${redactUrl(url)}`,
    )
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!p.aesKeyBase64) return bytes
  return decryptAesEcb(bytes, parseAesKey(p.aesKeyBase64))
}

/** Ciphertext size for AES-128-ECB with PKCS7 padding. */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

export function buildCdnUploadUrl(p: {
  cdnBaseUrl: string
  uploadParam: string
  filekey: string
}): string {
  return `${p.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(p.uploadParam)}` +
    `&filekey=${encodeURIComponent(p.filekey)}`
}

/** CDN URLs carry auth in the query string — never log them raw. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}?<redacted>`
  } catch {
    return '<invalid-url>'
  }
}

/**
 * The CDN reports failures through headers, often with an empty body — notably
 * x-error-code -5102031, which it returns when a media_type=IMAGE upload does
 * not decode as an image. Keep every signal it gives us.
 */
async function describeCdnError(res: Response): Promise<string> {
  const parts: string[] = []
  const code = res.headers.get('x-error-code')
  const msg = res.headers.get('x-error-message')
  if (code) parts.push(`x-error-code=${code}`)
  if (msg) parts.push(msg)
  if (parts.length === 0) {
    const body = (await res.text()).trim()
    parts.push(body ? body.slice(0, 200) : '(no error detail)')
  }
  return parts.join(' ')
}

/**
 * Upload one buffer to the Weixin CDN, encrypted. Retries server errors up to
 * UPLOAD_MAX_RETRIES; client errors (4xx) abort immediately.
 */
export async function uploadBufferToCdn(p: {
  buf: Buffer
  uploadFullUrl?: string
  uploadParam?: string
  filekey: string
  aeskey: Buffer
  label: string
}): Promise<{ downloadParam: string }> {
  const ciphertext = encryptAesEcb(p.buf, p.aeskey)
  const full = p.uploadFullUrl?.trim()
  let cdnUrl: string
  if (full) {
    cdnUrl = full
  } else if (p.uploadParam) {
    cdnUrl = buildCdnUploadUrl({
      cdnBaseUrl: CDN_BASE_URL,
      uploadParam: p.uploadParam,
      filekey: p.filekey,
    })
  } else {
    throw new Error(`${p.label}: CDN upload URL missing (need upload_full_url or upload_param)`)
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      })
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`CDN upload client error ${res.status}: ${await describeCdnError(res)}`)
      }
      if (res.status !== 200) {
        throw new Error(`CDN upload server error ${res.status}: ${await describeCdnError(res)}`)
      }
      const downloadParam = res.headers.get('x-encrypted-param')
      if (!downloadParam) {
        throw new Error('CDN upload response missing x-encrypted-param header')
      }
      return { downloadParam }
    } catch (err) {
      if (err instanceof Error && err.message.includes('client error')) throw err
      lastError = err
      process.stderr.write(
        `weixin channel: ${p.label} attempt ${attempt}/${UPLOAD_MAX_RETRIES} failed ` +
        `url=${redactUrl(cdnUrl)} error=${String(err)}\n`,
      )
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${p.label}: CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`)
}

export type UploadedFileInfo = {
  filekey: string
  /** From the CDN response; goes into media.encrypt_query_param. */
  downloadEncryptedQueryParam: string
  /** AES-128 key, hex-encoded. */
  aeskey: string
  /** Plaintext byte length. */
  fileSize: number
  /** Ciphertext byte length; goes into image_item.mid_size. */
  fileSizeCiphertext: number
}

/** Read → hash → encrypt → getUploadUrl → CDN upload. */
export async function uploadMediaToCdn(
  opts: ApiOptions,
  p: { filePath: string; toUserId: string; mediaType: number },
): Promise<UploadedFileInfo> {
  const plaintext = await readFile(p.filePath)
  const rawsize = plaintext.length
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = randomBytes(16).toString('hex')
  const aeskey = randomBytes(16)

  const resp = await getUploadUrl(opts, {
    filekey,
    media_type: p.mediaType,
    to_user_id: p.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
  })

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: resp.upload_full_url,
    uploadParam: resp.upload_param,
    filekey,
    aeskey,
    label: `upload[${filekey}]`,
  })

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString('hex'),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  }
}
