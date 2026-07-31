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
