# 「正在输入」状态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 入站消息通过访问网关后让对方看到「正在输入」，回复发完后消失。

**Architecture:** `api.ts` 加 `getConfig` / `sendTyping` 两个端点；新增 `typing.ts` 管理 ticket 缓存与每用户一个的输入会话（5 秒续期定时器 + 3 分钟硬超时）；`server.ts` 在 `handleInbound` 里开、在 `reply` 的 `finally` 里关。

**Tech Stack:** Bun + TypeScript，`bun test`（内置）。零新依赖。

## Global Constraints

- 仓库 `/root/code/claude-plugin-weixin`，分支 `feat/typing-indicator`
- **不引入任何新的 npm 依赖**
- 本地模块 import 带 `.ts` 后缀
- 续期间隔 `TYPING_INTERVAL_MS = 5000`，硬超时 `TYPING_MAX_MS = 3 * 60 * 1000`
- ticket 正缓存 24 小时，负缓存 60 秒
- `status`：1 = 正在输入，2 = 取消
- **所有 typing 调用 fire-and-forget**：错误只写 stderr，绝不影响消息投递或 reply
- 只对通过 gate 的发送者触发
- `access.json` 的 `typing` 为 `false` 时零请求

---

### Task 1: `api.ts` 加 `getConfig` 与 `sendTyping`

**Files:**
- Modify: `api.ts`
- Modify: `api.test.ts`

**Interfaces:**
- Consumes: `api.ts` 已有的 `apiPost`、`ApiOptions`
- Produces:
  - `TypingStatus = { TYPING: 1, CANCEL: 2 }`
  - `type ConfigResp = { ret?: number; errmsg?: string; typing_ticket?: string }`
  - `getConfig(opts: ApiOptions, p: { ilinkUserId: string; contextToken?: string }): Promise<ConfigResp>`
  - `sendTyping(opts: ApiOptions, p: { ilinkUserId: string; ticket: string; status: number }): Promise<void>`

- [ ] **Step 1: 写失败的测试（追加到 `api.test.ts` 末尾）**

```ts
test('getConfig posts the user id and returns the ticket', async () => {
  let seenUrl = '', seenBody: any = null
  globalThis.fetch = (async (url: any, init: any) => {
    seenUrl = String(url)
    seenBody = JSON.parse(init.body)
    return new Response(JSON.stringify({ ret: 0, typing_ticket: 'TICKET' }))
  }) as any

  const resp = await getConfig(
    { token: 't', baseUrl: 'https://api.example.com/' },
    { ilinkUserId: 'u1', contextToken: 'ctx' },
  )

  expect(seenUrl).toBe('https://api.example.com/ilink/bot/getconfig')
  expect(seenBody.ilink_user_id).toBe('u1')
  expect(seenBody.context_token).toBe('ctx')
  expect(resp.typing_ticket).toBe('TICKET')
})

test('getConfig returns non-zero ret instead of throwing — typing is optional', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ret: -1, errmsg: 'nope' }))) as any

  const resp = await getConfig(
    { token: 't', baseUrl: 'https://api.example.com/' },
    { ilinkUserId: 'u1' },
  )
  expect(resp.ret).toBe(-1)
})

test('sendTyping posts the ticket and status', async () => {
  let seenUrl = '', seenBody: any = null
  globalThis.fetch = (async (url: any, init: any) => {
    seenUrl = String(url)
    seenBody = JSON.parse(init.body)
    return new Response(JSON.stringify({ ret: 0 }))
  }) as any

  await sendTyping(
    { token: 't', baseUrl: 'https://api.example.com/' },
    { ilinkUserId: 'u1', ticket: 'TICKET', status: TypingStatus.CANCEL },
  )

  expect(seenUrl).toBe('https://api.example.com/ilink/bot/sendtyping')
  expect(seenBody.ilink_user_id).toBe('u1')
  expect(seenBody.typing_ticket).toBe('TICKET')
  expect(seenBody.status).toBe(2)
  expect(seenBody.base_info.channel_version).toBeTruthy()
})
```

并把 `api.test.ts` 顶部的 import 改为：

```ts
import {
  buildClientVersion, randomWechatUin, buildHeaders,
  textItem, getUploadUrl, MessageItemType, UploadMediaType,
  getConfig, sendTyping, TypingStatus,
} from './api.ts'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /root/code/claude-plugin-weixin && bun test api.test.ts`
Expected: FAIL —— `getConfig is not a function`（或同类 import 错误）

- [ ] **Step 3: 实现（追加到 `api.ts` 末尾）**

```ts
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const

export type ConfigResp = {
  ret?: number
  errmsg?: string
  /** Base64 ticket required by sendTyping. */
  typing_ticket?: string
}

/**
 * Fetch per-user bot config. Unlike the other endpoints this does NOT throw on
 * a non-zero ret — the typing indicator is optional, and the caller decides.
 */
export async function getConfig(
  opts: ApiOptions,
  p: { ilinkUserId: string; contextToken?: string },
): Promise<ConfigResp> {
  return apiPost(opts, 'ilink/bot/getconfig', {
    ilink_user_id: p.ilinkUserId,
    context_token: p.contextToken,
    base_info: baseInfo(),
  }, 10000)
}

export async function sendTyping(
  opts: ApiOptions,
  p: { ilinkUserId: string; ticket: string; status: number },
): Promise<void> {
  await apiPost(opts, 'ilink/bot/sendtyping', {
    ilink_user_id: p.ilinkUserId,
    typing_ticket: p.ticket,
    status: p.status,
    base_info: baseInfo(),
  }, 10000)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test api.test.ts`
Expected: PASS，9 个 test（原 6 + 新 3）

- [ ] **Step 5: 提交**

```bash
git add api.ts api.test.ts
git commit -m "feat: add getConfig and sendTyping endpoints"
```

---

### Task 2: `typing.ts` ticket 缓存与输入会话

**Files:**
- Create: `typing.ts`
- Create: `typing.test.ts`

**Interfaces:**
- Consumes: `api.ts` 的 `ApiOptions`、`getConfig`、`sendTyping`、`TypingStatus`
- Produces:
  - `TYPING_INTERVAL_MS: number`、`TYPING_MAX_MS: number`
  - `getTypingTicket(api: ApiOptions, userId: string, contextToken?: string): Promise<string | null>`
  - `startTyping(api: ApiOptions, p: { userId: string; contextToken?: string; intervalMs?: number; maxMs?: number }): Promise<void>`
  - `stopTyping(api: ApiOptions, userId: string): Promise<void>`
  - `resetTypingState(): void`（测试用，清空 ticket 缓存与所有会话）

- [ ] **Step 1: 写失败的测试 `typing.test.ts`**

```ts
import { test, expect, afterEach } from 'bun:test'
import { getTypingTicket, startTyping, stopTyping, resetTypingState } from './typing.ts'

const API = { token: 't', baseUrl: 'https://api.example.com/' }
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  resetTypingState()
})

/** Record every call so tests can assert on endpoint + status. */
function recordFetch(configResp: object = { ret: 0, typing_ticket: 'TICKET' }) {
  const calls: Array<{ endpoint: string; body: any }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url)
    const endpoint = u.slice(u.lastIndexOf('/') + 1)
    calls.push({ endpoint, body: JSON.parse(init.body) })
    if (endpoint === 'getconfig') return new Response(JSON.stringify(configResp))
    return new Response(JSON.stringify({ ret: 0 }))
  }) as any
  return calls
}

const typingCalls = (calls: Array<{ endpoint: string; body: any }>) =>
  calls.filter(c => c.endpoint === 'sendtyping')

test('getTypingTicket caches the ticket so getconfig is hit once per user', async () => {
  const calls = recordFetch()
  expect(await getTypingTicket(API, 'u1')).toBe('TICKET')
  expect(await getTypingTicket(API, 'u1')).toBe('TICKET')
  expect(calls.filter(c => c.endpoint === 'getconfig')).toHaveLength(1)
})

test('getTypingTicket returns null on a non-zero ret without throwing', async () => {
  recordFetch({ ret: -1, errmsg: 'no typing for you' })
  expect(await getTypingTicket(API, 'u1')).toBeNull()
})

test('startTyping sends status=1 and keeps it alive on the interval', async () => {
  const calls = recordFetch()
  await startTyping(API, { userId: 'u1', intervalMs: 10, maxMs: 10_000 })

  expect(typingCalls(calls)).toHaveLength(1)
  expect(typingCalls(calls)[0]!.body.status).toBe(1)

  await Bun.sleep(35)
  expect(typingCalls(calls).length).toBeGreaterThanOrEqual(2)
  expect(typingCalls(calls).every(c => c.body.status === 1)).toBe(true)

  await stopTyping(API, 'u1')
})

test('stopTyping sends status=2 and stops the keepalive', async () => {
  const calls = recordFetch()
  await startTyping(API, { userId: 'u1', intervalMs: 10, maxMs: 10_000 })
  await stopTyping(API, 'u1')

  const afterStop = typingCalls(calls).length
  expect(typingCalls(calls).at(-1)!.body.status).toBe(2)

  await Bun.sleep(35)
  expect(typingCalls(calls)).toHaveLength(afterStop)
})

test('the hard timeout stops typing on its own and cancels', async () => {
  const calls = recordFetch()
  await startTyping(API, { userId: 'u1', intervalMs: 10, maxMs: 25 })

  await Bun.sleep(60)
  expect(typingCalls(calls).at(-1)!.body.status).toBe(2)

  const afterTimeout = typingCalls(calls).length
  await Bun.sleep(35)
  expect(typingCalls(calls)).toHaveLength(afterTimeout)
})

test('no ticket means no typing traffic at all', async () => {
  const calls = recordFetch({ ret: 0, typing_ticket: '' })
  await startTyping(API, { userId: 'u1', intervalMs: 10, maxMs: 10_000 })
  expect(typingCalls(calls)).toHaveLength(0)
})

test('stopTyping without an active session sends nothing', async () => {
  const calls = recordFetch()
  await stopTyping(API, 'u1')
  expect(calls).toHaveLength(0)
})

test('a sendtyping failure never propagates to the caller', async () => {
  globalThis.fetch = (async (url: any) => {
    if (String(url).endsWith('getconfig')) {
      return new Response(JSON.stringify({ ret: 0, typing_ticket: 'TICKET' }))
    }
    return new Response('boom', { status: 500 })
  }) as any

  await startTyping(API, { userId: 'u1', intervalMs: 1000, maxMs: 10_000 })
  await stopTyping(API, 'u1')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test typing.test.ts`
Expected: FAIL —— `Cannot find module './typing.ts'`

- [ ] **Step 3: 写 `typing.ts`**

```ts
/**
 * Typing indicator: keep a "…is typing" state alive for one user at a time.
 *
 * Ported from Tencent/openclaw-weixin v2.4.6 (MIT) — src/api/config-cache.ts and
 * the typing callbacks in src/messaging/process-message.ts. Upstream drives this
 * from its own agent loop; here the window is bounded by inbound-message arrival
 * on one side and the reply tool on the other, so a hard timeout is required.
 */

import { getConfig, sendTyping, TypingStatus, type ApiOptions } from './api.ts'

/** The indicator expires server-side; refresh it on this cadence. */
export const TYPING_INTERVAL_MS = 5000

/** Claude may never reply to a given message — never pulse forever. */
export const TYPING_MAX_MS = 3 * 60 * 1000

const TICKET_TTL_MS = 24 * 60 * 60 * 1000
const TICKET_NEGATIVE_TTL_MS = 60 * 1000

type TicketEntry = { ticket: string | null; expiresAt: number }
type Session = {
  ticket: string
  timer: ReturnType<typeof setInterval>
  deadline: ReturnType<typeof setTimeout>
}

const ticketCache = new Map<string, TicketEntry>()
const sessions = new Map<string, Session>()

/** Test seam: drop every cached ticket and cancel every timer. */
export function resetTypingState(): void {
  for (const s of sessions.values()) {
    clearInterval(s.timer)
    clearTimeout(s.deadline)
  }
  sessions.clear()
  ticketCache.clear()
}

/**
 * Look up this user's typing ticket. Failures are cached briefly so a broken
 * or unsupported account does not trigger a getconfig on every message.
 */
export async function getTypingTicket(
  api: ApiOptions,
  userId: string,
  contextToken?: string,
): Promise<string | null> {
  const hit = ticketCache.get(userId)
  if (hit && hit.expiresAt > Date.now()) return hit.ticket

  let ticket: string | null = null
  try {
    const resp = await getConfig(api, { ilinkUserId: userId, contextToken })
    if (resp?.ret === undefined || resp.ret === 0) {
      ticket = resp?.typing_ticket?.trim() || null
    }
  } catch (err) {
    process.stderr.write(`weixin channel: getConfig failed for typing: ${err}\n`)
  }

  ticketCache.set(userId, {
    ticket,
    expiresAt: Date.now() + (ticket ? TICKET_TTL_MS : TICKET_NEGATIVE_TTL_MS),
  })
  return ticket
}

/** Fire-and-forget: the indicator is cosmetic and must never break a reply. */
async function pulse(api: ApiOptions, userId: string, ticket: string, status: number): Promise<void> {
  try {
    await sendTyping(api, { ilinkUserId: userId, ticket, status })
  } catch (err) {
    process.stderr.write(`weixin channel: sendTyping status=${status} failed: ${err}\n`)
  }
}

function clearSession(userId: string): Session | undefined {
  const s = sessions.get(userId)
  if (!s) return undefined
  clearInterval(s.timer)
  clearTimeout(s.deadline)
  sessions.delete(userId)
  return s
}

/**
 * Show "typing" until stopTyping or the hard timeout. Restarting for a user who
 * is already typing just resets the clock — no cancel/restart flicker.
 */
export async function startTyping(
  api: ApiOptions,
  p: { userId: string; contextToken?: string; intervalMs?: number; maxMs?: number },
): Promise<void> {
  const ticket = await getTypingTicket(api, p.userId, p.contextToken)
  if (!ticket) return

  clearSession(p.userId)

  const timer = setInterval(() => {
    void pulse(api, p.userId, ticket, TypingStatus.TYPING)
  }, p.intervalMs ?? TYPING_INTERVAL_MS)
  const deadline = setTimeout(() => {
    void stopTyping(api, p.userId)
  }, p.maxMs ?? TYPING_MAX_MS)

  // Timers must not hold the process open.
  timer.unref?.()
  deadline.unref?.()

  sessions.set(p.userId, { ticket, timer, deadline })
  await pulse(api, p.userId, ticket, TypingStatus.TYPING)
}

/** Clear the indicator. A no-op when this user has no active session. */
export async function stopTyping(api: ApiOptions, userId: string): Promise<void> {
  const s = clearSession(userId)
  if (!s) return
  await pulse(api, userId, s.ticket, TypingStatus.CANCEL)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test typing.test.ts`
Expected: PASS，8 个 test

- [ ] **Step 5: 提交**

```bash
git add typing.ts typing.test.ts
git commit -m "feat: add typing session manager with ticket cache"
```

---

### Task 3: `server.ts` 接线、开关与真机验证

**Files:**
- Modify: `server.ts`
- Modify: `README.md`
- Modify: `package.json` + `.claude-plugin/plugin.json`（version → 0.7.0）

**Interfaces:**
- Consumes: `typing.ts` 的 `startTyping`、`stopTyping`
- Produces: 无（终端节点）

- [ ] **Step 1: 加 import**

```ts
import { startTyping, stopTyping } from './typing.ts'
```

- [ ] **Step 2: `Access` 类型加 `typing` 字段**

`server.ts` 里的 `type Access` 加一行：

```ts
  typing?: boolean
```

`readAccessFile` 的返回对象加一行（放在 `textChunkLimit` 之后）：

```ts
      typing: parsed.typing,
```

- [ ] **Step 3: `handleInbound` 里开启**

在 `knownUsers.add(senderId)` 之后插入：

```ts
  // Cosmetic and fire-and-forget: never let it delay or block delivery.
  if (result.access.typing !== false) {
    void startTyping(api, { userId: senderId, contextToken: msg.context_token })
  }
```

- [ ] **Step 4: `reply` 结束后关闭**

把 `case 'reply': {` 内、`assertAllowedUser(userId)` 之后的全部内容包进 `try { ... } finally { ... }`：

```ts
        try {
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
        } finally {
          // The reply has landed (or failed) — drop the indicator either way.
          void stopTyping(api, userId)
        }
```

- [ ] **Step 5: 更新 MCP instructions**

在 `instructions` 数组里，`'Inbound attachments are downloaded for you: ...'` 那一行**之前**插入：

```ts
      'The sender sees a "typing" indicator from the moment their message reaches you until your reply is sent, so a slow answer still looks alive. It clears itself after 3 minutes if you never reply.',
      '',
```

- [ ] **Step 6: 跑全部测试**

Run: `cd /root/code/claude-plugin-weixin && bun test`
Expected: PASS，56 个 test，0 fail（api 9 + cdn 16 + media 14 + inbox 9 + typing 8）

- [ ] **Step 7: 确认 server 能启动**

Run: `timeout 20 bun server.ts < /dev/null 2>&1 | head -3`
Expected: `weixin channel: long-poll started (https://ilinkai.weixin.qq.com/)`

- [ ] **Step 8: README 补一节**

在 `### Receiving images and files` 一节**之后**插入：

```markdown
### Typing indicator

The sender sees "typing" from the moment their message passes the access gate
until the reply is sent. The state is refreshed every 5 seconds and clears
itself after 3 minutes if no reply arrives.

Set `"typing": false` in `~/.claude/channels/weixin/access.json` to disable it.
Failures are silent — the indicator never blocks message delivery or replies.
```

- [ ] **Step 9: 版本提到 0.7.0 并提交**

`package.json` 与 `.claude-plugin/plugin.json` 的 `"version"` 都改为 `"0.7.0"`。

```bash
git add server.ts README.md package.json .claude-plugin/plugin.json
git commit -m "feat: show a typing indicator while working on a reply"
```

- [ ] **Step 10: 装到运行中的插件目录**

```bash
cp /root/code/claude-plugin-weixin/{api.ts,cdn.ts,media.ts,inbox.ts,typing.ts,server.ts,package.json} \
   /root/.claude/plugins/cache/m1heng-plugins/weixin/0.4.0/
```

- [ ] **Step 11: 真机端到端**

需要用户重启 Claude Code，然后：

1. 用户在微信给 bot 发一条消息
2. 用户观察微信界面是否出现「对方正在输入」
3. 回复发出后，该状态应消失

Expected: 出现并消失。

**若界面无变化**：先确认接口层面是否成功——用 `getconfig` 是否返回了非空 `typing_ticket`、
`sendtyping` 是否返回 `ret=0` 来区分「接口失败」与「接口成功但客户端不渲染」。
两者的结论完全不同，必须如实区分后再报告，不得臆测。

---

## 自查

**Spec 覆盖：**

| Spec 要求 | 对应 Task |
|---|---|
| `getconfig` / `sendtyping` 两个端点 | Task 1 |
| `getconfig` 非零 ret 不抛异常 | Task 1 + 专门的测试 |
| 5 秒续期 | Task 2 `TYPING_INTERVAL_MS` + 测试 |
| 3 分钟硬超时并发取消 | Task 2 `TYPING_MAX_MS` + 测试 |
| ticket 正缓存 24h / 负缓存 60s | Task 2 `getTypingTicket` + 缓存命中测试 |
| 砍掉上游退避阶梯 | Task 2（只有正负两种 TTL） |
| 关闭时机在 reply 完成之后 | Task 3 Step 4 的 `finally` |
| 只对通过 gate 的发送者触发 | Task 3 Step 3（插入点在 `knownUsers.add` 之后） |
| `access.json` 的 `typing` 开关 | Task 3 Step 2、3 |
| 失败静默、不影响投递与 reply | Task 2 `pulse` 吞异常 + Task 3 用 `void` 调用 + 测试 |
| 真机验证与不确定性处理 | Task 3 Step 11 |

**未在 spec 中、本计划新增的一处**：定时器调用 `unref()`，避免续期定时器让进程无法退出。
spec 没提，但不加会让 MCP server 在关闭时挂住。
