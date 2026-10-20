// Which Host a seam-2 spec is talking to. Seam 2's `globalSetup` starts both
// example apps: Vite's on `SEAM2_PORT`, and Next's on `SEAM2_NEXT_PORT`, which
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
//   absolute path, which keeps only the origin. The suites that run on every
//   bed are `PARAMETERIZED_SUITES`; every other spec runs on Vite's projects only.
// - **By name.** `hostURL('next', '/pages-router')` from a spec that runs on
//   Vite's projects, as `next-app.spec.ts` does.
//
// Seam 1 names a Host with `startExampleServer({ on: 'next' })` (dev-server.ts).

/** The Hosts a test can ask for. */
export type HostName = 'vite' | 'next'

/** Where `globalSetup` leaves the Next.js test bed's origin for the workers. */
export const NEXT_URL_ENV = 'SEAM2_NEXT_URL'

/** Vite's seam-2 port; agents in parallel worktrees each set their own. */
export const SEAM2_PORT = Number(process.env.SEAM2_PORT ?? 5178)

/** Next's seam-2 port, fixed so a project can carry it before Next is up. */
export const SEAM2_NEXT_PORT = Number(process.env.SEAM2_NEXT_PORT ?? SEAM2_PORT + 1)

/** One page a parameterized suite runs on. */
export interface TestBed {
  /** What the project name adds after the engine; empty for Vite. */
  suffix: string
  host: HostName
  /** The project's `baseURL`: the bed's origin and route. */
  baseURL: string
}

export const TEST_BEDS: readonly TestBed[] = [
  { suffix: '', host: 'vite', baseURL: `http://127.0.0.1:${SEAM2_PORT}` },
  { suffix: '-next-app', host: 'next', baseURL: `http://127.0.0.1:${SEAM2_NEXT_PORT}/` },
  {
    suffix: '-next-pages',
    host: 'next',
    baseURL: `http://127.0.0.1:${SEAM2_NEXT_PORT}/pages-router`,
  },
]

/**
 * The suites that run on every test bed (ticket 06 of the Next.js Connector):
 * everything the page shows, on Vite and on both of Next's routers.
 */
export const PARAMETERIZED_SUITES = [
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
].map((name) => `**/${name}.spec.ts`)

/** `path` on the seam-2 server of Host `on`. */
export function hostURL(on: HostName, path: string): string {
  if (on === 'vite') return path
  const origin = process.env[NEXT_URL_ENV]
  if (!origin)
    throw new Error(`${NEXT_URL_ENV} is unset: seam 2's globalSetup did not run`)
  return origin + path
}
