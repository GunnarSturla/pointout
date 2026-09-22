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
| 3 | a real Claude Code harness | Vitest, own config | `npm run test:seam3` |

`npm test` runs seams 1 and 2. **Seam 3 is never in the default run**: it spawns a real
session on the developer's own account, touches the real registry, and its model tier
costs tokens. It needs the `claude` CLI and a login, skips with that reason when either
is missing, and never runs in CI. Tickets 20 and 21 build it; today it reports that it
is not implemented.

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
