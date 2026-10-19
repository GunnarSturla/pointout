// Fixture: an element pinned against each of the four viewport edges — the last
// of spec §1's list alongside the scroll container.
//
// They are what the Highlight's chip and the Panel have to survive: a box at the
// top edge has no room above it for its chip, and one at the bottom edge has
// none below it for a Panel. The Highlight's half is ticket 09's; the Panel's is
// ticket 12's.
//
// Off until it is asked for. These are fixed elements, and four of them standing
// on the edges of every other journey's viewport would be four new decoys.

import { useState } from 'react'

const EDGES = ['top', 'right', 'bottom', 'left'] as const

export function ViewportEdges() {
  const [shown, setShown] = useState(false)

  return (
    <section className="fixture" data-fixture="viewport-edges-section">
      <h2>Elements at every viewport edge</h2>
      <button
        type="button"
        className="dense-mount"
        data-fixture="viewport-edges-toggle"
        onClick={() => setShown(!shown)}
      >
        {shown ? 'Hide the edge elements' : 'Show the edge elements'}
      </button>
      {shown &&
        EDGES.map((edge) => (
          <span key={edge} className={`edge edge-${edge}`} data-fixture={`edge-${edge}`}>
            {edge} edge
          </span>
        ))}
    </section>
  )
}
