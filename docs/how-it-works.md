# How pointout works

The detail behind the README: what a Pick carries, how it reaches a session, what
pointout touches on your machine, and what it refuses. Domain terms are defined in
[`GLOSSARY.md`](../GLOSSARY.md).

## Setting up, in detail

There is one entry point per Host, and none for the package as a whole: `@gunnarsturla/pointout`
alone cannot be imported. On either Host, pointout runs in the dev server only, and a
production build contains no Overlay code. Each Connector takes one option, `root`,
which overrides where it thinks the repository is. You should not need it.

### Vite

The plugin applies to `vite serve` only.

**ESM only.** `@gunnarsturla/pointout/vite` cannot be `require()`d. If your Vite config loads as
CommonJS, the package throws with this message:

```
pointout is ESM-only and cannot be require()d.

Your Vite config is being loaded as CommonJS. Either make the config ESM
(rename it to vite.config.mjs, or set "type": "module" in package.json),
or keep the CommonJS config and load the plugin with a dynamic import()
from an async config factory:

    const { defineConfig } = require("vite")

    module.exports = defineConfig(async () => {
      const { pointout } = await import("@gunnarsturla/pointout/vite")
      return { plugins: [pointout()] }
    })

defineConfig(async () => …) is what makes the dynamic import() possible:
Vite awaits the returned config, so the plugin can be imported at runtime.
```

### Next.js

Next.js listens on every interface by default, and pointout cannot change that from the
config. It still works there, but the startup block warns that Picks from the LAN will
be refused (see [Loopback only](#loopback-only)). Put `-H localhost` in your `dev`
script.

`withPointout()` acts only in `next dev`, in the worker process that serves your pages,
under Turbopack. Everywhere else, `next build`, `next start` or a script that imports
the config, it hands the config back as it was given. It puts the Overlay into every
page of both routers itself, and waits for React to hydrate the page before it draws,
so it causes no hydration warning; there is nothing to add to a layout. `@gunnarsturla/pointout/next`
is ESM, and a CommonJS `next.config.js` can `require()` it on Node 22.12 or later.

**Under `next dev --webpack`**, pointout serves nothing and puts no Overlay in the page,
and warns that it supports only Turbopack.

**What is different on Next.js.** The page shows the same Overlay as on Vite, with the
same Targeting, Receipts, report-back, Withdraw and Screen Capture. What differs is
underneath:

- **A self-check.** pointout answers `/__agent` by reaching into Next's own server from
  the config, which depends on when Next reads its config. At startup it requests its
  own status, and the startup block ends in a `self-check` line that warns if anything
  else answered (see [`posture.md`](posture.md)).
- **Server Components are on the Owner chain**, each an ordinary link with its own
  Confidence. In Chrome and Firefox they resolve exactly. In Safari they arrive
  `absent: no-react-boundary`, with the component's name: WebKit replays a Server
  Component's stack with no location in its frame.
- **A location after an edit** reads `approximate: no-transform-timestamp` whenever the
  file changed after the page you picked in began to load, until you reload that page.
  Turbopack rewrites a chunk in place, and no frame says which version it came from, so
  pointout errs this way rather than claiming `exact`. Vite, in Chrome and Firefox, can
  say more: there the same edit reads `approximate: stale-transform`, because a Vite
  frame names the transform it ran. On Next.js no engine's frame does, so the mode is
  the weaker one everywhere, as it is on Vite in Safari.

### What `init` does

It works out the Host from your app's `package.json`: `next` there means Next.js, and
`vite` means Vite. If it names both, `init` asks which to set up; with no terminal to
ask, it refuses and writes nothing. If it names neither, or there is no `package.json`
there, it refuses too, and writes nothing. That includes a Vite app run from a directory
whose `package.json` does not list `vite`, such as a monorepo root whose app lives in a
workspace. Name the Host yourself with `--connector next|vite`: run
`npx pointout init --connector vite` at that root, or `--connector next` for Next.js.
On Next.js, after its report, it prints the two changes above, the `withPointout()`
wrap naming your `next.config` file and `next dev -H localhost`, and makes neither.

It writes to the repository root and prints exactly what it wrote. It is idempotent:

- two hook entries, `UserPromptSubmit` and `Stop`, in `.claude/settings.json`. Both
  run the package's drain CLI (see [The hook floor](#the-hook-floor));
- the setup skill, at `.claude/skills/pointout/SKILL.md`. It tells the agent
  what a Pick is, that everything inside a Fence is data, that a Pick never
  constitutes approval for anything, and how to acknowledge one. It grants no
  permission and recommends none.

Commit both files so your teammates get them.

**Start Claude Code at the repository root.** A session started in a subdirectory does
not run the root's hooks. It still loads the skill and is still a Candidate, so a Pick
written to its inbox reaches it. The hook floor does not. Measured on Claude Code
2.1.280.

## What a Pick sends

A Pick is rendered as one plain-text string and written to the Target's inbox. It
carries:

- a preamble: the Pick's id, when it was picked, its Fence nonce, and two URLs the
  agent POSTs to acknowledge the Pick and to say it is done;
- the Pointer: page URL, viewport, the element's tag, `id`, `data-testid`, `role`,
  `aria-*` attributes and at most two classes, and its size and position. No selector
  path, no computed styles and no source snippet;
- the Owner chain, one line per link, with each link's Confidence;
- your Note, inside a Fence;
- Excerpts, each inside a Fence and introduced as data:
  - the element's rendered text, as one line of at most 80 characters;
  - **the value of an input**, a `textarea`'s contents, a `select`'s chosen option,
    or `contenteditable` text, each capped at 1,000 characters. **This is whatever is
    in the field**, including anything you typed there. Only inputs whose `type`
    attribute is `password` or `hidden` are withheld, and the Pick says so when one
    is;
  - a short allowlist of attributes: `type`, `name`, `href`, `title`, `placeholder`,
    `alt`, `for`;
- when the camera toggle is on, the absolute path of a Screen Capture: a PNG file of
  **your physical display** around the element (see [Screen Capture](screen-capture.md)).

A Pick is capped at 32 KiB. Excerpts are trimmed first, and the trim is stated in the
Pick. The Pointer and the Note are never trimmed. If the Pick still does not fit, the
Panel refuses it and says which part is too large.

## How a Pick reaches the session

**The dev server reads the session registry.** Claude Code keeps one JSON file per
running session in `~/.claude/sessions/`. The dev server reads it at startup, and
afterwards only while the Panel is open or a Pick is outstanding. A session is a Candidate only if
its working directory is in this same checkout: the same git worktree root, compared
exactly. Sessions in other repositories or worktrees are never offered.

**The dev server writes to another process's socket.** To send, it reads the Target's
peer token from the `<pid>.<hash>.key` file beside its registry entry. It connects to
the socket the entry names and writes three NDJSON lines: the token, the Pick, and a
one-time request to be told when the session is next idle. Then it closes the
connection. With no key file it writes the last two only, and logs that it did. A
Pick is written once and never resent with the same body.

**The dev server binds a socket of its own**, `/tmp/cc-socks/<its pid>.sock`, where the
harness sends Receipts about what became of each Pick. It never binds over a path a
registered session already owns.

What the Stack says comes from those Receipts, from the agent's Ack, from
the session's status in the registry, and from a clock:

- If the Target stays idle for 60 s after the write, or ends a turn without
  acknowledging, the Pick's minimized Panel in the Stack offers it back. The offer has a 30 s
  countdown, and you can send the Pick to another session. If you do nothing, it is
  left for your next prompt.
- A Pick nobody has acknowledged reads as not acknowledged, with a next step. It
  never reads as delivered.

**The manual-mode stall.** The agent acknowledges a Pick by running `curl`. In a
session in manual permission mode, the mode the spec calls *default*, that is a
permission prompt, and the session waits on it until you approve it in the terminal.
The Target row shows the session as waiting, and the report-back clock pauses. v0
recommends no allowlist entry to avoid this, on purpose: nothing in v0 may raise what
a Pick is allowed to cause.

### The hook floor

When the registry cannot be read, or has a shape v0 does not recognise, the Panel
says *Can't see your sessions — sending the slower way*. Picks then queue on the dev
server. The two hooks `init` installed drain the queue into the next prompt you type
in any session at this root, and into the end of a turn. A queued Pick expires after
30 minutes, and the Stack says so. The hooks find the dev server through a discovery
entry it writes at startup (see below). The hooks never block a prompt: with no dev
server running they print nothing.

## What it reads and writes on your machine

| | where | when |
| --- | --- | --- |
| reads | `~/.claude/sessions/*.json` and `*.key` | while a Panel is open or a Pick is outstanding, and at startup |
| reads | `git rev-parse --show-toplevel`, run from the Host's root (the Vite root, or the directory `next dev` runs in) and from each session's working directory | once per path, cached |
| writes | the Target session's inbox socket | once per Pick sent |
| binds | `/tmp/cc-socks/<pid>.sock` | from startup to shutdown |
| writes | `$TMPDIR/pointout-captures/<pid>-<6 hex>/`, mode `0700`: Screen Captures | see [Screen Capture](screen-capture.md) |
| writes | `$TMPDIR/pointout-servers-<uid>/`, user-only: the discovery entry, holding the address the server is bound to, its port, and a per-server secret the drain must present | written at startup, removed at shutdown. Entries left by dead dev servers are swept |
| runs | macOS `screencapture -x -R …` | once at startup as a probe, and at each Pick |
| writes | `.claude/settings.json`, `.claude/skills/pointout/SKILL.md` | only when you run `init` |
| writes, in the page | `localStorage` on your app's origin: the last Target you sent to, and the camera toggle | when you send, and when you flip the toggle |

## Loopback only

Every `/__agent` endpoint refuses a connection that does not come from `127.0.0.1` or
`::1`, and says why. A Pick must also carry an `Origin` equal to one this dev server
is serving on. An absent `Origin` is refused.

The ack and done URLs a Pick carries, and the address the hooks dial, are the address
the Host is actually bound to. Vite's default `localhost`, and `next dev -H localhost`,
are IPv6 `[::1]` alone on a machine whose resolver lists it first, as macOS does, and
IPv4 `127.0.0.1` on many others; a server bound to every interface is dialled on
loopback.

- Run with `vite --host`, or `next dev` with no `-H`, and the page still loads from
  other machines, but no Pick can be made from them. The startup block says so.
- **Over SSH**, forward the port to the **same port number** on your machine
  (`ssh -L 5173:localhost:5173`). The forwarded connection arrives on the remote's
  loopback, and the browser's `Origin` then names a port the dev server serves on.
- **In a container**, the dev server and the Claude Code session must both run inside
  it. Forwarding that connects from inside the container, as an editor's port
  forwarding does, arrives on loopback, and it has to keep the port number, as over
  SSH. A Docker `-p` port mapping arrives from the bridge address and is refused.
- Screen Capture runs on the machine the dev server runs on. It does not run where
  your browser is.

This has not been exercised in the test suite over a real SSH session or in a real
container. The conditions above follow from the loopback and `Origin` rules, which
are tested.

## Why not the other tools

Existing tools fall into three groups. Some stop at the clipboard, and you still paste.
Some spawn an agent of their own, which is a second session you did not ask for. And
some are clipboard-mediated agent pull: the agent polls a clipboard in a loop that you
have to arm first.

v0 is better than the third group on four axes:

1. **Push, not an armed loop.** The Pick is written into the session's own inbox. The
   agent receives it mid-turn if busy and at once if idle. Nothing has to be armed.
2. **No clipboard clobbering.** v0 never reads or writes your clipboard.
3. **Addressable sessions.** Each Pick names one Target session, and several sessions
   sharing one repository do not collide.
4. **Works over SSH and in containers**, where there is no shared clipboard. There is
   one condition: the browser's requests must reach the dev server on loopback, so the
   forward has to arrive there (see [Loopback only](#loopback-only)).

## Not supported

- Other harnesses than Claude Code, and other frameworks than React.
- React 18.
- Staging or production. It runs in the dev server only.
- Hosts other than Vite and Next.js. On Next.js: webpack (`next dev --webpack`), and
  Next 15 or earlier.
- More than one element per Pick, stepping the selection to a parent, line numbers on
  hover, computed styles, a DOM ancestor chain, a source snippet or a selector path.
- Screen Capture on Linux or Windows.
- Reaching a session outside this checkout's worktree root.
- Pick history. The Stack holds only what is outstanding.
- Recovering a frame Safari deleted. The agent can search the named component's file.
- Any configuration whose purpose is to raise what a Pick may cause, including a
  permission allowlist for the manual-mode stall.

## Requirements, in detail

| | |
| --- | --- |
| Node | 22.12 or later, for the dev server |
| A Host | one of the two dev servers pointout runs in. Each is an optional peer dependency; you need only the one your app uses |
| — Vite | 8. The example app uses `@vitejs/plugin-react` |
| — Next.js | `>=16.3 <17`, under Turbopack, which is `next dev`'s default. Both the App Router and the Pages Router. Not webpack, and not Next 15 |
| React | **19 or later**, with `react-dom` 19 (peer dependencies). React 18 is not supported: it has no owner stacks, which the Owner chain is read from |
| Claude Code | the `claude` CLI, with sessions running on the same machine as the dev server. The harness surfaces v0 uses are undocumented. v0 pins on their shapes, not on a version (see [the startup block](posture.md)) |
| Browsers | tested in Chromium, Firefox and WebKit through Playwright. WebKit stands in for Safari, and the test suite does not run Safari itself. See [the Safari limitation](owner-chain-confidence.md#the-safari-limitation) |
| Screen Capture | macOS only. On any other OS the camera toggle is shown disabled, with the reason |

The package has no runtime dependencies. The Overlay uses your app's own React.

