// Fixture, Next only: a same-origin frame that loads a route of this app. The
// shared test bed's frame is `about:blank`, filled by a portal from this page;
// this one is a whole Next page of its own, with its own React root, on the
// page's origin.
export function FramedRoute() {
  return (
    <section className="fixture" data-fixture="framed-route-section">
      <h2>Same-origin frame, loading a route</h2>
      <iframe
        className="fixture-frame"
        data-fixture="framed-route"
        src="/framed"
        title="A route of this app, in a same-origin frame"
      />
    </section>
  )
}
