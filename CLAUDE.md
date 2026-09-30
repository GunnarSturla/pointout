# pointout

A Vite dev-server plugin that lets a developer pick an element in the running app,
type a request about it, and have it reach the Claude Code session they are already
working in, with the element's source location attached.

See `README.md` for the idea and `CONTEXT.md` for the domain language.

## Start here

`docs/agents/build-brief.md` — what exists, the rules that are not negotiable, the
facts already measured, and how to run the gates fast. Read it before your ticket.

## Agent skills

### Issue tracker

Issues are local markdown files under `.scratch/<effort>/issues/`; there is no remote
and no hosted tracker. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See
`docs/agents/triage-labels.md`.

### Testing

Three seams; `npm test` runs seams 1 and 2. No test imports a server module. See
`docs/agents/testing.md` — read it before writing a test.

### TypeScript, packaging, lint and format

Everything is TypeScript; the package is `tsc`-emitted ESM in `dist/`, not `src/`. A
relative import inside `src/` writes `.js`. oxfmt formats on save and oxlint gates a
finished task, both as hooks; the formatter never touches prose. See
`docs/agents/packaging.md` — read it before writing a source file.

### Overlay surfaces

The Panel, Stack and Picker are React components in `src/overlay/*.tsx`, fed props by
the imperative controller in `src/overlay/overlay.ts`; the Highlight stays imperative.
Every shape that crosses HTTP is written once in `src/wire.ts`. See
`docs/adr/0004-react-surfaces-and-hand-rolled-placement.md` before touching a surface.

### Motion

No movement by default: all of it lives in one `prefers-reduced-motion: no-preference`
block in `src/overlay/styles.ts`, and a seam-1 test reads the built Overlay to keep it
there. A fade is not movement: opacity and colour may ease outside that block, for everyone.
The `review-animations` gate has run; the armed-hover Highlight morph is an accepted
deviation from it. A re-run is owed for everything that moves since overlay-polish. See `docs/motion.md` — read it before adding anything that moves.

### Borrowed code

Targeted, non-UI and credited: a per-file provenance header plus an entry in
`LICENSE-THIRDPARTY`. See `docs/agents/provenance.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root, ADRs in `docs/adr/`. See
`docs/agents/domain.md`.
