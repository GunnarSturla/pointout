// Which Host a browser-suite spec is talking to. The browser suite's `globalSetup` starts both
// example apps: Vite's on `BROWSER_PORT`, and Next's on `BROWSER_NEXT_PORT`, which
// is the next port up unless it is set.
//
// A spec reaches a Host one of two ways:
//
// - **By project.** Each engine has three Playwright projects, one per test bed
//   (`TEST_BEDS`): `chromium` is Vite's, `chromium-next-app` the App Router
//   route and `chromium-next-pages` the Pages Router route. A bed is the
//   project's `baseURL`, origin *and* route, so a spec that runs on every bed
//   opens its page with a URL relative to it (`page.goto('?probe=…')`, never
//   `'/?probe=…'`, which would drop the route) and reaches `/__agent` with an
//   absolute path, which keeps only the origin. Which suites a Next project runs
//   is `nextBedSuites`; every other spec runs on Vite's projects only.
// - **By name.** `hostURL('next', '/pages-router')` from a spec that runs on
//   Vite's projects, as `next-app.spec.ts` does.
//
// The server suite names a Host with `startExampleServer({ on: 'next' })` (dev-server.ts).

/** The Hosts a test can ask for. */
export type HostName = 'vite' | 'next'

/** Where `globalSetup` leaves the Next.js test bed's origin for the workers. */
export const NEXT_URL_ENV = 'BROWSER_NEXT_URL'

/** Vite's browser-suite port; agents in parallel worktrees each set their own. */
export const BROWSER_PORT = Number(process.env.BROWSER_PORT ?? 5178)

/** Next's browser-suite port, fixed so a project can carry it before Next is up. */
export const BROWSER_NEXT_PORT = Number(process.env.BROWSER_NEXT_PORT ?? BROWSER_PORT + 1)

/** One page a parameterized suite runs on. */
export interface TestBed {
  /** What the project name adds after the engine; empty for Vite. */
  suffix: string
  host: HostName
  /** The project's `baseURL`: the bed's origin and route. */
  baseURL: string
}

export const TEST_BEDS: readonly TestBed[] = [
  { suffix: '', host: 'vite', baseURL: `http://127.0.0.1:${BROWSER_PORT}` },
  {
    suffix: '-next-app',
    host: 'next',
    baseURL: `http://127.0.0.1:${BROWSER_NEXT_PORT}/`,
  },
  {
    suffix: '-next-pages',
    host: 'next',
    baseURL: `http://127.0.0.1:${BROWSER_NEXT_PORT}/pages-router`,
  },
]

/** What a Next.js Chromium run on the App Router adds: everything the page shows. */
const PARAMETERIZED_SUITES = [
  'surfaces',
  'highlight',
  'hit-test',
  'controls',
  'targeting',
  'withdraw',
  'receipts',
  'report-back',
  'capture',
  'panel-motion',
  'owner-chain',
  'confidence',
  'excerpts',
]

/**
 * The suites whose answer depends on the Host and the router as well as the
 * engine: what Next's stacks and frames carry, and what its dev tools cover. The
 * others are the same Overlay once it is mounted, so one Next bed holds them, and
 * `next-app.spec.ts` holds mounting and hydration on both routers in every engine.
 */
const HOST_SENSITIVE_SUITES = ['hit-test', 'owner-chain', 'confidence', 'excerpts']

/** The spec files a Next bed runs in an engine. */
export function nextBedSuites(engine: string, bed: TestBed): string[] {
  const suites =
    engine === 'chromium' && bed.suffix === '-next-app'
      ? PARAMETERIZED_SUITES
      : HOST_SENSITIVE_SUITES
  return suites.map((name) => `**/${name}.spec.ts`)
}

/** `path` on the browser-suite server of Host `on`. */
export function hostURL(on: HostName, path: string): string {
  if (on === 'vite') return path
  const origin = process.env[NEXT_URL_ENV]
  if (!origin)
    throw new Error(
      `${NEXT_URL_ENV} is unset: the browser suite's globalSetup did not run`,
    )
  return origin + path
}
