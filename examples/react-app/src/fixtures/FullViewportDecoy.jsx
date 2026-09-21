import { useState } from 'react'

// Fixture: a fixed, full-viewport element that takes the pointer — the scrim
// every real app has. `elementFromPoint` returns this and nothing else, which
// is exactly why the hit test cannot be a single call to it (ticket 08).
//
// It is on by default, so ticket 08's rules are exercised without setup, and it
// dismisses in one click so the app stays usable as the development target. The
// control sits bottom-left; the Overlay's own surfaces claim the other corners.
export function FullViewportDecoy() {
  const [shown, setShown] = useState(true)

  if (!shown) {
    return (
      <button
        type="button"
        className="decoy-control"
        data-fixture="full-viewport-decoy-restore"
        onClick={() => setShown(true)}
      >
        Show decoy
      </button>
    )
  }

  return (
    <div className="decoy" data-fixture="full-viewport-decoy">
      <button
        type="button"
        className="decoy-control"
        data-fixture="full-viewport-decoy-dismiss"
        onClick={() => setShown(false)}
      >
        Dismiss decoy
      </button>
    </div>
  )
}
