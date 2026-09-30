// Screen Capture, the Overlay's half of it (spec §10): the camera toggle's
// standing state, and the one capture an unsubmitted Pick holds on the dev
// server.
//
// A capture is taken at every pick, toggle or no toggle, because the moment the
// developer pointed at is the thing worth keeping and it is gone by the time
// they decide. The toggle decides only what becomes of it at Send: kept for the
// agent, or deleted. So the page ships coordinates at pick time, and at Send it
// ships the id it was given and the toggle as it stands.
//
// At most one capture per unsubmitted Pick (spec §10, story 71). Every start and
// every abort goes through one chain, in order: a move deletes the capture it
// is leaving and only then starts the next, so a developer clicking through six
// elements never has two of their screen on disk for one Pick, let alone six.

import { NO_CAPTURE } from '../wire.js'
import type { CaptureCoordinates, CaptureRequest } from '../wire.js'
import { abortCapture, startCapture } from './client.js'
import * as words from './words.js'

/** What the Panel draws the toggle from. */
export interface CameraState {
  /** The developer's standing choice, persisted across Picks and reloads. */
  on: boolean
  /**
   * Why this dev server cannot capture at all, in its own words — not macOS,
   * no Screen Recording permission, a probe that failed. Null until a refusal
   * has said so. The toggle is shown disabled with this, never hidden (story 74).
   */
  unavailable: string | null
  /** On, and a dev server that can honour it: a Pick sent now keeps its capture. */
  keeping: boolean
  /** Why the open Pick's capture did not start, when it did not. */
  failed: string | null
  /** A capture this page let go of and could not delete, in a sentence. */
  undeleted: string | null
}

export interface Camera {
  state(): CameraState
  /** Flip the standing choice. A toggle that cannot capture does not flip. */
  toggle(): void
  /** A Pick was made, or moved: let go of the capture it held and take this one. */
  take(coordinates: CaptureCoordinates): void
  /** The Pick was discarded: its capture is deleted. */
  discard(): void
  /**
   * Send a Pick carrying its capture. Accepted, the capture is the server's —
   * kept or deleted as the toggle said. Refused, it is still this page's, and
   * a Send made again carries it again.
   */
  carry<T>(
    send: (capture: CaptureRequest | null) => Promise<T>,
    accepted: (result: T) => boolean,
  ): Promise<T>
  /** The page is going away: delete what the open Pick holds, on the way out. */
  leave(): void
}

/**
 * The camera, one per page. `changed` is told whenever something the Panel
 * draws has changed: the toggle, the reason it is off, a capture that failed.
 */
export function createCamera(view: Window, changed: () => void): Camera {
  let on = readToggle(view)
  let unavailable: string | null = null
  let failed: string | null = null
  let undeleted: string | null = null
  /** The chain every start and abort goes through; it ends in the id held now. */
  let held: Promise<string | null> = Promise.resolve(null)
  /** The same id, known without waiting, once the server has answered it. */
  let current: string | null = null
  /** The id a Send in flight is carrying. A move does not delete that one. */
  let lent: string | null = null

  let state = snapshot()
  function snapshot(): CameraState {
    return {
      on,
      unavailable,
      keeping: on && unavailable === null,
      failed,
      undeleted,
    }
  }
  const update = () => {
    state = snapshot()
    changed()
  }

  const setFailed = (reason: string | null) => {
    if (failed === reason) return
    failed = reason
    update()
  }

  /** Delete a capture this page is letting go of, and say so if it cannot. */
  const release = async (id: string | null) => {
    if (!id || id === lent) return
    const answer = await abortCapture(id)
    if (!answer.ok) {
      undeleted = words.captureNotDeleted(answer.reason)
      update()
    }
  }

  return {
    state: () => state,

    toggle() {
      if (unavailable) return
      on = !on
      writeToggle(view, on)
      update()
    },

    take(coordinates) {
      held = held.then(async (previous) => {
        await release(previous)
        current = null
        setFailed(null)
        // Told once, and then not asked again: a dev server that cannot capture
        // says so on every request, and a page that kept asking would write one
        // warning into its log per pick (ticket 17).
        if (unavailable) return null
        const started = await startCapture(coordinates)
        if (started.ok) {
          current = started.captureId
          return started.captureId
        }
        if (started.disabled) {
          unavailable = started.reason
          update()
        } else {
          setFailed(started.reason)
        }
        return null
      })
    },

    discard() {
      held = held.then(async (previous) => {
        await release(previous)
        current = null
        setFailed(null)
        return null
      })
    },

    async carry(send, accepted) {
      const id = await held
      const capture = requestFor(id)
      lent = id
      let result
      try {
        result = await send(capture)
      } finally {
        lent = null
      }
      if (!id) return result
      if (accepted(result)) {
        // The server has it now, and the Pick is submitted: it holds nothing
        // any more. One a move took while the Send was in flight belongs to no
        // Pick at all, so it is let go of like any other.
        held = held.then(async (still) => {
          if (still !== id) await release(still)
          return null
        })
        current = null
      } else if (current !== id) {
        // Refused, and the Pick was moved while it was in flight: nothing
        // will carry this one again, so it is deleted like any capture let go.
        void release(id)
      }
      return result
    },

    leave() {
      // Not through the chain: the page will not wait for it. A request that
      // outlives its page is what `keepalive` is for.
      if (current && current !== lent) void abortCapture(current, { keepalive: true })
    },
  }

  /**
   * What the Pick body says about its capture. A toggle that is on always says
   * something: the id it holds, or — when there is none to hold, because this
   * dev server cannot capture or this one did not start — that one was meant
   * to travel, so the server writes the line saying it was intended and why
   * it failed. Absent only when the toggle is off and there is nothing to
   * delete (spec §10, §21: never a silent missing capture).
   */
  function requestFor(id: string | null): CaptureRequest | null {
    if (id) return { id, keep: on && unavailable === null }
    return on ? { id: NO_CAPTURE, keep: true } : null
  }
}

/**
 * The toggle, by origin, like the remembered Target (spec §14). Storage a page
 * has disabled is not an error: the toggle starts off on every load, which is
 * the whole cost of it.
 */
function readToggle(view: Window): boolean {
  try {
    return view.localStorage.getItem(toggleKey(view)) === ON
  } catch {
    return false
  }
}

function writeToggle(view: Window, on: boolean): void {
  try {
    view.localStorage.setItem(toggleKey(view), on ? ON : OFF)
  } catch {
    // See `readToggle`.
  }
}

const ON = 'on'
const OFF = 'off'

function toggleKey(view: Window): string {
  return `pointout:screen-capture:${view.location.origin}`
}
