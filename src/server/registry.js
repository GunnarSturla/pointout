import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeToWorktreeRoot } from './paths.js'

// The registry is the directory of per-session JSON files under the user's
// Claude home — never the `claude agents` CLI, which drops the socket path and
// costs a subprocess (spec §14). It is an undocumented surface, so the shape is
// pinned here and a shape that has moved is reported rather than worked around.

/** Test-only. A consumer never sets it. */
const REGISTRY_DIR_ENV = 'VITE_AGENT_INSPECT_REGISTRY_DIR'

/** An entry carrying all six is usable. Anything less is a harness that moved. */
const REQUIRED_FIELDS = ['pid', 'sessionId', 'cwd', 'status', 'name', 'messagingSocketPath']

/** The three states, and the two of them that fall back to the hook floor. */
export const READABLE = 'readable'
export const DIRECTORY_MISSING = 'directory-missing'
export const SHAPE_UNRECOGNISED = 'shape-unrecognised'

export function registryDirectory() {
  return process.env[REGISTRY_DIR_ENV] || join(homedir(), '.claude', 'sessions')
}

/**
 * The registry, and the Candidates in it, in one read. Both callers want both,
 * and reading the directory twice could answer them differently.
 *
 * @param {{ registryDir: string, root: string, claudePid: number | null }} facts
 */
export function readCandidates({ registryDir, root, claudePid }) {
  const registry = readRegistry(registryDir)
  return { registry, candidates: candidatesIn(registry, root, claudePid) }
}

/**
 * Read the registry directory. Never throws: an unreadable registry is a state
 * this plugin reports, not an error it propagates.
 *
 * `rejected` counts the files that were there and could not be used. It is
 * carried rather than swallowed: dropping an entry without saying so is the
 * silent drop spec §21 forbids.
 *
 * @returns {{ state: string, hookFloor: boolean, rejected: number,
 *   directory: string, entries: object[] }}
 */
function readRegistry(directory) {
  let names
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'))
  } catch {
    return state(DIRECTORY_MISSING, directory, [], 0)
  }

  const entries = []
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
function candidatesIn(registry, repoRoot, claudePid) {
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

function parseEntry(file) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  for (const field of REQUIRED_FIELDS) {
    if (parsed[field] === undefined || parsed[field] === null) return null
  }
  if (typeof parsed.cwd !== 'string' || typeof parsed.messagingSocketPath !== 'string') {
    return null
  }
  return parsed
}

function state(name, directory, entries, rejected) {
  return { state: name, hookFloor: name !== READABLE, rejected, directory, entries }
}
