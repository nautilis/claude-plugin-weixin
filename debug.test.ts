import { test, expect, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { dumpRawMessage, RAW_DUMP_MARKER, RAW_DUMP_DIR } from './debug.ts'

function clean(): void {
  rmSync(RAW_DUMP_MARKER, { force: true })
  rmSync(RAW_DUMP_DIR, { recursive: true, force: true })
}
afterEach(clean)

function enable(): void {
  mkdirSync(join(RAW_DUMP_MARKER, '..'), { recursive: true })
  writeFileSync(RAW_DUMP_MARKER, '')
}

test('dumpRawMessage writes nothing while the marker file is absent', () => {
  clean()
  dumpRawMessage({ item_list: [{ type: 1 }] })
  expect(existsSync(RAW_DUMP_DIR)).toBe(false)
})

test('dumpRawMessage records the whole payload once enabled', () => {
  enable()
  dumpRawMessage({ item_list: [{ type: 1, ref_msg: { title: '小王' } }] })

  const files = readdirSync(RAW_DUMP_DIR)
  expect(files).toHaveLength(1)
  const dumped = JSON.parse(readFileSync(join(RAW_DUMP_DIR, files[0]!), 'utf8'))
  expect(dumped.item_list[0].ref_msg.title).toBe('小王')
})

test('dumpRawMessage swallows its own failures — diagnostics never break delivery', () => {
  enable()
  const circular: any = {}
  circular.self = circular
  expect(() => dumpRawMessage(circular)).not.toThrow()
})
