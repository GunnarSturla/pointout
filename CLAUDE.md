# vite-agent-inspect

A Vite dev-server plugin that lets a developer pick an element in the running app,
type a request about it, and have it reach the Claude Code session they are already
working in, with the element's source location attached.

See `README.md` for the idea and `CONTEXT.md` for the domain language.

## Agent skills

### Issue tracker

Issues are local markdown files under `.scratch/<effort>/issues/`; there is no remote
and no hosted tracker. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root, ADRs in `docs/adr/`. See
`docs/agents/domain.md`.
