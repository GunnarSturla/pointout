// The camera toggle (spec §7, §10): leftmost in the Panel footer, and the one
// line under the footer that says why there will be no Screen Capture when
// there will not be one.
//
// A toggle this dev server cannot honour is shown disabled rather than hidden,
// so the developer knows the feature exists and why it is off (story 74). It is
// marked rather than made inert, like the Target row: a disabled button is not
// read by everything, and clicking this one is how the reason is asked for.

import { memo } from 'react'
import type { CameraState } from './capture.js'
import { partProps } from './root.js'
import * as words from './words.js'

export interface CameraToggleProps {
  camera: CameraState
  onToggle(): void
  /** Asked for the reason a toggle that cannot capture is off. */
  onExplain(): void
}

export const CameraToggle = memo(function CameraToggle({
  camera,
  onToggle,
  onExplain,
}: CameraToggleProps) {
  const { keeping, unavailable } = camera
  return (
    <button
      type="button"
      {...partProps('camera')}
      aria-label={words.SCREEN_CAPTURE}
      aria-pressed={keeping}
      aria-disabled={unavailable ? true : undefined}
      data-on={keeping ? '' : undefined}
      title={unavailable ? words.captureUnavailable(unavailable) : words.SCREEN_CAPTURE}
      onClick={unavailable ? onExplain : onToggle}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="M2 5h2.5l1.2-1.8h4.6L11.5 5H14v7.5H2z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <circle
          cx="8"
          cy="8.6"
          r="2.3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      </svg>
    </button>
  )
})

export interface CameraLineProps {
  camera: CameraState
  /** The developer asked why the toggle is off. */
  explaining: boolean
}

/**
 * Nothing, in the ordinary case. A toggle that is on and cannot be honoured
 * always says so, because the developer asked for a capture and would otherwise
 * find its absence only in what the agent received (spec §21); one that is off
 * says why only when asked. A capture that could not be deleted is said
 * whatever the toggle: it is the developer's screen, still on disk.
 */
export const CameraLine = memo(function CameraLine({
  camera,
  explaining,
}: CameraLineProps) {
  const { on, unavailable, failed, undeleted } = camera
  return (
    <>
      {unavailable && (on || explaining) && (
        <div {...partProps('camera-off')}>{words.captureUnavailable(unavailable)}</div>
      )}
      {!unavailable && on && failed && (
        <div {...partProps('camera-failed')}>{words.captureFailed(failed)}</div>
      )}
      {undeleted && <div {...partProps('camera-failed')}>{undeleted}</div>}
    </>
  )
})
