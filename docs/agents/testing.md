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

**Seam 1** is where most tests live. `test/harness/dev-server.mjs` starts a real Vite dev
server, with the plugin, against the real example app, so the module graph and the
sourcemaps are real. Tests POST and GET against it.

**Seam 2** exists because a browser is the only honest way to produce a real owner stack.
Few journeys, chosen for what only a browser can show. It runs against the same server,
booted by `test/harness/serve.mjs` on a fixed port.

**Seam 3** exists because the first two fake the harness, and v0 depends on undocumented
surfaces that have already churned. A suite that fakes them can pass forever against a
harness that has moved.

## Faking the harness — the four overrides

Seam 1 fakes the harness at its boundaries, through environment overrides the plugin
needs anyway. These names are normative; the plugin reads them from `process.env` by
exactly these strings, and `test/harness/fixture-env.mjs` sets them.

| variable | what it overrides |
| --- | --- |
| `VITE_AGENT_INSPECT_REGISTRY_DIR` | the session registry directory, so a test can write fake session JSON and key files |
| `VITE_AGENT_INSPECT_SOCKET_DIR` | the socket directory, so a test can bind a unix socket per fake session, record every frame written to it, and send Receipts and idle notices back |
| `PATH` | a fake `screencapture` is placed first: it writes a known PNG, an empty file, hangs or fails, on `FAKE_SCREENCAPTURE_MODE` |
| `CLAUDE_PID` | the pid the started-this-server preselect matches |

Each override is test-only. A consumer never sets any of them.

## The example app

`examples/react-app/` is the test bed and the development target. Fixtures live one per
file under `src/fixtures/`, each carrying `data-fixture` attributes that tests select on.
Add the fixture your ticket needs; `src/App.jsx` lists the ones still to come and which
ticket owns each.

Nothing in the example app animates. The spec's default is no motion (§9); ticket 09 opts
in under `prefers-reduced-motion`, and a test bed that shimmers on its own would make that
assertion meaningless.

## Seam 1 also holds the repo-shape checks

`test/seam1/repo-shape.test.js` asserts on files rather than on HTTP: that the first
commit carries the tracker and the five spikes, that each spike README opens by saying it
is a dead end, and that no source file imports from a spike directory. They are still
outside-in — they read what is on disk — and they have nowhere better to live.
