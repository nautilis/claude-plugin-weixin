/**
 * What the plugin has seen, keyed by server message id.
 *
 * WeChat quotes carry only `msg_id` — never the quoted text (see
 * docs/superpowers/specs). Resolving a quote therefore means remembering our
 * own traffic. Ids are int64: they must never pass through Number().
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { STATE_DIR } from './api.ts'

export const LEDGER_FILE = join(STATE_DIR, 'messages.jsonl')
export const LEDGER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** A quote only needs the gist; this bounds both memory and the file. */
export const LEDGER_MAX_TEXT = 160

type Entry = { id: string; text: string; at: number }

let file = LEDGER_FILE
let entries = new Map<string, Entry>()

/** Clear in-memory state; pass a path to point the ledger elsewhere (tests). */
export function resetLedger(nextFile?: string): void {
  entries = new Map()
  file = nextFile ?? LEDGER_FILE
}

function truncate(text: string): string {
  return text.length > LEDGER_MAX_TEXT ? text.slice(0, LEDGER_MAX_TEXT) + '…' : text
}

export function recordMessage(id: string, text: string, opts?: { at?: number }): void {
  if (!id || !text) return
  const entry: Entry = { id, text: truncate(text), at: opts?.at ?? Date.now() }
  entries.set(id, entry)
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 })
  } catch (err: any) {
    // A lost quote is not worth dropping a message over.
    process.stderr.write(`weixin channel: ledger write failed: ${err?.message ?? err}\n`)
  }
}

export function lookupMessage(id: string): string | undefined {
  return entries.get(id)?.text
}

/** Read the ledger, drop anything past the window, rewrite what survived. */
export function loadLedger(): void {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const cutoff = Date.now() - LEDGER_MAX_AGE_MS
  const kept: Entry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: Entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue // a torn write must not cost the rest of the file
    }
    if (!entry?.id || !(entry.at > cutoff)) continue
    entries.set(entry.id, entry)
    kept.push(entry)
  }
  try {
    writeFileSync(file, kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), {
      mode: 0o600,
    })
  } catch (err: any) {
    process.stderr.write(`weixin channel: ledger rewrite failed: ${err?.message ?? err}\n`)
  }
}
