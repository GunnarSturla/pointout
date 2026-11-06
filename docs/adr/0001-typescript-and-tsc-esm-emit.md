# ADR-0001: TypeScript, emitted as ESM by `tsc`, with no bundler

- **Status**: accepted
- **Date**: 2026-09-22
- **Ticket**: 23 of the v0 build, in the local tracker
- **Touches**: spec §1 (*Package, repo and packaging*)

## Context

The spec settled the packaging question — one standalone, unpublished, ESM-only npm
package at the repo root, exporting one Vite plugin factory, with a CommonJS entry that
throws — but not the language, and not whether a consumer receives source or an emit.
Ticket 01 answered both by default: JavaScript, published straight from `src/` through
the `exports` map.

Two tickets' worth of code later, the package has an HTTP surface, a Guard, a registry
reader whose shape is pinned against an undocumented harness, and a posture block whose
wording is asserted on. Twenty tickets remain, most of them adding structure rather than
glue: an owner chain with per-frame Confidence, a claim-once queue with a state machine,
Receipts, four Overlay surfaces. These are the shapes a type system is for, and the
registry shape in particular is a contract with someone else's undocumented file format.

The conversion also gets cheaper the earlier it happens, which is why it is a prefactor
rather than a cleanup: seven files now against twenty tickets later.

## Decision

**TypeScript throughout**, with `strict` and `verbatimModuleSyntax` on and `nodenext`
resolution, and **`tsc` as the build** — one file in, one file out, emitted to `dist/`
with declarations and source maps. The package's `exports` map points at `dist/`; a
`files` field limits the package to it. No bundler.

`npm run build` is a `pre` step of `dev` and of every test command, so nothing runs
against a stale emit.

## Alternatives

**Publish `src/` and let the consumer's Vite transform the TypeScript.** It works — Vite
transforms `.ts` — but only for the Overlay. The server half runs in the Vite config's
own process, under Node, and Node cannot load `.ts` on this repo's Node floor. The plugin
would be unloadable by the thing it is a plugin for.

**JSDoc types with `checkJs`, no build at all.** Keeps the emit-free package and gets a
type checker. Rejected on the shapes ahead: discriminated unions for the queue's states
and for per-frame Confidence are what the next twenty tickets are made of, and expressing
those in JSDoc is a tax paid on every line.

**A bundler (Rollup, tsup, Rolldown).** Rejected twice over. It buys nothing — the server
side imports Node built-ins and Vite's own APIs, and the Overlay's one runtime dependency
belongs to the consumer's Vite graph, not ours. And it costs the file-per-module layout:
the plugin locates its own Overlay entry and its own package root by `import.meta.url`,
relative to the emitted file. A bundle would have to keep both paths true by accident.

## Consequences

- A consumer receives no source. The `.d.ts` files and source maps are what they read and
  debug against; both are emitted.
- The emit must stay exactly one level under the package root. `dist/src/…` would break
  `server.fs.allow` silently. There is a test on the emitted layout because of this.
- **One build project spans two runtimes.** The Overlay is browser code and the server
  side is Node code, and both live under `src/`, so the project carries the DOM lib *and*
  Node's types. Nothing stops a server module from reaching for `document` and getting a
  green check.

  Accepted rather than solved, because the alternative is two projects and a shared
  third for `api.ts`, and the shared module is three constants. **If a wrong global is
  ever actually reached for, split it**: `src/overlay` under the DOM lib with no Node
  types, `src/server` under Node's types with no DOM, and `src/api.ts` in both. That is
  the fix; it does not need another ADR, only a ticket.
- Each test command runs a build first, so a red test can now be a compile error. That is
  the intended trade: the error arrives before the assertion does.
- The incremental state lives at `dist/.tsbuildinfo`, inside the emit rather than beside
  it. An incremental `tsc` trusts that file over the files on disk, so state that
  outlives its emit makes the next build a silent no-op — and the failure surfaces as
  Vite being unable to resolve the package, which names nothing about the build. Inside
  `dist`, the two cannot disagree. `files` excludes it by negation.
