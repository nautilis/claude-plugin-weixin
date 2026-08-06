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

test('a reply that lands before the ticket does cancels the pending typing', async () => {
  let releaseConfig: () => void = () => {}
  const gate = new Promise<void>(r => { releaseConfig = r })
  const calls: Array<{ endpoint: string; body: any }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url)
    const endpoint = u.slice(u.lastIndexOf('/') + 1)
    calls.push({ endpoint, body: JSON.parse(init.body) })
    if (endpoint === 'getconfig') {
      await gate
      return new Response(JSON.stringify({ ret: 0, typing_ticket: 'TICKET' }))
    }
    return new Response(JSON.stringify({ ret: 0 }))
  }) as any

  // server.ts fires this with `void` — it is still waiting on getconfig.
  const starting = startTyping(API, { userId: 'u1', intervalMs: 10, maxMs: 10_000 })
  // Claude answers fast, so the reply tool's finally block runs first.
  await stopTyping(API, 'u1')
  releaseConfig()
  await starting

  await Bun.sleep(35)
  expect(typingCalls(calls).filter(c => c.body.status === 1)).toHaveLength(0)
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
