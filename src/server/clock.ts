// The server's own clock, in one place. Spec §15 gives every queue entry thirty
// minutes and §17 makes the expiry a stated failure, so "thirty minutes have
// passed" has to be something seam 1 can make true rather than wait for.

/** Test-only, like the four harness overrides. A consumer never sets it. */
const CLOCK_SKEW_ENV = 'VITE_AGENT_INSPECT_CLOCK_SKEW_MS'

/**
 * The wall clock, plus however far the harness has moved it. Read at every call
 * rather than once at startup: a test makes time pass in the middle of one, and
 * a clock sampled at boot could not notice.
 */
export function now(): number {
  const skew = Number.parseInt(process.env[CLOCK_SKEW_ENV] ?? '', 10)
  return Date.now() + (Number.isNaN(skew) ? 0 : skew)
}
