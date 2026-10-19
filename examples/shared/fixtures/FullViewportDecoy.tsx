import { useState, useSyncExternalStore } from 'react'

// Fixture: a fixed, full-viewport element that takes the pointer — the scrim
// every real app has. `elementFromPoint` returns this and nothing else, which
// is exactly why the hit test cannot be a single call to it (ticket 08).
//
// It is off at load, so the app is usable as the development target; `/?decoy`
// in the url turns it on at load, which is how ticket 08's tests open it. Either
// way one click shows or hides it. The control sits bottom-left; the
// Overlay's own surfaces claim the other corners.
//
// The url is read through `useSyncExternalStore`, so a server render, which has
// no url, says "off", and a hydrating page then catches up without a hydration
// warning (examples/next-app). A page React renders from scratch, as Vite's
// does, reads the url on its first render.
export function FullViewportDecoy() {
  const atLoad = useSyncExternalStore(neverChanges, decoyInUrl, () => false)
  const [toggled, setShown] = useState<boolean | null>(null)
  const shown = toggled ?? atLoad

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

function decoyInUrl(): boolean {
  return new URLSearchParams(window.location.search).has('decoy')
}

/** The query is read once, at load; nothing here listens for a change. */
function neverChanges(): () => void {
  return () => {}
}
