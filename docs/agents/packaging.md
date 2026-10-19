# TypeScript and the built package

Source: `.scratch/vite-agent-inspect/spec.md` §1, and ticket 23, which introduced both.
Read this before writing a source file. The decision itself, with its alternatives, is
`docs/adr/0001-typescript-and-tsc-esm-emit.md`.

## The shape

Everything in this repository is TypeScript. `src/` is `.ts`, with the Overlay's
three React surfaces in `.tsx` (ADR-0004); the CommonJS stub is `.cts`, the tests and
the harness are `.ts`, the three runner configs are `.ts`, and the example app is
`.tsx`.

The package a consumer installs is **`dist/`, not `src/`**. `tsc` emits it one file in,
one file out — `src/server/http.ts` becomes `dist/server/http.js`, with `.d.ts` and a
source map beside it. There is no bundler, and two things depend on that:

- the Vite plugin, `dist/vite/index.js`, resolves the Overlay's entry with
  `new URL('../overlay/index.js', import.meta.url)`,
- and it hands Vite its own package root as `new URL('../..', import.meta.url)`, which
  is what `server.fs.allow` is given.

Both read off the emitted layout. They hold only while the emit sits exactly one level
under the package root and the Connector one level under that. An emit that nested the
output deeper — `dist/src/…` — would break `server.fs.allow` in a way no error message
would explain.

## The entry points, and where a Connector lives

The package has **one entry point per Host and no root entry** (ADR-0005). Importing
bare `pointout` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, so no Host is the default.

| entry | what it is | source |
| --- | --- | --- |
| `pointout/vite` | the Vite plugin, `pointout()`, also the default export | `src/vite/index.ts` |
| `pointout/vite`, `require` | throws, naming `await import("pointout/vite")` | `src/vite/cjs-entry.cts` |
| `pointout/next` | `withPointout()`, from ticket 04 | `src/next/` |

The bin, `pointout`, is the CLI and belongs to no Host. `vite` is an **optional** peer
(`peerDependenciesMeta`); `next` joins it the same way. Each is needed only by its own
Connector.

**A Connector lives in its own directory**, `src/<host>/`, and is the only code that
imports its Host, even a type. `test/seam1/connectors.test.ts` reads the emitted `dist/`
and fails any module outside `dist/vite/` that imports `vite`; ticket 04 extends it to
`next` and `dist/next/`. A Connector does four things (`GLOSSARY.md` › Connector):

- puts the Overlay in the page,
- serves the Guard's endpoints, by mounting the handler `createAgentEndpoints` in
  `src/server/http.ts` returns. It hands that a `Connector`: the Host's logger, the
  origins the page is served on, the loopback origin, and a frame resolver;
- turns the Host's served positions back into source positions, with a **frame
  resolver** (`src/server/frame-resolver.ts`). Given a served frame's URL, line and
  column, it answers `found`, with the source file, the map to decode against or none,
  whether the module drifted since the page read the frame, and whether it is vendor
  code, or `absent` with a mode and a reason. The Vite one is
  `src/vite/frame-resolver.ts`: the module graph, plus the `.vite/deps` and
  `node_modules` vendor test;
- says where the Host is listening: `boundAddress` in `src/server/bound-host.ts` takes
  whatever the listening server's `address()` answered.

Everything else is the core, under `src/server/`, `src/cli/`, `src/overlay/`, `src/api.ts`
and `src/wire.ts`. The core logs through its own `Logger` (`src/server/logger.ts`), which
a Host's logger satisfies. It owns the decoder, the Owner chain and Confidence, and never
reads a URL scheme or a Host path.

## The two rules that bite

**A relative import inside `src/` writes the extension the built file will have**, which
is `.js`, never `.ts`:

```ts
import { readCandidates } from './registry.js' // resolves registry.ts, emits registry.js
```

Module resolution is `nodenext`, because the emit has to satisfy Node. The tests follow
the same rule; Vite maps a `.js` specifier onto the `.ts` file beside it, so the harness
works unchanged. The example apps are the exception, and deliberately: Vite and Next
bundle them and `tsc` never emits them, so they import the real filename
(`../../shared/App.tsx`).

**A type-only import says so.** `verbatimModuleSyntax` is on, so an `import` that survives
into the emit is one the runtime actually needs:

```ts
import type { ViteDevServer } from 'vite' // only ever inside src/vite/
```

Get this wrong and the emitted file carries a runtime import of a package that is only a
peer dependency. The Overlay's surfaces are the deliberate case: `"jsx": "react-jsx"`
makes every `.tsx` module import `react/jsx-runtime`, and the components import `react`
and `react-dom/client` themselves. Those resolve to the consumer's own React when Vite
serves the Overlay, which is why `react` and `react-dom` are peer dependencies and the
plugin names both in `optimizeDeps.include`.

## Where a type belongs

Beside the module that owns it, exported from there — `Registry` in
`server/registry.ts`, `Refusal` in `server/guard.ts`, `ServerFacts` in `server/index.ts`.
There is no `types.ts`; a type that has no owning module is usually a module waiting to
be found.

The one exception is the wire. Every shape that crosses HTTP between the Overlay and
the dev server, or between the drain CLI and the dev server, is written once in
`src/wire.ts` — `PickBody`, `Candidate`, `PickStatus`, the Pick states, the Excerpt
kinds, the Note cap — and both halves import it. A wire shape spelled twice by hand is
a shape that drifts; `api.ts` names the paths, `wire.ts` names what travels on them.

Types are named in `GLOSSARY.md`'s vocabulary. The glossary applies to type names exactly
as it applies to prose: a `Candidate` is a Candidate, and nothing else gets called one.

## The commands

| command | what it does |
| --- | --- |
| `npm run build` | emits `dist/`, incrementally |
| `npm run typecheck` | checks the package and the tests, then the example app |
| `npm run lint` | oxlint, warnings denied |
| `npm run lint:fix` | formats, then applies oxlint's fixes |
| `npm run format` | oxfmt, in place |
| `npm run format:check` | oxfmt, reporting rather than writing |
| `npm run clean` | removes `dist/` |

`npm run build` is a `pre` step of `dev` and of each test command, so nothing ever runs
against a stale `dist` and nobody has to remember a build.

The compiler's incremental state is `dist/.tsbuildinfo` — inside the output on purpose.
An incremental `tsc` trusts that state over the files on disk, so a state that outlives
the emit it describes makes the next build a no-op and leaves a consumer with nothing to
import, reported as an unrelated resolve failure. Keeping the two together means deleting
one deletes the other. A negation in the package's `files` keeps it from shipping.

`npm run typecheck` is two invocations because the two halves are checked under different
settings: the package under Node's resolution, the test bed under a bundler's, with the
DOM lib and React's JSX. It builds first — the example app resolves the package through
`exports`, so there has to be an emit to check against. `dist/` is the package's product;
a green typecheck is the repository's.

## Linting and formatting

oxlint and oxfmt, configured at the root in `.oxlintrc.json` and `.oxfmtrc.json`, with
ADR-0002 recording why oxc rather than ESLint and Prettier.

**The formatter is configured to this codebase**, not the other way round: no semicolons,
single quotes, trailing commas, `printWidth` 90 — measured against the existing code, not
guessed. Import sorting is off, because the order here is meaningful: Node built-ins,
then Vite, then local.

**The formatter's scope is code.** Markdown is excluded, and so are `.scratch/` and the
spikes. The prose in this repository is a record — the spec, the resolved research, every
closed ticket — and a formatter run over a closed ticket does not tidy it, it falsifies
it. `package.json` is excluded too: npm rewrites it on install, so the formatter and the
package manager would take turns.

**The linter runs at `correctness` and `suspicious`, and the gate denies warnings.** A
rule that is turned off or configured carries a comment saying why, in the config, beside
it — and a test fails if one does not. Nothing is silenced merely because it was noisy: a
finding is fixed, or it is configured with a reason a reader can disagree with.

### The two gates

Both automated, because a convention in a document is not a gate:

- **On save** — a `PostToolUse` hook runs oxfmt on the file an agent just wrote
  (`.claude/hooks/format-file.sh`), and `.vscode/settings.json` does the same for a
  human. The hook filters by extension itself rather than trusting the formatter's
  ignore list, because oxfmt would otherwise reformat a Markdown file an agent wrote.
- **Before done** — a `Stop` hook runs the lint gate (`.claude/hooks/lint-gate.sh`) and
  blocks with the findings named. It **blocks once, not forever**: the loop guard it
  needs to avoid deadlocking a session (`stop_hook_active`) is also what lets the next
  stop through. Read it as a loud nag that cannot be missed, not a wall that cannot be
  passed. It is repository-wide, so lint left red by *other* work — an earlier task, or
  a second agent's uncommitted files — fires at whoever stops next rather than at
  whoever caused it. Under concurrent agents that is noisier than it sounds: check
  whose files are red before touching them.

Both hooks live in `.claude/settings.json`, which is checked in. A machine-specific
override belongs in `.claude/settings.local.json`, which is not.


## What does not change

**No test imports a server module** (`testing.md`) — and in TypeScript that means no test
imports a server module's *types* either. A test that needs to know the shape of a payload
writes that shape out. The duplication is the point.

One project spans the Overlay's DOM lib and the server's Node types, so nothing stops
server code from reaching for `document` and getting a green check. If that ever happens,
ADR-0001 says what to do about it.
