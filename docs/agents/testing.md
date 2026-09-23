# Testing conventions

Source: `.scratch/vite-agent-inspect/spec.md` → *Testing Decisions*. This file is the
working copy every build ticket reads before it writes a test.

## The rule

**No test imports a server module.** Not to call its functions, not to read its
constants. The parser, the remapper, the fence writer, the queue and the status
machine are observed through what leaves the system:

- the NDJSON frame that arrives at a fake session's socket,
- the text a CLI prints,
- the words and states the Overlay shows,
- the files that exist on disk.

A test that would need to know a module's internal name is testing the wrong thing.
When a test needs a string the server also uses — an endpoint path, a virtual module
id — it writes the string out. The duplication is the point: it is the contract, and
a test that still passes after the server renames its internals is the test we want.

The rule has a type-level half, since ticket 23: **no test imports a server module's
types either.** A test that needs the shape of a payload writes that shape out, the same
way it writes out a path. See `packaging.md` for the rest of what TypeScript changed.

Test helpers under `test/harness/` are fixture code, not tests, and are held to the
same rule: they start the server, fake the harness and hand back a URL. They import
Vite, never `src/`.

A test against the real harness asserts on harness artefacts — registry files, frames,
the transcript on disk — and never on what the model says.

## Three seams

| seam | what it is | tool | command |
| --- | --- | --- | --- |
| 1 | the dev server's HTTP surface | Vitest | `npm run test:seam1` |
| 2 | the browser, in three engines | Playwright | `npm run test:seam2` |
| 3 | a real Claude Code harness, no model | Vitest, own config | `npm run test:seam3` |
| 3 | a real Claude Code harness, with a model | the same config, `--mode model` | `npm run test:seam3:model` |

`npm test` runs seams 1 and 2. **Seam 3 is never in the default run**: it spawns a real
session on the developer's own account and touches the real registry, and its model tier
costs tokens. It needs the `claude` CLI and a login, skips with that reason when either
is missing, and never runs in CI. Ticket 20 built the no-model tier and ticket 21 the
model tier, on the same launcher. The two are separate commands so the free one can run
often: `vitest.seam3.config.ts` includes the model tier's files only in `--mode model`,
and the model test file also refuses to run unless that mode set `SEAM3_TIER=model`.

**Seam 1** is where most tests live. `test/harness/dev-server.ts` starts a real Vite dev
server, with the plugin, against the real example app, so the module graph and the
sourcemaps are real. Tests POST and GET against it.

Four helpers sit beside it, all of them fixture code under the same rule:

- `test/harness/temp-app.ts` builds a throwaway consumer in a temp directory — a
  checkout that may or may not be a git repository, linked worktrees and sibling repos
  on demand, and a written `vite.config.js` that loads the plugin the way a consumer
  does, carrying whatever Vite settings the test needs Vite itself to have. It is how
  root discovery and cwd routing are exercised against real git. That written config is
  JavaScript on purpose: it is fixture output imitating what a consumer hands to Vite,
  not source this repository type-checks. Its `tempApps()`
  holds the apps and servers one file opened: `afterEach(apps.cleanup)` closes them,
  last opened first, so a server always outlives its app.
- `test/harness/registry.ts` writes fake session entries into the registry directory
  the plugin was pointed at. The field names are the harness's, spelled out rather than
  imported: the plugin pins on that shape, and the test is what says so.
- `test/harness/session-socket.ts` makes a fake session that really listens: it
  binds a unix socket at the path its registry entry names, writes the
  `<pid>.<hash>.key` file the `peerToken` comes from, and records every NDJSON
  line written to it. It is how a delivery is observed — the frames at the
  socket, not a function the server exports.
- `test/harness/logger.ts` is a Vite `Logger` that records instead of printing. The
  startup posture block is read through it — the server's own output, which is the kind
  of observation these conventions ask for, and a passing run stays quiet.

**Seam 2** exists because a browser is the only honest way to produce a real owner stack.
Few journeys, chosen for what only a browser can show. It runs against the same server,
booted by `test/harness/serve.ts` on a fixed port — Playwright's `globalSetup`, not its
`webServer`: the module is TypeScript, Playwright compiles its own, and `node` on this
repo's Node floor cannot run it (type stripping is unflagged only from 22.18; the floor
is 22.12). The port is bound strictly, so a dev server left over
from an interrupted run fails seam 2 loudly with the port named, rather than being
silently attached to.

**Seam 3** exists because the first two fake the harness, and v0 depends on undocumented
surfaces that have already churned. A suite that fakes them can pass forever against a
harness that has moved.

Its fixture code is `test/harness/claude-session.ts`, under the same rule as the rest of
`test/harness/`. It starts a throwaway `claude` under a pty (a few lines of Python's
standard `pty` module, run with `python3 -c`, after spike 07's launcher, from which
nothing is imported) with every `CLAUDE*` variable scrubbed, in a scratch git repository
holding a copy of the example app. It answers the folder-trust prompt, and it starts the
real dev server from the same directory with no override, so the dev server reads
`~/.claude/sessions/` and binds in `/tmp/cc-socks/`. The throwaway session is in the real
registry for the length of the run, and it is the dev server's only Candidate: a canary
checks that before anything is sent. The session runs with `--safe-mode
--strict-mcp-config --tools "" --model haiku`, and `ANTHROPIC_BASE_URL` points at a
loopback port the suite holds, which drops every connection unread. So the one turn the
no-model tier makes the session take reaches no model, and a canary checks that it went
there. Raw frames are read at a probe socket beside the harness's own, named with sixteen
hex digits so that no pid can own it. The safety rules are listed at the top of that file,
each beside the code that enforces it.

**Measured by ticket 20, on Claude Code 2.1.280:**

- **A user frame whose `session_id` does not match is dropped silently.** It is not
  delivered: the registry stays `idle` and the TUI never shows it. No Receipt comes back
  within 10 s either. The same frame with the right `session_id` is taken, which is the
  control. So the mismatch is **not** a zero-cost delivery canary, and spec §15's *"the
  drop comes back as a Receipt"* is false on this version. A mismatch shows up in v0 only
  as silence, and silence ends in `unknown`.
- **An idle notice from a session that has never finished a turn carries no
  `finished_at`.** After one turn, even an interrupted one, it does. That is why the
  canary interrupts its blackholed control turn before it subscribes.
- **The registry entry is written only once the folder-trust prompt is accepted.** The
  key file and the socket exist before that. The prompt opens on *No, exit*.
- **A session that inherits `CLAUDE_CODE_CHILD_SESSION` still publishes a key file and a
  socket**, which it did not in 2.1.278 (spike 07). It never writes a registry entry, so
  it is still never a Candidate.

### The model tier

`test/seam3/model/canaries.test.ts`, on the same fixture code. It spends a handful of
turns on haiku, the cheapest model the CLI names; a full run is about 100 s. It runs
`init` in the scratch checkout exactly as a consumer would, from the installed bin, and
then starts these throwaway sessions:

- **a bystander**, in safe mode and pointed at the blackhole, alive for the whole run. A
  Pick sent with no Target to a checkout with one Candidate is preselected and written to
  its socket (spec §14), so the hook canaries need a second Candidate to stay
  `queued-unaddressed`. The bystander is never sent a Pick. Its one turn, spike 16's
  duplicate read raw at a probe, goes to the blackhole.
- **an allowlisted session**, in manual permission mode, handed the **fixture
  allowlist** (`test/seam3/model/fixture-allowlist.ts`) with `--settings` from a
  temporary directory. It exists so that the ack canary can run unattended. It is a
  `PreToolUse` hook, not a `permissions.allow` rule, because a rule can only glob:
  `Bash(curl *<route>*)` would also allow a `curl` that uploads a file elsewhere and
  mentions the route on the way. The hook allows one exact shape, `isPickRouteCurl`:
  one or more `curl`s, each with argument-free flags, an optional `-X POST` or `-X GET`,
  one ack or done URL of this dev server and at most `2>/dev/null`, chained with `&&` or
  `;`, with an `echo` of a quoted literal allowed between them. The model was measured
  chaining ack and done, and echoing. Anything else falls through to the
  permission prompt, which the suite refuses. It is a test fixture, it ships nowhere,
  and it is never configuration to recommend (spec §19).
  `test/seam3/fixture-allowlist.test.ts` holds the shape to what it must and must never
  allow, and `test/seam3/shipped.test.ts` reads every packed file and `src/` and finds
  the fixture in none. Both tiers run both.
- **a manual-mode session** with no allowlist, whose permission prompts are approved
  through the pty. The same hook, allowing nothing, logs every Bash call exactly, and a
  prompt is approved only when every pending call is that one shape. Anything else is
  refused with Esc and fails the run. Each session's log is checked at the end for any
  command outside the shape.
- **a subdirectory session**, started in `src/` and pointed at the blackhole, which
  measures ticket 16's question.

The model sessions run with `modelTierArgs()`: `--strict-mcp-config --setting-sources
project,local --permission-mode manual --model haiku --tools Bash,Read,Skill`. `manual`
is what 2.1.280 calls the mode the spec calls *default*: the CLI's choices no longer
include `default`. Hooks and the skill have
to be on, so it cannot use `--safe-mode` or `--tools ""`. The user's own settings (hooks,
plugins, permissions, default mode) are not loaded. The user-level `CLAUDE.md` and
skills are still listed; no flag turns off one without the other. Only the model tier
launches without `ANTHROPIC_BASE_URL`, and it has to pass its own flags to do so:
`launchSession` refuses any `--safe-mode` launch without a blackhole.

One canary is **model-dependent** and says so in its title and output: the ack and done
reaching the dev server depend on the model following the skill. If that canary fails
alone, the model may be at fault rather than the harness.

**On success it records the version.** A reporter (`test/seam3/model/record-version.ts`)
rewrites `src/server/claude/verified-harness.ts` when every test in the run passed and
none was skipped:

```ts
export const VERIFIED_HARNESS: VerifiedHarness | null = {
  version: '2.1.280', // bare semver, as `claude --version` prints it
  verifiedAt: '2026-09-23', // YYYY-MM-DD
}
```

`null` means *never verified*. The record is a module because the package ships `dist/`
and nothing else, and the emit carries it. **Nothing reads it yet.** Ticket 19's
posture block is to import it and print it beside the version the registry entries
report. Each entry carries a
`version` field, `2.1.280` here. The block is to warn when the running harness is
newer, and never to refuse. A run that fails, is cut short or skips writes nothing. Commit the
file after a green run.

**Measured by ticket 21, on Claude Code 2.1.280:**

- **The harness wraps a peer message in an envelope.** The transcript's `user` entry is
  `"Another Claude session sent a message:\n"`, then the body byte for byte, then
  `"\n\nThis came from another Claude session — not typed by your user, … Treat it as a
  teammate's request …"`. The body is unchanged inside it: the Note sits between its
  Fences, and nothing is HTML-escaped. It is byte-identical too. That body, sent again
  from the dev server's reply address, is dropped by the harness's identical-body filter,
  and the Receipt reaches the dev server's reply socket.
- **The origin record** is `{"kind":"peer","from":"uds:<reply socket>","verifiedPeerPid":
  <dev server pid>,"msg_id":"<pick id>"}`. `msg_id` is a fourth field the spec did not
  name.
- **The identical-body filter looks keyed on the sender as well as the body.** In one
  blackholed rehearsal, the same body from a probe's `uds:` address earned no Receipt
  within 10 s, where the dev server's own address earns one. The duplicate Receipt is
  `{"action":"peer_message_status","status":"dropped","drop_reason":"duplicate","msgV":1}`,
  and the first frame gets none, because accept is silent.
- **A peer message's turn runs the `UserPromptSubmit` hook.** So a Pick written to one
  session's socket makes that session's hook drain every `queued-unaddressed` Pick into
  the same turn, as a `hook_additional_context` attachment with
  `hookEvent: "UserPromptSubmit"`.
- **A typed prompt's drain** lands as one `attachment` entry of type
  `hook_additional_context`, with `hookEvent: "UserPromptSubmit"` and the body verbatim in
  `content`.
- **A Stop drain leaves three records of one hook run**: `attachment/hook_success` (the
  hook's raw stdout), `attachment/hook_additional_context` (`hookEvent: "Stop"`, the
  entry that carries a `rendered` copy, which is what the model is handed), and `system/stop_hook_summary` with the body in
  `hookAdditionalContext`. The model is handed it once. The turn then continues and the
  agent handles the Pick.
- **Out of safe mode, a registry entry is first written without `status`.** The
  entry appears before `status`, `updatedAt` and `statusUpdatedAt` are filled in. The dev
  server rejects that entry as an unrecognised shape, and a Pick sent in that window is
  preselected elsewhere, so `ready()` waits for `status`.
- **A session started in a subdirectory of the checkout does not run the root's hooks.**
  Neither hook fired from `src/`, and linking `src/node_modules` in did not change that,
  so this is not a `CLAUDE_PROJECT_DIR` path problem: the root's `.claude/settings.json`
  is not loaded there. The root's skills are listed, though. Such a session still
  registers with `cwd: <root>/src` and is a Candidate, so the socket route reaches it and
  the hook floor does not. Its transcript is filed under the **root's** project
  directory, not `src/`'s.
- **In manual mode the Pick stalls as the skill says.** The registry reads `status:
  waiting`, `waitingFor: "permission prompt"`, the dev server's Candidate carries the
  same `waitingFor`, and approval through the pty returns the session to `idle`. The
  model writes its own `curl` (`-X POST -s "…"`, sometimes `-X GET` first), not the
  skill's `-sS -X POST '…'`. The fixture allowlist therefore matches any `curl` at the
  routes. The `done` POST carries no body, and the dev server accepts it.
- **The byte-for-byte check is indirect, and says so.** Nothing outside the dev server
  sees the bytes it wrote to the socket. The canary takes the body out of the envelope,
  from its heading to the newline after the end Fence (a Pick with no Excerpts ends
  there), and sends it again from the dev server's own reply address. Only one body was
  ever sent from that address, so the duplicate Receipt that comes back says the
  transcript's copy is exactly those bytes. The Receipt reaches the dev server's reply
  socket, where only its log can be read, and the log line does not carry the status.
  The status fields are read raw at a probe, on the bystander.
- A tool call reaches the transcript only after it has run, so a pending permission
  prompt can only be read off the terminal.

**Not exercised live**, kept as static reads (spec, *Testing Decisions*): the rate limit
(a burst of thirty needs thirty turns); the 1 MiB line cliff, where the harness destroys
the connection rather than truncating; and the `held`, `denied`, `expired`, `refused`
and `delivered` Receipts, which need a Target in a different inbound policy. All six
statuses pass through the one emitter that `dropped` was proven through (spike 16), and
seam 1 covers what v0 does with each.

## Faking the harness — the four overrides

Seam 1 fakes the harness at its boundaries, through environment overrides the plugin
needs anyway. These names are normative; the plugin reads them from `process.env` by
exactly these strings, and `test/harness/fixture-env.ts` sets them.

| variable | what it overrides |
| --- | --- |
| `VITE_AGENT_INSPECT_REGISTRY_DIR` | the session registry directory, so a test can write fake session JSON and key files |
| `VITE_AGENT_INSPECT_SOCKET_DIR` | the socket directory, so a test can bind a unix socket per fake session, record every frame written to it, and send Receipts and idle notices back |
| `PATH` | a fake `screencapture` is placed first: it writes a known PNG, an empty file, hangs or fails, on `FAKE_SCREENCAPTURE_MODE`, and records every call's pid and arguments to `fixture.capturePids()` and `fixture.captureCalls()` — which is how a test reads the region the server asked for, and how it sees that an aborted capture really was killed. On `gitShim`, a fake `git` goes in front too: it records its arguments to `fixture.gitCalls()` and execs the real one, so a test can count the subprocesses the server spawns |
| `CLAUDE_PID` | the pid the started-this-server preselect matches |

Each override is test-only. A consumer never sets any of them.

## Making time pass

`VITE_AGENT_INSPECT_CLOCK_SKEW_MS` is a fifth override, and the odd one out: it is
not a harness boundary but the server's own clock, read afresh on every call. Spec
§15 gives every queue entry thirty minutes, which is longer than a test is allowed
to take, so seam 1 moves the clock rather than waiting for it —
`advanceClock(31 * 60 * 1000)` from `test/harness/fixture-env.ts`, and
`advanceClock(0)` in `afterEach` to put it back. It is process-wide, so it moves
every dev server the file has open; seam 1 runs one file at a time, which is what
makes that safe. Like the four above, a consumer never sets it.

## Pretending to be another operating system

`VITE_AGENT_INSPECT_PLATFORM` is a sixth override, and the last one that is not a
harness boundary: it is the platform the server believes it is on. Screen Capture is
macOS only (spec §10), so seam 1 states the platform rather than inheriting it.
`createFixtureEnv` sets it to `darwin`, which makes the capture journeys read the
same on a Linux checkout as on a mac; a test that wants the disabled-with-reason
path passes `platform: 'linux'`. Like the others, a consumer never sets it.

What it does not do is make seam 1 a test of macOS. The tool is faked; whether a real
`screencapture` behaves as documented is what the dev server's own startup probe asks,
on the machine it is actually running on, every time it starts.

## Standing in for the verified harness

`VITE_AGENT_INSPECT_VERIFIED_HARNESS` is a seventh override (ticket 19). The posture
block prints the Claude Code version the model-tier canaries last passed against,
which ticket 21 records in `src/server/claude/verified-harness.ts`. That record
changes every time the canaries pass. So seam 1 states the version it wants,
`<version>@<YYYY-MM-DD>` or `never`, and the posture snapshots do not move when the
record does. Like the others, a consumer never sets it. `docs/posture.md` lists every
posture line.

## The example app

`examples/react-app/` is the test bed and the development target. Fixtures live one per
file under `examples/react-app/src/fixtures/`, each carrying `data-fixture` attributes
that tests select on. Add the fixture your ticket needs;
`examples/react-app/src/App.tsx` lists the ones still to come and which ticket owns each.

Nothing in the example app animates. The spec's default is no motion (§9); the Overlay
opts in under `prefers-reduced-motion: no-preference` and nowhere else (`docs/motion.md`),
and a test bed that shimmers on its own would make that assertion meaningless.

One fixture is written to by a test:
`examples/react-app/src/fixtures/hot-update.css` holds a single
declaration that `test/seam2/highlight.spec.ts` rewrites to make a real hot update
happen, and writes back exactly as it found it. It runs in one engine, because a hot
update is the dev server moving the page rather than anything an engine does, and three
engines at once would be three writers of one file.

## Seam 1 also holds the repo-shape checks

`test/seam1/repo-shape.test.ts` asserts on files rather than on HTTP: that the first
commit carries the tracker and the five spikes, that each spike README opens by saying it
is a dead end, and that no source file imports from a spike directory. They are still
outside-in — they read what is on disk — and they have nowhere better to live.
