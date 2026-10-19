import { readFileSync } from 'node:fs'

// The server's own clock, in one place. Spec §15 gives every queue entry thirty
// minutes and §17 makes the expiry a stated failure, so "thirty minutes have
// passed" has to be something seam 1 can make true rather than wait for.

/** Test-only, like the four harness overrides. A consumer never sets it. */
const CLOCK_SKEW_ENV = 'POINTOUT_CLOCK_SKEW_MS'

/**
 * Test-only too: a file holding the skew, for a dev server in a process the
 * test cannot reach through `process.env`, such as a `next dev` the harness
 * spawned. When it is set, the file is the clock and the variable above is not
 * read. A file that is missing or empty is no skew.
 */
const CLOCK_SKEW_FILE_ENV = 'POINTOUT_CLOCK_SKEW_FILE'

/**
 * The wall clock, plus however far the harness has moved it. Read at every call
 * rather than once at startup: a test makes time pass in the middle of one, and
 * a clock sampled at boot could not notice.
 */
export function now(): number {
  const skew = Number.parseInt(skewText(), 10)
  return Date.now() + (Number.isNaN(skew) ? 0 : skew)
}

function skewText(): string {
  const file = process.env[CLOCK_SKEW_FILE_ENV]
  if (!file) return process.env[CLOCK_SKEW_ENV] ?? ''
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
