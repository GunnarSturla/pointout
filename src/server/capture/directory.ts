import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomSuffix, sweepDead } from '../temp-files.js'

// Where an image of the physical display lives, and how little time it lives for
// (spec §10): one directory per dev server, named `<pid>-<6 hex>` under a shared
// root in the OS temp directory, mode 0700, removed whole at shutdown — and at
// startup the root is swept of everything that is not a live dev server's, because
// a dev server that was killed leaves images of somebody's screen behind.

/** Named in full, in the posture block, on purpose: see `docs/screen-capture.md`. */
const ROOT_NAME = 'vite-agent-inspect-captures'

/** `<pid>-<6 hex>`: the only shape the startup sweep spares. */
const OWNED = /^(\d+)-[0-9a-f]{6}$/

export interface CaptureDirectory {
  path: string
  /** What the startup sweep removed, for the posture line to state. */
  swept: number
  /** The shutdown sweep. Idempotent: a dev server may be closed twice. */
  close(): void
}

/**
 * Sweep the root, then take a directory in it. Throws only if the temp root
 * itself cannot be written, which the caller turns into a disabled reason.
 */
export function openCaptureDirectory(): CaptureDirectory {
  const root = join(tmpdir(), ROOT_NAME)
  mkdirSync(root, { recursive: true, mode: 0o700 })

  const swept = sweepDead(root, OWNED)
  const path = join(root, `${process.pid}-${randomSuffix()}`)
  mkdirSync(path, { mode: 0o700 })

  return {
    path,
    swept,
    close() {
      rmSync(path, { recursive: true, force: true })
    },
  }
}
