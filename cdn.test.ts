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
