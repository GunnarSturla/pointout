import { NestedOwners } from './fixtures/NestedOwners.tsx'
import { OwnerChainDepth } from './fixtures/OwnerChainDepth.tsx'
import { DependencyComponent } from './fixtures/DependencyComponent.tsx'
import { SvgIcon } from './fixtures/SvgIcon.tsx'
import { FullViewportDecoy } from './fixtures/FullViewportDecoy.tsx'
import { PointerEventsNone } from './fixtures/PointerEventsNone.tsx'
import { ShadowRootCard } from './fixtures/ShadowRootCard.tsx'
import { SameOriginIframe } from './fixtures/SameOriginIframe.tsx'
import { ScrollContainer } from './fixtures/ScrollContainer.tsx'
import { ViewportEdges } from './fixtures/ViewportEdges.tsx'
import { Unmounting } from './fixtures/Unmounting.tsx'
import { HotUpdatable } from './fixtures/HotUpdatable.tsx'
import { ElementExcerpts } from './fixtures/ElementExcerpts.tsx'
import { DensePage } from './fixtures/DensePage.tsx'

// The test bed. Every section is a hard case the Pointer has to survive; each
// one carries a `data-fixture` attribute that tests select on.
//
// Ticket 01 shipped four, ticket 05 a fifth and ticket 08 the four its hit test
// rules needed. Ticket 09 closes spec §1's list with the scroll container and
// the elements at every viewport edge, and adds the two its own lifecycle needs:
// an element that unmounts, and a component with a hot-updatable stylesheet.
// Ticket 07 adds the one every kind of Excerpt can be lifted from.
export function App() {
  return (
    <>
      <FullViewportDecoy />
      <main className="page">
        <header className="page-header">
          <h1>pointout — test bed</h1>
          <p>
            The development target and the fixture set. Nothing here moves: the only
            motion in the project is the Overlay's, and it is behind a media query.
          </p>
        </header>
        <NestedOwners />
        <OwnerChainDepth />
        <DependencyComponent />
        <SvgIcon />
        <PointerEventsNone />
        <ShadowRootCard />
        <SameOriginIframe />
        <ScrollContainer />
        <ViewportEdges />
        <Unmounting />
        <HotUpdatable />
        <ElementExcerpts />
        <DensePage />
      </main>
    </>
  )
}
