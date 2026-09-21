import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Fake session entries, written into the registry directory the plugin was
// pointed at. The field names are the harness's, not ours: the plugin pins on
// this shape and says so out loud when it does not find it.

let nextPid = 40_000

/**
 * @param {object} fixture The fixture env of a running harness server.
 * @param {object} entry
 * @param {string} entry.cwd Where the session thinks it is working.
 * @param {number} [entry.pid]
 * @param {string} [entry.sessionId]
 * @param {string} [entry.name]
 * @param {string} [entry.status]
 * @param {string|null} [entry.waitingFor]
 * @param {string} [entry.statusUpdatedAt]
 * @param {boolean} [entry.socket] false leaves the socket path off disk.
 * @param {string[]} [entry.omit] Fields to leave out, to fake a shape change.
 */
export function writeSession(fixture, entry) {
  const pid = entry.pid ?? nextPid++
  const socketPath = join(fixture.socketDir, `${pid}.sock`)
  if (entry.socket !== false) writeFileSync(socketPath, '')

  const record = {
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
