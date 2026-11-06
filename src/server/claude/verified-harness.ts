// The Claude Code version the Claude-suite model tier last passed against in full
// (ticket 21). Written by `npm run test:claude:model`, and only when every test in
// it passed; never edited by hand. `null` is *never verified*.
//
// It is a module rather than a data file because the package ships `dist/` and
// nothing else, and a record the emit carries cannot go missing from it.
// Ticket 19's posture block is to print `version` beside the version the
// registry entries report, and warn when the running harness is newer; until
// then nothing reads it. It is a warning,
// never a refusal: shape-pinning, not version-pinning, decides behaviour.

export interface VerifiedHarness {
  /** Bare semver, as `claude --version` prints it before ` (Claude Code)`. */
  version: string
  /** The day the model tier passed against it, `YYYY-MM-DD`. */
  verifiedAt: string
}

export const VERIFIED_HARNESS: VerifiedHarness | null = {
  version: '2.1.280',
  verifiedAt: '2026-09-23',
}
