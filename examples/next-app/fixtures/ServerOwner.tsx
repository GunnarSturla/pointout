import { ClientLeaf } from './ClientLeaf.tsx'

// Fixture, Next only: a Server Component that owns a client component. The
// client fiber's owner is not a fiber but the server's record of this component,
// and its stack frames point into a *server* chunk, so the Owner chain has to
// carry a link no browser fiber stands for (tickets 06 and 08).
//
// Its element is nested inside the root element on purpose: WebKit deletes the
// call-site frame of a component whose body is a bare `return <tag>`.
export function ServerOwner() {
  return (
    <section className="fixture" data-fixture="server-owner-section">
      <h2>Server Component owner</h2>
      <div data-fixture="server-owner">
        <ClientLeaf label="Owned by a Server Component." />
      </div>
    </section>
  )
}
