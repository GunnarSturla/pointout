# The build brief

**Read this first, then your ticket.** It replaces reading five closed tickets'
`## Comments` to find out what the build already decided. It is maintained as tickets
land; if it disagrees with a ticket's own Comments, the ticket is right and this file
is stale — say so.

## What exists

Two Hosts, Vite and Next.js 16 (`>=16.3 <17`, Turbopack only), each with a Connector
over a core that belongs to no Host (ADR-0005; the Next.js effort's tickets are in
the local tracker). `pointout/vite` is `src/vite/`; `pointout/next` is
`src/next/`: `withPointout()` acts only in Next's dev worker, intercepts `/__agent` on
Next's own listening server (ADR-0006), checks itself with a `self-check` posture line,
and injects the Overlay through `instrumentationClientInject`, which waits for the page's
React root to hydrate before drawing. The core reaches a Connector only through
`Connector` in `src/server/http.ts` and the **frame resolver** seam,
`src/server/frame-resolver.ts`: a resolver answers `found` (one module), `chunk` (a
bundle, with per-source file, drift and vendor-ness) or `absent`, and the core decodes
(`sourcemap.ts`, flat and index maps) and judges Confidence. Vite's resolver reads the
module graph; Next's dispatches to `client-chunks.ts` (the served `.js.map`) and
`server-chunks.ts` (a Server Component's chunk map on disk). Neither imports the other.
`docs/agents/packaging.md` › *The entry points* has the layout.

The server side: root discovery and cwd normalization, the Guard (loopback always,
Origin on ingress), the session registry read and Candidate filter, the startup posture
block, Pick ingest, the claim-once queue and its ledger, `GET /__agent/status`, the
reply socket and the Receipts read off it, the drain endpoint and CLI, Screen
Capture, and Withdraw.

Withdraw is `DELETE /__agent/pick/<id>` (overlay-polish 02), guarded as Pick ingress.
`isWithdrawable(state, reportBack)` in `src/wire.ts` is the one predicate both halves
apply: `queued-unaddressed`, `failed`, `unknown`, and a `sent` or `unknown` Pick while
it is offered back. It takes the Pick off the queue and out of the ledger, stops its
clock and deletes the capture file that Pick itself took. The answer's `alreadyWritten`
is about who may have the Pick, not what this server tried: a requeued or retargeted
Pick still says a session had it, and `targetName` is null when the hook floor carried
it.

The startup posture block is complete and ordered (ticket 19); every line and what it
means is in `docs/posture.md`. It is logged once, at `warn` when any line degrades.
`src/server/claude/harness-version.ts` compares the registry's newest `version` with
`VERIFIED_HARNESS` and warns, never refuses; the server suite overrides the record with
`POINTOUT_VERIFIED_HARNESS` (`<semver>@<YYYY-MM-DD>` or `never`), test-only.
A Pick refused at the cap no longer spends its capture: `ingestPick` takes the claim
only after `fitPayload` accepts. The §21 audit table, one test per item, is in ticket
19.

The CLI: `drain`, and `init` (ticket 16), which writes the two hook entries into the
project's `.claude/settings.json` and the setup skill into `.claude/skills/`. It first
chooses the Host (`src/cli/hosts.ts`, Next.js Connector 09) from the `package.json` it
runs beside, or `--connector next|vite`; both named asks on a TTY and refuses without
one. On Next.js it prints the `withPointout()` wrap and `next dev -H localhost` and edits
neither file. The
harness-neutral half is `src/cli/setup.ts` (`HarnessSetup`); the Claude half, and the
skill text, live in `src/cli/claude/`. It mirrors `DeliveryRoute` in
`src/server/delivery.ts` rather than sharing one interface with it.

The Overlay: one open shadow root, the Picker, Highlight, Panel and Stack, the hit
test with its shield, the Owner chain with per-frame Confidence, and Target selection.
The Panel, Stack and Picker are React components fed by an imperative controller; the
Highlight is imperative (ADR-0004).

Every surface follows `docs/overlay-design.md`, the
approved design plan; its tokens are custom properties on `:host` at the top of
`src/overlay/styles.ts`, with a forced-colours mapping. The Picker is an edge tab with
Remix Icon's crosshair (`src/overlay/icons.tsx`, credited once for the set), reading
**Picking…** on solid `--accent-strong` while armed; "Back to your pick" hangs off its
right edge, out of flow. Every control is listed once in `CONTROLS` in `styles.ts`,
which gives it hover, press and the focus ring.

There are two Highlights,
`src/overlay/marks.ts` (overlay-polish 03): with an unsubmitted Panel open and Alt held,
a **live** mark follows the pointer while the **current** one rests; the boxes trade
roles on an Alt-click (`data-mark`), and one not shown is out of the DOM. The shutter
hides only the fill and the chip.

A session's health is a dot and a word
(`words.healthOf`, `src/overlay/dot.tsx`): Ready, Working, Needs you. The Panel's
arrival, departure and travel are `src/overlay/presence.ts`: a leaving surface leaves an
inert, part-less still copy ahead of the surfaces' container. Same-origin frames are
heard through `src/overlay/frames.ts`; a frame whose probe event nobody hears gets a
frame shield while armed (overlay-polish 12). The example app's decoy is off at load,
and `/?decoy` turns it on. The Panel's placement is arithmetic in
`src/overlay/placement.ts`; there is no runtime dependency. Send closes the
unsubmitted Panel, and the Pick rests as its minimized Panel in the Stack
(overlay-polish ticket 08): a traffic light with its state in a `title`, the component,
the Note's first line, a camera when a Screen Capture went, and a second line of §17's
words. The light, its word, the words and the next action come from one
`say(state, reason, name, offered)` in `stack.tsx`; `held` and `failed` Receipts reach
it (ticket 27). "Chip" means the Highlight's label only. Send shrinks the Panel
into its slot (overlay-polish 09), and pressing a minimized Panel's first line, a button,
opens it above the Stack (`Expanded` in `stack.tsx`, part `expanded`): at most one, its
slot marked `data-open`, and it closes back into the slot. A submitted Panel's `Escape` is
its own; the controller leaves it alone (`inSubmittedPanel`). `Submitted.slot` is the
Stack's key, and survives a retarget.
A minimized Panel carries a Withdraw × exactly where `isWithdrawable(state, reportBack)`
holds (overlay-polish 10): a button beside the line's, in `minimized-head`, never inside
it. The DELETE's answer is said in place: *Already sent to `<name>`* or *Already delivered
to a session* (`minimized-withdrawn`) for four seconds, then the Panel leaves a fading copy
(`presence.ts`); nothing written just leaves; a 404 is gone; any other refusal stays on
the Panel (`minimized-refusal`).

The Panel footer has the camera toggle, and a pick closes the Shutter for the
capture frame whatever the toggle says (ticket 18, `src/overlay/capture.ts`). A Pick
that never lands is offered back (ticket 14): the 60 s report-back clock runs on the
server (`src/server/report-back.ts`), the 30 s countdown in the page
(`src/overlay/report-back.tsx`), and `POST /__agent/pick/<id>/report` resolves the
offer. The offer is not a Pick state; `reportBack.state` on the status row says
whether a `sent` or `unknown` Pick is offered. Each TTL case has its own sentence.

The Claude suite's no-model tier (ticket 20) spawns a real, scrubbed, throwaway session through
`test/harness/claude-session.ts` and checks the harness shapes v0 pins, at no token
cost. Its model tier (ticket 21, `npm run test:claude:model`) costs tokens, runs a
blackholed bystander session beside the real one, and on a fully green run rewrites
`src/server/claude/verified-harness.ts` — `VERIFIED_HARNESS` is `null` or a three-line
`{ version, verifiedAt }` literal, and nothing but its reporter may change that shape.

The shapes that cross HTTP live once, in `src/wire.ts`, and both halves import them.
The server keeps one ledger per dev server (`src/server/ledger.ts`): a Pick is in the
claim-once queue exactly while its state is `queued-unaddressed`, `sent` or `held`, and
`drainable()` and `expire()` read that off the state rather than off a second structure.

## Rules that are not negotiable

- **No test imports a server module — and in TypeScript, not its types either.** Tests
  observe NDJSON frames at a fake session's socket, HTTP responses, the Host's recorded
  log, what a real browser shows, the text a CLI prints, and files on disk. A string
  a test needs is written out, not imported. The duplication is the contract.
- **Fail closed, say so out loud** (spec §21). No silent drop, retarget, truncation,
  walk-up, empty capture or *delivered*.
- **Everything is TypeScript**; a relative import inside `src/` writes the `.js`
  extension the emit will have; type-only imports use `import type`.
- **`GLOSSARY.md` is binding on identifiers as well as prose**, including its `_Avoid_`
  lists. Pick, Pointer, Note, Fence, Guard, Candidate, Target, Receipt, Ack, Overlay,
  Picker, Highlight, Panel, Stack, Confidence, Screen Capture.
- **Movement is opt-in, and lives in one place.** Everything that travels, resizes or
  shortens sits inside the single `@media (prefers-reduced-motion: no-preference)`
  block at the bottom of `src/overlay/styles.ts`. A fade is not movement: just above
  that block, a fade — `opacity`, `color`, `background-color`, `border-color`,
  `outline-color` — may ease, for every developer, and `transition: none` may stop it. A module that animates in script has to name `prefers-reduced-motion`
  itself. A server-suite test reads the built Overlay for all of it. See `docs/motion.md`,
  which also records the `review-animations` gate's outcome and the deviations it
  accepted.
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
- **`npx vitest` skips the `pretest` build hook**, and the server suite exercises the emitted
  `dist/`. Run `npm run test:server`, or your test is grading the last build.
- **Closing a Vite dev server while its optimizer runs never returns.**
  `test/harness/dev-server.ts` awaits `waitForRequestsIdle()` before `close()`, and
  gives the two 20 s, failing with the server's root and port if they hang.
- **The server suite runs its files in parallel, in forked workers** (`pool: 'forks'`, four at
  a time). A file still owns `process.env` and `advanceClock`, because it owns its
  process; never switch the pool to `threads`. Tests and hooks get 30 s; a test that
  runs a whole command gives its own longer timeout beside itself.
- **A hot update reaches every page on the browser-suite server**, in every worker and
  engine, and re-measures each Highlight. `highlight.spec.ts` keeps its hot update
  and its frame-by-frame morph apart with `apartFromHotUpdates`
  (`test/harness/hot-update-lock.ts`); a new journey that watches frames takes the
  same lock.
- **Every example-app fixture sits below the fold.** A browser-suite test must
  `scrollIntoViewIfNeeded` before measuring; `elementsFromPoint` outside the viewport
  answers nothing.
- **`ours(event)` may not be `composedPath().includes(host)`** — with the shield up
  that is true of every page click and no Pick can be made.

- **A `session_id`-mismatched frame produces no Receipt** (Claude Code 2.1.280,
  ticket 20). It is dropped silently. Spec §15's sentence saying it comes back as a
  Receipt, and the premise of the stand-in in `test/server/receipts.test.ts`, are wrong.
- **An idle notice from a session that has never finished a turn carries no
  `finished_at`.** v0 subscribes only after a Pick, so it is not affected.
- **A session registers only after the folder-trust prompt is accepted**, and a
  session that inherits `CLAUDE_CODE_CHILD_SESSION` publishes a key file and a socket
  but never registers.
- **The Overlay's import graph is checked for harness words.** `test/server/overlay-harness-neutral.test.ts`
  fails any Claude Code mechanism string in `src/overlay/**`, and
  `test/server/overlay-words.test.ts` fails a second spelling of *approve it in your
  terminal* or any "delivered" that is not "Not delivered". Import the constant from
  `words.ts`.
- **A browser-suite spec can send real Receipts**: read `from` and `msg_id` off the delivered
  frame in `BROWSER_FRAMES_LOG` and call `replyTo(from)` from
  `test/harness/session-socket.ts`. Nothing fakes `/status`.
- **An idle notice offers back every Pick outstanding to its Target.** A browser-suite spec
  that ends a turn on purpose must use a session no other spec addresses — the fifth
  browser-suite session, `browser-suite report-back session` (`BROWSER_REPORT_BACK_FRAMES_LOG`), exists
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
- **A drain takes every `queued-unaddressed` Pick on the browser-suite server**, whichever worker
  or engine made it. A journey that drains, or that holds a Pick in that queue while it
  reads what became of it, takes `apartFromDrains` (`test/harness/drain-lock.ts`). The
  drain's secret is at `BROWSER_DISCOVERY_ENTRY`, set by `globalSetup`. A null-Target Pick
  cannot make a queued one there: the server preselects the started-this-server session;
  an offer left for the next prompt does.
- **WebKit runs no listener in a frame sandboxed without `allow-scripts`**, not even
  one the parent page adds (overlay-polish 12). Chromium and Firefox run them. The
  Overlay measures it with a probe event rather than reading the attribute, and covers
  such a frame with a frame shield, so in WebKit only the shield route is exercised.
- **A `ResizeObserver` reports every target once when it starts observing it.** That
  report is not a change; taken for one, it cancelled the Highlight's morph about 33 ms
  in. `highlight.ts` skips each target's first report, and a browser-suite journey samples the
  morph frame by frame to keep it so.
- **A clone of a `textarea` does not reliably carry what was typed** (Chromium's does,
  others do not), so `presence.ts` copies field values into a leaving copy by hand.
- **The status dots loop forever.** A `settled()` that waits for `getAnimations()` to
  reach zero never returns while a Working or Needs you dot or light is drawn; leave out
  `dot-working` and `dot-needs` by animation name.
- **Firefox spends `locator.click()`'s actionability checks inside frames a journey is
  watching**; the frame-by-frame motion journeys press by coordinates.
- **WebKit needs `Alt+Tab` to reach a button from the keyboard** in Playwright.
- **A Playwright route that holds an answer must be unrouted before its test ends**
  (`page.unrouteAll({ behavior: 'ignoreErrors' })`), or it throws into the next test on
  that worker, which never runs; Playwright exits 1 with *1 error was not a part of any
  test*. Read Playwright's own exit code, not a pipe's.

### Next.js (October 2026, next 16.4.2)

- **`next dev` never reads the config itself.** It forks a worker child with
  `NEXT_PRIVATE_WORKER=1`, which owns the socket and evaluates the config, a function
  config twice. A config edit restarts the worker (exit 77, new pid). Anything started
  from the config checks `NEXT_PRIVATE_WORKER === '1'`.
- **The config loads after `listen`**, in the `'listening'` callback, so patching
  `createServer` or `listen` is too late. pointout finds the server through
  `process._getActiveHandles()` and wraps that instance's `emit`.
- **On shutdown Next re-evaluates the config** in a detached telemetry flush (ppid 1),
  in `phase-development-server` and without `NEXT_PRIVATE_WORKER`, even with telemetry
  disabled.
- **On SIGINT the parent SIGKILLs the worker 100 ms after it exits**, so only
  synchronous `exit` cleanup runs. A `process.on('SIGTERM')` registered from the config
  cancels the default exit; pointout registers none.
- **`next dev -H localhost` binds `[::1]` only**; with no `-H`, Next binds `::`. The
  harness binds `127.0.0.1`.
- **An Overlay root made before the App Router hydrates kills every page handler**
  (ticket 06): React marks `document` as listened to. The entry polls for the hydrated
  root on `document` or `#__next`.
- **Turbopack rewrites a chunk in place under the same url**, and frames after a hot
  update still name the old line. Client drift is judged against when the Pick's own
  page began to load (`pageLoadedAt` on the body, the top document's
  `performance.timeOrigin`; when absent, against when pointout started), so a reload
  clears it and another tab's reload does not; server drift against the chunk file's
  mtime. Either way the mode is `no-transform-timestamp`, where Vite in Chromium and
  Firefox says `stale-transform`.
- **WebKit replays a Server Component's stack with no location** and no
  `react_stack_bottom_frame`, so those links are `absent: no-react-boundary` in WebKit
  (issue 11). Chromium and Firefox resolve them exactly.
- **A package link differs by Host**: `dependency, exact` on Next (Turbopack's map names
  the file), `absent` on Vite. A test asserts each Host's answer.
- **A detached `next dev` outlives a vitest worker ended by SIGTERM** unless the harness
  kills its groups on SIGTERM too, which `test/harness/next-server.ts` does (ticket 08).
  Signal only process groups you started; a broad `pkill` once killed a developer's
  unrelated `next dev`.

## The gates, and how to run them fast

| | |
| --- | --- |
| `npm run lint` / `format:check` / `typecheck` | **under 2s each** — run them constantly |
| `npm run test:server` | ~1.5 min, four files at a time; each Next test boots a `next dev`. About 600 tests |
| `npm run test:browser:fast` | ~1 min, Chromium, Vite's bed only |
| `npm run test:browser` | ~5 min, three engines on Vite, with Next's beds narrowed to what depends on the Host (`nextBedSuites`) — once, at the end |

**Iterate on single files; all three engines once at the end.** Run the file you are
changing (`npx vitest run test/server/<file>` after `npm run build`, or
`npx playwright test --project=chromium test/browser/<file>`), and the full
`caffeinate -i npm test` once, when you are done. Timings were measured on an 8-core
laptop at a load average of 7 to 25 (November 2026). The browser suite can run one
bed of one engine: `--project=chromium-next-app`.

**The browser suite binds a fixed port (5178).** Agents running in parallel worktrees must each
set `BROWSER_PORT` to their own port, or a bind failure reads as a broken test.
`npm run test:claude` really spawns a session; it is never in `npm test`.

Warnings are denied. Fix a finding; never suppress it. A rule may be configured in
`.oxlintrc.json` only with a comment line directly above saying why, and a test fails
any rule that has no reason beside it.

## Working beside other agents

Several agents share one working tree. **`git add` only your own paths — never
`git add -A` or `git add .`.** If a shared file holds someone else's changes too, stage
your hunks rather than the file. If a commit lands under you, rebase your thinking onto
it before committing. Your ticket names which files are yours.

**Only one full browser suite runs on the machine at a time.** Its `globalSetup` takes a
lock under the OS temp dir; a second run prints *waiting for another browser-suite run,
pid N* and waits, for up to 10 minutes, rather than doubling both runs' times. A
lock left by a killed run is taken over. So a wait there is another agent, not a
hang.

**Run your final full suite as `caffeinate -i npm test` on macOS.** Idle sleep once
stretched a browser-suite run to 18.6 minutes; `caffeinate -i` stops idle sleep while the
command runs, though not a lid close.

**Report the tree you proved green, and nothing is proved twice.** After your final
green full run, report `git rev-parse HEAD^{tree}` beside your commit. The
orchestrator reruns the full suite on main only when the merged tree differs from a
tree an agent reported green, and then once per batch of merges, not once per merge.

## Known open items

- **WebKit's Server Component links are `absent`** (Next.js Connector issue 11,
  needs-triage). The Server Component record's own `stack` is the likely route; it would
  need a field on `OwnerChainLink`.
- **A server chunk's staleness is judged against the chunk's mtime**, not when the page
  rendered: an edit after Turbopack rewrote the chunk, with the page still showing the
  old render, reads `exact`. A hot update refetches the RSC payload in practice, but
  nothing proves it. Pinned by a server-suite test and filed as Next.js Connector issue 12
  (needs-triage), with why the Pick's `pageLoadedAt` does not settle it.

- **The Overlay still names the harness in three places** (ticket 16): spec §17's
  sentences say "Claude", the wire carries `registry.hookFloor`, and `api.ts`, which
  the Overlay imports, exports the hook budget and `DRAIN_PATH`. Ticket 16's
  "no reference to Claude or hooks" box is met in substance only; a follow-up needs a
  harness-neutral wire name and the hook budget out of `api.ts`.
- **`GLOSSARY.md`'s Receipt says "bad outcomes only"**, but a `delivered` Receipt
  releases a `held` Pick. The definition needs that clause.
- **"reply" is on Ack's _Avoid_ list**, yet the code says "reply address" and the
  harness has `replyTo()`. Settle the word.
- **`GLOSSARY.md`'s Screen Capture says "a cropped image"**, with *crop* and *image*
  both on its own _Avoid_ list. The server's sentences no longer say "crop" (ticket 19).
- **Ticket 19 left three small gaps**: the temp directory's "not opened" posture line
  has no test; a capture-able server that refuses the page's capture request still
  reads to the agent as only "none was started"; the drain's too-large line still
  reaches the agent as context when it fits the budget (ticket 15's choice).
- **Spec corrections owed** (tickets 20 and 21): §15's mismatched-`session_id`
  Receipt does not exist; "every state except idle and you never type again" is false
  for a session started below the root; the origin record carries a fourth field,
  `msg_id`; the Stop drain leaves three records, not one; "default mode" is `manual`.
- **`GLOSSARY.md` has no term for the report-back offer and no definition of
  `unknown`** (ticket 14), and none for the Shutter (ticket 18), which is now in
  `data-shutter`, `styles.ts` and `docs/motion.md`.
- **The `review-animations` gate needs a re-run** before v0 is called done. Its
  2026-09-23 outcome covers the build at `2640572`; everything the overlay-polish
  tickets 03 to 10 made move came after it. `docs/motion.md` › *The re-run owed* lists
  what it has to see. It is run by the human, by name; no agent runs it.
- **`GLOSSARY.md` lags the Overlay** (overlay-polish): the Picker's _Avoid_ says no
  form is chosen, and the design plan now calls it an edge tab; the glossary says the
  **current** and **live** Highlight where the code says *mark* (`marks.ts`,
  `data-mark`); and there is no term for a frame shield.
- **The camera on a minimized Panel is the page's claim** (overlay-polish 08): it shows
  when the Send kept a capture, and `PickAccepted` does not say whether the tool then
  succeeded. Closing that needs a field on the accept answer.
- **A drained `sent` Pick cannot be withdrawn until its TTL fails it** (overlay-polish
  02): it has no report-back clock, so no offer comes. Adding `sent` with a null
  `reportBack` to `isWithdrawable` changes both halves at once.
- **The §21 audit table in v0 ticket 19 has no Withdraw row.** It would be *a Withdraw
  that implies recall*, held by three `withdraw.test.ts` journeys named in
  overlay-polish 02's Comments.
- **Frames, left open by overlay-polish 12**: a frame inside a shadow root is not
  found; the armed cursor and the armed `pointer-events` rule are set in the top
  document only; the wheel over a frame shield scrolls the top page; and
  `topDocumentPoint`, like `viewportBox`, walks to the outermost same-origin window, so
  if the Overlay's own page were framed by a same-origin parent, a point from one of
  its child frames would come back in the parent's coordinates.
- **A Vite page framing another page Vite serves would draw two Overlays.** Next's entry
  draws nothing in a same-origin child frame (`src/next/overlay.ts`); Vite's has no such
  check, and its only frame fixture is `about:blank`, so nothing holds it (Next.js
  Connector ticket 06's Comments).
- **"Back to your pick" has no guard against a narrow viewport's right edge.**
- **react-dom under Trusted Types is unverified.** The Overlay's surfaces are built by
  react-dom now, and the guarantee that nothing builds DOM from a markup string rests on
  its behaviour under the first consumer's `require-trusted-types-for 'script'`. Check
  it against that app before v0 is called done (ADR-0004).
