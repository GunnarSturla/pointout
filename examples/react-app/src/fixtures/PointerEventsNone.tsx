// Fixture: a decorative element the page has made untouchable with
// `pointer-events: none`. The browser's own hit test skips it, so an overlay
// that asks where the pointer is gets the element underneath and the developer
// is told they picked something they did not point at.
//
// While the Overlay is armed the rule that forces every element hittable puts
// this badge back in the hit test; while it is not, the badge is inert and the
// page behaves exactly as its author wrote it (ticket 08).

export function PointerEventsNone() {
  return (
    <section className="fixture" data-fixture="pointer-events-none-section">
      <h2>Decorative element</h2>
      <p className="decorative-row" data-fixture="decorative-row">
        <span className="decorative-badge" data-fixture="pointer-events-none">
          decorative
        </span>
        <span>A badge the page has made untouchable.</span>
      </p>
    </section>
  )
}
