// Fixture: content that scrolls inside the page rather than with it. The last
// of spec §1's list, and the one the Highlight's tracking is measured against.
//
// A `scroll` on this container never reaches the window by bubbling — `scroll`
// does not bubble — so an Overlay that listened for it the ordinary way would
// leave its Highlight floating where the element used to be. The listener is a
// capture-phase one on the window for exactly this fixture's shape (ticket 09).

const ROWS = 14

export function ScrollContainer() {
  return (
    <section className="fixture" data-fixture="scroll-section">
      <h2>Scroll container</h2>
      <div className="scroll-container" data-fixture="scroll-container">
        {Array.from({ length: ROWS }, (_, row) => (
          <p
            key={row}
            className="scroll-row"
            data-fixture={row === 3 ? 'scroll-target' : `scroll-row-${row}`}
          >
            Row {row} — it scrolls inside the box, not with the page.
          </p>
        ))}
      </div>
    </section>
  )
}
