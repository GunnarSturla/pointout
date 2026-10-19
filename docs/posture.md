# The startup posture block

Every time the dev server starts, the plugin prints one block that says where it
is, what it will refuse, and which of its parts are working. It is printed once,
as one list, when the Host (Vite or Next.js) is listening, and no line in it is logged a second time
anywhere else. A system that is quietly doing nothing is the failure this block is
there to rule out (spec §2, §21).

```
pointout — startup posture
  root             /home/me/app (git rev-parse --show-toplevel)
  guard            loopback only; Origin required on Pick ingress, and absent means refused
  registry         readable — 1 session in this checkout
  harness version  Claude Code 2.1.280 in the registry; the canaries last passed against 2.1.280 (2026-09-01)
  reply socket     bound at /tmp/cc-socks/54321.sock
  screen capture   available
  temp directory   /var/folders/…/pointout-captures/54321-9f0ab1 (user-only; removed at shutdown, and what dead dev servers left beside it is swept at startup)
  discovery entry  /var/folders/…/pointout-servers-501/3f…-54321-a1b2c3.json (user-only; removed at shutdown)
```

**Info or warning.** A block where everything works is logged as information. If
any line reports something degraded, the whole block is logged as a warning, so it
still shows at Vite's `logLevel: 'warn'`; on Next.js it goes to stderr. The lines that make it a warning are marked
*warns* below.

The lines always come in this order. `self-check` is printed on Next.js only, and
`host` is the only line that can be absent on either Host.

## `root`

Where this dev server thinks the repository is, and how it found out. Paths in a
Pick are written relative to it, and a session is a Candidate only if its working
directory is in this same checkout.

| text | meaning |
| --- | --- |
| `<path> (git rev-parse --show-toplevel)` | the usual case: the git toplevel above the Vite root, or above the directory `next dev` runs in |
| `<path> (the Vite root; not inside a git repository)` | no git, so the Vite root is used. On Next.js it reads `the Next.js root`: the directory `next dev` runs in |
| `<path> (the root option)` | you passed `pointout({ root })`, or `withPointout(config, { root })` |

## `guard`

Always the same: `loopback only; Origin required on Pick ingress, and absent means
refused`. Every `/__agent` endpoint refuses a connection from off this machine. A
Pick must also carry an `Origin` that is this dev server's own. Each refusal is
answered with a reason, and the reason is logged.

## `registry`

Whether the plugin can read the session registry (`~/.claude/sessions/`), which is
how it finds the sessions a Pick can go to.

| text | meaning |
| --- | --- |
| `readable — N sessions in this checkout` | normal. `0 sessions` means no session is working in this checkout right now |
| `…, and N entries in an unrecognised shape, ignored` | some entries could not be read. The ones that could still work |
| `directory missing (<dir>) — targeting falls back to the hook floor` *warns* | no registry at all. Picks wait for your next prompt in this repo and arrive with it |
| `entries in an unrecognised shape (<dir>) — targeting falls back to the hook floor` *warns* | there are entries, but none of them has the shape v0 reads, so the harness has probably changed. Same fallback as above |

## `harness version`

The Claude Code version the registry's sessions report, beside the last version the
model-tier canaries passed against (`npm run test:seam3:model`, ticket 21). The canaries
record that version in `src/server/claude/verified-harness.ts`.

| text | meaning |
| --- | --- |
| `Claude Code X in the registry; the canaries last passed against X (date)` | the running harness is one that has been verified, or older |
| `…; never verified — no canary run has recorded a version it passed against` | this build of the plugin has never been checked against a real harness |
| `no readable registry entry reports a version; …` | no session is running, the registry cannot be read, or its entries are in a shape v0 does not read |
| `…. This harness is newer than the last one verified. …` *warns* | Claude Code has moved on since the last canary run |

A newer harness is a **warning, never a refusal**. v0 depends on the *shapes* it
reads, not on a version number. If a shape has changed, that is reported where it
is read (for example `registry` above, or an ignored frame at the reply address).
Several sessions on different versions are all listed, and the newest one is
compared. A version that is not a number is listed and not compared.

## `reply socket`

The dev server's own reply address, where the harness sends Receipts.

| text | meaning |
| --- | --- |
| `bound at <path>` | Receipts will arrive |
| `… (a stale socket file was removed first)` | a dev server that was killed left its socket behind, and it has been removed |
| `not bound — <why>. Receipts will not arrive; delivery is unaffected.` *warns* | Picks are still delivered. You will not see `held` or `failed` from the harness, and a Pick that went nowhere shows as unacknowledged instead. The usual reason is that a registered session already owns the path, and the plugin never binds over one |

## `screen capture`

| text | meaning |
| --- | --- |
| `available` | the camera toggle in the Panel works |
| `disabled — this dev server is not running on macOS …` *warns* | v0 takes Screen Captures with macOS's `screencapture` only |
| `disabled — the startup probe found that the tool exited cleanly but wrote no image …` *warns* | usually missing Screen Recording permission. Grant it to your terminal and restart the dev server. See `docs/screen-capture.md` |
| `disabled — the startup probe found that …` *warns* | the tool could not run, or it took too long. The rest of the line is its reason |
| `disabled — its temp directory could not be opened (…)` *warns* | see `temp directory` |

A disabled capture is said again when the page first asks for one: the Panel shows
the reason. If a Pick was meant to carry a capture, the Pick tells the agent it
does not.

## `temp directory`

Where this dev server writes Screen Captures: `<os tmp>/pointout-captures/<pid>-<6 hex>`,
mode `0700`. The whole directory is removed at shutdown. At startup, whatever dead
dev servers left in the shared root is swept, and `; N left by dead dev servers
swept` says how much. It is swept whether or not capture is available.

`not opened — <why>` *warns* means the OS temp directory could not be written.

## `discovery entry`

The file the hooks installed by `npx pointout init` read to find this dev
server and drain the Picks waiting for your next prompt.

| text | meaning |
| --- | --- |
| `<path> (user-only; removed at shutdown)` | written. `N left by dead dev servers swept` is added when there were any |
| `not written — this dev server is not listening on a TCP port …` *warns* | Vite is in middleware mode, so no hook can reach it. Picks left for the next prompt will expire |
| `not written — <error>. …` *warns* | the file could not be written. Same consequence |

## `self-check`

Next.js only. pointout answers `/__agent` on Next's own server by reaching into it
from `next.config` (ADR-0006), which depends on Next reading its config after it
starts listening. So at startup it asks its own `GET /__agent/status`, over loopback.

| text | meaning |
| --- | --- |
| `pointout answered GET <url>` | the Overlay can reach this server |
| `pointout did not answer GET <url> (<what happened>) — the Overlay cannot reach this server, and no Pick will` *warns* | something else answered, or nothing did. A Next.js release has probably changed when it reads its config |

If pointout cannot find Next's listening server at all, the block is this one line:
`found no listening server in Next's dev worker to serve /__agent on …` *warns*.

## `host`

Printed only when the Host is bound to an address other than loopback (`vite --host`,
or Next.js's own default, every interface):
`<Host> is bound to <address> — Picks arriving from the LAN will be refused` *warns*,
where `<Host>` is `Vite` or `Next.js`. `next dev -H localhost` keeps Next.js on
loopback.
The app still loads from other machines, but the plugin works only from this one.
A phone on the same network can load the page and cannot make a Pick.

## Elsewhere in the log

Everything else the plugin logs happens at the moment it happens: every refused
request with its reason, a Pick that could not be delivered, a Receipt, a frame
ignored at the reply address (including a stale idle notice), a report-back offer
and how it was resolved, a Pick that expired, and a drain that carried Picks.
None of these repeat a posture line.

## For tests

`POINTOUT_VERIFIED_HARNESS` stands in for the recorded version, as
`<version>@<YYYY-MM-DD>` or `never`. It is **test-only**, like the other overrides
in `docs/agents/testing.md`, and a consumer never sets it. The seam-1 posture test
(`test/seam1/posture.test.ts`) holds the exact wording of every line on this page,
and `test/seam1/next-connector.test.ts` the Next.js block, `self-check` included.
`POINTOUT_NEXT_NO_INTERCEPT=1`, test-only too, starts pointout on Next.js without
reaching into its server, so the self-check has nothing to find.
