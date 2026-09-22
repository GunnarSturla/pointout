import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FixtureEnv } from './fixture-env.js'

// Fake session entries, written into the registry directory the plugin was
// pointed at. The field names are the harness's, not ours: the plugin pins on
// this shape and says so out loud when it does not find it.

let nextPid = 40_000

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
