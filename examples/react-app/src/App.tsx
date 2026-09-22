import { NestedOwners } from './fixtures/NestedOwners.tsx'
import { OwnerChainDepth } from './fixtures/OwnerChainDepth.tsx'
import { DependencyComponent } from './fixtures/DependencyComponent.tsx'
import { SvgIcon } from './fixtures/SvgIcon.tsx'
import { FullViewportDecoy } from './fixtures/FullViewportDecoy.tsx'
import { PointerEventsNone } from './fixtures/PointerEventsNone.tsx'
import { ShadowRootCard } from './fixtures/ShadowRootCard.tsx'
import { SameOriginIframe } from './fixtures/SameOriginIframe.tsx'
import { DensePage } from './fixtures/DensePage.tsx'

// The test bed. Every section is a hard case the Pointer has to survive; each
// one carries a `data-fixture` attribute that tests select on.
//
// Ticket 01 shipped four and ticket 05 a fifth; ticket 08 adds the four its hit
// test rules need. What is left of spec §1's list:
//   - a scroll container               (ticket 09)
//   - elements at every viewport edge  (ticket 09, ticket 12)
export function App() {
  return (
    <>
      <FullViewportDecoy />
      <main className="page">
        <header className="page-header">
          <h1>vite-agent-inspect — test bed</h1>
          <p>
            The development target and the fixture set. Nothing here moves: motion arrives
            in ticket 09, behind a media query.
          </p>
        </header>
        <NestedOwners />
        <OwnerChainDepth />
        <DependencyComponent />
        <SvgIcon />
        <PointerEventsNone />
        <ShadowRootCard />
        <SameOriginIframe />
        <DensePage />
      </main>
    </>
  )
}
