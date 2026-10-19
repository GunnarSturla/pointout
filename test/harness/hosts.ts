// Which Host a seam-2 spec is talking to. Seam 2's `globalSetup` starts both
// example apps: Vite's on `SEAM2_PORT`, which is Playwright's `baseURL`, so a
// spec that names no Host gets Vite; and Next's on a port Next chooses, handed
// to the workers in the environment. A spec names a Host with `hostURL`.
//
// Seam 1 names one with `startExampleServer({ on: 'next' })` (dev-server.ts).

/** The Hosts a test can ask for. */
export type HostName = 'vite' | 'next'

/** Where `globalSetup` leaves the Next.js test bed's origin for the workers. */
export const NEXT_URL_ENV = 'SEAM2_NEXT_URL'

/** `path` on the seam-2 server of Host `on`. */
export function hostURL(on: HostName, path: string): string {
  if (on === 'vite') return path
  const origin = process.env[NEXT_URL_ENV]
  if (!origin)
    throw new Error(`${NEXT_URL_ENV} is unset: seam 2's globalSetup did not run`)
  return origin + path
}
