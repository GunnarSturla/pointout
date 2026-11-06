# ADR-0005: one package, a Connector per Host, over a core that belongs to no Host

- **Status**: accepted
- **Date**: 2026-10-19
- **Deviates from**: the v0 map's Out of scope, "Framework adapters /
  plugin-per-framework"
- **Raised by**: ticket 01 of the Next.js Connector effort, decided by the maintainer

## Context

pointout was built as a Vite plugin, and Vite is written into its server. Vite's
middlewares serve the endpoints, `transformIndexHtml` puts the Overlay in the page, and
`moduleGraph` turns served positions back into source positions. `httpServer` gives the
bound address and the shutdown. Most of the rest is Vite-free: the Overlay, `src/wire.ts`,
the ledger and queue, delivery to Claude, the CLI, and Screen Capture. They reach Vite only
through `import type { Logger }`.

During charting, the map ruled out framework adapters. Its reason was timing: "a
package-shaped design drawn before a single pick has landed in a terminal". It said they
would come back only as a fresh effort. Picks now land, and supporting Next.js is that
effort.

Three shapes were on the table:

| shape | cost |
| --- | --- |
| a separate `pointout-next` package | two packages to version against one wire, `GLOSSARY.md` and test suite |
| a fork of the server for Next.js | every fix to the ledger, delivery or Guard made twice |
| one package, an entry point per Host (`pointout/vite`, `pointout/next`), a shared core | moving most of `src/server/` out of a Vite-shaped module, once |

## Decision

**One package. Each Host gets its own Connector and entry point, over a core that belongs to
no Host.**

- The Vite Connector moves to `pointout/vite`, and the Next.js one is `pointout/next`. The
  package has no root entry: importing bare `pointout` fails, so no Host is the default. It
  has never been published, so nothing depends on the old import.
- `vite` and `next` are both optional peer dependencies. Each is needed only by its own
  Connector.
- A Connector does four things: it puts the Overlay in the page, serves the Guard's
  endpoints, turns the Host's served positions back into source positions, and says where
  the Host is listening.
- Everything else is core. The core imports nothing from either Host, not even a type.
- The core's interface is drawn from what the two Connectors actually need. It is extracted
  inside the Next.js effort, not ahead of it, so it is shaped by two real cases rather than
  one guessed one.
- The page is the same on every Host, and so is the Guard. A Host that cannot serve the
  endpoints under the Guard as it stands does not get a weaker Guard.

## Consequences

- `GLOSSARY.md` gains **Host** and **Connector**. "Adapter" stays reserved for delivery to
  other harnesses.
- The server and browser suites run against both Hosts, parameterized by Host. A test still imports no
  server module.
- The core has to stop importing Vite's `Logger` type, and grows its own.
- Out of scope remains: other harnesses, and other UI frameworks than React.
