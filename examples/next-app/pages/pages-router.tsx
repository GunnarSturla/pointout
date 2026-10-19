import { App } from '../../shared/App.tsx'

// The Pages Router route: the same shared test bed as `/`, rendered by the app's
// own React rather than the one Next vendors for the App Router.
export default function PagesRouterPage() {
  return <App />
}
