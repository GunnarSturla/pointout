# vite-agent-inspect

> Point at something in your running app, type what's wrong, and have it land in the
> coding agent session you already have open.

**Status:** idea / pre-scaffold. This document is a starting point, not a spec.

---

## The idea

You're looking at your app in the browser. Something is wrong with a component —
wrong spacing, wrong copy, wrong empty state. Today you switch to the terminal and
describe the thing in words: *"the filter dropdown on the waiting list page, the one
next to the date picker."* The agent then spends several tool calls rediscovering
what you were already looking at.

`vite-agent-inspect` removes that translation step. A dev-only overlay lets you pick
an element the way DevTools' inspector does, type a prompt, and send it — element,
source file, line, component name and your words — straight into the agent session
running in your terminal.

### The direction matters

Most tooling in this space runs **agent → browser**: the agent drives the page to
verify its own work (Claude in Chrome, chrome-devtools MCP, Playwright MCP).
Valuable, but it's the agent's loop, not yours.

This is **browser → agent**. The human is at the wheel, the browser is the input
device, and the terminal session is the target. The nearest prior art with the right
posture ([UI-Locator](https://github.com/amir1824/UI-Locator)) stops at the
clipboard; you still paste. Closing that last leg is the point of this project.

---

## Why a Vite plugin rather than a browser extension

Both can pick an element. The plugin wins on everything after that:

- **It already knows which agent session owns it.** A dev server started by the
  agent's shell inherits `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` and the session's
  cwd. No pairing UI, no session picker, no query params.
- **The dev server is the transport.** `configureServer` gives you HTTP middleware
  and a WebSocket upgrade on an origin the page is already allowed to talk to.
  A standalone relay on another port is a cross-origin request that a strict dev
  CSP will refuse.
- **It owns the module graph.** Element → source file can be resolved server-side,
  and a JSX transform can stamp source markers directly, which is more durable than
  reading React internals.
- **Distribution is a commit**, not a per-machine extension install for everyone on
  the team.

The concession — dev servers only, no staging or production — is accepted. This is a
development tool. Production debugging is a later, separate problem, and an extension
posting to the same endpoint is the obvious way to solve it if it ever matters.

---

## Shape

```
agent session
  └─ spawns dev server ──── inherits CLAUDE_CODE_SESSION_ID, cwd
        │
        ├─ plugin injects overlay (virtual module + transformIndexHtml, apply:'serve')
        ├─ POST /__agent/pick      ← overlay, same origin
        └─ WS   /__agent/picks     → agent session
```

Three problems, roughly independent:

**1. Picking.** Inspector-style hover/highlight/select overlay. Shadow DOM so app CSS
can't reach it and it can exclude itself from its own hit testing. Solved many times
over; borrow rather than invent.

**2. Source mapping.** Element → `path/to/Component.tsx:42` plus component name. Two
approaches: walk the React Fiber for `_debugSource` (works on React 18, removed in
React 19), or stamp `data-source` attributes via a JSX transform at dev time, which
survives version changes. Start with the first, keep the second as the escape hatch.

**3. Delivery.** The open problem, and the reason this project exists. See below.

---

## Delivery: the actual open question

Everything in the prior art lands on one of three mechanisms. None is obviously right.

| Mechanism | How | Cost |
| --- | --- | --- |
| **Pull (MCP tool)** | Plugin exposes an MCP endpoint off the dev server; agent calls `get_pick` | You still have to prompt the agent to look. Defeats half the point. |
| **Prompt hook** | Write pick to a file; a `UserPromptSubmit` hook staples it to your next message | Zero infrastructure, very robust. Only lands when you next type. |
| **Push (WebSocket)** | Agent subscribes to `ws://localhost:<port>/__agent/picks`; each pick arrives as an event mid-conversation | True push. Subscription has a lifetime and needs re-arming; agent-specific. |

Claude Code's `Monitor` tool takes a `ws:` source and turns each text frame into an
event in the running conversation, which makes push viable today — capped at 30
minutes per arm. **No prior-art project appears to use this.** That's the gap worth
exploring, and it's also the smallest piece of code in the whole design.

A pragmatic read: ship the hook mechanism first because it always works, and treat
push as the upgrade.

### Routing

Route on **cwd**, not session id. The session id is stamped when the dev server
starts but rotates on `/clear` and `--fork-session`, so it goes stale while the server
keeps running. Keying on repo path means a restarted session just re-subscribes and
takes over — and it makes git worktrees work for free, since each worktree's dev
server is its own port and its own path.

---

## Prior art

Crowded field. Nothing here is a reason not to build, but plenty is a reason not to
build *from scratch*.

### Closest posture (browser → agent, human-driven)

- **[UI-Locator](https://github.com/amir1824/UI-Locator)** — Shift+click copies a
  compact AI prompt. Right idea, stops at the clipboard.
- **[vite-plugin-herdr](https://github.com/scaccogatto/vite-plugin-herdr)** — pick an
  element, add a prompt, send to a herdr agent. Element + computed styles + text.
- **[vite-plugin-opencode](https://github.com/Brendonovich/vite-plugin-opencode)** (6★)
  — picker → OpenCode, sessions scoped per source file. Notable for injecting source
  markers into JSX/TSX at dev time. Very early.
- **[Pinpoint](https://github.com/ragrivera/pinpoint)** (2★) — pins → file queue →
  MCP, with two dispatch modes: spawn a headless worker, or have a live session claim
  the batch by blocking in a `wait_for_pins` tool. Tiny, but the dispatch model is the
  most directly relevant prior thinking on delivery.

### Adjacent

- **[vite-plugin-pilot](https://github.com/2234839/vite-plugin-pilot)** (53★) —
  overlaps, but weighted toward letting the agent read and drive the page. Its
  `UserPromptSubmit` hook fallback is the notable borrowable idea.
- **[MCP Pointer](https://github.com/etsd-tech/mcp-pointer)** (~600★) — extension +
  MCP server, Option+click, React Fiber source mapping. The mature one, and strictly
  pull-based. Also the clearest confirmation that React 19 breaks `_debugSource`.
- **[vite-plugin-mcp-client-tools](https://github.com/atesgoral/vite-plugin-mcp-client-tools)**
  — not a picker, but the cleanest precedent for exposing browser-side tools over the
  Vite dev server (`claude mcp add … --transport http http://localhost:3000/mcp`).
- **[vite-plugin-agent-presence](https://pi.dev/packages/vite-plugin-agent-presence)**
  — dev overlay showing when an agent is active. Good complementary idea: the page
  should show whether anyone is listening.
- **[vite-plugin-mcp](https://github.com/antfu/nuxt-mcp-dev/tree/main/packages/vite-plugin-mcp)**
  (antfu) — module-graph understanding for agents. Different problem, good reference
  for plugin ergonomics and auto-writing agent config.
- **[ViteLens](https://dev.to/mdsohail99/effortless-ui-context-for-ai-coding-inside-vitelens-for-react-vite-5ac)**
  — Alt+click jump-to-source, Ctrl+click multi-select.

### Agent → browser (the other direction, for contrast)

- **[Claude in Chrome](https://code.claude.com/docs/en/chrome)** (`claude --chrome`),
  chrome-devtools MCP, Playwright MCP — the agent drives. Complementary, not competing.
- **[Stagewise](https://stagewise.io/)** (YC S25, ~6.5k★, AGPLv3) — started as exactly
  this toolbar, pivoted to its own Electron browser and its own agent. The cautionary
  tale about scope.
- **[chrome-devtools-mcp#268](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/268)**
  — upstream issue asking for "select an element to inspect it." The gap is acknowledged.

### Pre-AI ancestors

- **[Locator.js](https://www.locatorjs.com/)**,
  **[click-to-react-component](https://github.com/ericclemmons/click-to-react-component)**
  — click → jump to source in your editor. Best reference for the picking UX and for
  the JSX source-stamping transform.

---

## Known constraints from the first target app

The intended first consumer is a Vite + React 18.3.1 app whose dev server sets an
enforced CSP, which is a useful forcing function:

- `connect-src 'self'` — the overlay can only talk to the dev server's own origin.
  Confirms the plugin architecture and rules out a separate relay port.
- `require-trusted-types-for 'script'` with a fixed policy allowlist — the overlay
  must build DOM with `createElement`/`textContent`. Any `innerHTML` throws, and
  widening the allowlist is not acceptable since it mirrors the production header.

Worth treating both as permanent design rules rather than app-specific workarounds.
They're what a strict app looks like, and a tool that works there works anywhere.

---

## Open questions

- Is push actually better than the hook, or does "lands when I next type" match how
  people work? Build the cheap one and find out.
- Batching: one pick per prompt, or collect several and send together?
- What's the right payload? Selector + source ref + component name is the floor.
  Computed styles, ancestor chain, a screenshot crop — each costs context and may not
  earn it when the agent can open the file.
- Does the overlay need to show whether an agent is listening, and which session?
- Agent-agnostic or Claude-Code-first? The transport is generic; the delivery leg
  isn't. Probably: generic core, pluggable delivery adapters.
- Does this want to be a plugin per framework, or one plugin with framework adapters?

## Next step

Before writing code: install `UI-Locator` and `vite-plugin-herdr` against a real app
and find out what's genuinely missing versus what just needs a patch upstream.
