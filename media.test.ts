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
