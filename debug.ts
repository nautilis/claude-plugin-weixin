/**
 * Opt-in capture of raw inbound payloads.
 *
 * WeChat has no history API and the MCP server's stderr goes nowhere durable,
 * so when the wire format is in question this is the only way to see what the
 * server actually sent. Off unless the marker file exists.
 */

import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import { STATE_DIR } from './api.ts'

/** `touch ~/.claude/channels/weixin/debug-raw` to start capturing. */
export const RAW_DUMP_MARKER = join(STATE_DIR, 'debug-raw')
export const RAW_DUMP_DIR = join(STATE_DIR, 'raw')

export function dumpRawMessage(msg: any): void {
  if (!existsSync(RAW_DUMP_MARKER)) return
  try {
    const body = JSON.stringify(msg, null, 2)
    mkdirSync(RAW_DUMP_DIR, { recursive: true, mode: 0o700 })
    const path = join(RAW_DUMP_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}.json`)
    writeFileSync(path, body, { mode: 0o600 })
  } catch (err: any) {
    // Diagnostics must never cost a message.
    process.stderr.write(`weixin channel: raw dump failed: ${err?.message ?? err}\n`)
  }
}
