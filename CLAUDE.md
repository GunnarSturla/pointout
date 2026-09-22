# vite-agent-inspect

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

### Borrowed code

Targeted, non-UI and credited: a per-file provenance header plus an entry in
`LICENSE-THIRDPARTY`. See `docs/agents/provenance.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root, ADRs in `docs/adr/`. See
`docs/agents/domain.md`.
