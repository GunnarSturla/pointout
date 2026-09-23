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

The CLI: `drain`, and `init` (ticket 16), which writes the two hook entries into the
project's `.claude/settings.json` and the setup skill into `.claude/skills/`. The
harness-neutral half is `src/cli/setup.ts` (`HarnessSetup`); the Claude half, and the
skill text, live in `src/cli/claude/`. It mirrors `DeliveryRoute` in
`src/server/delivery.ts` rather than sharing one interface with it.

The Overlay: one open shadow root, the Picker, Highlight, Panel and Stack, the hit
test with its shield, the Owner chain with per-frame Confidence, and Target selection.
The Panel, Stack and Picker are React components fed by an imperative controller; the
Highlight is imperative (ADR-0004). The Panel's placement is arithmetic in
`src/overlay/placement.ts`; there is no runtime dependency. A Pick's chip words and
next action come from one `say(state, reason, name)` in `stack.tsx`; `held` and
`failed` Receipts reach the chip (ticket 27).

The Panel footer has the camera toggle, and a pick closes the Shutter for the
capture frame whatever the toggle says (ticket 18, `src/overlay/capture.ts`). A Pick
that never lands is offered back (ticket 14): the 60 s report-back clock runs on the
server (`src/server/report-back.ts`), the 30 s countdown in the page
(`src/overlay/report-back.tsx`), and `POST /__agent/pick/<id>/report` resolves the
offer. The offer is not a Pick state; `reportBack.state` on the status row says
whether a `sent` or `unknown` Pick is offered. Each TTL case has its own sentence.

Seam 3's no-model tier (ticket 20) spawns a real, scrubbed, throwaway session through
`test/harness/claude-session.ts` and checks the harness shapes v0 pins, at no token
cost. Its model tier (ticket 21, `npm run test:seam3:model`) costs tokens, runs a
blackholed bystander session beside the real one, and on a fully green run rewrites
`src/server/claude/verified-harness.ts` — `VERIFIED_HARNESS` is `null` or a three-line
`{ version, verifiedAt }` literal, and nothing but its reporter may change that shape.

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

- **A `session_id`-mismatched frame produces no Receipt** (Claude Code 2.1.280,
  ticket 20). It is dropped silently. Spec §15's sentence saying it comes back as a
  Receipt, and the premise of the stand-in in `test/seam1/receipts.test.ts`, are wrong.
- **An idle notice from a session that has never finished a turn carries no
  `finished_at`.** v0 subscribes only after a Pick, so it is not affected.
- **A session registers only after the folder-trust prompt is accepted**, and a
  session that inherits `CLAUDE_CODE_CHILD_SESSION` publishes a key file and a socket
  but never registers.
- **The Overlay's import graph is checked for harness words.** `test/seam1/overlay-harness-neutral.test.ts`
  fails any Claude Code mechanism string in `src/overlay/**`, and
  `test/seam1/overlay-words.test.ts` fails a second spelling of *approve it in your
  terminal* or any "delivered" that is not "Not delivered". Import the constant from
  `words.ts`.
- **A seam-2 spec can send real Receipts**: read `from` and `msg_id` off the delivered
  frame in `SEAM2_FRAMES_LOG` and call `replyTo(from)` from
  `test/harness/session-socket.ts`. Nothing fakes `/status`.
- **An idle notice offers back every Pick outstanding to its Target.** A seam-2 spec
  that ends a turn on purpose must use a session no other spec addresses — the fifth
  seam-2 session, `seam 2 report-back session` (`SEAM2_REPORT_BACK_FRAMES_LOG`), exists
  for that. Ending the default session's turn broke `receipts.spec.ts`'s silence
  journey in every engine.
- **A session started below the repo root runs none of the root's hooks** (2.1.280,
  ticket 21). It still loads the skills and is still a Candidate, so the socket reaches
  it and the hook floor does not. The README must tell consumers to start Claude Code
  at the root.
- **A peer-message turn runs `UserPromptSubmit`**, so a socket delivery drains the whole
  unaddressed queue into that turn. A Stop drain leaves three transcript records
  (`hook_success`, `hook_additional_context`, `stop_hook_summary`).
- **Outside safe mode a registry entry is written first without `status`**, and v0
  rejects it as unrecognised until the full entry lands.
- **A lone Candidate is preselected**, so a Pick with no Target never stays
  `queued-unaddressed`; a hook canary needs a second, bystander session.
- **`manual` is today's CLI name** for the spec's "default" permission mode.
- **A Playwright route that holds an answer must be unrouted before its test ends**
  (`page.unrouteAll({ behavior: 'ignoreErrors' })`), or it throws into the next test on
  that worker, which never runs; Playwright exits 1 with *1 error was not a part of any
  test*. Read Playwright's own exit code, not a pipe's.

## The gates, and how to run them fast

| | |
| --- | --- |
| `npm run lint` / `format:check` / `typecheck` | **under 2s each** — run them constantly |
| `npm run test:seam1` | ~47s |
| `npm run test:seam2:fast` | ~18s, Chromium only — **iterate on this** |
| `npm run test:seam2` | ~46s, all three engines — **run before you commit** |

**Seam 2 binds a fixed port (5178).** Agents running in parallel worktrees must each
set `SEAM2_PORT` to their own port, or a bind failure reads as a broken test.
`npm run test:seam3` really spawns a session; it is never in `npm test`.

Warnings are denied. Fix a finding; never suppress it. A rule may be configured in
`.oxlintrc.json` only with a comment line directly above saying why, and a test fails
any rule that has no reason beside it.

## Working beside other agents

Several agents share one working tree. **`git add` only your own paths — never
`git add -A` or `git add .`.** If a shared file holds someone else's changes too, stage
your hunks rather than the file. If a commit lands under you, rebase your thinking onto
it before committing. Your ticket names which files are yours.

## Known open items

- **The Overlay still names the harness in three places** (ticket 16): spec §17's
  sentences say "Claude", the wire carries `registry.hookFloor`, and `api.ts`, which
  the Overlay imports, exports the hook budget and `DRAIN_PATH`. Ticket 16's
  "no reference to Claude or hooks" box is met in substance only; a follow-up needs a
  harness-neutral wire name and the hook budget out of `api.ts`.
- **`CONTEXT.md`'s Receipt says "bad outcomes only"**, but a `delivered` Receipt
  releases a `held` Pick. The definition needs that clause.
- **"reply" is on Ack's _Avoid_ list**, yet the code says "reply address" and the
  harness has `replyTo()`. Settle the word.
- **Spec corrections owed** (tickets 20 and 21): §15's mismatched-`session_id`
  Receipt does not exist; "every state except idle and you never type again" is false
  for a session started below the root; the origin record carries a fourth field,
  `msg_id`; the Stop drain leaves three records, not one; "default mode" is `manual`.
- **`CONTEXT.md` has no term for the report-back offer and no definition of
  `unknown`** (ticket 14), and none for the Shutter (ticket 18), which is now in
  `data-shutter`, `styles.ts` and `docs/motion.md`.
- **Ticket 17's posture and 409 sentence says "v0 crops the display"**; *crop* is on
  `CONTEXT.md`'s _Avoid_ list, and seams 1 and 2 both spell the sentence out.
- **An over-cap 413 has already kept or deleted the Pick's capture** (ticket 18):
  `ingestPick` resolves the capture before `fitPayload`, so the resend is told the Pick
  holds no capture with that id. Ticket 19's audit.
- **react-dom under Trusted Types is unverified.** The Overlay's surfaces are built by
  react-dom now, and the guarantee that nothing builds DOM from a markup string rests on
  its behaviour under the first consumer's `require-trusted-types-for 'script'`. Check
  it against that app before v0 is called done (ADR-0004).
- **Ticket 19 cannot test fail-closed by stripping `Origin`** — see above. It needs
  another mechanism.
- Spec §12's "frame directly above the sentinel" sentence is superseded by ADR-0003;
  ticket 22 corrects the sentence.
