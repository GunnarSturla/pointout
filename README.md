# pointout

**Click an element in your browser and tell Claude Code what to do.** Your request lands
in the session you already have open, with the exact file and line of the element
attached, and an optional screenshot.

<!-- DEMO PLACEHOLDER: a recording of 10 seconds or less, browser and terminal side by
side. Link it by absolute URL: the npm package does not ship images. -->

**Early release (0.1.0).** pointout relies on undocumented Claude Code internals, so a
Claude Code update can break direct delivery. The dev server warns at startup when your
Claude Code is newer than the last version tested. If it can't read your session list,
it warns and delivers requests with your next prompt instead.

## Quick start

Install it as a dev dependency:

```sh
npm install --save-dev @gunnarsturla/pointout
```

Add it to your dev server.

**Vite:**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pointout } from '@gunnarsturla/pointout/vite'

export default defineConfig({
  plugins: [react(), pointout()],
})
```

**Next.js:**

```ts
import type { NextConfig } from 'next'
import { withPointout } from '@gunnarsturla/pointout/next'

const nextConfig: NextConfig = {}

export default withPointout(nextConfig)
```

On Next.js, also put `next dev -H localhost` in your `dev` script, because requests are
only accepted from this machine.

Then set up your repo:

```sh
npx pointout init
```

`init` adds two things to your repo and prints what it wrote. Commit both so your
teammates get them.

- **Two hooks** in `.claude/settings.json` (`UserPromptSubmit` and `Stop`). If pointout
  can't reach your session directly, waiting requests are delivered with your next prompt
  or at the end of a turn. With no dev server running, they do nothing.
- **A skill**, `.claude/skills/pointout/SKILL.md`, which tells Claude what a request from
  the browser looks like, to treat page content as data, and how to report progress back.
  It grants no permissions. It's optional, but recommended: use `--no-skill` to leave it
  out, and requests still reach your session, but they'll likely show as not acknowledged.

In a monorepo, run `npx pointout init --connector vite` or `--connector next` at the repo
root.

Finally, start your dev server, and start Claude Code at the repo root. A session started
in a subdirectory doesn't run the hooks.

## Using it

Hold **Alt/Option**, or click the **Pick** tab at the bottom of the page. Hover to see each
element's component and file, then click one. Type what you want and press **Enter**.
Click the camera icon to attach a screenshot.

Sent requests collect at the bottom right, each with a status light: grey for sent, amber
for working, green for done, red when it needs you. Hover a light for details, or click a
request to read it again. A red one tells you what to do next. Requests that haven't been
picked up can be withdrawn with **×**.

The session is chosen for you: the one you last sent to, the one that started the dev
server, or the only one in this checkout. If it can't tell, choose from the list in the
panel, which shows only sessions in this checkout.

## Why this one

Similar tools tend to stop at the clipboard, so you still have to paste; start their own
agent, a second session without your context; or have the agent poll in a loop you have to
start first.

pointout pushes into the session you already have open. There's nothing to arm, and your
clipboard is never touched. Each request names one session, so several sessions in one
repo don't collide.

## Requirements

| | |
| --- | --- |
| Claude Code | The `claude` CLI, running on the same machine as the dev server |
| Framework | React 19 or later |
| Dev server | Vite 8, or Next.js 16.3+ with Turbopack (the `next dev` default). Node 22.12+ |
| Browsers | Chrome and Firefox get full results. In Safari, some elements come back with the component name but no line number ([why](docs/owner-chain-confidence.md#the-safari-limitation)) |
| Screenshots | macOS only, and the terminal running the dev server needs Screen Recording permission |

It only runs in your dev server, and nothing is added to a production build. It only
reaches sessions in the same checkout. Not yet checked against apps enforcing Trusted
Types.

## Worth knowing

What leaves the page with a request:

- The element's location and the attributes that identify it, plus what you typed.
- The contents of the selected input, so Claude sees what's actually in the field. Only
  `password` and `hidden` inputs are withheld.
- A screenshot, if you turn the camera on. It shows your physical display, not just the
  page, so any window in front of the browser is in it.

The dev server only accepts requests from this machine. For everything pointout reads,
writes and binds, see [how it works](docs/how-it-works.md).

## Further reading

- [How it works](docs/how-it-works.md): what a request carries, how it travels, and what it
  touches on your machine, including SSH and containers
- [Using the overlay in detail](docs/overlay.md)
- [What a location is worth](docs/owner-chain-confidence.md): how exact a file and line is,
  and when
- [Screenshots](docs/screen-capture.md): where they live and when they're deleted
- [The startup block](docs/posture.md): every line the dev server prints
- [Contributing](CONTRIBUTING.md)
- [Prior art](docs/prior-art.md) and [third-party licences](LICENSE-THIRDPARTY)
