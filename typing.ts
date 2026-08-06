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

/**
 * Bumped by every start and every stop. startTyping fetches a ticket before it
 * has a session to cancel, so a stop landing inside that window has nothing to
 * find — the generation is what tells the resuming start it was overtaken.
 */
const generations = new Map<string, number>()

function nextGeneration(userId: string): number {
  const gen = (generations.get(userId) ?? 0) + 1
  generations.set(userId, gen)
  return gen
}

/** Test seam: drop every cached ticket and cancel every timer. */
export function resetTypingState(): void {
  for (const s of sessions.values()) {
    clearInterval(s.timer)
    clearTimeout(s.deadline)
  }
  sessions.clear()
  ticketCache.clear()
  generations.clear()
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
  const gen = nextGeneration(p.userId)

  const ticket = await getTypingTicket(api, p.userId, p.contextToken)
  if (!ticket) return
  // A reply (or a newer message) landed while we were fetching the ticket.
  // Starting now would pulse "typing" at someone who already has their answer.
  if (generations.get(p.userId) !== gen) return

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
  // Invalidate any start still waiting on its ticket; without this it would
  // resume after us and leave the indicator stuck until the hard timeout.
  nextGeneration(userId)
  const s = clearSession(userId)
  if (!s) return
  await pulse(api, userId, s.ticket, TypingStatus.CANCEL)
}
