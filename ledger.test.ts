import { test, expect, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import {
  resetLedger, recordMessage, lookupMessage, loadLedger,
  LEDGER_MAX_AGE_MS, LEDGER_MAX_TEXT,
} from './ledger.ts'

const TMP = '/tmp/claude-0/-tmp/29446466-709a-4ecd-9423-e65c45d979c6/scratchpad/ledger-test'
const FILE = join(TMP, 'messages.jsonl')

function fresh(): void {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  resetLedger(FILE)
}
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

test('recordMessage then lookupMessage round-trips a quoted body', () => {
  fresh()
  recordMessage('7488894805294949123', '那个 CDN 报错是不是解决了')
  expect(lookupMessage('7488894805294949123')).toBe('那个 CDN 报错是不是解决了')
})

test('lookupMessage returns undefined for an id the plugin never saw', () => {
  fresh()
  expect(lookupMessage('123')).toBeUndefined()
})

test('ids keep full precision — they exceed Number.MAX_SAFE_INTEGER', () => {
  fresh()
  const exact = '7488896191118167176'
  expect(String(Number(exact))).not.toBe(exact) // the bug this guards against
  recordMessage(exact, 'hi')
  expect(lookupMessage(exact)).toBe('hi')
})

test('the ledger survives a restart', () => {
  fresh()
  recordMessage('999', '重启前说的话')
  resetLedger(FILE)
  loadLedger()
  expect(lookupMessage('999')).toBe('重启前说的话')
})

test('loadLedger drops entries past the retention window', () => {
  fresh()
  recordMessage('old', '很久以前', { at: Date.now() - LEDGER_MAX_AGE_MS - 1000 })
  recordMessage('new', '刚才', { at: Date.now() })
  resetLedger(FILE)
  loadLedger()
  expect(lookupMessage('old')).toBeUndefined()
  expect(lookupMessage('new')).toBe('刚才')
})

test('loadLedger rewrites the file so pruned entries stop costing disk', () => {
  fresh()
  recordMessage('old', '很久以前', { at: Date.now() - LEDGER_MAX_AGE_MS - 1000 })
  recordMessage('new', '刚才')
  resetLedger(FILE)
  loadLedger()
  const lines = readFileSync(FILE, 'utf8').trim().split('\n')
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0]!).id).toBe('new')
})

test('recordMessage truncates long bodies — a quote only needs the gist', () => {
  fresh()
  const long = 'x'.repeat(LEDGER_MAX_TEXT + 500)
  recordMessage('long', long)
  const stored = lookupMessage('long')!
  expect(stored.length).toBeLessThanOrEqual(LEDGER_MAX_TEXT + 1)
  expect(stored.endsWith('…')).toBe(true)
})

test('a corrupt line does not take the whole ledger down', () => {
  fresh()
  recordMessage('good', 'ok')
  const { appendFileSync } = require('fs')
  appendFileSync(FILE, '{not json\n')
  resetLedger(FILE)
  loadLedger()
  expect(lookupMessage('good')).toBe('ok')
})

test('recordMessage is a no-op without an id — nothing to key on', () => {
  fresh()
  recordMessage('', 'orphan')
  expect(existsSync(FILE)).toBe(false)
})

