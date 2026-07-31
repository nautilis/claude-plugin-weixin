# 接收图片与文件附件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 入站微信图片与文件附件下载解密到本地 inbox，路径通过 channel 通知的 meta 交给 Claude。

**Architecture:** `cdn.ts` 补下载侧原语（解密、下载 URL、双编码 key 解析），`media.ts` 加纯函数 `extractMediaRefs` 从 `item_list` 抽出媒体引用，新增 `inbox.ts` 负责落盘/大小限制/清理/编排，`server.ts` 在 `handleInbound` 里接线。

**Tech Stack:** Bun + TypeScript，`bun test`（内置），Node 内置 `crypto`。零新依赖。

## Global Constraints

- 仓库 `/root/code/claude-plugin-weixin`，分支 `feat/receive-media`
- **不引入任何新的 npm 依赖**
- 本地模块 import 带 `.ts` 后缀
- 单附件上限 `MAX_INBOUND_BYTES = 20 * 1024 * 1024`，下载前按声明大小预判、下载后按实际字节复核
- inbox 目录 `~/.claude/channels/weixin/inbox/`，权限 0700
- 清理阈值 7 天（`INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000`）
- 附件路径**只进 meta，绝不进正文**
- 文件名一律自己生成 `<时间戳>-<8位hex><扩展名>`，不采用发送者提供的 `file_name`
- CDN 下载 URL 日志一律经 `redactUrl` 脱敏
- `MessageItemType`：TEXT = 1，IMAGE = 2，FILE = 4

---

### Task 1: `cdn.ts` 下载侧原语

**Files:**
- Modify: `cdn.ts`
- Modify: `cdn.test.ts`

**Interfaces:**
- Consumes: `cdn.ts` 已有的 `CDN_BASE_URL`、`redactUrl`
- Produces:
  - `decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer`
  - `buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl?: string): string`
  - `parseAesKey(aesKeyBase64: string): Buffer`
  - `downloadAndDecrypt(p: { encryptedParam?: string; fullUrl?: string; aesKeyBase64?: string; label: string }): Promise<Buffer>`

- [ ] **Step 1: 写失败的测试（追加到 `cdn.test.ts` 末尾）**

```ts
test('parseAesKey accepts raw-16-byte base64 (images)', () => {
  const raw = Buffer.alloc(16, 9)
  expect(parseAesKey(raw.toString('base64')).equals(raw)).toBe(true)
})

test('parseAesKey accepts base64-of-hex-string (files/voice)', () => {
  const raw = Buffer.alloc(16, 3)
  const b64OfHex = Buffer.from(raw.toString('hex')).toString('base64')
  expect(parseAesKey(b64OfHex).equals(raw)).toBe(true)
})

test('parseAesKey rejects anything else, reporting the decoded length', () => {
  const bad = Buffer.alloc(20, 1).toString('base64')
  expect(() => parseAesKey(bad)).toThrow(/20 bytes/)
})

test('buildCdnDownloadUrl escapes the query param', () => {
  expect(buildCdnDownloadUrl('a b&c', 'https://cdn/c2c'))
    .toBe('https://cdn/c2c/download?encrypted_query_param=a%20b%26c')
})

test('downloadAndDecrypt decrypts what the CDN returns', async () => {
  const key = Buffer.alloc(16, 5)
  const plain = Buffer.from('inbound picture bytes')
  const cipher = encryptAesEcb(plain, key)
  let seenUrl = ''
  globalThis.fetch = (async (url: any) => {
    seenUrl = String(url)
    return new Response(cipher, { status: 200 })
  }) as any

  const out = await downloadAndDecrypt({
    encryptedParam: 'PARAM',
    aesKeyBase64: key.toString('base64'),
    label: 'test',
  })
  expect(out.toString()).toBe('inbound picture bytes')
  expect(seenUrl).toBe(`${CDN_BASE_URL}/download?encrypted_query_param=PARAM`)
})

test('downloadAndDecrypt prefers full_url and returns plain bytes without a key', async () => {
  globalThis.fetch = (async (url: any) => {
    expect(String(url)).toBe('https://cdn/full')
    return new Response(Buffer.from('plain'), { status: 200 })
  }) as any

  const out = await downloadAndDecrypt({ fullUrl: 'https://cdn/full', label: 'test' })
  expect(out.toString()).toBe('plain')
})

test('downloadAndDecrypt throws with a redacted URL on HTTP error', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 404 })) as any
  await expect(downloadAndDecrypt({
    encryptedParam: 'SECRET', aesKeyBase64: Buffer.alloc(16).toString('base64'), label: 'test',
  })).rejects.toThrow(/404/)
})
```

同时把 `cdn.test.ts` 顶部的 import 改为：

```ts
import {
  encryptAesEcb, aesEcbPaddedSize, buildCdnUploadUrl, redactUrl,
  uploadBufferToCdn, uploadMediaToCdn, CDN_BASE_URL,
  decryptAesEcb, buildCdnDownloadUrl, parseAesKey, downloadAndDecrypt,
} from './cdn.ts'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /root/code/claude-plugin-weixin && bun test cdn.test.ts`
Expected: FAIL —— `parseAesKey is not a function`（或同类 import 错误）

- [ ] **Step 3: 实现（追加到 `cdn.ts`，放在 `encryptAesEcb` 之后）**

```ts
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
```

并把 `cdn.ts` 顶部的 crypto import 改为：

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test cdn.test.ts`
Expected: PASS，15 个 test（原 9 + 新 6）

- [ ] **Step 5: 提交**

```bash
git add cdn.ts cdn.test.ts
git commit -m "feat: add CDN download and decryption primitives"
```

---

### Task 2: `media.ts` 抽取媒体引用 + inbox 豁免

**Files:**
- Modify: `api.ts`（加 `INBOX_DIR` 常量）
- Modify: `media.ts`
- Modify: `media.test.ts`

**Interfaces:**
- Consumes: `api.ts` 的 `STATE_DIR`、`MessageItemType`
- Produces:
  - `INBOX_DIR: string`（从 `api.ts` 导出）
  - `type MediaRef = { kind: 'image' | 'file'; encryptedParam?: string; fullUrl?: string; aesKeyBase64?: string; declaredSize?: number; name?: string }`
  - `extractMediaRefs(msg: any): MediaRef[]`

- [ ] **Step 1: 在 `api.ts` 的 `STATE_DIR` 下面加一行**

```ts
/** Inbound media lands here; deliberately sendable (see media.ts). */
export const INBOX_DIR = join(STATE_DIR, 'inbox')
```

- [ ] **Step 2: 写失败的测试（追加到 `media.test.ts` 末尾）**

```ts
test('extractMediaRefs pulls image refs, preferring the top-level hex aeskey', () => {
  const rawKey = Buffer.alloc(16, 4)
  const refs = extractMediaRefs({
    item_list: [
      { type: 1, text_item: { text: 'hello' } },
      {
        type: 2,
        image_item: {
          aeskey: rawKey.toString('hex'),
          media: { encrypt_query_param: 'QP', aes_key: 'SHOULD-BE-IGNORED' },
          hd_size: 4096,
        },
      },
    ],
  })
  expect(refs).toHaveLength(1)
  expect(refs[0]!.kind).toBe('image')
  expect(refs[0]!.encryptedParam).toBe('QP')
  expect(refs[0]!.declaredSize).toBe(4096)
  // top-level aeskey is hex; it is re-encoded as base64 of the RAW bytes
  expect(refs[0]!.aesKeyBase64).toBe(rawKey.toString('base64'))
})

test('extractMediaRefs falls back to media.aes_key and mid_size', () => {
  const refs = extractMediaRefs({
    item_list: [{ type: 2, image_item: { media: { aes_key: 'B64KEY', full_url: 'https://cdn/x' }, mid_size: 99 } }],
  })
  expect(refs[0]!.aesKeyBase64).toBe('B64KEY')
  expect(refs[0]!.fullUrl).toBe('https://cdn/x')
  expect(refs[0]!.declaredSize).toBe(99)
})

test('extractMediaRefs pulls file refs with name and plaintext length', () => {
  const refs = extractMediaRefs({
    item_list: [{
      type: 4,
      file_item: { media: { encrypt_query_param: 'FP', aes_key: 'FK' }, file_name: 'report.pdf', len: '2048' },
    }],
  })
  expect(refs[0]!.kind).toBe('file')
  expect(refs[0]!.name).toBe('report.pdf')
  expect(refs[0]!.declaredSize).toBe(2048)
})

test('extractMediaRefs skips items with no CDN reference at all', () => {
  expect(extractMediaRefs({ item_list: [
    { type: 2, image_item: { media: {} } },
    { type: 4, file_item: { file_name: 'x.pdf' } },
    { type: 3, voice_item: { text: 'hi' } },
  ] })).toHaveLength(0)
  expect(extractMediaRefs({})).toHaveLength(0)
})

test('validateAttachment allows inbox files but still blocks credentials', () => {
  mkdirSync(INBOX_DIR, { recursive: true })
  const inboxFile = join(INBOX_DIR, 'inbox-allowed-test.png')
  writeFileSync(inboxFile, 'x')
  const stateFile = join(STATE_DIR, 'validate-inbox-test.tmp')
  writeFileSync(stateFile, 'x')
  try {
    expect(() => validateAttachment(inboxFile)).not.toThrow()
    expect(() => validateAttachment(stateFile)).toThrow(/channel state/)
  } finally {
    rmSync(inboxFile, { force: true })
    rmSync(stateFile, { force: true })
  }
})
```

并把 `media.test.ts` 顶部的 import 改为：

```ts
import { STATE_DIR, INBOX_DIR, MessageItemType } from './api.ts'
import {
  getMimeFromFilename, isImageFile, buildImageItem, buildFileItem,
  validateAttachment, formatReplyResult, MAX_FILE_BYTES, extractMediaRefs,
} from './media.ts'
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test media.test.ts`
Expected: FAIL —— `extractMediaRefs is not a function`

- [ ] **Step 4: 实现（`media.ts`）**

顶部 import 加入 `INBOX_DIR`：

```ts
import {
  MessageItemType, UploadMediaType, STATE_DIR, INBOX_DIR, sendItem,
  type ApiOptions, type MessageItem,
} from './api.ts'
```

`assertNotChannelState` 整个函数替换为（放行 inbox）：

```ts
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
```

文件末尾追加：

```ts
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
    if (item.type === MessageItemType.IMAGE) {
      const img = item.image_item
      const media = img?.media
      if (!media?.encrypt_query_param && !media?.full_url) continue
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
    } else if (item.type === MessageItemType.FILE) {
      const f = item.file_item
      const media = f?.media
      if (!media?.encrypt_query_param && !media?.full_url) continue
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
  return refs
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test media.test.ts`
Expected: PASS，14 个 test（原 9 + 新 5）

- [ ] **Step 6: 提交**

```bash
git add api.ts media.ts media.test.ts
git commit -m "feat: extract inbound media refs, exempt inbox from state guard"
```

---

### Task 3: `inbox.ts` 落盘、限额与清理

**Files:**
- Create: `inbox.ts`
- Create: `inbox.test.ts`

**Interfaces:**
- Consumes: `api.ts` 的 `INBOX_DIR`，`cdn.ts` 的 `downloadAndDecrypt`，`media.ts` 的 `MediaRef`
- Produces:
  - `MAX_INBOUND_BYTES: number`
  - `INBOX_MAX_AGE_MS: number`
  - `sniffImageExt(buf: Buffer): string`
  - `safeExtFromName(name: string | undefined): string`
  - `safeDisplayName(name: string | undefined): string | undefined`
  - `pruneInbox(maxAgeMs?: number): number`
  - `type SavedAttachment = { kind: 'image' | 'file'; path: string; name?: string; size: number }`
  - `fetchInboundMedia(refs: MediaRef[]): Promise<{ saved: SavedAttachment[]; errors: string[] }>`

- [ ] **Step 1: 写失败的测试 `inbox.test.ts`**

```ts
import { test, expect, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'fs'
import { join, dirname } from 'path'
import { INBOX_DIR } from './api.ts'
import { encryptAesEcb } from './cdn.ts'
import {
  sniffImageExt, safeExtFromName, safeDisplayName, pruneInbox,
  fetchInboundMedia, MAX_INBOUND_BYTES,
} from './inbox.ts'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8)])

test('sniffImageExt identifies formats by magic bytes, not by claim', () => {
  expect(sniffImageExt(PNG)).toBe('.png')
  expect(sniffImageExt(JPG)).toBe('.jpg')
  expect(sniffImageExt(Buffer.from('GIF89a-----'))).toBe('.gif')
  expect(sniffImageExt(Buffer.from('not an image at all'))).toBe('.bin')
})

test('safeExtFromName only honours whitelisted extensions', () => {
  expect(safeExtFromName('report.pdf')).toBe('.pdf')
  expect(safeExtFromName('archive.ZIP')).toBe('.zip')
  expect(safeExtFromName('evil.exe')).toBe('.bin')
  expect(safeExtFromName(undefined)).toBe('.bin')
})

test('safeDisplayName strips characters that could forge meta or markup', () => {
  expect(safeDisplayName('a<b>[c];\nd')).toBe('a_b__c___d')
  expect(safeDisplayName(undefined)).toBeUndefined()
})

test('pruneInbox deletes files older than the cutoff and keeps recent ones', () => {
  mkdirSync(INBOX_DIR, { recursive: true })
  const old = join(INBOX_DIR, 'prune-old-test.bin')
  const fresh = join(INBOX_DIR, 'prune-fresh-test.bin')
  writeFileSync(old, 'x')
  writeFileSync(fresh, 'x')
  const eightDaysAgo = Date.now() / 1000 - 8 * 24 * 60 * 60
  utimesSync(old, eightDaysAgo, eightDaysAgo)
  try {
    const removed = pruneInbox()
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  } finally {
    rmSync(old, { force: true })
    rmSync(fresh, { force: true })
  }
})

test('fetchInboundMedia downloads, decrypts and saves into the inbox', async () => {
  const key = Buffer.alloc(16, 2)
  globalThis.fetch = (async () =>
    new Response(encryptAesEcb(PNG, key), { status: 200 })) as any

  const { saved, errors } = await fetchInboundMedia([{
    kind: 'image', encryptedParam: 'QP', aesKeyBase64: key.toString('base64'), declaredSize: 16,
  }])

  expect(errors).toEqual([])
  expect(saved).toHaveLength(1)
  expect(saved[0]!.kind).toBe('image')
  expect(saved[0]!.size).toBe(PNG.length)
  expect(dirname(saved[0]!.path)).toBe(INBOX_DIR)
  expect(saved[0]!.path.endsWith('.png')).toBe(true)
  rmSync(saved[0]!.path, { force: true })
})

test('fetchInboundMedia never lets a sender-supplied name reach the path', async () => {
  const key = Buffer.alloc(16, 2)
  globalThis.fetch = (async () =>
    new Response(encryptAesEcb(Buffer.from('%PDF-1.4 data'), key), { status: 200 })) as any

  const { saved } = await fetchInboundMedia([{
    kind: 'file', encryptedParam: 'QP', aesKeyBase64: key.toString('base64'),
    name: '../../../etc/passwd.pdf', declaredSize: 13,
  }])

  expect(saved).toHaveLength(1)
  expect(dirname(saved[0]!.path)).toBe(INBOX_DIR)
  expect(saved[0]!.path).not.toContain('..')
  expect(saved[0]!.path).not.toContain('passwd')
  expect(saved[0]!.name).toBe('.._.._.._etc_passwd.pdf')
  rmSync(saved[0]!.path, { force: true })
})

test('fetchInboundMedia skips oversized attachments without fetching', async () => {
  let called = false
  globalThis.fetch = (async () => { called = true; return new Response('') }) as any

  const { saved, errors } = await fetchInboundMedia([{
    kind: 'file', encryptedParam: 'QP', aesKeyBase64: 'k', declaredSize: MAX_INBOUND_BYTES + 1,
  }])

  expect(called).toBe(false)
  expect(saved).toEqual([])
  expect(errors[0]).toMatch(/too large/)
})

test('fetchInboundMedia rejects payloads that exceed the cap after download', async () => {
  const key = Buffer.alloc(16, 2)
  const big = Buffer.alloc(MAX_INBOUND_BYTES + 16, 7)
  globalThis.fetch = (async () =>
    new Response(encryptAesEcb(big, key), { status: 200 })) as any

  const { saved, errors } = await fetchInboundMedia([{
    kind: 'file', encryptedParam: 'QP', aesKeyBase64: key.toString('base64'), declaredSize: 10,
  }])

  expect(saved).toEqual([])
  expect(errors[0]).toMatch(/too large/)
})

test('fetchInboundMedia reports failures without dropping the other attachments', async () => {
  const key = Buffer.alloc(16, 2)
  let call = 0
  globalThis.fetch = (async () => {
    call++
    if (call === 1) return new Response('gone', { status: 404 })
    return new Response(encryptAesEcb(PNG, key), { status: 200 })
  }) as any

  const { saved, errors } = await fetchInboundMedia([
    { kind: 'file', encryptedParam: 'A', aesKeyBase64: key.toString('base64') },
    { kind: 'image', encryptedParam: 'B', aesKeyBase64: key.toString('base64') },
  ])

  expect(saved).toHaveLength(1)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/404/)
  rmSync(saved[0]!.path, { force: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test inbox.test.ts`
Expected: FAIL —— `Cannot find module './inbox.ts'`

- [ ] **Step 3: 写 `inbox.ts`**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test inbox.test.ts`
Expected: PASS，9 个 test

- [ ] **Step 5: 提交**

```bash
git add inbox.ts inbox.test.ts
git commit -m "feat: add inbound media inbox with size cap and pruning"
```

---

### Task 4: `server.ts` 接线与真机验证

**Files:**
- Modify: `server.ts`
- Modify: `README.md`
- Modify: `package.json` + `.claude-plugin/plugin.json`（version → 0.6.0）

**Interfaces:**
- Consumes: `media.ts` 的 `extractMediaRefs`，`inbox.ts` 的 `fetchInboundMedia`/`pruneInbox`
- Produces: 无（终端节点）

- [ ] **Step 1: 加 import**

```ts
import { sendMediaFile, validateAttachment, formatReplyResult, extractMediaRefs } from './media.ts'
import { fetchInboundMedia, pruneInbox } from './inbox.ts'
```

- [ ] **Step 2: 启动时清理**

在 `server.ts` 里 `setInterval(checkApprovals, 5000)` 那一行下面加：

```ts
// Bound the inbox at startup; a failure here must never block the channel.
try {
  const removed = pruneInbox()
  if (removed > 0) process.stderr.write(`weixin channel: pruned ${removed} old inbox file(s)\n`)
} catch (err) {
  process.stderr.write(`weixin channel: inbox prune failed: ${err}\n`)
}
```

- [ ] **Step 3: 在 `handleInbound` 里接线**

把 `const text = extractText(msg)` 起到函数结尾的那段替换为：

```ts
  const text = extractText(msg)
  const ts = msg.create_time_ms
    ? new Date(msg.create_time_ms).toISOString()
    : new Date().toISOString()

  const refs = extractMediaRefs(msg)
  const { saved, errors } = refs.length > 0
    ? await fetchInboundMedia(refs)
    : { saved: [], errors: [] }
  const firstImage = saved.find(s => s.kind === 'image')

  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        user_id: senderId,
        ...(msg.context_token ? { context_token: msg.context_token } : {}),
        ts,
        // Paths go in meta only — content is sender-forgeable.
        ...(firstImage ? { image_path: firstImage.path } : {}),
        ...(saved.length > 0 ? { attachments: JSON.stringify(saved) } : {}),
        ...(errors.length > 0 ? { attachment_error: errors.join('; ') } : {}),
      },
    },
  })
}
```

- [ ] **Step 4: 更新 MCP instructions**

在 `instructions` 数组里，`'reply accepts local file paths ...'` 那一行**之前**插入：

```ts
      'Inbound attachments are downloaded for you: if the <channel> tag has an image_path attribute, Read that file — it is the photo the sender attached. The attachments attribute holds JSON for every saved attachment ({kind, path, name, size}); attachment_error explains any that failed. Message content only ever shows an (image) placeholder — trust the meta attributes, not the text.',
      '',
```

- [ ] **Step 5: 跑全部测试**

Run: `cd /root/code/claude-plugin-weixin && bun test`
Expected: PASS，44 个 test，0 fail（api 6 + cdn 15 + media 14 + inbox 9）

- [ ] **Step 6: 确认 server 能启动**

Run: `timeout 20 bun server.ts < /dev/null 2>&1 | head -3`
Expected: `weixin channel: long-poll started (https://ilinkai.weixin.qq.com/)`

- [ ] **Step 7: README 补一节**

在 `### Sending images and files` 一节**之后**插入：

```markdown
### Receiving images and files

Inbound photos and file attachments are downloaded, decrypted and written to
`~/.claude/channels/weixin/inbox/`. The channel notification carries
`image_path` (first photo) and `attachments` (JSON for all of them); Claude
reads the file from there. Attachments over 20MB are skipped, and files older
than 7 days are pruned when the server starts.

Paths appear in notification metadata only — never in message content, which a
sender could forge.
```

- [ ] **Step 8: 版本提到 0.6.0 并提交**

`package.json` 与 `.claude-plugin/plugin.json` 的 `"version"` 都改为 `"0.6.0"`。

```bash
git add server.ts README.md package.json .claude-plugin/plugin.json
git commit -m "feat: deliver inbound attachments to Claude via notification meta"
```

- [ ] **Step 9: 装到运行中的插件目录**

```bash
cp /root/code/claude-plugin-weixin/{api.ts,cdn.ts,media.ts,inbox.ts,server.ts,package.json} \
   /root/.claude/plugins/cache/m1heng-plugins/weixin/0.4.0/
```

- [ ] **Step 10: 真机端到端**

需要用户重启 Claude Code（MCP server 在会话启动时拉起），然后：

1. 用户在微信给 bot 发一张有具体内容的图片
2. 确认 `<channel>` 标签带上了 `image_path`
3. `Read` 该路径，**说出图里有什么**

Expected: 能描述图片内容。仅拿到路径不算通过——那只证明下载成功，不证明解密正确；解密错误会产出一个大小正确但无法解码的文件。

---

## 自查

**Spec 覆盖：**

| Spec 要求 | 对应 Task |
|---|---|
| `cdn.ts` 下载侧原语 | Task 1 |
| `aes_key` 双编码判别 | Task 1 `parseAesKey` + 3 个测试 |
| 顶层 `aeskey` 优先于 `media.aes_key` | Task 2 `extractMediaRefs` + 断言 |
| `full_url` 优先、否则拼下载 URL | Task 1 `downloadAndDecrypt` + 测试 |
| `extractMediaRefs` 纯函数 | Task 2 |
| inbox 落盘、0700/0600 | Task 3 `saveToInbox` |
| 文件名不采用发送者的 `file_name` | Task 3 + 路径穿越测试 |
| 20MB 上限，下载前预判 + 下载后复核 | Task 3 + 两个测试 |
| 7 天清理 | Task 3 `pruneInbox` + Task 4 启动时调用 |
| inbox 从 state 守卫豁免 | Task 2 `assertNotChannelState` + 测试 |
| meta：`image_path` / `attachments` / `attachment_error` | Task 4 |
| 路径不进正文 | Task 4（`extractText` 保持不变）+ instructions 说明 |
| 附件失败不影响消息投递 | Task 3 收集 errors、Task 4 照常发通知 + 测试 |
| 日志 URL 脱敏 | Task 1 `downloadAndDecrypt` 用 `redactUrl` |
| 真机验证到内容层面 | Task 4 Step 10 |

**未在 spec 中、本计划新增的两处**：
- 无 `aes_key` 时按明文下载（上游 `downloadPlainCdnBuffer` 的行为），否则这类图片直接失败
- `sniffImageExt` 按 magic bytes 定扩展名，而非信任发送者——spec 只说"扩展名由 kind 与后缀推导"，这里收得更紧
