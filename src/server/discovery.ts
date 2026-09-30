import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoundAddress } from './bound-host.js'
import { says, warns } from './posture.js'
import type { PostureLine } from './posture.js'
import { alive, randomSuffix, sweepDead, sweptClause } from './temp-files.js'

// The hook discovery entry (spec §18): how a hook, which knows only a cwd,
// finds the dev servers serving that checkout and is allowed to drain them.
//
// Three properties the file format carries, and nothing else does:
//
//   1. **Keyed by the normalized repo root.** The name is a hash of the root, so
//      a hook lists one prefix rather than reading every dev server's entry on
//      the machine — and the root is *also* a field, because a hash is an index
//      and the field is the truth.
//   2. **One entry per dev server, not per root.** Several dev servers for one
//      root each have their own (spec §18), so the name carries the pid and a
//      random suffix: one process can be two Vite servers.
//   3. **The secret is the whole credential of `POST /__agent/drain`.** A remote
//      page can POST to loopback without CORS but cannot read a file, which is
//      why the mode is 0600 and the directory 0700 (spec §11).
//
// Like the capture directory, this lives under the OS temp root and is swept by
// pid liveness at startup, because a dev server that was killed leaves an entry
// naming a port that is now somebody else's.

/** Per-user by name as well as by mode: a shared `/tmp` is the normal case. */
const ROOT_NAME = 'pointout-servers'

/** `<root hash>-<pid>-<6 hex>.json`: the only shape the startup sweep spares. */
const OWNED = /^[0-9a-f]{16}-(\d+)-[0-9a-f]{6}\.json$/

/** One dev server, as the file on disk states it. The CLI reads exactly this. */
export interface DiscoveryEntry {
  /** The normalized repo root this dev server is serving (spec §2). */
  root: string
  /**
   * The address it is bound to, spelled for a URL (`bound-host.ts`): the drain
   * dials this rather than assuming 127.0.0.1, which an IPv6-only server does
   * not answer on.
   */
  host: string
  /** The loopback port `POST /__agent/drain` answers on. */
  port: number
  /** The per-server secret, and the drain endpoint's only credential. */
  secret: string
  pid: number
}

/** The directory every entry on this machine, for this user, lives in. */
export function discoveryDirectory(): string {
  return join(tmpdir(), `${ROOT_NAME}-${userKey()}`)
}

export interface Discovery {
  /** The secret this dev server's entry publishes, and the drain compares. */
  secret: string
  /**
   * Written, and where — or why not (spec §21). Read after `publish`, which is
   * the only place a failure to write is said: the posture block says it.
   */
  readonly postureLine: PostureLine
  /** Write the entry. Called once the port exists, which is at `listening`. */
  publish(address: BoundAddress): void
  /** Remove it. Idempotent: a dev server may be closed twice. */
  close(): void
}

export interface DiscoveryOptions {
  /** The normalized repo root this dev server serves. */
  root: string
}

/**
 * Mint this dev server's secret and sweep what dead dev servers left behind.
 * Nothing is written until `publish`, because the entry's whole purpose is to
 * name a port and there is no port until Vite is listening.
 */
export function createDiscovery({ root }: DiscoveryOptions): Discovery {
  const secret = randomBytes(24).toString('hex')
  let path: string | null = null
  // A failure to publish is stated, never thrown: the floor degrades.
  let line = warns('not written — this dev server has not started listening')

  return {
    secret,
    get postureLine() {
      return line
    },

    publish({ host, port }) {
      if (path) return
      if (!Number.isInteger(port) || port <= 0) {
        line = warns(
          'not written — this dev server is not listening on a TCP port, so no ' +
            'hook could reach it; picks left for the next prompt will expire',
        )
        return
      }

      try {
        const directory = discoveryDirectory()
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        // Stated rather than inherited: `mkdir`'s mode is masked by the umask,
        // and this directory's whole job is to be unreadable by anyone else.
        chmodSync(directory, 0o700)
        const swept = sweepDead(directory, OWNED)

        const entry: DiscoveryEntry = { root, host, port, secret, pid: process.pid }
        const written = join(
          directory,
          `${rootKey(root)}-${process.pid}-${randomSuffix()}.json`,
        )
        writeFileSync(written, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 })
        chmodSync(written, 0o600)

        path = written
        line = says(`${written} (user-only; removed at shutdown${sweptClause(swept)})`)
      } catch (error) {
        line = warns(
          `not written — ${(error as Error).message}. Picks left for the next ` +
            'prompt cannot be drained by a hook and will expire',
        )
      }
    },

    close() {
      if (!path) return
      rmSync(path, { force: true })
      path = null
      line = says('removed at shutdown')
    },
  }
}

/**
 * Every live dev server serving `root`, as the drain CLI finds them. A root is
 * matched on the field rather than on the file name, so a hash that collided
 * would cost a read and nothing else; a dead pid is skipped, because its port
 * belongs to somebody else by now.
 */
export function readDiscoveryEntries(root: string): DiscoveryEntry[] {
  const directory = discoveryDirectory()
  const prefix = rootKey(root) + '-'

  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    // No directory means no dev server has ever run here. The normal case.
    return []
  }

  const found: DiscoveryEntry[] = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const entry = read(join(directory, name))
    if (entry && entry.root === root && alive(entry.pid)) found.push(entry)
  }
  return found
}

function read(path: string): DiscoveryEntry | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const { root, host, port, secret, pid } = parsed as Record<string, unknown>
    if (typeof root !== 'string' || typeof secret !== 'string') return null
    if (typeof port !== 'number' || typeof pid !== 'number') return null
    // An entry written before the field existed was written by a server that
    // printed 127.0.0.1 everywhere, so that is where it is dialled.
    return {
      root,
      host: typeof host === 'string' ? host : '127.0.0.1',
      port,
      secret,
      pid,
    }
  } catch {
    // A file being written as we read it, or one this version does not
    // recognise. Either way it names no dev server we can reach.
    return null
  }
}

/** The index a hook lists by. The `root` field is what it then checks. */
function rootKey(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16)
}

/** Windows has no uid; there the name is the next-best per-user thing. */
function userKey(): string {
  const uid = process.getuid?.()
  if (uid !== undefined) return String(uid)
  return (process.env.USERNAME ?? 'user').replace(/[^\w.-]/g, '_')
}
