import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Logger } from 'vite'
import { says, warns } from '../posture.js'
import type { PostureLine } from '../posture.js'
import { NO_CAPTURE } from '../../wire.js'
import type { CaptureCoordinates, CaptureRequest } from '../../wire.js'
import { sweptClause } from '../temp-files.js'
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
const PLATFORM_ENV = 'POINTOUT_PLATFORM'

const MACOS = 'darwin'

export interface CaptureService {
  /** Null when Screen Capture is available; otherwise why it is not. */
  disabledReason: string | null
  /** Available, or disabled with its reason: a line in the posture block. */
  postureLine: PostureLine
  /** Where the captures go and that the shared root was swept: the next line. */
  directoryLine: PostureLine
  /** Start one capture and answer its id at once; the tool runs behind it. */
  start(coordinates: CaptureCoordinates): string
  /** Abort and delete. False when this server minted no such capture. */
  abort(id: string): boolean
  /**
   * What the Pointer says about the capture a Pick asked for, once a capture
   * still running has finished. Nothing is kept or deleted until the claim is
   * taken: a Pick refused after this (too large, say) leaves the capture where
   * it was, for the resend the developer makes (spec §21).
   */
  resolve(request: CaptureRequest | null): Promise<CaptureClaim>
  /**
   * Delete a capture this server kept for an accepted Pick, now rather than at
   * the shutdown sweep: the Pick was withdrawn, and nothing is left to open it.
   */
  discard(file: string): void
  /** Kill anything still running and take the directory with it. */
  close(): void
}

/**
 * The Pointer's line for one capture, and the act of letting it go. `take` is
 * called once the Pick is accepted, with nothing awaited between `resolve` and
 * it: it deletes the file when the toggle was off, keeps it for the agent when it
 * was on, and either way this server no longer holds it under that id.
 */
export interface CaptureClaim {
  /** Null when the Pointer says nothing about a capture. */
  line: string | null
  /**
   * The file kept for the agent — the one a Withdraw deletes — or null when
   * nothing is kept: no capture, the toggle off, one that failed, or one a
   * second Pick naming the same id took first.
   */
  take(): string | null
}

/** A claim on nothing: there is no capture to keep or to delete. */
const claimOn = (line: string | null): CaptureClaim => ({ line, take: () => null })

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
    const why = (error as Error).message
    return disabled(
      `its temp directory could not be opened (${why})`,
      warns(`not opened — ${why}`),
    )
  }

  const platform = process.env[PLATFORM_ENV] || process.platform
  if (platform !== MACOS) {
    return disabled(
      `this dev server is not running on macOS (platform: ${platform}), and v0 ` +
        "takes a Screen Capture with macOS's own screencapture tool",
      directoryLine(directory),
      directory,
    )
  }

  const probeFailed = await probeScreencapture(directory.path)
  if (probeFailed) {
    return disabled(
      `the startup probe found that ${probeFailed}`,
      directoryLine(directory),
      directory,
    )
  }

  const open = directory
  return {
    disabledReason: null,
    postureLine: says('available'),
    directoryLine: directoryLine(open),

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
            logger.warn(`pointout: capture ${id} produced nothing: ${result.reason}`)
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
      if (!request) return claimOn(null)
      // The toggle was on and the page holds nothing to name: the capture it
      // asked for at pick time never started. Said, not left out (spec §21).
      if (request.id === NO_CAPTURE) {
        return claimOn(
          request.keep
            ? intended('the page asked for one at pick time and none was started')
            : null,
        )
      }

      const pending = captures.get(request.id)
      const result = pending ? await pending.settled : null
      // Read again after the wait: a DELETE that arrived meanwhile has aborted
      // it, and the line must not name a file that is gone.
      const capture = captures.get(request.id)

      if (!capture || !result) {
        if (!request.keep) return claimOn(null)
        return claimOn(
          intended(
            'this dev server holds no capture with that id — it was aborted, or ' +
              'the dev server restarted under the pick',
          ),
        )
      }

      const take = () => {
        if (captures.get(request.id) !== capture) return null
        captures.delete(request.id)
        // Kept until the shutdown sweep, so the agent can open it (spec §10).
        if (!request.keep) rmSync(capture.file, { force: true })
        return request.keep && result.ok ? capture.file : null
      }
      if (!request.keep) return { line: null, take }
      if (!result.ok) return { line: intended(result.reason), take }
      return { line: capture.file + offsetClause(capture.offsetBy), take }
    },

    discard(file) {
      // Only a file in this server's own directory: the path came from here,
      // and this is what keeps that from being a comment nobody enforces.
      if (dirname(file) !== open.path) return
      rmSync(file, { force: true })
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
function disabled(
  reason: string,
  where: PostureLine,
  directory?: CaptureDirectory,
): CaptureService {
  return {
    disabledReason: reason,
    postureLine: warns(`disabled — ${reason}`),
    directoryLine: where,
    start() {
      // Unreachable: the endpoint refuses with the reason before it gets here,
      // and this is what keeps that from being a comment nobody enforces.
      throw new Error(`pointout: Screen Capture is disabled — ${reason}`)
    },
    abort: () => false,
    resolve: (request) =>
      Promise.resolve(claimOn(request?.keep ? intended(reason) : null)),
    // A disabled service never kept a file for anyone.
    discard: () => {},
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
    'than its viewport, and this server places the capture as though all of that chrome were on top)'
  )
}

/**
 * The temp directory, where it is and what was swept (spec §2). Named in full on
 * purpose: a Screen Capture of somebody's display must never be found by accident.
 */
function directoryLine({ path, swept }: CaptureDirectory): PostureLine {
  return says(
    `${path} (user-only; removed at shutdown, and what dead dev servers left ` +
      `beside it is swept at startup${sweptClause(swept)})`,
  )
}
