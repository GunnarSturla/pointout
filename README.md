# vite-agent-inspect

> Point at something in your running app, type what's wrong, and have it land in the
> Claude Code session you already have open for this repository.

**Status:** v0, unpublished, dev server only. It is not on npm. v0 is not yet declared
done: two human checks remain (see [Before v0 is called done](#before-v0-is-called-done)).

---

## What it does

You are looking at your app in the browser and one element is wrong. Hold Alt/Option,
or click the Picker, and a Highlight follows whatever you hover, with a chip naming the
component and its file. Click, and a Panel opens beside the element. Type a Note and
press Enter. The Pick goes into the inbox of a Claude Code session working in this
checkout, with the element's Owner chain attached:
every JSX call site that produced the element, innermost first, each as
`path:line:col` with a stated Confidence.

- **The Picker** is a small tab at the bottom centre of the page, peeking up from the
  edge with a crosshair and the word **Pick**. It comes out when you hover it or give it
  focus, and stays out while anything is unresolved. Armed, it turns solid blue and
  reads **Picking…**; click it again to stop. When the open Panel has scrolled out of
  view with its element, **Back to your pick** appears beside it.
- **Enter** sends, **Shift+Enter** starts a new line, **Escape** discards. `Escape`
  unwinds one level at a time: picked, then armed, then off.
- With an empty Note the button reads **Locate & stand by**: the agent finds the
  element, reports where it is and changes nothing.
- The Note is capped at 4,000 characters. A counter appears from 3,500.
- **Alt-click another element** before sending and the Pick moves there, keeping your
  Note. While the Panel is open, holding Alt shows a second Highlight on whatever you
  hover, so you see what an Alt-click would pick before you make it. After sending,
  Alt-click starts a new Pick.
- **A Pick has one Panel for its whole life, in two forms.** Before you send, it is
  open beside its element, and there is only ever one. Send shrinks it into the
  **Stack**, bottom right, where it rests **minimized** until its fate is settled: one
  line with a traffic light, the component, the first line of your Note, and a camera
  if a Screen Capture went with it. The light's colour, and the words it shows on
  hover, say what is known: grey *Sent* or *Waiting for the next prompt*; amber
  *Working*; green *Done* (the agent's claim, and it clears itself after about eight
  seconds); red *Needs your approval*, ringing where motion is allowed, when it is
  waiting for you in the terminal; steady red *Failed*, *No acknowledgement yet* or
  *Never picked up*. A second line underneath says
  what happened and what to do next. The Overlay never reports a Pick as delivered on
  the strength of silence.
- **Click a minimized Panel** and it opens above the Stack to be read: the whole Note,
  and which session it went to. One opens at a time. Click it again, or press
  **Escape** inside it, to put it back. The Panel you are still writing keeps its place
  and its focus.
- **Withdraw.** A Pick that went wrong — failed, not acknowledged, never picked up, or
  still queued for your next prompt — has a **×** beside its minimized Panel. It takes
  back whatever the dev server still holds: the queued Pick, its report-back offer, its
  Screen Capture. It cannot take back a Pick already written to a session, and says so:
  *Already sent to `<name>` — it may still act on it*, or, when the hooks carried it,
  *Already delivered to a session — it may still act on it*. A Pick that is still only sent, working, waiting
  on your approval, or done cannot be withdrawn.

The Target is the session a Pick goes to, shown in the Panel's footer before you send.
It is preselected, in this order: the session you last sent to from this origin, while
it is still running here; the session whose shell started the dev server; the only
session in this checkout. If none of those applies, Send stays disabled until you
choose.

## Why this, rather than the tools that exist

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

**There is a way to choose the session.** Click the Target row in the Panel's footer
and it expands to the Session list, every Candidate with a coloured dot and a word
for how it is doing: *Ready*, *Working* or *Needs you*, with what it is waiting for.
A session idle a day or more shows its age, such as *3d*, and the one that started
the dev server says *started this server*. You will rarely need it, because a session is usually
preselected: the one you last chose, or the one that started the dev server.

## Requirements

| | |
| --- | --- |
| Node | 22.12 or later, for the dev server |
| Vite | 8 (peer dependency) |
| React | **19 or later**, with `react-dom` 19 (peer dependencies). React 18 is not supported: it has no owner stacks, which the Owner chain is read from. The example app uses `@vitejs/plugin-react` |
| Claude Code | the `claude` CLI, with sessions running on the same machine as the dev server. The harness surfaces v0 uses are undocumented. v0 pins on their shapes, not on a version (see [The startup posture block](#the-startup-posture-block)) |
| Browsers | tested in Chromium, Firefox and WebKit through Playwright. WebKit stands in for Safari, and the test suite does not run Safari itself. See [the Safari limitation](#what-a-location-is-worth) |
| Screen Capture | macOS only. On any other OS the camera toggle is shown disabled, with the reason |

The package has no runtime dependencies. The Overlay uses your app's own React.

## Install and set up

The package is not published. Build it from a checkout, then install it into your app
from that checkout:

```sh
git clone <this repository> vite-agent-inspect
cd vite-agent-inspect && npm install && npm run build
cd /path/to/your/app && npm install --save-dev /path/to/vite-agent-inspect
```

Add the plugin to your Vite config:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { agentInspect } from 'vite-agent-inspect'

export default defineConfig({
  plugins: [react(), agentInspect()],
})
```

The plugin applies to `vite serve` only. A production build contains no Overlay code.
It takes one option, `root`, which overrides where it thinks the repository is. You
should not need it.

**ESM only.** The package cannot be `require()`d. If your Vite config loads as
CommonJS, the package throws with this message:

```
vite-agent-inspect is ESM-only and cannot be require()d.

Your Vite config is being loaded as CommonJS. Either make the config ESM
(rename it to vite.config.mjs, or set "type": "module" in package.json),
or keep the CommonJS config and load the plugin with a dynamic import()
from an async config factory:

    const { defineConfig } = require("vite")

    module.exports = defineConfig(async () => {
      const { agentInspect } = await import("vite-agent-inspect")
      return { plugins: [agentInspect()] }
    })

defineConfig(async () => …) is what makes the dynamic import() possible:
Vite awaits the returned config, so the plugin can be imported at runtime.
```

**Run `init` once**, from anywhere in the repository:

```sh
npx vite-agent-inspect init
```

It writes to the repository root and prints exactly what it wrote. It is idempotent:

- two hook entries, `UserPromptSubmit` and `Stop`, in `.claude/settings.json`. Both
  run the package's drain CLI (see [The hook floor](#the-hook-floor));
- the setup skill, at `.claude/skills/vite-agent-inspect/SKILL.md`. It tells the agent
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
  **your physical display** around the element (see [Screen Capture](#screen-capture)).

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
| reads | `git rev-parse --show-toplevel`, run from the Vite root and from each session's working directory | once per path, cached |
| writes | the Target session's inbox socket | once per Pick sent |
| binds | `/tmp/cc-socks/<pid>.sock` | from startup to shutdown |
| writes | `$TMPDIR/vite-agent-inspect-captures/<pid>-<6 hex>/`, mode `0700`: Screen Captures | see [Screen Capture](#screen-capture) |
| writes | `$TMPDIR/vite-agent-inspect-servers-<uid>/`, user-only: the discovery entry, holding the address the server is bound to, its port, and a per-server secret the drain must present | written at startup, removed at shutdown. Entries left by dead dev servers are swept |
| runs | macOS `screencapture -x -R …` | once at startup as a probe, and at each Pick |
| writes | `.claude/settings.json`, `.claude/skills/vite-agent-inspect/SKILL.md` | only when you run `init` |
| writes, in the page | `localStorage` on your app's origin: the last Target you sent to, and the camera toggle | when you send, and when you flip the toggle |

## Loopback only

Every `/__agent` endpoint refuses a connection that does not come from `127.0.0.1` or
`::1`, and says why. A Pick must also carry an `Origin` equal to one this dev server
is serving on. An absent `Origin` is refused.

The ack and done URLs a Pick carries, and the address the hooks dial, are the address
Vite is actually bound to. Vite's default `localhost` is IPv6 `[::1]` alone on a
machine whose resolver lists it first, as macOS does, and IPv4 `127.0.0.1` on many
others; a server bound to every interface is dialled on loopback.

- Run with `vite --host` and the page still loads from other machines, but no Pick
  can be made from them. The startup block says so.
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

## Screen Capture

Off by default. A camera toggle sits in the Panel's footer, and it remembers its state
per origin. A capture is taken at the moment you pick, whatever the toggle says, so
that it shows what you pointed at. The toggle decides only whether it travels. It is a
PNG file of your **physical display**, not of the page, so any window in front of the
browser at that moment is in it. No file contents are sent anywhere: the Pick carries
the file's path, and the agent opens it.

- The files live in `$TMPDIR/vite-agent-inspect-captures/<pid>-<6 hex>/`, mode `0700`.
  The path is printed at every startup.
- A move of the Pick deletes the capture it left behind. Discarding the Pick, or
  sending it with the toggle off, deletes its capture.
- Sending with the toggle on keeps the file until the dev server shuts down. **At
  shutdown the whole directory is deleted**, including files already handed to an
  agent. At startup, whatever dead dev servers left behind is swept.
- It needs Screen Recording permission for the **terminal** that started the dev
  server. Without it, `screencapture` writes nothing and exits successfully. The
  startup probe checks the file it wrote, so the toggle is disabled with that reason.

The full account is in [`docs/screen-capture.md`](docs/screen-capture.md).

## What a location is worth

Each Owner-chain link says whether it is `exact`, `approximate` with a reason, or
`absent` with a reason. A link that cannot be placed keeps the component's name, and a
Pick is never refused for a poor location. The table of every mode is in
[`docs/owner-chain-confidence.md`](docs/owner-chain-confidence.md).

- **The Safari limitation.** JavaScriptCore deletes the frame of a component whose
  body is a bare `return <tag>`. In Safari, an element nested *inside* its
  component's root element resolves exactly. An element that *is* that root element
  arrives `absent: call-site-frame-elided-by-engine`, with its component's name.
  Chrome and Firefox resolve both. Safari also strips the query from a stack URL, so
  after a hot update its locations read `approximate: no-transform-timestamp`.
- **The ceiling: about 10,000 elements created per second.** Above that, React stops
  recording owner stacks and hands out one shared placeholder. The Pointer then names
  components without lines. Ticket 06 measured the placeholder against React 19.3 in
  all three engines. It names only React's own runtime, never a place in your source,
  and the dev server marks it `absent` (`unknown-owner-placeholder`, or
  `no-react-boundary` in WebKit). **v0 has no silently wrong mode**: the ceiling costs
  a location and never invents one.

## The startup posture block

Every dev-server start prints one block saying where the plugin is, what it will
refuse, and which of its parts work: `root`, `guard`, `registry`, `harness version`,
`reply socket`, `screen capture`, `temp directory`, `discovery entry`, and `host` when
Vite is bound off loopback. If any line reports something degraded, the whole block
is logged as a warning. The `harness version` line compares the Claude Code version
your sessions report with the version the canaries last passed against, and warns,
never refuses, when yours is newer. Every line and what it means is in
[`docs/posture.md`](docs/posture.md).

## Before v0 is called done

- **Trusted Types is unverified.** The Panel, Stack and Picker are rendered by your
  app's `react-dom`. v0's own code builds no DOM from a markup string. Whether
  `react-dom` itself stays within `require-trusted-types-for 'script'` has not been
  checked against a real app that enforces it. `connect-src 'self'` is not a problem,
  because every request goes to the dev server's own origin.
- **The `review-animations` gate needs a re-run.** It is a human-run review of the
  Overlay's motion. It ran on 2026-09-23, and its outcome is in
  [`docs/motion.md`](docs/motion.md#the-outcome). Everything that moves since then —
  the Picker's lift and widening, the pressed controls, the status dots, the Panel
  growing, travelling and shrinking into the Stack — was added after that run, and
  the outcome does not cover it. All movement is opt-in under
  `prefers-reduced-motion: no-preference`. With reduced motion set, nothing in the
  Overlay moves; fades still ease.

## What v0 does not do

- Other harnesses than Claude Code, and other frameworks than React.
- React 18.
- Staging or production. It is a dev-server plugin only.
- More than one element per Pick, stepping the selection to a parent, line numbers on
  hover, computed styles, a DOM ancestor chain, a source snippet or a selector path.
- Screen Capture on Linux or Windows.
- Reaching a session outside this checkout's worktree root.
- Pick history. The Stack holds only what is outstanding.
- Recovering a frame Safari deleted. The agent can search the named component's file.
- Any configuration whose purpose is to raise what a Pick may cause, including a
  permission allowlist for the manual-mode stall.

---

## Developing this repository

```sh
npm install
npm run dev            # builds dist/, then serves examples/react-app/ with the plugin
npm test               # seams 1 and 2: the dev server's HTTP surface, then three browsers
npm run lint && npm run format:check && npm run typecheck
```

`examples/react-app/` is the React 19 test bed. Its full-viewport decoy, the fixture that
covers the page the way a real app's scrim does, is off when the page loads; add
`?decoy` to the URL to load with it on, or press **Show decoy**, bottom left.

The conventions every change follows start at [`CLAUDE.md`](CLAUDE.md), and the domain
language is in [`CONTEXT.md`](CONTEXT.md).

### The canary suites

The default test run fakes Claude Code. The canaries run the real harness. They need
the `claude` CLI on `PATH` and a logged-in account, skip with that reason when either
is missing, and never run in CI or in `npm test`. Each spawns throwaway sessions in a
temporary git repository. Those sessions appear in your real registry while the suite
runs.

| command | what it costs | what it checks |
| --- | --- | --- |
| `npm run test:seam3` | **no tokens.** The session's model traffic goes to a loopback port that drops it unread | the registry entry's shape, the key file, the socket, the idle notice at the dev server's socket, and that a child session does not register |
| `npm run test:seam3:model` | **tokens**: a handful of turns on haiku, about 100 s | a real Pick landing byte for byte, the duplicate Receipt, the manual-mode stall and its approval, the agent's ack and done (the one model-dependent canary), and both hooks draining a queued Pick. On a fully green run it rewrites `src/server/claude/verified-harness.ts`. Commit that file |

Run the free tier often. Run the model tier after every Claude Code upgrade, when the
posture block's `harness version` line warns, and on a regular cadence.

**Not exercised live**, and kept as static reads of the harness: the rate limit (a
burst of thirty needs thirty turns); the 1 MiB line limit, where the harness drops the
connection rather than truncating; and the `held`, `denied`, `expired`, `refused` and
`delivered` Receipts, which need a Target with a different inbound policy. Seam 1
covers what v0 does with each of them. A frame with a mismatched `session_id` is
dropped with no Receipt at all (measured, Claude Code 2.1.280).

### The spike directories

`spike-06-delivery/`, `spike-07-envelopes/`, `spike-14-inbox-socket/`,
`spike-16-receipts/` and `spike-17-overlay-shape/` are **dead ends**, kept as the record
of what was measured before v0 was built. Each README opens by saying so. Nothing in
v0 imports from them, and a test enforces it.

### Documentation

| | |
| --- | --- |
| [`docs/posture.md`](docs/posture.md) | every startup line |
| [`docs/screen-capture.md`](docs/screen-capture.md) | where captures live and when they go |
| [`docs/owner-chain-confidence.md`](docs/owner-chain-confidence.md) | every Confidence mode, the Safari limitation and the ceiling |
| [`docs/motion.md`](docs/motion.md) | what moves, and the `review-animations` gate |
| [`docs/adr/`](docs/adr/) | decisions that deviate from, or refine, the spec |
| [`LICENSE-THIRDPARTY`](LICENSE-THIRDPARTY) | the five projects borrowed from, their licences and the files that carry each borrow |

## Prior art

- **[UI-Locator](https://github.com/amir1824/UI-Locator)**: Shift+click copies a
  compact AI prompt to the clipboard. v0 borrows its attribute allowlist.
- **[vite-plugin-herdr](https://github.com/scaccogatto/vite-plugin-herdr)**: pick an
  element, add a prompt, send it to a herdr agent. v0 borrows its fail-closed
  same-origin check and the payload format its Pointer prose grew from.
- **[vite-plugin-opencode](https://github.com/Brendonovich/vite-plugin-opencode)**:
  picker to OpenCode, with source markers injected into JSX at dev time.
- **[Pinpoint](https://github.com/ragrivera/pinpoint)**: pins to a file queue to MCP,
  with a headless worker or a live session blocking in a tool.
- **[vite-plugin-pilot](https://github.com/2234839/vite-plugin-pilot)**: weighted
  toward the agent reading and driving the page. It has a `UserPromptSubmit` hook
  fallback.
- **[MCP Pointer](https://github.com/etsd-tech/mcp-pointer)**: an extension plus an
  MCP server, with React Fiber source mapping. Pull-based.
- **[react-grab](https://github.com/aidenybai/react-grab)**: v0 borrows its deep
  element-at-point hit test.
- **[click-to-react-component](https://github.com/ericclemmons/click-to-component)**
  and **[Locator.js](https://www.locatorjs.com/)**: click to jump to source. v0
  borrows the armed `pointer-events` rule.
- **React DevTools**: v0 borrows its stack-frame parser.
- Agent-to-browser tools (Claude in Chrome, chrome-devtools MCP, Playwright MCP) run
  the other direction, with the agent driving. They complement v0 rather than compete
  with it.
