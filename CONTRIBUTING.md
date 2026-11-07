# Contributing

```sh
npm install
npm run dev            # builds dist/, then serves examples/react-app/ with the plugin
npm run build && npm run dev --workspace pointout-example-next   # the Next.js test bed
npm test               # the server and browser suites: the dev server's HTTP surface, then three browsers
npm run lint && npm run format:check && npm run typecheck
```

`examples/react-app/` is the React 19 test bed. Its full-viewport decoy, the fixture that
covers the page the way a real app's scrim does, is off when the page loads; add
`?decoy` to the URL to load with it on, or press **Show decoy**, bottom left.
`examples/next-app/` is the Next.js 16 test bed, built from the same fixtures in
`examples/shared/`, with an App Router route at `/`, a Pages Router route at
`/pages-router`, and its config wrapped in `withPointout()`.

The conventions every change follows start at [`CLAUDE.md`](CLAUDE.md), and the domain
language is in [`GLOSSARY.md`](GLOSSARY.md).

## The canary suites

The default test run fakes Claude Code. The canaries run the real harness. They need
the `claude` CLI on `PATH` and a logged-in account, skip with that reason when either
is missing, and never run in CI or in `npm test`. Each spawns throwaway sessions in a
temporary git repository. Those sessions appear in your real registry while the suite
runs.

| command | what it costs | what it checks |
| --- | --- | --- |
| `npm run test:claude` | **no tokens.** The session's model traffic goes to a loopback port that drops it unread | the registry entry's shape, the key file, the socket, the idle notice at the dev server's socket, and that a child session does not register |
| `npm run test:claude:model` | **tokens**: a handful of turns on haiku, about 100 s | a real Pick landing byte for byte, the duplicate Receipt, the manual-mode stall and its approval, the agent's ack and done (the one model-dependent canary), and both hooks draining a queued Pick. On a fully green run it rewrites `src/server/claude/verified-harness.ts`. Commit that file |

Run the free tier often. Run the model tier after every Claude Code upgrade, when the
posture block's `harness version` line warns, and on a regular cadence.

**Not exercised live**, and kept as static reads of the harness: the rate limit (a
burst of thirty needs thirty turns); the 1 MiB line limit, where the harness drops the
connection rather than truncating; and the `held`, `denied`, `expired`, `refused` and
`delivered` Receipts, which need a Target with a different inbound policy. The server suite
covers what v0 does with each of them. A frame with a mismatched `session_id` is
dropped with no Receipt at all (measured, Claude Code 2.1.280).

## Documentation

| | |
| --- | --- |
| [`docs/how-it-works.md`](docs/how-it-works.md) | what a Pick carries, how it travels, what it touches on your machine |
| [`docs/overlay.md`](docs/overlay.md) | every behaviour of the Picker, Panel and Stack |
| [`docs/prior-art.md`](docs/prior-art.md) | the tools this one learned from |
| [`docs/posture.md`](docs/posture.md) | every startup line |
| [`docs/screen-capture.md`](docs/screen-capture.md) | where captures live and when they go |
| [`docs/owner-chain-confidence.md`](docs/owner-chain-confidence.md) | every Confidence mode, the Safari limitation and the ceiling |
| [`docs/motion.md`](docs/motion.md) | what moves, and the `review-animations` gate |
| [`docs/adr/`](docs/adr/) | decisions that deviate from, or refine, the spec |
| [`LICENSE-THIRDPARTY`](LICENSE-THIRDPARTY) | the five projects borrowed from, their licences and the files that carry each borrow |
