// Fixture: an element that leaves the page while the developer is still looking
// at it — a toast, a menu, a row that finished loading.
//
// Picking it and then losing it is user story 25: the Highlight fades where it
// stood, the Panel says the element is gone, and the Pick still sends. A button
// rather than a timer, because a test that waits for a timer is a test that
// sometimes waits for the wrong one — and because the test bed holds still.
//
// The element is rendered or not rendered, never swapped for another `<p>` in
// its place: React reconciles two branches of the same tag at the same position
// into *one* DOM node, which is an element that changed rather than an element
// that left, and nothing about this fixture would then be true.

import { useState } from 'react'

export function Unmounting() {
  const [shown, setShown] = useState(true)

  return (
    <section className="fixture" data-fixture="unmounting-section">
      <h2>Element that unmounts</h2>
      <button
        type="button"
        className="dense-mount"
        data-fixture={shown ? 'unmount-now' : 'unmount-restore'}
        onClick={() => setShown(!shown)}
      >
        {shown ? 'Remove it' : 'Bring it back'}
      </button>
      {shown && (
        <p className="card" data-fixture="unmounting-target">
          Pick this, then remove it. The pick outlives the element.
        </p>
      )}
    </section>
  )
}
