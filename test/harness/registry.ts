import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FixtureEnv } from './fixture-env.js'

// Fake session entries, written into the registry directory the plugin was
// pointed at. The field names are the harness's, not ours: the plugin pins on
// this shape and says so out loud when it does not find it.

// Far above any pid this machine hands out, because a fake session's socket is
// `<socketDir>/<pid>.sock` and so is the dev server's own reply socket: a fake
// session that happened to pick the test runner's pid would make the server
// refuse to bind, for a reason that has nothing to do with the test.
let nextPid = 400_000

/** Only the two directories are needed, so a partial fixture will do. */
type RegistryFixture = Pick<FixtureEnv, 'registryDir' | 'socketDir'>

export interface SessionSpec {
  /** Where the session thinks it is working. */
  cwd: string
  pid?: number
  sessionId?: string
  name?: string
  status?: string
  waitingFor?: string | null
  statusUpdatedAt?: string
  updatedAt?: string
  /** false leaves the socket path off disk. */
  socket?: boolean
  /** Fields to leave out, to fake a shape change. */
  omit?: string[]
}

export function writeSession(
  fixture: RegistryFixture,
  entry: SessionSpec,
): Record<string, unknown> {
  const pid = entry.pid ?? nextPid++
  const socketPath = join(fixture.socketDir, `${pid}.sock`)
  if (entry.socket !== false) writeFileSync(socketPath, '')

  // Deliberately loose: this is the harness's JSON, written field by field so a
  // test can leave one out, not a shape this repo gets to define.
  const record: Record<string, unknown> = {
    pid,
    sessionId: entry.sessionId ?? `session-${pid}`,
    cwd: entry.cwd,
    status: entry.status ?? 'idle',
    name: entry.name ?? `session ${pid}`,
    messagingSocketPath: socketPath,
  }
  if (entry.waitingFor !== undefined) record.waitingFor = entry.waitingFor
  if (entry.statusUpdatedAt !== undefined) record.statusUpdatedAt = entry.statusUpdatedAt
  if (entry.updatedAt !== undefined) record.updatedAt = entry.updatedAt
  for (const field of entry.omit ?? []) delete record[field]

  writeFileSync(join(fixture.registryDir, `${pid}.json`), JSON.stringify(record, null, 2))
  return record
}

/**
 * Rewrite one session's entry in place, the way the harness does when its status
 * changes: the same file, the same fields, a new `status` (and whatever else the
 * test names). It is how a test makes the Target go busy, idle or waiting
 * after a Pick has been written to it.
 */
export function updateSession(
  fixture: Pick<FixtureEnv, 'registryDir'>,
  pid: number,
  fields: Record<string, unknown>,
): void {
  const file = join(fixture.registryDir, `${pid}.json`)
  const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, JSON.stringify({ ...record, ...fields }, null, 2))
}
