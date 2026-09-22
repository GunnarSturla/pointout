import Skeleton from 'react-loading-skeleton'
import 'react-loading-skeleton/dist/skeleton.css'

// Fixture: an element whose owner is a component that lives in node_modules.
// The Pointer has to say so rather than hand back a path the developer cannot
// open (spec §12's `dependency` flag).
//
// Open question for ticket 06: Vite pre-bundles this dependency, so the owner
// frame is likely to point at `.vite/deps/…` rather than at node_modules. If
// the remap needs the raw path, add `optimizeDeps.exclude` for this package in
// the example app's config and say why here.
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
