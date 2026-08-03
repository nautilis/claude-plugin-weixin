import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * The poll loop keeps the event loop alive forever, so a server whose client
 * has died gets re-parented to init and keeps writing the shared sync cursor.
 * Every Claude Code restart used to leave one behind.
 */
test('server exits when its client closes stdin', async () => {
  const home = mkdtempSync(join(tmpdir(), 'weixin-home-'))
  const stateDir = join(home, '.claude', 'channels', 'weixin')
  mkdirSync(stateDir, { recursive: true })
  // Unreachable API: the poll loop stays in its retry cycle, so the process
  // stays alive for any reason other than the one under test.
  writeFileSync(
    join(stateDir, 'credentials.json'),
    JSON.stringify({ token: 'test-token', baseUrl: 'http://127.0.0.1:1/' }),
  )

  const child = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, HOME: home },
  })

  try {
    child.stdin.end()
    const outcome = await Promise.race([
      child.exited,
      Bun.sleep(3000).then(() => 'still running' as const),
    ])
    expect(outcome).not.toBe('still running')
  } finally {
    child.kill()
  }
})
