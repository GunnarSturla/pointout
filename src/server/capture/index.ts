import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from 'vite'
import type { CaptureCoordinates, CaptureRequest } from '../../wire.js'
import { regionFor } from './region.js'
import { openCaptureDirectory } from './directory.js'
import type { CaptureDirectory } from './directory.js'
import { probeScreencapture, runScreencapture } from './screencapture.js'
import type { CaptureResult, RunningCapture } from './screencapture.js'

// Screen Capture, the whole of the server's side of it (spec §10, §20, §21).
// A Screen Capture is bounded by the physical display rather than by the page,
// which is why it is carried as a file path the agent opens and never as
// content, and why every one of them is accounted for: started here, aborted or
// kept here, and gone from disk by the time this dev server is.
//
// The feature fails closed. Not macOS, no Screen Recording permission, a probe
// that produced nothing, a tool that hung, an image that never landed — each is
// a stated reason, in the startup posture block and again at the point of use.
// The one outcome that is never allowed is an empty capture that travels.

/** Test-only, like the harness overrides. A consumer never sets it. */
const PLATFORM_ENV = 'VITE_AGENT_INSPECT_PLATFORM'

const MACOS = 'darwin'

export interface CaptureService {
  /** Null when Screen Capture is available; otherwise why it is not. */
  disabledReason: string | null
  /** This server's line in the startup posture block. */
  postureLine: string
  /** Start one capture and answer its id at once; the tool runs behind it. */
  start(coordinates: CaptureCoordinates): string
  /** Abort and delete. False when this server minted no such capture. */
  abort(id: string): boolean
  /**
   * What the Pointer says about the capture a Pick asked for, and null when it
   * says nothing. Waits for a capture still running, deletes the file when the
   * toggle was off, and keeps it for the agent when it was on.
   */
  resolve(request: CaptureRequest | null): Promise<string | null>
  /** Kill anything still running and take the directory with it. */
  close(): void
}

interface Capture {
  file: string
  /** The horizontal chrome difference, when it is enough to say so. */
  offsetBy: number | null
  running: RunningCapture
  settled: Promise<CaptureResult>
}

export interface CaptureServiceOptions {
  logger: Logger
}

/**
 * Work out whether this dev server can capture, sweep what an earlier one left
 * behind, and hand back the service. Never throws: a Screen Capture that
 * cannot be taken is a state this plugin reports, exactly like a reply socket
 * it could not bind.
 */
export async function createCaptureService({
  logger,
}: CaptureServiceOptions): Promise<CaptureService> {
  const captures = new Map<string, Capture>()

  let directory: CaptureDirectory | null = null
  try {
    directory = openCaptureDirectory()
  } catch (error) {
    return disabled(
      `its temp directory could not be opened (${(error as Error).message})`,
      null,
    )
  }

  const platform = process.env[PLATFORM_ENV] || process.platform
  if (platform !== MACOS) {
    return disabled(
      `this dev server is not running on macOS (platform: ${platform}), and v0 ` +
        "crops the display with macOS's own screencapture tool",
      directory,
    )
  }

  const probeFailed = await probeScreencapture(directory.path)
  if (probeFailed) {
    return disabled(`the startup probe found that ${probeFailed}`, directory)
  }

  const open = directory
  return {
    disabledReason: null,
    postureLine:
      `available — captures are written to ${open.path} and swept at startup ` +
      `and shutdown${sweptClause(open)}`,

    start(coordinates) {
      const id = randomUUID()
      const region = regionFor(coordinates)
      const file = join(open.path, `${id}.png`)
      const running = runScreencapture(region, file)
      const settled = running.settled.then((result) => {
        if (!result.ok) {
          rmSync(file, { force: true })
          // An abort is this server doing as it was told, and a developer
          // moving a Pick through six elements should not read six warnings.
          if (!result.aborted) {
            logger.warn(
              `vite-agent-inspect: capture ${id} produced nothing: ${result.reason}`,
            )
          }
        }
        return result
      })
      captures.set(id, { file, offsetBy: region.offsetBy, running, settled })
      return id
    },

    abort(id) {
      const capture = captures.get(id)
      if (!capture) return false
      captures.delete(id)
      capture.running.abort()
      // After it has stopped, not before: a tool killed mid-write would put the
      // file back under a delete that ran first.
      void capture.settled.finally(() => rmSync(capture.file, { force: true }))
      return true
    },

    async resolve(request) {
      if (!request) return null
      const capture = captures.get(request.id)
      captures.delete(request.id)

      if (!capture) {
        if (!request.keep) return null
        return intended(
          'this dev server holds no capture with that id — it was aborted, or ' +
            'the dev server restarted under the pick',
        )
      }

      const result = await capture.settled
      if (!request.keep) {
        rmSync(capture.file, { force: true })
        return null
      }
      if (!result.ok) return intended(result.reason)
      // Kept until the shutdown sweep, so the agent can open it (spec §10).
      return capture.file + offsetClause(capture.offsetBy)
    },

    close() {
      for (const [id, capture] of captures) {
        captures.delete(id)
        capture.running.abort()
      }
      open.close()
    },
  }
}

/** Available or not, the directory is still swept and still stated (spec §21). */
function disabled(reason: string, directory: CaptureDirectory | null): CaptureService {
  const where = directory
    ? ` Nothing is captured; ${directory.path} was swept anyway${sweptClause(directory)}.`
    : ''
  return {
    disabledReason: reason,
    postureLine: `disabled — ${reason}.${where}`,
    start() {
      // Unreachable: the endpoint refuses with the reason before it gets here,
      // and this is what keeps that from being a comment nobody enforces.
      throw new Error(`vite-agent-inspect: Screen Capture is disabled — ${reason}`)
    },
    abort: () => false,
    resolve: (request) => Promise.resolve(request?.keep ? intended(reason) : null),
    close: () => directory?.close(),
  }
}

/** The Pointer's line when a capture was meant to travel and did not (spec §13). */
function intended(reason: string): string {
  return `a capture was intended, and failed: ${reason}`
}

function offsetClause(offsetBy: number | null): string {
  if (offsetBy === null) return ''
  return (
    ` (this capture may be offset: the browser window is ${offsetBy} px wider ` +
    'than its viewport, and this server crops as though all of that chrome were on top)'
  )
}

function sweptClause({ swept }: CaptureDirectory): string {
  if (swept === 0) return ''
  return ` (${swept} left by an earlier dev server ${swept === 1 ? 'was' : 'were'} swept)`
}
