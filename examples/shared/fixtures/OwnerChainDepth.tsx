// Fixture: an Owner chain three components deep with no callback anywhere in
// it, and a picked element that is not its own component's root.
//
// `NestedOwners` is the same shape and is the harder case on purpose; this one
// is the easy case on purpose. Every call site here is an argument to another
// JSX call rather than a tail call, so no engine's proper tail calls delete a
// frame, and the innermost link resolves exactly in Chromium, Firefox and
// WebKit alike. Ticket 05 needs one chain that is exact everywhere in order to
// say that the exact path works; ticket 06 owns the ones that are not.

export function OwnerChainDepth() {
  return (
    <section className="fixture" data-fixture="owner-chain-depth">
      <h2>Owner chain, three deep</h2>
      <ChainMiddle />
    </section>
  )
}

function ChainMiddle() {
  return (
    <div className="chain-middle">
      <ChainLeaf />
    </div>
  )
}

function ChainLeaf() {
  return (
    <p className="chain-leaf">
      <span data-fixture="chain-leaf">picked three owners down</span>
    </p>
  )
}
