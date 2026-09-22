# The build brief

**Read this first, then your ticket.** It replaces reading five closed tickets'
`## Comments` to find out what the build already decided. It is maintained as tickets
land; if it disagrees with a ticket's own Comments, the ticket is right and this file
is stale — say so.

## What exists

The server side: root discovery and cwd normalization, the Guard (loopback always,
Origin on ingress), the session registry read and Candidate filter, the startup posture
block, Pick ingest, the claim-once queue and its ledger, `GET /__agent/status`, the
reply socket and the Receipts read off it, the drain endpoint and CLI, and Screen
Capture.

The Overlay: one open shadow root, the Picker, Highlight, Panel and Stack, the hit
test with its shield, the Owner chain with per-frame Confidence, and Target selection.
The Panel, Stack and Picker are React components fed by an imperative controller; the
Highlight is imperative (ADR-0004). The Panel's placement is arithmetic in
`src/overlay/placement.ts`; there is no runtime dependency.

The shapes that cross HTTP live once, in `src/wire.ts`, and both halves import them.
The server keeps one ledger per dev server (`src/server/ledger.ts`): a Pick is in the
claim-once queue exactly while its state is `queued-unaddressed`, `sent` or `held`, and
`drainable()` and `expire()` read that off the state rather than off a second structure.

## Rules that are not negotiable

- **No test imports a server module — and in TypeScript, not its types either.** Tests
  observe NDJSON frames at a fake session's socket, HTTP responses, the recorded Vite
  logger, what a real browser shows, the text a CLI prints, and files on disk. A string
  a test needs is written out, not imported. The duplication is the contract.
- **Fail closed, say so out loud** (spec §21). No silent drop, retarget, truncation,
  walk-up, empty capture or *delivered*.
- **Everything is TypeScript**; a relative import inside `src/` writes the `.js`
  extension the emit will have; type-only imports use `import type`.
- **Nothing is imported from any `spike-*` directory** — a test enforces it. The spikes
  are labelled dead ends, readable as evidence of what was measured.
- **`CONTEXT.md` is binding on identifiers as well as prose**, including its `_Avoid_`
  lists. Pick, Pointer, Note, Fence, Guard, Candidate, Target, Receipt, Ack, Overlay,
  Picker, Highlight, Panel, Stack, Confidence, Screen Capture.
- **Motion is opt-in, and lives in one place.** Every moving declaration sits inside
  the single `@media (prefers-reduced-motion: no-preference)` block at the bottom of
  `src/overlay/styles.ts`; nothing outside it may move, and a module that animates in
  script has to name `prefers-reduced-motion` itself. A seam-1 test reads the built
  Overlay for both. See `docs/motion.md`, which also holds the deviation
  pre-registered against the `review-animations` gate.
- **Borrowed code is credited**: a provenance header, an end-of-borrow marker, and a
  `LICENSE-THIRDPARTY` entry. A test checks the header and the entry agree.
- **A wire shape is written once**, in `src/wire.ts`. The Overlay and the server import
  it; neither spells a body, a response or a state word out by hand.
- **The React surfaces obey the built-Overlay test too**: no `.tsx` module may contain
  the words a moving declaration would — in prose as well as code — and React's
  `useTransition` and `startTransition` are never imported (ADR-0004).

## Measured facts you would otherwise rediscover

- **WebKit deletes tail-call frames.** JavaScriptCore drops the call-site frame of any
  component whose body is a bare `return <tag>`. Only an element nested inside its
  component's root element resolves exactly there. That is spec §12's
  `call-site-frame-elided-by-engine`, and it is annotated, never silent.
- **The app frame is the *first* after React's top frame, not the last** (ADR-0003):
  the JSX the developer pointed at, not the callback that enclosed it.
- **`Origin` cannot be stripped from a browser request** in any engine — Chromium,
  Firefox and WebKit all restore their own on `route.continue({ headers })`. Any test
  that wants a real 4xx should refuse on something else, such as the method.
- **`npx vitest` skips the `pretest` build hook**, and seam 1 exercises the emitted
  `dist/`. Run `npm run test:seam1`, or your test is grading the last build.
- **Closing a Vite dev server while its optimizer runs never returns.**
  `test/harness/dev-server.ts` awaits `waitForRequestsIdle()` before `close()`.
- **Every example-app fixture sits below the fold.** A seam-2 test must
  `scrollIntoViewIfNeeded` before measuring; `elementsFromPoint` outside the viewport
  answers nothing.
- **`ours(event)` may not be `composedPath().includes(host)`** — with the shield up
  that is true of every page click and no Pick can be made.

## The gates, and how to run them fast

| | |
| --- | --- |
| `npm run lint` / `format:check` / `typecheck` | **under 2s each** — run them constantly |
| `npm run test:seam1` | ~47s |
| `npm run test:seam2:fast` | ~18s, Chromium only — **iterate on this** |
| `npm run test:seam2` | ~46s, all three engines — **run before you commit** |

Warnings are denied. Fix a finding; never suppress it. A rule may be configured in
`.oxlintrc.json` only with a comment line directly above saying why, and a test fails
any rule that has no reason beside it.

## Working beside other agents

Several agents share one working tree. **`git add` only your own paths — never
`git add -A` or `git add .`.** If a shared file holds someone else's changes too, stage
your hunks rather than the file. If a commit lands under you, rebase your thinking onto
it before committing. Your ticket names which files are yours.

## Known open items

- The TTL sentence *"nobody prompted Claude in this repo within 30 minutes"* is a
  stretch for a Pick written to a socket, **false** for a drained one, and false twice
  over for a `held` one — somebody was asked, and it was delivered. Ticket 14 owns the
  fix. The whole of the TTL rule is now one predicate in `ledger.ts`'s `expire()`:
  which states expire, and with which sentence.
- **react-dom under Trusted Types is unverified.** The Overlay's surfaces are built by
  react-dom now, and the guarantee that nothing builds DOM from a markup string rests on
  its behaviour under the first consumer's `require-trusted-types-for 'script'`. Check
  it against that app before v0 is called done (ADR-0004).
- **Ticket 19 cannot test fail-closed by stripping `Origin`** — see above. It needs
  another mechanism.
- Spec §12's "frame directly above the sentinel" sentence is superseded by ADR-0003;
  ticket 22 corrects the sentence.
