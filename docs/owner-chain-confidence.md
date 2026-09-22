# What a location in a pick is worth

Every element a developer picks carries an **Owner chain**: the JSX call sites that
created it, innermost first. Each link states its own **Confidence** — `exact`,
`approximate` with a reason, or `absent` with a reason.

Confidence belongs to one link and never to the pick. A chain can be exact at one
end and absent at the other, and the whole of it still travels: a pick degrades by
annotation, never by refusal. A link the dev server cannot place keeps the
component's name, so a teammate whose engine lost a frame still learns *who* wrote
the element even when they cannot be told *where*.

A link reads as one line:

```
  owner chain  ChainLeaf — examples/react-app/src/fixtures/OwnerChainDepth.tsx:28:7 (exact)
               ArticleList — no location (absent: call-site-frame-elided-by-engine — this engine's proper tail calls deleted …)
               Skeleton — no location (dependency, absent: module-not-in-graph — …)
```

## The modes

| stated as | when |
| --- | --- |
| `exact` | the frame remapped through the module's own sourcemap, and the transform it was made against is the one the server still holds |
| `approximate: stale-transform` | the frame names a transform of the module that this dev server has since replaced. The line is remapped through a sourcemap that has moved under it |
| `approximate: no-transform-timestamp` | the module has been re-transformed since the page loaded, and the frame carries no timestamp to compare — **Safari strips the query from a stack url** |
| `approximate: no-sourcemap` | the module was served without one. The line and column are kept, but they are the *served* module's, not the source file's |
| `absent: call-site-frame-elided-by-engine` | **Safari** deleted the frame. See below |
| `absent: no-react-boundary` | the stack never came out to app code: React's ten-frame cap, or an element created outside render |
| `absent: unknown-owner-placeholder` | React stopped recording owner stacks. See the ceiling, below |
| `absent: unreadable-frame` | the frame above React's own carries no location this server can read |
| `absent: module-not-in-graph` | nothing in this dev server's module graph answers to the path the frame names |
| `absent: unmapped-position` | the module's sourcemap has nothing at that position |

A link is additionally flagged **`dependency`** when its frame is inside a package —
`node_modules`, or one of Vite's pre-bundled `.vite/deps` modules. The flag leads the
parenthesis, because it is the one word that means *do not edit here* whatever the
rest of it says.

## The Safari limitation

JavaScriptCore implements proper tail calls, and a component whose body is a bare
`return <tag>` ends in one. Safari deletes that call site's frame, so the owner stack
React captured arrives with React's own boundary and nothing above it. The link is
`absent: call-site-frame-elided-by-engine`, and it keeps the component's name.

In practice: in Safari, only an element nested *inside* its component's root element
resolves exactly. An element that *is* the root element resolves in Chrome and Firefox
and not in Safari. The dev server does not try to recover the frame; the agent can
search the named component's file itself.

## The ceiling: about 10,000 elements a second

React 19 records an owner stack per element by throwing away an `Error` at every JSX
call, which is expensive, so it stops: above roughly 10,000 elements created per
second it hands every further element **one shared placeholder stack** instead of a
real one.

Spec §12 left open whether that placeholder is recognisable, and named it as the one
mode that might be *silently wrong* — a plausible-looking location that is somebody
else's. **It is not.** Measured against React 19.3.0 in Chromium, Firefox and WebKit:

- The placeholder is built once, at module load, as
  `react_stack_bottom_frame(UnknownOwner)` inside `react/jsx-dev-runtime`. It
  therefore names React's own runtime and no app frame at all, in every engine. It
  could never remap to a position in your source, so it was never going to be
  plausible-looking.
- In Chromium and Firefox its top frame is React's `UnknownOwner`, and the dev server
  recognises it by that name: the link reads
  `absent: unknown-owner-placeholder`.
- In WebKit both of those frames are themselves tail calls, so JavaScriptCore deletes
  them and the stack arrives with no React boundary at all. The link reads
  `absent: no-react-boundary` there — a different sentence for the same event, and
  still `absent`.

So the ceiling costs a location and never invents one. **v0 has no silently-wrong
mode.** What it costs is real: in a render that crosses the threshold, every element
after it loses its call site, and the Pointer names components without lines.
