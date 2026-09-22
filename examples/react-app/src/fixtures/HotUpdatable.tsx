// Fixture: a component a developer edits while the Overlay is on its element.
// A hot update relays out the page under a Highlight that nothing told, which is
// the third way an element moves without a scroll or a resize (spec §5).
//
// Its size lives in `hot-update.css`, imported here, so a test can make a real
// hot update happen by editing one declaration: Vite swaps the style tag, React
// is never re-rendered, and the box changes height under the Highlight. Editing
// this file's own markup would do as well, and is what a developer does; the
// stylesheet is the half a test can put back byte for byte.

import './hot-update.css'

export function HotUpdatable() {
  return (
    <section className="fixture" data-fixture="hot-update-section">
      <h2>Hot-updatable component</h2>
      <p className="hot-update-box" data-fixture="hot-update-box">
        Edit <code>hot-update.css</code> while this is highlighted.
      </p>
    </section>
  )
}
