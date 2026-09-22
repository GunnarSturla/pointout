import Skeleton from 'react-loading-skeleton'
import 'react-loading-skeleton/dist/skeleton.css'

// Fixture: an element whose owner is a component that lives in node_modules.
// The Pointer has to say so rather than hand back a path the developer cannot
// open (spec §12's `dependency` flag).
//
// Ticket 01's open question, answered by ticket 06 and measured: the owner frame
// really does point at `/node_modules/.vite/deps/react-loading-skeleton.js?v=…`.
// **No `optimizeDeps.exclude` is added, and none is wanted.** Vite keys a
// pre-bundled dependency in its module graph by the `?v=` hash it serves it
// under, so the query-stripped path spec §12 remaps through is in no graph at
// all, and the link travels as `dependency` with `absent` and the graph's own
// reason. Excluding the package would make that link resolve — to a position
// inside `node_modules`, in a file the developer must still not edit. It would
// buy a path nobody may open at the price of changing a consumer's build to
// flatter a degraded mode, which is not a trade a test bed should model.
//
// `enableAnimation={false}`: this package shimmers by default, and the test bed
// holds still so ticket 09's reduced-motion assertions mean something.
export function DependencyComponent() {
  return (
    <section className="fixture" data-fixture="dependency-component">
      <h2>Dependency component</h2>
      <p>Owned by a component this repo does not contain.</p>
      <div className="skeleton-row" data-fixture="dependency-skeleton">
        <Skeleton count={2} enableAnimation={false} />
      </div>
    </section>
  )
}
