# ADR-0003: the app frame is the JSX, not the callback that enclosed it

- **Status**: accepted
- **Date**: 2026-09-22
- **Deviates from**: spec §12
- **Raised by**: ticket 05, decided by the maintainer, implemented under ticket 26

## Context

An Owner-chain link is a raw `_debugStack` string. Both React's own top frame and
React's `react_stack_bottom_frame` sentinel are discarded, leaving a region of app
frames. Something has to choose one of them.

**Spec §12 says the frame directly above the sentinel** — the *last* of that region.
**React DevTools takes the first frame after the top frame** — the *first*.

For an ordinary call site the region holds exactly one frame and the two rules are the
same answer. They diverge only when a callback sits between the component and its JSX:
a `.map()`, a `.filter()`, a render prop.

Measured on `NestedOwners.tsx`, picking the badge:

| rule | reports |
| --- | --- |
| spec §12, last frame | `:37` — the `return articles.map(` line |
| React DevTools, first frame | `:42` — the `<span>` itself |

## Decision

**Take the first frame: the JSX.**

A Pick carries a developer saying *"this element needs more padding"* or *"change this
text"*. The line they mean is the tag they pointed at, not the expression that produced
it. `GLOSSARY.md` defines the Owner chain as "the place a component wrote the tag, or
passed the props" — line 42 is where ArticleList wrote the tag; line 37 is where it
started a loop.

A devtools user reading a render tree may well want the enclosing expression, which is
plausibly why React DevTools' upstream context differs from ours. v0 is not that tool.

## Consequences

- **It also recovers locations in Safari.** The frame directly above the sentinel is
  frequently the component's own tail call, which JavaScriptCore deletes. Picking the
  badge in WebKit used to report `no location`; it now reports `NestedOwners.tsx:42:9
  (exact)`. This was not the reason for the decision and was found by making it.
- **The genuinely elided case still exists** and is unaffected: a component whose body
  is a bare `return <h3>` has no argument-position frame to fall back to. Ticket 06's
  `card-heading` journey covers it, and spec §12's `call-site-frame-elided-by-engine`
  mode is still reachable.
- **Spec §12's sentence is now wrong** where it describes the rule. It is right about
  everything else in that bullet — the content sniff, both sentinel spellings, popping
  React's top frame. Ticket 22 should correct the sentence rather than the paragraph.
- The change is one loop in `readAppFrame`. Two tests hold it: a server-suite test that sends
  one stack carrying both frames and asserts which comes back, and the browser-suite badge
  journey. The server-suite one was verified to fail under the old rule before being kept —
  a test for a one-line choice is worthless if it passes either way.
