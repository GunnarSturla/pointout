# ADR-0002: oxlint and oxfmt, with the formatter configured to the code

- **Status**: accepted
- **Date**: 2026-09-22
- **Ticket**: 24 of the v0 build, in the local tracker
- **Follows**: ADR-0001 (TypeScript, `tsc` ESM emit, no bundler)

## Context

After ADR-0001 the repository had exactly one automated static gate: the type checker.
Everything else — no semicolons, single quotes, comment density, the import order that
puts Node built-ins first — was held by attention alone. That worked for fifty-nine
files written in one sitting by one hand, and it is the first thing to go when work
resumes across sessions.

The repository is also mostly written by agents, which sharpens the requirement: a
convention an agent has to remember is a convention that drifts. It has to be a gate.

## Decision

**oxlint for linting, oxfmt for formatting**, both from the oxc toolchain, both
configured at the repository root, both reachable as npm scripts so a hook and a person
run the same command.

**The formatter is configured to this codebase, not the other way round.** oxfmt's
defaults are semicolons and double quotes; this repository is written without semicolons
and with single quotes. `printWidth` was measured — 80 reflows 387 lines, 90 reflows 100,
100 reflows 97 — and set to 90.

**The linter runs at `correctness` and `suspicious`, and the gate denies warnings.**
`pedantic` was measured and left out. Every rule that is off or configured carries a
comment saying why, and a test fails if one does not.

**Two gates, both automated:**

- `PostToolUse` formats the file an agent just wrote; a checked-in editor setting does
  the same for a human.
- `Stop` runs the lint gate and refuses to end a task while it is red.

## Alternatives

**ESLint and Prettier.** The default, and rejected on shape rather than on speed. ESLint
9's flat config for a repository spanning Node, DOM and React is three plugin sets and a
`typescript-eslint` parser pass; oxc is two config files and no parser plumbing. Speed is
a bonus, not the argument — the argument is that this repository has five configuration
files already and adding six more to lint fifty-nine is the wrong ratio.

**Biome.** The closest call: one tool for both jobs, and mature. oxc was chosen because
oxlint's rule coverage is the larger of the two for the things this repository actually
hit, and because the two tools being separate let the formatter be scoped to code while
the linter is scoped differently — see below.

**Format everything, including Markdown.** Tried, and reverted the same hour. oxfmt
formats Markdown, and the default run rewrote **56 prose files**: the spec, every
resolved map ticket, every closed build ticket, the research notes and `GLOSSARY.md`.
Those are a record of what was decided and when. A formatter run over a closed ticket
does not tidy it, it falsifies it.

**Only lint changed files.** Rejected for the Stop gate: a repository that is green only
on the lines someone touched is not green.

## Consequences

- **The formatter's scope is code, and prose is hand-written.** `.oxfmtrc.json` excludes
  `**/*.md` and `.scratch/**`; the `PostToolUse` hook filters by extension
  as well, rather than trusting the formatter's ignore list for a file named explicitly.
  Two tests hold both halves.
- **`package.json` is excluded too.** npm rewrites it on every install, so a formatter
  and a package manager would take turns reformatting the same file and `format:check`
  would be red after any `npm install`.
- **The Stop gate is repository-wide**, so lint left red by earlier work fires at the
  next task rather than at the one that caused it. That is the intended severity: it is
  a gate, and the loud version is the useful one.
- **It blocks once, not forever**, and the wording elsewhere should not claim otherwise.
  The hook reads `stop_hook_active` so a blocking gate cannot re-enter itself — and that
  same guard means the following stop passes. It reports; it does not enforce. Making it
  enforce would need a gate that distinguishes "red because of this task" from "red
  because something else is unfinished", which the working tree alone cannot tell it.
  Observed in practice: with two agents in one tree, the gate fired at the session for
  another agent's in-flight files — three times, every one of them somebody else's
  work. **The gate now lints tracked files only.** A brand-new file nobody has staged
  is by definition unfinished, and a gate that reports on it is reporting on whatever
  is half-written next door rather than on the task that is ending. Finished work is
  staged work, so the gate still sees everything it is for.
- **Nineteen findings on existing code were fixed rather than suppressed**, including a
  shadowed binding in the plugin factory and a re-thrown error that dropped its `cause`.
  Three rules are configured and one is allowed an exception; each carries its reason.
