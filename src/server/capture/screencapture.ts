import { execFile } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Region } from './region.js'

// macOS's own `screencapture`, run through `execFile` (spec §10). Two things
// about the tool shape this module:
//
//   1. it exits 0 having written nothing when the process that started the dev
//      server has no Screen Recording permission, so its result is inspected by
//      **content**, never by exit code, and
//   2. it can hang, so every run is bounded and every run can be killed.
//
// A run that produced no image is a failure with a reason. There is no third
// outcome, and in particular no empty file that travels (spec §21).

const TOOL = 'screencapture'

/** Long enough for any real capture, short enough that a Send is not held. */
const TIMEOUT_MS = 5_000

/** The eight bytes every PNG opens with. The content half of the probe. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * What `screencapture` does when Screen Recording permission is missing for the
 * parent process, worded for the developer who has to go and grant it.
 */
const NO_IMAGE_REASON =
  'the tool exited cleanly but wrote no image, which is what screencapture does ' +
  'when the process that started this dev server has no Screen Recording ' +
  'permission (System Settings → Privacy & Security → Screen Recording)'

/** A run that produced no image says why, and whether it was this server's doing. */
export type CaptureResult = { ok: true } | { ok: false; reason: string; aborted: boolean }

export interface RunningCapture {
  /** Kill the tool. The run settles as a failure naming the abort. */
  abort(): void
  /** Settles once the tool has finished, been killed, or run out of time. */
  settled: Promise<CaptureResult>
}

/** Start one capture. Never throws: a tool that could not be run is a reason. */
export function runScreencapture(region: Region, file: string): RunningCapture {
  let aborted = false
  let kill = () => {}

  const settled = new Promise<CaptureResult>((resolve) => {
    const child = execFile(
      TOOL,
      ['-x', '-R', `${region.x},${region.y},${region.width},${region.height}`, file],
      { timeout: TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (aborted) {
          return resolve({ ok: false, reason: 'it was aborted', aborted: true })
        }
        if (error) {
          return resolve({
            ok: false,
            reason: failureReason(error, stderr),
            aborted: false,
          })
        }
        resolve(
          holdsAnImage(file)
            ? { ok: true }
            : { ok: false, reason: NO_IMAGE_REASON, aborted: false },
        )
      },
    )

    kill = () => {
      aborted = true
      child.kill()
    }
  })

  // The executor above ran synchronously, so `kill` is the child's by now.
  return { abort: () => kill(), settled }
}

/**
 * The startup probe (spec §10): a one-pixel capture, judged by what landed. It is
 * what turns "capture works here" from an assumption into a startup fact.
 * Returns the reason capture is disabled, or null when it is available.
 */
export async function probeScreencapture(directory: string): Promise<string | null> {
  const file = join(directory, 'probe.png')
  const region: Region = { x: 0, y: 0, width: 1, height: 1, offsetBy: null }
  try {
    const result = await runScreencapture(region, file).settled
    return result.ok ? null : result.reason
  } finally {
    rmSync(file, { force: true })
  }
}

/** Content, not exit code: a real PNG, with bytes in it. */
function holdsAnImage(file: string): boolean {
  try {
    const head = readFileSync(file)
    return head.length > PNG_SIGNATURE.length && head.subarray(0, 8).equals(PNG_SIGNATURE)
  } catch {
    // Nothing was written at all, which is the same story as an empty file.
    return false
  }
}

function failureReason(error: Error, stderr: string): string {
  const said = stderr.trim().split('\n')[0]
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    return `${TOOL} is not on this dev server's PATH`
  }
  // `execFile` kills a run that outlived its timeout, and reports it as killed.
  if ((error as { killed?: boolean }).killed) {
    return `the capture took too long (more than ${TIMEOUT_MS / 1000} s) and was stopped`
  }
  return `${TOOL} failed${said ? `: ${said}` : ''}`
}
