/**
 * Process lifecycle: tie this server's life to the client that started it.
 */

/** Minimal shape of the stdin we listen on — a real stream satisfies it. */
export type ReadableLike = { on(event: string, listener: () => void): unknown }

export function exitWhenClientDisconnects(stdin: ReadableLike, exit: () => void): void {
  stdin.on('end', exit)
}
