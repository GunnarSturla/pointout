# Borrowed code: the provenance header

Borrowing in this repo is **targeted, non-UI, and credited** (spec §1). Targeted: the
smallest piece that answers the problem, never a dependency-by-copy. Non-UI: no picker
and no overlay code is taken from any prior-art project. Credited: two things happen
together, and a borrow that does only one of them is not finished.

## 1. A header on the file

Every file holding borrowed code opens with this block, before any import:

```js
// Borrowed: <what was taken, in a clause>
// From: <project> — <url>
// Version: <tag, version or commit sha> (<date taken>)
// License: <SPDX identifier> — full text in LICENSE-THIRDPARTY
// Changes: <how it was adapted, or "none">
```

Worked example:

```js
// Borrowed: the two stack-frame regexes and their parse functions
// From: React DevTools — https://github.com/facebook/react
// Version: v19.0.0 (2026-09-21)
// License: MIT — full text in LICENSE-THIRDPARTY
// Changes: dropped the source-map lookup; V8 and SpiderMonkey grammars only.
```

Rules:

- One borrow per file. A file that would carry two headers is two files.
- The borrowed code sits at the top of the file, under the header, separated from
  this repo's own code by a comment saying where the borrow ends.
- `Changes:` is prose about behaviour, not a diff. It is what a reader needs in order
  to know whether upstream's bug is also ours.

## 2. An entry in `LICENSE-THIRDPARTY`

The header credits; `LICENSE-THIRDPARTY` carries the licence text that the credit is
legally standing on. Add the entry in the same commit as the file. Its format is
documented in the file itself.

## The five borrows v0 expects

Named in the spec so a reviewer can tell a planned borrow from an unplanned one. Each
lands in the ticket beside it:

| what | from | ticket |
| --- | --- | --- |
| the stack-trace parser: two regexes and the parse functions | React DevTools | 05 |
| the deep-element-at-point hit test, with same-origin iframe handling | react-grab | 08 |
| the attribute allowlist, with its password and hidden-value redaction | UI-Locator | 07 |
| the armed `pointer-events` rule | click-to-react-component | 08 |
| the payload format the Pointer prose evolved from, and the fail-closed same-origin guard | herdr | 02, 13 |

Nothing else is vendored.
