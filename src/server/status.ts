import type { PickStatus } from '../wire.js'
import { isQueued } from './ledger.js'
import type { Ledger } from './ledger.js'
import type { IdleLog } from './receipt.js'
import { addresses, readCandidates } from './registry.js'
import type { RegistryQuery } from './registry.js'

// What `GET /__agent/status` answers (spec §20): every Pick this dev server
// accepted, in the state the ledger holds it, with the Target row beside it.
//
// The two halves come from different places on purpose (spec §17). The state is
// Pick-specific evidence and lives in the ledger; the Target row is
// session-level evidence — read live from the registry on every poll, and from
// the idle notices this server has heard — and it colours the row without ever
// moving the Pick.

export function pickStatuses(
  facts: RegistryQuery,
  ledger: Ledger,
  idle: IdleLog,
): PickStatus[] {
  // One registry read for the whole poll: two reads could answer two Picks
  // addressed to the same session differently.
  const { candidates } = readCandidates(facts)

  return ledger.all().map((record) => {
    const target = record.pick.target
    const live = target
      ? candidates.find((candidate) => addresses(candidate, target))
      : undefined

    return {
      pickId: record.pick.id,
      state: record.state,
      reason: record.reason,
      queued: isQueued(record.state),
      createdAt: record.pick.createdAt,
      expiresAt: record.expiresAt,
      history: record.history,
      target: target
        ? {
            sessionId: target.sessionId,
            pid: target.pid,
            name: live?.name ?? null,
            status: live?.status ?? null,
            waitingFor: live?.waitingFor ?? null,
            idleAt: idle.latest(target),
          }
        : null,
    }
  })
}
