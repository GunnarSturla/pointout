import type { PostureLine } from '../posture.js'
import { says, warns } from '../posture.js'
import type { SessionEntry } from '../registry.js'
import { VERIFIED_HARNESS } from './verified-harness.js'
import type { VerifiedHarness } from './verified-harness.js'

// The posture block's harness line (spec §2): the Claude Code version the
// registry's sessions report, beside the one the model-tier canaries last passed
// against (ticket 21 records it in `verified-harness.ts`). A harness newer than
// the verified one is a **warning, never a refusal**: v0 pins the shapes it reads,
// not a version, and a shape that has moved is refused where it is read. So this
// line decides nothing; it tells the developer how far the evidence reaches.

/**
 * Test-only, like the registry-directory override: stands in for the recorded
 * file, so seam 1 can boot none, older and equal. `<version>@<YYYY-MM-DD>`, or
 * `never` for a harness no canary run has verified. A consumer never sets it.
 */
const VERIFIED_HARNESS_ENV = 'VITE_AGENT_INSPECT_VERIFIED_HARNESS'

const NEWER =
  'This harness is newer than the last one verified. v0 carries on, because it pins ' +
  'the shapes it reads rather than a version, and a shape that has moved is ' +
  'reported where it is read.'

export function harnessVersionLine(entries: readonly SessionEntry[]): PostureLine {
  const verified = verifiedHarness()
  const reported = [
    ...new Set(entries.map((entry) => entry.version).filter(isText)),
  ].toSorted(byVersion)

  const running =
    reported.length > 0
      ? `Claude Code ${inWords(reported)} in the registry`
      : 'no readable registry entry reports a version'
  if (!verified) {
    return says(
      `${running}; never verified — no canary run has recorded a version it passed against`,
    )
  }

  const against =
    `${running}; the canaries last passed against ${verified.version} ` +
    `(${verified.verifiedAt})`
  const newest = reported.at(-1)
  const unread = reported.filter((version) => !parseVersion(version))
  const unreadClause =
    unread.length > 0
      ? `. ${inWords(unread)} does not read as a version number, so it was not compared`
      : ''
  if (newest && parseVersion(newest) && byVersion(newest, verified.version) > 0) {
    return warns(`${against}${unreadClause}. ${NEWER}`)
  }
  return says(`${against}${unreadClause}`)
}

function verifiedHarness(): VerifiedHarness | null {
  const override = process.env[VERIFIED_HARNESS_ENV]
  if (!override) return VERIFIED_HARNESS
  if (override === 'never') return null
  const [version, verifiedAt] = override.split('@')
  // Bare semver, like the recorded file: anything else would read as older than
  // every harness and warn on every start, which is a test that lies.
  if (!version || !verifiedAt || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `vite-agent-inspect: ${VERIFIED_HARNESS_ENV} is "${override}"; it takes ` +
        '<major.minor.patch>@<YYYY-MM-DD>, or never. It is a test-only override.',
    )
  }
  return { version, verifiedAt }
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

/** `2.1.280`, read as numbers. A prerelease or build suffix is not compared. */
function parseVersion(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? match.slice(1).map(Number) : null
}

/**
 * Numeric where both read as versions, so 2.1.100 is newer than 2.1.99; a
 * version that does not read as one sorts first, and is never "newer".
 */
function byVersion(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return left ? 1 : right ? -1 : a.localeCompare(b)
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function inWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
