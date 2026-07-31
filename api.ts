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
