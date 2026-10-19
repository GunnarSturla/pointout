# ADR-0006: the Next.js Connector intercepts Next's own server

- **Status**: accepted
- **Date**: 2026-10-19
- **Raised by**: `.scratch/nextjs-connector/issues/01-nextjs-connector.md`, decided by the
  maintainer. The measurements are in
  `.scratch/nextjs-connector/research/02-serving-from-inside-next-dev.md`.

## Context

The Guard is fixed (ADR-0005). It refuses a connection from anything but loopback, and it
requires an `Origin` equal to the page's own. The Vite Connector mounts the Guard's endpoints
on Vite's middlewares. Next.js 16 has no equivalent: Turbopack has no plugin API, and
next.config has no dev-middleware hook.

Four ways were measured or ruled out:

| way | loopback check | `Origin` check | cost |
| --- | --- | --- | --- |
| a custom server wrapped around Next | yes | yes | the app's `dev` script changes, and pointout owns Next's startup. The maintainer ruled it out as too much complexity |
| route handler or `proxy.ts` | **no**: Next does not expose the peer address | yes | files in the app, and anyone who can reach the port can write into a session. Ruled out |
| a sidecar on `127.0.0.1:0` | yes | yes, but cross-origin, with CORS | a second port that changes on every restart, and a Guard reworded from "this server's origin" to "the page's origin" |
| intercepting Next's own server from next.config | yes | yes, same origin | monkey-patching Node's `http.Server` |

Measured on 16.4.2: next.config is evaluated in the worker child that owns the listening
socket, after the server is already listening. Patching `http.Server.prototype.emit` from
there answers a request before Next's own `'request'` listener sees it. It gets the raw peer
address and the browser's `Origin`, and it left pages, HMR and Fast Refresh untouched.

## Decision

**`withPointout()` intercepts `/__agent/*` on Next's own listening server, on the page's
origin, and the Guard stays exactly as it is.**

- It acts only in Next's worker child (`NEXT_PRIVATE_WORKER === '1'`), in
  `phase-development-server`, under Turbopack. Everywhere else it returns the config
  unchanged.
- It touches only Next's listening server and only `/__agent/*`. Every other request, and
  every upgrade, passes through untouched.
- At startup the posture block calls its own `/__agent/status` over loopback. If pointout
  does not answer, the block degrades loudly.

## Consequences

- The setup is `withPointout(nextConfig)`. The `dev` script stays `next dev`.
- This depends on when Next loads its config relative to `listen`, which no Next.js document
  promises. The posture self-check is what turns a change in that order into a stated
  degradation rather than a silent one. If a later 16.x breaks it, the sidecar is the
  recorded fallback.
- A request in the moment between Next listening and the config loading is answered by Next,
  not pointout.
- Cleanup must be synchronous: Next sends SIGKILL 100 ms after Ctrl-C. Nothing the config
  starts may register a SIGTERM handler, because that cancels Next's default exit.
