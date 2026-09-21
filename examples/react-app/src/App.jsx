import { NestedOwners } from './fixtures/NestedOwners.jsx'
import { DependencyComponent } from './fixtures/DependencyComponent.jsx'
import { SvgIcon } from './fixtures/SvgIcon.jsx'
import { FullViewportDecoy } from './fixtures/FullViewportDecoy.jsx'

// The test bed. Every section is a hard case the Pointer has to survive; each
// one carries a `data-fixture` attribute that tests select on.
//
// Ticket 01 ships four. Later tickets add the rest of spec §1's list:
//   - a shadow-root web component      (ticket 08)
//   - a same-origin iframe             (ticket 08)
//   - a scroll container               (ticket 08, ticket 09)
//   - elements at every viewport edge  (ticket 09, ticket 12)
//   - a `pointer-events: none` element (ticket 08)
export function App() {
  return (
    <>
      <FullViewportDecoy />
      <main className="page">
        <header className="page-header">
          <h1>vite-agent-inspect — test bed</h1>
          <p>
            The development target and the fixture set. Nothing here moves:
            motion arrives in ticket 09, behind a media query.
          </p>
        </header>
        <NestedOwners />
        <DependencyComponent />
        <SvgIcon />
      </main>
    </>
  )
}
