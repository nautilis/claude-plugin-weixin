import { test, expect } from 'bun:test'
import { Readable } from 'stream'
import { exitWhenClientDisconnects } from './lifecycle.ts'

test('exitWhenClientDisconnects exits when stdin reaches EOF', () => {
  // EOF on stdin is how a dead parent announces itself: the MCP transport
  // listens only for 'data', so without this the poll loop outlives its client.
  const stdin = new Readable({ read() {} })
  let exited = 0
  exitWhenClientDisconnects(stdin, () => { exited++ })

  stdin.push(null)
  stdin.resume()

  return new Promise<void>(resolve => setImmediate(() => {
    expect(exited).toBe(1)
    resolve()
  }))
})
