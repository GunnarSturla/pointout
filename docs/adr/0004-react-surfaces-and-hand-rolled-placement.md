# ADR-0004: the Panel, Stack and Picker are React; the Highlight is not

- **Status**: accepted
- **Date**: 2026-09-22
- **Decided by**: the maintainer, on a review of the Overlay before tickets 14, 18 and 27

## Context

The Overlay's three standing surfaces were built by hand: `createElement`,
`textContent`, and a `render()` in the Panel that removed and re-inserted the Target
row, the empty state, the cancel button and the rows list depending on nine pieces of
state. The Stack did the same for chip words and sub-lines. That is reconciliation
written out longhand, and the three open Overlay tickets each add more of it: a
countdown offer, a capture toggle, `held` and `unknown` chips.

The Panel was positioned by Floating UI — one `computePosition` with `flip` and `shift`,
and `autoUpdate` to re-run it — while the Highlight measured the same elements itself,
through `viewportBox`, and the controller already listened for every scroll and resize.
Two geometry paths and two trigger paths for one page.

React is already a peer dependency: v0 is React-only, because the Owner chain is read
off React's fibers. The consumer's page therefore always has React loaded.

## Decision

**The Panel, the Stack and the Picker are React components**, rendered into one root
inside the shadow root (`src/overlay/surfaces.tsx`). The controller in
`src/overlay/overlay.ts` owns the state that decides what is on screen — armed, picked,
which element, which Picks are outstanding — and hands it down as props on every
change. Each surface keeps only what is its own: the Note being written, the Target
chosen, the chip words last polled.

**The Highlight and the controller stay imperative.** The Highlight is geometry plus two
observers, updated on every pointer move, and its no-travel-on-first-appearance rule
depends on a synchronous layout read between two attribute writes. The controller is
event plumbing and a three-state machine. Neither is rendering.

**Floating UI is gone.** The Panel's placement is forty lines of arithmetic in
`src/overlay/placement.ts`: below the element at its start edge, above it when there is
more room there, shifted whole into the viewport on opening — and after that it keeps
the offset it opened at and rides with the element, which is spec §7's rule stated
directly rather than through a shift limiter. It measures the anchor with the same
`viewportBox` the Highlight uses, and re-measures on the same `reflow` signal the
controller raises for scroll, resize and hot updates. The package has no runtime
dependency.

## Alternatives

- **Keep the surfaces imperative.** The code worked and its tests were green. It was
  rejected because the three open tickets would each have added another hand-written
  reconciler to the two that existed, and the readability cost compounds.
- **A smaller renderer, or a signal library.** Rejected: the consumer already has React
  on the page, and a second framework in the same shadow root is a second thing to
  keep in step with it.
- **Keep Floating UI, through `@floating-ui/react-dom`.** Rejected: the Panel sits in a
  fixed host at inset zero with the fixed strategy, so the hard part of Floating UI —
  offset-parent and transform arithmetic — is never exercised, and its `autoUpdate`
  duplicated triggers the Overlay already owned. `@floating-ui/react` was never a
  candidate: its interaction hooks are for popovers that dismiss and manage focus, and
  the Panel deliberately does neither.

## Consequences

- **The Overlay is React-dependent as a whole.** Before, only `src/overlay/fiber.ts`
  knew React existed. `react-dom` joins `react` as a peer dependency, and the plugin
  names `react/jsx-runtime` and `react-dom/client` in `optimizeDeps.include` so Vite
  prebundles them with the app's own dependencies rather than discovering them on the
  first page load. If a later version ever supports another framework's Overlay, this
  is the decision it reopens.
- **The Trusted Types claim changes hands.** The seam-1 test that reads the built
  Overlay for markup-string APIs still passes — react-dom is the consumer's module, not
  ours — but the guarantee that nothing in the Overlay builds DOM from a string now
  rests on react-dom's behaviour under `require-trusted-types-for 'script'`. That has
  to be verified against the first consumer's CSP before v0 is called done; it is
  recorded in the build brief as an open item.
- **The Overlay's own elements count toward React's owner-stack budget.** Every
  dev-mode element captures an owner stack, and the placeholder ceiling this project
  measured is a per-instance counter. A Panel re-rendering on the tick is negligible; a
  Highlight re-rendering on every pointer move would not be. That is one more reason
  the Highlight stays imperative.
- **The Note is read off the textarea's own `input` event, not React's `onChange`.**
  React ignores an `input` event for a value it has already seen written to the
  element, and a Note put into the textarea by anything other than keystrokes — a
  script, an extension, a test driver — must still count. The textarea is uncontrolled
  for the same reason, with `defaultValue` bringing the text back when the zero-state
  morph re-mounts it.
- **`src/` gains `.tsx`**, the shared `tsconfig.json` gains `"jsx": "react-jsx"`, and the
  root package carries React and its types as dev dependencies for the typecheck. The
  emit is unchanged: one file in, one file out, with `react/jsx-runtime` imported by
  name and resolved from the consumer's tree when Vite serves the Overlay.
- **Two rules the built-Overlay test already held apply to JSX files too**, and bite
  in prose as well as code: no module but the stylesheet may contain the words a
  moving declaration would, so a component's comments do not discuss motion, and
  React's `useTransition` and `startTransition` are never imported.
