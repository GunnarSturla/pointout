import { App } from '../../shared/App.tsx'
import { ServerOwner } from '../fixtures/ServerOwner.tsx'
import { FramedRoute } from '../fixtures/FramedRoute.tsx'

// The App Router route. This page is a Server Component; the shared test bed it
// renders is a client component, and so is every fixture in it. The two
// fixtures after it exist only on Next: a Server Component that owns a client
// component, and a same-origin frame that loads a route of this app.
export default function AppRouterPage() {
  return (
    <>
      <App />
      <div className="page">
        <ServerOwner />
        <FramedRoute />
      </div>
    </>
  )
}
