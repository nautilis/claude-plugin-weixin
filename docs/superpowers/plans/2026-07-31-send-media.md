# 图片/文件发送 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `reply` 工具带 `files` 参数，把本地图片/文件经微信 CDN 加密上传后发到对方微信。

**Architecture:** 把 `server.ts` 里的 HTTP 层抽成 `api.ts`，新增 `cdn.ts`（AES-128-ECB 加密 + CDN 上传）与 `media.ts`（MIME 路由 + 消息 item 组装 + 附件校验）。`server.ts` 只保留 MCP 层、访问网关、长轮询。协议细节逐字段照抄 `Tencent/openclaw-weixin` v2.4.6（MIT）。

**Tech Stack:** Bun + TypeScript，`@modelcontextprotocol/sdk`，`bun test`（内置，零新依赖），Node 内置 `crypto`。

## Global Constraints

- 仓库 `/root/code/claude-plugin-weixin`，分支 `feat/send-media`
- **不引入任何新的 npm 依赖**
- 移植自 `Tencent/openclaw-weixin` 的文件，头部注释注明来源与 MIT
- 所有本地模块 import 带 `.ts` 后缀（bun 直接跑 TS，仓库现有风格）
- 附件大小上限 `20 * 1024 * 1024` 字节
- CDN 基址 `https://novac2c.cdn.weixin.qq.com/c2c`
- `media_type`：IMAGE = 1，FILE = 3
- `MessageItemType`：TEXT = 1，IMAGE = 2，FILE = 4
- 日志中出现的 CDN URL 必须脱敏（URL 带鉴权参数）
- 每条消息的 `item_list` 只放一个 item

---

### Task 1: 抽出 `api.ts`，补 iLink 请求头与 `getUploadUrl`

**Files:**
- Create: `api.ts`
- Create: `api.test.ts`
- Modify: `package.json`（加 `ilink_appid` 字段）
- Modify: `server.ts:19-156`（删除搬走的代码，改为 import）

**Interfaces:**
- Consumes: 无
- Produces:
  - `type ApiOptions = { token: string; baseUrl: string }`
  - `STATE_DIR: string`
  - `buildClientVersion(version: string): number`
  - `randomWechatUin(): string`
  - `buildHeaders(token: string): Record<string, string>`
  - `apiPost(opts: ApiOptions, endpoint: string, body: object, timeoutMs?: number): Promise<any>`
  - `getUpdates(opts: ApiOptions, buf: string): Promise<any>`
  - `textItem(text: string): MessageItem`
  - `sendItem(opts: ApiOptions, p: { to: string; item: MessageItem; contextToken: string }): Promise<void>`
  - `getUploadUrl(opts: ApiOptions, req: UploadUrlReq): Promise<UploadUrlResp>`
  - `type MessageItem = Record<string, unknown>`
  - `MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 }`
  - `UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 }`
  - `type UploadUrlReq = { filekey, media_type, to_user_id, rawsize, rawfilemd5, filesize, no_need_thumb, aeskey }`
  - `type UploadUrlResp = { upload_param?: string; upload_full_url?: string; ret?: number; errmsg?: string }`

- [ ] **Step 1: 装依赖**

```bash
cd /root/code/claude-plugin-weixin && bun install
```

- [ ] **Step 2: 给 package.json 加 `ilink_appid`**

在 `"license": "MIT",` 下一行插入：

```json
  "ilink_appid": "bot",
```

- [ ] **Step 3: 写失败的测试 `api.test.ts`**

```ts
import { test, expect, afterEach } from 'bun:test'
import {
  buildClientVersion, randomWechatUin, buildHeaders,
  textItem, getUploadUrl, MessageItemType, UploadMediaType,
} from './api.ts'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

test('buildClientVersion packs major/minor/patch into 0x00MMNNPP', () => {
  expect(buildClientVersion('1.0.11')).toBe(0x0001000b)
  expect(buildClientVersion('0.5.0')).toBe(0x000500)
  expect(buildClientVersion('garbage')).toBe(0)
})

test('randomWechatUin is base64 of a decimal uint32 string', () => {
  const decoded = Buffer.from(randomWechatUin(), 'base64').toString('utf-8')
  expect(decoded).toMatch(/^\d+$/)
  const n = Number(decoded)
  expect(n).toBeGreaterThanOrEqual(0)
  expect(n).toBeLessThanOrEqual(0xffffffff)
})

test('buildHeaders carries ilink auth and app identity', () => {
  const h = buildHeaders('tok')
  expect(h['Content-Type']).toBe('application/json')
  expect(h['AuthorizationType']).toBe('ilink_bot_token')
  expect(h['Authorization']).toBe('Bearer tok')
  expect(h['X-WECHAT-UIN']).toBeTruthy()
  expect(h['iLink-App-Id']).toBe('bot')
  expect(Number(h['iLink-App-ClientVersion'])).toBeGreaterThan(0)
})

test('textItem builds a TEXT item', () => {
  expect(textItem('hi')).toEqual({ type: MessageItemType.TEXT, text_item: { text: 'hi' } })
})

test('getUploadUrl posts the documented body and returns the upload params', async () => {
  let seenUrl = '', seenBody: any = null
  globalThis.fetch = (async (url: any, init: any) => {
    seenUrl = String(url)
    seenBody = JSON.parse(init.body)
    return new Response(JSON.stringify({ ret: 0, upload_param: 'P', upload_full_url: 'https://cdn/u' }))
  }) as any

  const resp = await getUploadUrl(
    { token: 't', baseUrl: 'https://api.example.com/' },
    {
      filekey: 'fk', media_type: UploadMediaType.IMAGE, to_user_id: 'u1',
      rawsize: 10, rawfilemd5: 'md5', filesize: 16,
      no_need_thumb: true, aeskey: 'deadbeef',
    },
  )

  expect(seenUrl).toBe('https://api.example.com/ilink/bot/getuploadurl')
  expect(seenBody.filekey).toBe('fk')
  expect(seenBody.media_type).toBe(1)
  expect(seenBody.no_need_thumb).toBe(true)
  expect(seenBody.aeskey).toBe('deadbeef')
  expect(seenBody.base_info.channel_version).toBeTruthy()
  expect(resp.upload_full_url).toBe('https://cdn/u')
})

test('getUploadUrl throws on non-zero ret', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ret: -14, errmsg: 'stale token' }))) as any

  await expect(getUploadUrl(
    { token: 't', baseUrl: 'https://api.example.com/' },
    {
      filekey: 'fk', media_type: 1, to_user_id: 'u1',
      rawsize: 1, rawfilemd5: 'm', filesize: 16, no_need_thumb: true, aeskey: 'k',
    },
  )).rejects.toThrow(/ret=-14/)
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd /root/code/claude-plugin-weixin && bun test api.test.ts`
Expected: FAIL —— `Cannot find module './api.ts'`

- [ ] **Step 5: 写 `api.ts`**

```ts
/**
 * iLink Bot API client for the weixin channel.
 *
 * Wire format (endpoints, headers, message envelope) ported from
 * Tencent/openclaw-weixin v2.4.6 (MIT) — src/api/api.ts.
 */

import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

export const STATE_DIR = join(homedir(), '.claude', 'channels', 'weixin')

export type ApiOptions = { token: string; baseUrl: string }
export type MessageItem = Record<string, unknown>

export const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const

const MESSAGE_TYPE_BOT = 2
const MESSAGE_STATE_FINISH = 2
const DEFAULT_TIMEOUT_MS = 15000

const PKG = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'),
) as { version?: string; ilink_appid?: string }

const CHANNEL_VERSION = PKG.version ?? '0.0.0'
const ILINK_APP_ID = PKG.ilink_appid ?? 'bot'

/**
 * iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP
 * (major << 16 | minor << 8 | patch). e.g. "1.0.11" -> 0x0001000B.
 */
export function buildClientVersion(version: string): number {
  const parts = version.split('.').map(p => parseInt(p, 10))
  const major = parts[0] || 0
  const minor = parts[1] || 0
  const patch = parts[2] || 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION)

/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
export function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

export function buildHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${token}`,
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
}

function baseInfo(): object {
  return { channel_version: CHANNEL_VERSION }
}

export async function apiPost(
  opts: ApiOptions,
  endpoint: string,
  body: object,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<any> {
  const base = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`
  const url = new URL(endpoint, base)
  const bodyStr = JSON.stringify(body)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        ...buildHeaders(opts.token),
        'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
      },
      body: bodyStr,
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${text}`)
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

export async function getUpdates(opts: ApiOptions, buf: string): Promise<any> {
  try {
    return await apiPost(opts, 'ilink/bot/getupdates', {
      get_updates_buf: buf,
      base_info: baseInfo(),
    }, 35000)
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: buf }
    }
    throw err
  }
}

export function textItem(text: string): MessageItem {
  return { type: MessageItemType.TEXT, text_item: { text } }
}

/** Send one message carrying exactly one item. */
export async function sendItem(
  opts: ApiOptions,
  p: { to: string; item: MessageItem; contextToken: string },
): Promise<void> {
  const resp = await apiPost(opts, 'ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: p.to,
      client_id: `claude-weixin-${Date.now()}-${randomBytes(4).toString('hex')}`,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: [p.item],
      context_token: p.contextToken,
    },
    base_info: baseInfo(),
  })
  if (resp?.ret !== undefined && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`)
  }
}

export type UploadUrlReq = {
  filekey: string
  media_type: number
  to_user_id: string
  /** Plaintext byte length. */
  rawsize: number
  /** Plaintext MD5, hex. */
  rawfilemd5: string
  /** Ciphertext byte length. */
  filesize: number
  no_need_thumb: boolean
  /** AES-128 key, hex string. */
  aeskey: string
}

export type UploadUrlResp = {
  upload_param?: string
  upload_full_url?: string
  ret?: number
  errmsg?: string
}

export async function getUploadUrl(opts: ApiOptions, req: UploadUrlReq): Promise<UploadUrlResp> {
  const resp = await apiPost(opts, 'ilink/bot/getuploadurl', { ...req, base_info: baseInfo() })
  if (resp?.ret !== undefined && resp.ret !== 0) {
    throw new Error(`getUploadUrl ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`)
  }
  return resp
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test api.test.ts`
Expected: PASS，6 个 test

- [ ] **Step 7: 改 `server.ts` 用 `api.ts`**

删除 `server.ts` 中这些块（它们已搬进 `api.ts`）：`STATE_DIR` 定义、`randomWechatUin`、`buildHeaders`、`apiFetch`、`getUpdates`、`sendMessage`。

顶部 import 段改为（保留 MCP SDK 的 import 不动）：

```ts
import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync,
  statSync, renameSync, realpathSync,
} from 'fs'
import { join, sep } from 'path'
import {
  STATE_DIR, getUpdates, sendItem, textItem, type ApiOptions,
} from './api.ts'
```

凭据加载后加一行，其余凭据校验逻辑不动：

```ts
const api: ApiOptions = { token: creds.token, baseUrl: BASE_URL }
```

把三处旧调用改掉：

- `reply` 里的 `await sendMessage(userId, c, contextToken)`
  → `await sendItem(api, { to: userId, item: textItem(c), contextToken })`
- `handleInbound` 里配对码那次 `sendMessage(senderId, ..., ct)`
  → `sendItem(api, { to: senderId, item: textItem(\`${lead} — 在 Claude Code 终端运行：\n\n/weixin:access pair ${result.code}\`), contextToken: ct })`
- `pollLoop` 里的 `getUpdates(getUpdatesBuf)` → `getUpdates(api, getUpdatesBuf)`

- [ ] **Step 8: 确认 server.ts 能启动**

Run: `bun server.ts < /dev/null 2>&1 | head -3`
Expected: 打印 `weixin channel: long-poll started (https://ilinkai.weixin.qq.com/)`，无 `Cannot find` / 语法错误。（进程会挂起等 stdin，`< /dev/null` 让它立刻退出。）

- [ ] **Step 9: 提交**

```bash
cd /root/code/claude-plugin-weixin
git add api.ts api.test.ts server.ts package.json
git commit -m "refactor: extract api.ts, add iLink app headers and getUploadUrl"
```

---

### Task 2: `cdn.ts` —— AES-128-ECB 加密与 CDN 上传

**Files:**
- Create: `cdn.ts`
- Create: `cdn.test.ts`

**Interfaces:**
- Consumes: `api.ts` 的 `ApiOptions`、`getUploadUrl`、`UploadMediaType`
- Produces:
  - `CDN_BASE_URL: string`
  - `encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer`
  - `aesEcbPaddedSize(plaintextSize: number): number`
  - `buildCdnUploadUrl(p: { cdnBaseUrl: string; uploadParam: string; filekey: string }): string`
  - `redactUrl(url: string): string`
  - `uploadBufferToCdn(p: { buf: Buffer; uploadFullUrl?: string; uploadParam?: string; filekey: string; aeskey: Buffer; label: string }): Promise<{ downloadParam: string }>`
  - `type UploadedFileInfo = { filekey: string; downloadEncryptedQueryParam: string; aeskey: string; fileSize: number; fileSizeCiphertext: number }`
  - `uploadMediaToCdn(opts: ApiOptions, p: { filePath: string; toUserId: string; mediaType: number }): Promise<UploadedFileInfo>`

- [ ] **Step 1: 写失败的测试 `cdn.test.ts`**

```ts
import { test, expect, afterEach } from 'bun:test'
import { createDecipheriv } from 'crypto'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  encryptAesEcb, aesEcbPaddedSize, buildCdnUploadUrl, redactUrl,
  uploadBufferToCdn, uploadMediaToCdn, CDN_BASE_URL,
} from './cdn.ts'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

test('aesEcbPaddedSize always adds a full PKCS7 block at the boundary', () => {
  expect(aesEcbPaddedSize(0)).toBe(16)
  expect(aesEcbPaddedSize(1)).toBe(16)
  expect(aesEcbPaddedSize(15)).toBe(16)
  expect(aesEcbPaddedSize(16)).toBe(32)
  expect(aesEcbPaddedSize(17)).toBe(32)
})

test('encryptAesEcb output length matches aesEcbPaddedSize and decrypts back', () => {
  const key = Buffer.alloc(16, 7)
  const plain = Buffer.from('hello weixin cdn')
  const cipher = encryptAesEcb(plain, key)
  expect(cipher.length).toBe(aesEcbPaddedSize(plain.length))
  const d = createDecipheriv('aes-128-ecb', key, null)
  expect(Buffer.concat([d.update(cipher), d.final()]).toString()).toBe('hello weixin cdn')
})

test('buildCdnUploadUrl escapes both query params', () => {
  expect(buildCdnUploadUrl({ cdnBaseUrl: 'https://cdn/c2c', uploadParam: 'a b&c', filekey: 'k/1' }))
    .toBe('https://cdn/c2c/upload?encrypted_query_param=a%20b%26c&filekey=k%2F1')
})

test('redactUrl keeps origin and path but drops the query', () => {
  expect(redactUrl('https://cdn/c2c/upload?encrypted_query_param=secret&filekey=k'))
    .toBe('https://cdn/c2c/upload?<redacted>')
  expect(redactUrl('not a url')).toBe('<invalid-url>')
})

test('uploadBufferToCdn posts ciphertext and returns x-encrypted-param', async () => {
  let body: Uint8Array | null = null
  globalThis.fetch = (async (_url: any, init: any) => {
    body = init.body
    return new Response('', { status: 200, headers: { 'x-encrypted-param': 'DL' } })
  }) as any

  const res = await uploadBufferToCdn({
    buf: Buffer.from('abc'), uploadFullUrl: 'https://cdn/u',
    filekey: 'fk', aeskey: Buffer.alloc(16, 1), label: 'test',
  })
  expect(res.downloadParam).toBe('DL')
  expect(body!.byteLength).toBe(16)
})

test('uploadBufferToCdn aborts immediately on 4xx', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response('nope', { status: 403 })
  }) as any

  await expect(uploadBufferToCdn({
    buf: Buffer.from('abc'), uploadFullUrl: 'https://cdn/u',
    filekey: 'fk', aeskey: Buffer.alloc(16, 1), label: 'test',
  })).rejects.toThrow(/client error 403/)
  expect(calls).toBe(1)
})

test('uploadBufferToCdn retries 3 times on 5xx then throws', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response('boom', { status: 500 })
  }) as any

  await expect(uploadBufferToCdn({
    buf: Buffer.from('abc'), uploadFullUrl: 'https://cdn/u',
    filekey: 'fk', aeskey: Buffer.alloc(16, 1), label: 'test',
  })).rejects.toThrow(/server error/)
  expect(calls).toBe(3)
})

test('uploadMediaToCdn sends plaintext size/md5 and ciphertext size, uploads to CDN', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-test-'))
  const file = join(dir, 'a.txt')
  writeFileSync(file, 'hello')  // 5 bytes, md5 5d41402abc4b2a76b9719d911017c592

  let uploadBody: any = null
  let cdnUrl = ''
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url)
    if (u.endsWith('/ilink/bot/getuploadurl')) {
      uploadBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ret: 0, upload_param: 'UP' }))
    }
    cdnUrl = u
    return new Response('', { status: 200, headers: { 'x-encrypted-param': 'DL' } })
  }) as any

  const info = await uploadMediaToCdn(
    { token: 't', baseUrl: 'https://api.example.com/' },
    { filePath: file, toUserId: 'u1', mediaType: 1 },
  )

  expect(uploadBody.rawsize).toBe(5)
  expect(uploadBody.rawfilemd5).toBe('5d41402abc4b2a76b9719d911017c592')
  expect(uploadBody.filesize).toBe(16)
  expect(uploadBody.no_need_thumb).toBe(true)
  expect(uploadBody.aeskey).toMatch(/^[0-9a-f]{32}$/)
  expect(cdnUrl.startsWith(`${CDN_BASE_URL}/upload?encrypted_query_param=UP`)).toBe(true)

  expect(info.fileSize).toBe(5)
  expect(info.fileSizeCiphertext).toBe(16)
  expect(info.downloadEncryptedQueryParam).toBe('DL')
  expect(info.aeskey).toMatch(/^[0-9a-f]{32}$/)
  expect(info.filekey).toMatch(/^[0-9a-f]{32}$/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test cdn.test.ts`
Expected: FAIL —— `Cannot find module './cdn.ts'`

- [ ] **Step 3: 写 `cdn.ts`**

```ts
/**
 * Weixin CDN upload pipeline: AES-128-ECB encrypt, POST to CDN, hand the
 * download param back for the outgoing message item.
 *
 * Ported from Tencent/openclaw-weixin v2.4.6 (MIT) —
 * src/cdn/aes-ecb.ts, src/cdn/cdn-url.ts, src/cdn/cdn-upload.ts, src/cdn/upload.ts.
 */

import { createCipheriv, createHash, randomBytes } from 'crypto'
import { readFile } from 'fs/promises'
import { getUploadUrl, type ApiOptions } from './api.ts'

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

const UPLOAD_MAX_RETRIES = 3

/** Encrypt with AES-128-ECB (PKCS7 padding is the default). */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
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
        const errMsg = res.headers.get('x-error-message') ?? (await res.text())
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`)
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`
        throw new Error(`CDN upload server error: ${errMsg}`)
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test cdn.test.ts`
Expected: PASS，8 个 test

- [ ] **Step 5: 提交**

```bash
git add cdn.ts cdn.test.ts
git commit -m "feat: add AES-128-ECB CDN upload pipeline"
```

---

### Task 3: `media.ts` —— MIME 路由、item 组装、附件校验

**Files:**
- Create: `media.ts`
- Create: `media.test.ts`

**Interfaces:**
- Consumes: `api.ts` 的 `ApiOptions`/`MessageItem`/`MessageItemType`/`UploadMediaType`/`sendItem`/`STATE_DIR`，`cdn.ts` 的 `uploadMediaToCdn`/`UploadedFileInfo`
- Produces:
  - `MAX_FILE_BYTES: number`
  - `getMimeFromFilename(filename: string): string`
  - `isImageFile(filename: string): boolean`
  - `buildImageItem(u: UploadedFileInfo): MessageItem`
  - `buildFileItem(u: UploadedFileInfo, fileName: string): MessageItem`
  - `validateAttachment(filePath: string): void`
  - `formatReplyResult(chunks: number, files: number, failed: string[]): string`
  - `sendMediaFile(opts: ApiOptions, p: { filePath: string; to: string; contextToken: string }): Promise<void>`

- [ ] **Step 1: 写失败的测试 `media.test.ts`**

```ts
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, truncateSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE_DIR, MessageItemType } from './api.ts'
import {
  getMimeFromFilename, isImageFile, buildImageItem, buildFileItem,
  validateAttachment, formatReplyResult, MAX_FILE_BYTES,
} from './media.ts'

const uploaded = {
  filekey: 'fk',
  downloadEncryptedQueryParam: 'DL',
  aeskey: '00112233445566778899aabbccddeeff',
  fileSize: 5,
  fileSizeCiphertext: 16,
}

test('getMimeFromFilename maps known extensions, defaults to octet-stream', () => {
  expect(getMimeFromFilename('/a/b.PNG')).toBe('image/png')
  expect(getMimeFromFilename('/a/b.jpg')).toBe('image/jpeg')
  expect(getMimeFromFilename('/a/b.pdf')).toBe('application/pdf')
  expect(getMimeFromFilename('/a/b.xyz')).toBe('application/octet-stream')
})

test('isImageFile routes image/* only', () => {
  expect(isImageFile('/a/b.png')).toBe(true)
  expect(isImageFile('/a/b.webp')).toBe(true)
  expect(isImageFile('/a/b.pdf')).toBe(false)
  expect(isImageFile('/a/b.xyz')).toBe(false)
})

test('buildImageItem base64-encodes the hex aeskey string, not its bytes', () => {
  const item: any = buildImageItem(uploaded)
  expect(item.type).toBe(MessageItemType.IMAGE)
  expect(item.image_item.media.encrypt_query_param).toBe('DL')
  expect(item.image_item.media.encrypt_type).toBe(1)
  expect(item.image_item.mid_size).toBe(16)
  // Upstream quirk: base64 of the 32-char hex STRING (44 chars), not of 16 raw bytes.
  expect(item.image_item.media.aes_key).toBe(
    Buffer.from('00112233445566778899aabbccddeeff').toString('base64'),
  )
  expect(item.image_item.media.aes_key.length).toBe(44)
})

test('buildFileItem carries file_name and plaintext length as a string', () => {
  const item: any = buildFileItem(uploaded, 'report.pdf')
  expect(item.type).toBe(MessageItemType.FILE)
  expect(item.file_item.file_name).toBe('report.pdf')
  expect(item.file_item.len).toBe('5')
  expect(item.file_item.media.encrypt_query_param).toBe('DL')
})

test('validateAttachment rejects relative paths, missing files and directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-test-'))
  expect(() => validateAttachment('relative.png')).toThrow(/absolute/)
  expect(() => validateAttachment(join(dir, 'nope.png'))).toThrow(/not found/)
  expect(() => validateAttachment(dir)).toThrow(/not a regular file/)
})

test('validateAttachment rejects files over the size limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-test-'))
  const big = join(dir, 'big.bin')
  writeFileSync(big, '')
  truncateSync(big, MAX_FILE_BYTES + 1)
  expect(() => validateAttachment(big)).toThrow(/too large/)
})

test('validateAttachment refuses to send channel state files', () => {
  // Never touch the real credentials.json — use a throwaway marker file.
  mkdirSync(STATE_DIR, { recursive: true })
  const marker = join(STATE_DIR, 'validate-attachment-test.tmp')
  writeFileSync(marker, 'x')
  try {
    expect(() => validateAttachment(marker)).toThrow(/channel state/)
  } finally {
    rmSync(marker, { force: true })
  }
})

test('validateAttachment accepts an ordinary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-test-'))
  const ok = join(dir, 'ok.png')
  writeFileSync(ok, 'x')
  expect(() => validateAttachment(ok)).not.toThrow()
})

test('formatReplyResult reports chunks, files and per-file failures', () => {
  expect(formatReplyResult(2, 0, [])).toBe('sent 2 chunk(s)')
  expect(formatReplyResult(1, 2, [])).toBe('sent 1 chunk(s), 2 file(s)')
  expect(formatReplyResult(1, 1, ['/x.png (CDN 403)']))
    .toBe('sent 1 chunk(s), 1 file(s); failed: /x.png (CDN 403)')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test media.test.ts`
Expected: FAIL —— `Cannot find module './media.ts'`

- [ ] **Step 3: 写 `media.ts`**

```ts
/**
 * Attachment handling: MIME routing, message item assembly, safety checks.
 *
 * Item field layout ported from Tencent/openclaw-weixin v2.4.6 (MIT) —
 * src/messaging/send.ts, src/messaging/send-media.ts, src/media/mime.ts.
 */

import { statSync, realpathSync } from 'fs'
import { basename, extname, isAbsolute, sep } from 'path'
import {
  MessageItemType, UploadMediaType, STATE_DIR, sendItem,
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

/** Never let an attachment exfiltrate the channel's own credentials. */
function assertNotChannelState(filePath: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(filePath)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  if (real === stateReal || real.startsWith(stateReal + sep)) {
    throw new Error(`refusing to send channel state: ${filePath}`)
  }
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test media.test.ts`
Expected: PASS，9 个 test

- [ ] **Step 5: 提交**

```bash
git add media.ts media.test.ts
git commit -m "feat: add attachment MIME routing, item builders and validation"
```

---

### Task 4: `reply` 工具接上 `files` 参数

**Files:**
- Modify: `server.ts`（`reply` 的 inputSchema、description、handler，MCP instructions）

**Interfaces:**
- Consumes: `media.ts` 的 `sendMediaFile`/`validateAttachment`/`formatReplyResult`，`api.ts` 的 `sendItem`/`textItem`
- Produces: 无（终端节点）

- [ ] **Step 1: 删掉 server.ts 里已被 media.ts 取代的 `assertSendable`**

`server.ts` 中的 `assertSendable` 函数整段删除（`media.ts` 的 `validateAttachment` 已覆盖并加强了它）。同时把 import 里不再使用的 `realpathSync`、`sep` 去掉。

- [ ] **Step 2: 加 import**

```ts
import { sendMediaFile, validateAttachment, formatReplyResult } from './media.ts'
```

- [ ] **Step 3: 改 `reply` 的工具声明**

把 `ListToolsRequestSchema` handler 里的 `reply` 替换为：

```ts
    {
      name: 'reply',
      description:
        'Reply on WeChat. Pass user_id and context_token from the inbound message. ' +
        'context_token is required — without it the reply will fail. ' +
        'Attach local files with `files` (absolute paths): images are sent as photos, ' +
        'everything else as file attachments.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'The from_user_id from the inbound message.' },
          text: { type: 'string' },
          context_token: {
            type: 'string',
            description: 'context_token from the inbound message. Required for delivery.',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Absolute paths to local files to attach. Images (png/jpg/gif/webp/bmp) are ' +
              'sent as photos, other types as file attachments. Max 20MB each.',
          },
        },
        required: ['user_id', 'text', 'context_token'],
      },
    },
```

- [ ] **Step 4: 改 `reply` 的 handler**

`case 'reply':` 整块替换为：

```ts
      case 'reply': {
        const userId = args.user_id as string
        const text = (args.text as string) ?? ''
        const contextToken = args.context_token as string
        const files = Array.isArray(args.files) ? (args.files as string[]) : []

        if (!contextToken) throw new Error('context_token is required')
        assertAllowedUser(userId)

        const access = loadAccess()
        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const chunks = text ? chunk(text, limit) : []

        for (const c of chunks) {
          await sendItem(api, { to: userId, item: textItem(c), contextToken })
        }

        let sentFiles = 0
        const failed: string[] = []
        for (const f of files) {
          try {
            validateAttachment(f)
            await sendMediaFile(api, { filePath: f, to: userId, contextToken })
            sentFiles++
          } catch (err) {
            failed.push(`${f} (${err instanceof Error ? err.message : String(err)})`)
          }
        }

        return {
          content: [{ type: 'text', text: formatReplyResult(chunks.length, sentFiles, failed) }],
          isError: failed.length > 0,
        }
      }
```

- [ ] **Step 5: 更新 MCP instructions**

在 `new Server(...)` 的 `instructions` 数组里，`'WeChat has no message history API...'` 那一行**之前**插入：

```ts
      'reply accepts local file paths (files: ["/abs/path.png"]) — images go out as photos, other types as file attachments. Paths must be absolute; 20MB max each.',
      '',
```

- [ ] **Step 6: 跑全部测试**

Run: `cd /root/code/claude-plugin-weixin && bun test`
Expected: PASS，23 个 test（api 6 + cdn 8 + media 9）

- [ ] **Step 7: 确认 server 仍能启动**

Run: `bun server.ts < /dev/null 2>&1 | head -3`
Expected: `weixin channel: long-poll started (https://ilinkai.weixin.qq.com/)`

- [ ] **Step 8: 提交**

```bash
git add server.ts
git commit -m "feat: accept file attachments in the reply tool"
```

---

### Task 5: 文档、版本号、安装与真机验证

**Files:**
- Modify: `README.md`
- Modify: `package.json`（version → 0.5.0）
- Modify: `.claude-plugin/plugin.json`（version → 0.5.0）

**Interfaces:**
- Consumes: 前四个 task 的全部产出
- Produces: 无

- [ ] **Step 1: 版本号提到 0.5.0**

`package.json` 的 `"version": "0.1.0"` 与 `.claude-plugin/plugin.json` 的 `"version": "0.4.0"` 都改为 `"0.5.0"`。（两处历史上不同步，本次统一。）

- [ ] **Step 2: README 补一节**

在 `## How it works` 一节之后插入：

```markdown
### Sending images and files

`reply` takes an optional `files` array of absolute local paths:

- `image/*` (png, jpg, gif, webp, bmp) → sent as a photo
- everything else (pdf, zip, txt, …) → sent as a file attachment
- 20MB per file

Files are encrypted with AES-128-ECB and uploaded to the WeChat CDN before the
message is sent. Text and each attachment go out as separate messages.

The CDN pipeline is ported from [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) (MIT).
```

- [ ] **Step 3: 提交**

```bash
git add README.md package.json .claude-plugin/plugin.json
git commit -m "docs: document attachment support, bump to 0.5.0"
```

- [ ] **Step 4: 装到运行中的插件目录**

```bash
cp /root/code/claude-plugin-weixin/{api.ts,cdn.ts,media.ts,server.ts,package.json} \
   /root/.claude/plugins/cache/m1heng-plugins/weixin/0.4.0/
```

注意：这是覆盖式安装，`claude plugin update weixin` 会把它冲掉，届时重跑本步骤即可。

- [ ] **Step 5: 重启 channel 让改动生效**

MCP server 是会话启动时拉起的，改完文件必须重启 Claude Code 才会加载新代码。请用户重启，并确认启动命令仍带
`--dangerously-load-development-channels plugin:weixin@m1heng-plugins`。

- [ ] **Step 6: 真机端到端**

`context_token` 只来自入站消息，所以必须由用户先发起：

1. 用户在微信给 bot 发一条消息（比如"测试发图"）
2. 在该会话中生成一张测试图片：
   ```bash
   bun -e 'const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");require("fs").writeFileSync("/tmp/weixin-test.png",png)'
   ```
3. 用 `reply` 回复，带上 `files: ["/tmp/weixin-test.png"]`
4. 确认用户在微信里**看到图片本身**（不是文件名、不是裂图）

Expected: 微信收到一条文字 + 一张可正常预览的图片。

- [ ] **Step 7: 记录结果**

若图片显示异常，最可能的三个原因按顺序排查：`aes_key` 的双重编码是否写反、`mid_size` 是否误填明文大小、`filesize` 是否误填明文大小。三者都对时图片才会正常渲染。

---

## 自查

**Spec 覆盖：**

| Spec 要求 | 对应 Task |
|---|---|
| 四文件拆分 | Task 1（api.ts）、2（cdn.ts）、3（media.ts）、4（server.ts 瘦身） |
| `reply` 加 `files` | Task 4 |
| image/* 与文件附件路由 | Task 3（`isImageFile`、`sendMediaFile`） |
| aeskey hex / 双重 base64 | Task 2（传 hex）、Task 3（`cdnMedia`）+ 两处断言 |
| rawsize/rawfilemd5/filesize | Task 2 `uploadMediaToCdn` + 测试断言 |
| `no_need_thumb: true` | Task 2 |
| mid_size / len / encrypt_type | Task 3 |
| CDN 基址与拼接、`x-encrypted-param` | Task 2 |
| 3 次重试、4xx 立即放弃 | Task 2（含两个测试） |
| iLink-App-Id / ClientVersion 头 | Task 1 |
| 每条消息单 item | Task 1 `sendItem` |
| assertSendable 复用 | Task 3 `assertNotChannelState` + Task 4 Step 1 删旧的 |
| 绝对路径 / 20MB 上限 | Task 3 `validateAttachment` |
| 单文件失败不影响其他 | Task 4 handler 的 try/catch + `formatReplyResult` |
| getUploadUrl ret 检查 | Task 1 |
| 日志 URL 脱敏 | Task 2 `redactUrl` |
| 单元测试清单 | Task 1/2/3 |
| 真机端到端 | Task 5 |

**未在 spec 中、本计划新增的两处**（均为顺手补的健壮性，实现时若不认可可去掉）：
- `sendItem` 也检查 `ret !== 0`（spec 只要求 `getUploadUrl` 检查），避免发送静默失败
- `package.json` 与 `plugin.json` 的版本号统一到 0.5.0（原本 0.1.0 / 0.4.0 不同步）

**Spec 提到但本计划刻意不做**：上游 `base_info` 里还有 `bot_agent` 字段用于流量归因，spec 只批准了补两个 HTTP 头，故 `base_info` 保持现状（只发 `channel_version`）。
