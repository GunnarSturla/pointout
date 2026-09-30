import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DIRECTORY_MISSING, READABLE, SHAPE_UNRECOGNISED } from '../wire.js'
import type { Candidate, RegistryState, Target } from '../wire.js'
import { normalizeToWorktreeRoot } from './paths.js'

// The registry is the directory of per-session JSON files under the user's
// Claude home — never the `claude agents` CLI, which drops the socket path and
// costs a subprocess (spec §14). It is an undocumented surface, so the shape is
// pinned here and a shape that has moved is reported rather than worked around.

/** Test-only. A consumer never sets it. */
const REGISTRY_DIR_ENV = 'POINTOUT_REGISTRY_DIR'

/** An entry carrying all six is usable. Anything less is a harness that moved. */
const REQUIRED_FIELDS = [
  'pid',
  'sessionId',
  'cwd',
  'status',
  'name',
  'messagingSocketPath',
] as const

/**
 * One registry file, as the harness writes it. This is the pinned shape: the
 * six required fields, plus the three the Panel reads when they are there.
 */
export interface SessionEntry {
  pid: number
  sessionId: string
  cwd: string
  status: string
  name: string
  messagingSocketPath: string
  waitingFor?: string | null
  statusUpdatedAt?: string | null
  /** Read by §14's idle row, never published. Not a heartbeat. */
  updatedAt?: string | null
  /**
   * The Claude Code version the session is running. Not pinned: the posture
   * block prints it beside the verified one, and a missing one is said.
   */
  version?: string | null
}

/** What the registry directory turned out to be, and what was in it. */
export interface Registry {
  state: RegistryState
  hookFloor: boolean
  rejected: number
  directory: string
  entries: SessionEntry[]
}

/** What a registry read needs to know to answer both of its callers. */
export interface RegistryQuery {
  registryDir: string
  root: string
  claudePid: number | null
}

export function registryDirectory(): string {
  return process.env[REGISTRY_DIR_ENV] || join(homedir(), '.claude', 'sessions')
}

/**
 * The registry, and the Candidates in it, in one read. Both callers want both,
 * and reading the directory twice could answer them differently.
 */
export function readCandidates({ registryDir, root, claudePid }: RegistryQuery): {
  registry: Registry
  candidates: Candidate[]
} {
  const registry = readRegistry(registryDir)
  return { registry, candidates: candidatesIn(registry, root, claudePid) }
}

/**
 * Whether a registry entry or Candidate is the session a Target names. Both
 * halves of the identity are compared: a pid can be reused by another session,
 * and that is the misdelivery this check is here to catch (spec §15).
 */
export function addresses(
  session: { sessionId: string; pid: number },
  target: Target,
): boolean {
  return session.sessionId === target.sessionId && Number(session.pid) === target.pid
}

/**
 * The registry entry a Target was resolved from, which is where its inbox is.
 * Read off the registry already in hand rather than from disk again, so the
 * entry a delivery writes to is the one the Target was chosen from.
 */
export function sessionOf(registry: Registry, target: Target): SessionEntry | undefined {
  return registry.entries.find((entry) => addresses(entry, target))
}

/**
 * Every socket path the registry names, whatever shape the entry is in. The
 * reply socket refuses to bind over one of these (spec §16), and that refusal
 * is about ownership rather than usability: an entry this plugin cannot read is
 * still a session that owns its socket.
 */
export function claimedSocketPaths(directory: string): string[] {
  let names: string[]
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }

  const paths: string[] = []
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, name), 'utf8'))
      const path = (parsed as { messagingSocketPath?: unknown } | null)
        ?.messagingSocketPath
      if (typeof path === 'string' && path.length > 0) paths.push(path)
    } catch {
      // Not JSON, or gone since the listing. It names no path either way.
    }
  }
  return paths
}

/**
 * Read the registry directory. Never throws: an unreadable registry is a state
 * this plugin reports, not an error it propagates.
 *
 * `rejected` counts the files that were there and could not be used. It is
 * carried rather than swallowed: dropping an entry without saying so is the
 * silent drop spec §21 forbids.
 */
function readRegistry(directory: string): Registry {
  let names: string[]
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'))
  } catch {
    return state(DIRECTORY_MISSING, directory, [], 0)
  }

  const entries: SessionEntry[] = []
  let rejected = 0
  for (const name of names) {
    const entry = parseEntry(join(directory, name))
    if (entry) entries.push(entry)
    else rejected += 1
  }

  // Every file unusable is a shape that moved, and targeting falls to the hook
  // floor. Some of them unusable is not: the sessions that did parse are real,
  // and the count of the ones that did not is reported beside them.
  if (entries.length === 0 && rejected > 0) {
    return state(SHAPE_UNRECOGNISED, directory, [], rejected)
  }
  return state(READABLE, directory, entries, rejected)
}

/**
 * The sessions a Pick could be addressed to: same checkout, socket on disk.
 * Exact equality of normalized cwd, never ancestor matching.
 */
function candidatesIn(
  registry: Registry,
  repoRoot: string,
  claudePid: number | null,
): Candidate[] {
  return registry.entries
    .filter((entry) => normalizeToWorktreeRoot(entry.cwd) === repoRoot)
    .filter((entry) => existsSync(entry.messagingSocketPath))
    .map((entry) => ({
      name: entry.name,
      status: entry.status,
      waitingFor: entry.waitingFor ?? null,
      statusUpdatedAt: entry.statusUpdatedAt ?? null,
      pid: entry.pid,
      sessionId: entry.sessionId,
      startedThisServer: claudePid !== null && Number(entry.pid) === claudePid,
    }))
}

function parseEntry(file: string): SessionEntry | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  for (const field of REQUIRED_FIELDS) {
    if (record[field] === undefined || record[field] === null) return null
  }
  if (typeof record.cwd !== 'string' || typeof record.messagingSocketPath !== 'string') {
    return null
  }
  return record as unknown as SessionEntry
}

function state(
  name: RegistryState,
  directory: string,
  entries: SessionEntry[],
  rejected: number,
): Registry {
  return { state: name, hookFloor: name !== READABLE, rejected, directory, entries }
}
