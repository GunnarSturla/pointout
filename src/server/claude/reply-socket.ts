import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { join } from 'node:path'

// The reply address (spec §16). A Vite plugin listening in Claude Code's own
// socket namespace is a visible step, accepted knowingly, and it comes with two
// safety properties that land with the first bind rather than with what is read
// off it:
//
//   1. it never binds over a path a registry entry names, and
//   2. it unlinks its socket on shutdown.
//
// A third rule follows from those two rather than standing beside them: a dev
// server killed outright leaves its socket file behind, and without removing it
// the next dev server that draws the same pid could never take its own address
// again. It is removed only after the registry has been asked, only when it
// really is a socket, and the posture line says it happened.
//
// What arrives here is NDJSON, one frame per line, on a connection the sender
// opens for it. This module splits the lines and nothing else: what a line means
// is `receipt-frames.ts`, and which Pick it names is `route.ts`. A line it
// cannot use never reaches either, and never takes the connection down — the
// next frame on the same connection is still served (spec §16, user story 82).

/** Test-only. A consumer never sets it. */
const SOCKET_DIR_ENV = 'VITE_AGENT_INSPECT_SOCKET_DIR'

/** Measured, not guessed: this is where the harness keeps its own (spec §16). */
const DEFAULT_SOCKET_DIR = '/tmp/cc-socks'

export function socketDirectory(): string {
  return process.env[SOCKET_DIR_ENV] || DEFAULT_SOCKET_DIR
}

export interface ReplySocket {
  /** `uds:<path>` once bound, and null when it is not — never a guess. */
  address: string | null
  /** Bound at which path, or why not (spec §21). */
  postureLine: string
  close(): void
}

/**
 * How long a single frame may be before it is discarded unread. A control frame
 * is a few hundred bytes; anything approaching this is not one, and buffering it
 * would let whatever can reach this socket decide how much memory a dev server
 * holds.
 */
const LINE_MAX_CHARACTERS = 64 * 1024

export interface ReplySocketOptions {
  socketDir: string
  /** Every path the session registry names, Candidate or not. */
  claimedPaths: Iterable<string>
  /** One NDJSON line, as it arrived. Never throws back into the socket. */
  receive(line: string): void
  /** A line this socket would not even hand on, and why (spec §21). */
  refuse(why: string): void
}

/**
 * Bind this dev server's reply socket. Never throws: a reply address that could
 * not be taken is a state this plugin reports — v0 then behaves the way it would
 * have without Receipts at all, which is the floor it already has.
 */
export async function bindReplySocket({
  socketDir,
  claimedPaths,
  receive,
  refuse,
}: ReplySocketOptions): Promise<ReplySocket> {
  // `<pid>.sock` satisfies the harness's strict reply-address grammar, and is
  // the one name this dev server can claim without inventing an identity.
  const path = join(socketDir, `${process.pid}.sock`)
  const notBound = (why: string): ReplySocket => ({
    address: null,
    postureLine: `not bound — ${why}. Receipts will not arrive; delivery is unaffected.`,
    close: () => {},
  })

  for (const claimed of claimedPaths) {
    if (claimed === path) {
      return notBound(
        `a registered session already owns ${path}, and this plugin never binds ` +
          'over a path the session registry names',
      )
    }
  }

  try {
    mkdirSync(socketDir, { recursive: true })
  } catch (error) {
    return notBound(`${socketDir} could not be created (${(error as Error).message})`)
  }

  // A leftover from a dev server that was killed. Only ever a socket, and only
  // ever once the registry has been asked: a regular file here belongs to
  // somebody else, and is left alone.
  let removedStale = false
  try {
    if (lstatSync(path).isSocket()) {
      unlinkSync(path)
      removedStale = true
    } else {
      return notBound(`${path} is already a file, and it is not this plugin's to remove`)
    }
  } catch {
    // Nothing there, which is the ordinary case.
  }

  const server = createServer((connection) => {
    connection.setEncoding('utf8')
    let buffered = ''
    connection.on('data', (chunk: string) => {
      buffered += chunk
      let newline: number
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (line.trim()) receive(line)
      }
      // The remainder is a frame still arriving — unless it has grown past any
      // frame this socket knows, in which case it is dropped here and whatever
      // follows the next newline is read as a line of its own. That line is
      // unusable too, and is refused out loud like any other (spec §21).
      if (buffered.length > LINE_MAX_CHARACTERS) {
        refuse(`a frame longer than ${LINE_MAX_CHARACTERS} characters`)
        buffered = ''
      }
    })
    // An error on this connection is the sender's, and never the dev server's
    // to fall over on.
    connection.on('error', () => {})
  })
  server.on('error', () => {})

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    return notBound(`${path} could not be bound (${(error as Error).message})`)
  }

  try {
    chmodSync(path, 0o600)
  } catch {
    // The socket is bound; its mode is defence in depth, not the bind.
  }

  return {
    address: `uds:${path}`,
    postureLine:
      `bound at ${path}` +
      (removedStale ? ' (a stale socket file was removed first)' : ''),
    close: () => closeOnce(server, path),
  }
}

/** Idempotent: a dev server can be closed twice, and the path unlinked once. */
function closeOnce(server: Server, path: string): void {
  if (!server.listening) return
  server.close()
  try {
    unlinkSync(path)
  } catch {
    // Node usually unlinks it with the close; a path that is gone is the goal.
  }
}
