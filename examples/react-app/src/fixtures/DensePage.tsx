// Fixture: a page dense enough that the Overlay will not force the whole
// document hittable. `pointer-events` is inherited, so the one `*` rule restyles
// every element in the document: react-grab profiled that at roughly 4 ms on
// 5,600 elements and 30 to 35 ms on 16,000. Above its threshold the Overlay lays
// a shield instead and hit-tests through it (ticket 08).
//
// It is off until it is asked for, because every other journey in the test bed
// would otherwise pay for it.

import { useState } from 'react'

const ROWS = 1000
const CELLS = 6

/** One row, and the only place the element count actually comes from. */
function DenseRow({ row }: { row: number }) {
  return (
    <div className="dense-row">
      {Array.from({ length: CELLS }, (_, cell) => (
        <span key={cell}>
          {row}.{cell}
        </span>
      ))}
    </div>
  )
}

export function DensePage() {
  const [shown, setShown] = useState(false)

  return (
    <section className="fixture" data-fixture="dense-section">
      <h2>Dense page</h2>
      <p data-fixture="dense-target">
        The element a pick still has to land on once the page is dense.
      </p>
      <button
        type="button"
        className="dense-mount"
        data-fixture="dense-mount"
        onClick={() => setShown(true)}
      >
        Add {ROWS * (CELLS + 1)} elements
      </button>
      {shown && (
        <div className="dense-block" data-fixture="dense-block">
          {Array.from({ length: ROWS }, (_, row) => (
            <DenseRow key={row} row={row} />
          ))}
        </div>
      )}
    </section>
  )
}
