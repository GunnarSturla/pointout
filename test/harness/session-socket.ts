import { appendFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { join } from 'node:path'
import { writeSession } from './registry.js'
import type { SessionSpec } from './registry.js'
import type { FixtureEnv } from './fixture-env.js'

// A fake Claude Code session that really listens. `registry.ts` writes the entry;
// this binds a unix socket at the path that entry names and records every NDJSON
// line written to it, which is how the server suite observes a delivery without importing
// anything the server knows.
//
// The key file is the harness's too: `<registryDir>/<pid>.<hash>.key`, holding the
// `peerToken` the auth frame carries. Its name is spelled out here rather than
// imported, like every other harness-shaped string.
//
// The return leg is here as well. A Receipt is a fresh outbound connection from
// the session to the address the sender published in `from` — never an answer on
// the connection the Pick arrived over — so `replyTo` is what a fake session uses
// to say what became of a Pick, and `replyAddress()` is where it learns where to
// say it.

/** Only the two directories are needed, so a partial fixture will do. */
type SocketFixture = Pick<FixtureEnv, 'registryDir' | 'socketDir'>

export interface FakeSessionSpec extends Omit<SessionSpec, 'socket'> {
  /** The token the key file publishes. `null` writes no key file at all. */
  peerToken?: string | null
  /**
   * Append every received line to this file as well as to memory. The browser suite needs
   * it: the session is bound in Playwright's `globalSetup` process and the
   * specs run in worker processes, so a file is the only thing they share.
   */
  logFile?: string
}

export interface FakeSession {
  pid: number
  sessionId: string
  name: string
  socketPath: string
  /** The token the key file publishes, or null when there is no key file. */
  peerToken: string | null
  /** Every NDJSON line this session's inbox received, oldest first. */
  lines(): string[]
  /**
   * The `uds:` address the dev server published in the frames it wrote here —
   * where a Receipt goes. Throws when nothing carrying one has arrived yet.
   */
  replyAddress(): string
  /** The same lines, parsed. */
  frames(): Array<Record<string, unknown>>
  /** Resolve once `count` lines have arrived; reject if they do not. */
  awaitLines(count: number, timeoutMs?: number): Promise<string[]>
  close(): Promise<void>
}

export async function listeningSession(
  fixture: SocketFixture,
  spec: FakeSessionSpec,
): Promise<FakeSession> {
  const {
    peerToken = 'peer-token-' + Math.random().toString(16).slice(2),
    logFile,
    ...entry
  } = spec

  // `socket: false` keeps the registry writer from putting a plain file where the
  // listener is about to bind.
  const record = writeSession(fixture, { ...entry, socket: false })
  const pid = record.pid as number
  const socketPath = record.messagingSocketPath as string

  if (peerToken !== null) {
    writeFileSync(
      join(fixture.registryDir, `${pid}.0123456789abcdef.key`),
      JSON.stringify({ peerToken }),
    )
  }

  const lines: string[] = []
  const open = new Set<Socket>()
  const server: Server = createServer((connection) => {
    open.add(connection)
    connection.setEncoding('utf8')
    let buffered = ''
    connection.on('data', (chunk: string) => {
      buffered += chunk
      let newline: number
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (!line.trim()) continue
        lines.push(line)
        if (logFile) appendFileSync(logFile, line + '\n')
      }
    })
    connection.on('error', () => {})
    connection.on('close', () => open.delete(connection))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  return {
    pid,
    sessionId: record.sessionId as string,
    name: record.name as string,
    socketPath,
    peerToken,
    lines: () => [...lines],

    replyAddress() {
      for (const line of lines) {
        const from = (JSON.parse(line) as { from?: unknown }).from
        if (typeof from === 'string' && from.startsWith('uds:')) return from
      }
      throw new Error(`no frame at ${socketPath} carried a uds: reply address`)
    },
    frames: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),

    async awaitLines(count, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs
      while (lines.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `expected ${count} NDJSON lines at ${socketPath}, saw ${lines.length}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return [...lines]
    },

    async close() {
      for (const connection of open) connection.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try {
        unlinkSync(socketPath)
      } catch {
        // Node usually unlinks it already; a path that is gone is the goal.
      }
    },
  }
}

/** The fake sessions one test file opened, and the one call that closes them. */
export interface FakeSessions {
  open(fixture: SocketFixture, spec: FakeSessionSpec): Promise<FakeSession>
  closeAll(): Promise<void>
}

export function fakeSessions(): FakeSessions {
  const sessions: FakeSession[] = []
  return {
    async open(fixture, spec) {
      const session = await listeningSession(fixture, spec)
      sessions.push(session)
      return session
    },
    async closeAll() {
      while (sessions.length) await sessions.pop()!.close()
    },
  }
}

/**
 * One open connection to a dev server's reply address, held open on purpose: a
 * frame the server could not use must leave the socket serving the next one, and
 * the only way to see that is to send both down the same connection.
 */
export interface ReplyConnection {
  /** One NDJSON line per frame. */
  send(...frames: unknown[]): Promise<void>
  /** A raw line, for the frames a test needs to be malformed. */
  sendRaw(line: string): Promise<void>
  close(): Promise<void>
}

/** Connect to a `uds:<path>` reply address, the way the harness does. */
export async function replyTo(address: string): Promise<ReplyConnection> {
  const path = address.startsWith('uds:') ? address.slice('uds:'.length) : address
  const socket = connect(path)
  socket.on('error', () => {})

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve()
    })
  })

  const write = (line: string) =>
    new Promise<void>((resolve, reject) => {
      socket.write(line, (error) => (error ? reject(error) : resolve()))
    })

  return {
    send: (...frames) =>
      write(frames.map((frame) => JSON.stringify(frame) + '\n').join('')),
    sendRaw: (line) => write(line + '\n'),
    close: () =>
      new Promise<void>((resolve) => {
        socket.end(() => resolve())
      }),
  }
}
