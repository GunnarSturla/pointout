# Motion

Source: spec §5 and §9, settled on the built prototype in `spike-17-overlay-shape/`.
This is the working copy: read it before adding anything that moves, and before
running the `review-animations` gate.

## The rule

**There is no motion by default.** Everything that moves is opted into under
`@media (prefers-reduced-motion: no-preference)`, and there is exactly one such block
in the whole project — at the bottom of `src/overlay/styles.ts`. A developer who has
asked their system for less motion is not opted *out* of anything here; they were
never opted in.

Under reduce the Highlight jumps, surfaces appear and disappear where they belong, and
every tuck is instant. Nothing is merely slower: the same states are reached, at once.

Only CSS transitions and the Web Animations API are used. The Panel's placement is
arithmetic in `src/overlay/placement.ts` and never animates; the React surfaces
(ADR-0004) declare no motion of their own, and the built-Overlay test would catch one
that did.

## What moves, and what does not

| | |
| --- | --- |
| the Highlight travelling between two hovered elements | 170 ms, `translate` + `width` + `height` |
| the Highlight of an element that has left the page | 120 ms, `opacity` to 0, where it stood |
| the Picker's reveal out of its peek | 220 ms, `translate` |
| the Screen Capture shutter reopening — Highlights, Stack, Picker | 120 ms, `opacity` from 0 |
| the report-back countdown line, each one-second step | 1000 ms, `transform` (`scaleX`), linear |

The durations and curves are the prototype's own, not new numbers: 170 ms on
`cubic-bezier(0.77, 0, 0.175, 1)` for the morph and 220 ms on
`cubic-bezier(0.23, 1, 0.32, 1)` for the reveal are what was built and reacted to in
`spike-17-overlay-shape/`. Astro's 350 ms overshoot curve was built beside them and
rejected.

Two things never move, and the rule for both is the same one:

- **Nothing travels on its first appearance.** A box that is appearing has nowhere to
  travel *from*, so it flies in from the last element it was on — or from the page's
  corner. The live Highlight, the chip, the frozen Highlight and the Panel are each
  placed instantly when they appear. One rule; it fixed four observed bugs in the
  prototype.
- **Tracking is not travelling.** A scroll, a resize or a hot update moves the element
  under a Highlight that is already on it. A box that eased its way after a scroll
  would lag behind the thing it marks, so a re-measure is a placement and never a
  move.

In the Highlight both are the same mechanism: the box carries `data-placing` for that
one placement, the attribute suppresses the morph, and the placement is committed
before it comes off.

## The shutter

Every Pick, and every move of one, closes a shutter over the Overlay for the frame a
Screen Capture is taken in (spec §10, story 68). The host carries `data-shutter` for a
fixed 250 ms; while it does, the Highlight and its chip, the resting Highlights, the
Stack and the Picker are `visibility: hidden` and `opacity: 0`. The Panel is not behind
it: its entrance is never gated on a capture, and a large element's capture may catch
its edge.

- **Closing is instant in every mode.** A close that eased could be caught half-done by
  the capture, so the opt-in block turns easing off while the shutter is closed.
- **Opening eases, and only under no-preference** — 120 ms of `opacity`, the same span
  the Highlight fades by when its element leaves. Under reduce everything is simply
  back, at once, and the Overlay was still absent while the capture was asked for.
- **It reads the same whether a capture is taken, skipped, or unavailable.** The span is
  fixed, not tied to the capture's answer, because the dev server answers the id at once
  and runs the tool behind it. 250 ms is the real `screencapture` run (75–110 ms for a
  200 px region, process start included, measured on the build machine) more than
  twice over.

It is one more thing for the `review-animations` gate to see: a blink on every Pick,
which is a frequent action. It is not pre-registered as a deviation, because the hide
is the feature and only the 120 ms opening is motion; the gate may shorten or remove
that opening without touching the hide.

## The report-back countdown

A Pick offered back to the developer (spec §8, §17, story 47) counts down thirty
seconds as a thin line under the offer. Script sets the line's length once a second,
as the custom property `--left`, and it sets it **one step ahead**: at any moment the
line is aimed at where it will be a second from now. The line is 2 px high with no
radius, so it is scaled (`transform: scaleX`) rather than resized: there is no border
or corner for scaling to distort, and nothing around it is laid out again.

- **Under no-preference** the opt-in block eases each step across its second, linearly,
  so the line reads as one steady shortening that reaches empty exactly when the thirty
  seconds do. Linear because it is a clock, not an object arriving somewhere.
- **Under reduce** the same states are reached at once: the line shortens in
  one-second steps of one thirtieth, with nothing between them. Being a step ahead, it
  shows empty for the last second. The default fires on its own timer either way, at
  the thirtieth second, whatever the line shows.
- **Touching the offer removes the line** — hover, press or focus — and it never comes
  back (story 48). Nothing eases it away.

It is one more target for the `review-animations` gate, and it is **not** pre-registered
as a deviation. By the frequency rule it is rare — an offer is a Pick that failed to
land — and it carries information, so the rule's likely reading is that it may move;
the gate may still change the step, the curve or the reduce-mode behaviour.

## Why the morph animates `width` and `height`

Because `scale` distorts the box's own border and its corner radius while it travels,
and a morph may not distort its own edges (spec §9). `translate` + `scale` is the
GPU-only way to move a box and it was **rejected outright** on the prototype, where
both were built and compared. Animating `width` and `height` knowingly spends a
performance rule; it is affordable here and nowhere else, because the Highlight is one
fixed element outside the host's layout flow, so nothing of the consumer's page is
laid out again when it changes.

## The `review-animations` gate, and the deviation pre-registered against it

`review-animations` (`~/.claude/skills/review-animations/`) is a **build-time gate the
human runs by name** before v0 is called done. It is user-invocable only, so no agent
runs it. Ticket 22 is where it runs and where its outcome is recorded.

**The armed-hover Highlight morph is pre-registered as a deliberate deviation from
that gate's frequency rule.**

- **The rule it deviates from**: *"Match motion to how often it's seen. Keyboard-initiated
  and 100+/day actions get no animation."* The armed-hover morph is the
  highest-frequency motion in the whole design — it fires on every hover while the
  Picker is armed, which is hundreds of times in a session. By the frequency table it
  should be reduced or removed.
- **The warrant**: the human's reaction to the built prototype. Spike 17 built the
  morph and its alternatives; ticket 15 settled that the Highlight morphs, on the
  built artifact rather than on an argument.
- **Its standing**: pre-registered, which is a claim with two halves. **The gate may
  not silently reverse this decision** — a standards run may not undo a decision made
  on a built artifact without saying so. **And the decision may not skip the gate** —
  the morph is the gate's first target, and closing this out without running it would
  leave the spec saying *the Highlight morphs* against a known finding that it should
  not.
- **Status**: the gate has **not** run. Nothing here records its outcome, and nothing
  may claim one until ticket 22 does.

The second, smaller deviation is the `width`/`height` animation above: a performance
finding under the same standards, accepted for the reason given there. It is the gate's
second target.

## Running the gate

This section is for the human who runs `review-animations`. Ticket 22 prepared it and
did not run the gate.

### What the gate reviews

These are all the declarations in the `prefers-reduced-motion: no-preference` block
at the bottom of `src/overlay/styles.ts`. Nothing else in the Overlay moves, and
`test/seam1/overlay-build.test.ts` holds that. Each row says whether the decision
behind it is pre-registered, which means the gate may not silently reverse it, or
free, which means the gate may change it.

| # | surface | selector | what moves | how often | standing |
| --- | --- | --- | --- | --- | --- |
| 1 | the armed-hover Highlight morph | `.highlight` | `translate`, `width`, `height`: 170 ms, `cubic-bezier(0.77, 0, 0.175, 1)` | every hover move while armed | **pre-registered deviation** from the frequency rule. The first target |
| 2 | the morph's use of `width`/`height` rather than `scale` | `.highlight` | as row 1 | as row 1 | **pre-registered deviation** from the performance rule. The second target |
| 3 | the Highlight of an element that left the page | `.highlight[data-gone]` | `opacity` to 0: 120 ms linear | rare | free |
| 4 | the Picker's reveal out of its peek | `.picker-peek` | `translate`: 220 ms, `cubic-bezier(0.23, 1, 0.32, 1)` | each time the pointer reaches the bottom edge | free |
| 5 | the shutter reopening after a Screen Capture frame | `.highlight`, `.stack`, `.picker-peek` | `opacity` from 0: 120 ms linear. Closing is never eased | every Pick and every move of one | free. The hide is the feature and stays; only the opening is motion |
| 6 | the report-back countdown line | `.countdown` | `transform: scaleX`: each 1000 ms step linear, set one step ahead | rare: a Pick that did not land | free, including the reduce-mode behaviour of showing empty for the last second |

Two rules are not motion but bear on it, and the gate should see them too. **Nothing
travels on its first appearance**, and **tracking is not travelling**: `.highlight[data-placing]`
turns the transition off for a placement. Both are described above.

### Building and opening the Overlay

The gate should review the built Overlay: the emitted `dist/overlay/`, served by a
real dev server to the in-repo example app. It should not review `src/`.

1. From the repository root, run `npm install` once, then `npm run dev`. `predev`
   builds `dist/` first, then Vite serves `examples/react-app/` and prints its URL.
2. Open that URL in a browser, with the system's reduced-motion setting **off**. On
   macOS that is System Settings → Accessibility → Display → Reduce motion. Turn it
   on afterwards to see that the Overlay does not move at all.
3. **Rows 1–3**: hold Alt/Option, or click the Picker at the bottom centre, and move
   over the example app's fixtures. Click an element to pick it. Each fixture has a
   `data-fixture` attribute, and one of them unmounts its element on a button press
   (row 3).
4. **Row 4**: with nothing armed, move the pointer to the bottom edge, onto the
   Picker's peek.
5. **Row 5**: pick an element, then Alt-click a second one to move the Pick. The
   shutter blinks each time, whether or not a Screen Capture is taken.
6. **Row 6** needs a Pick that did not land. The deterministic way is to watch the
   seam-2 journey headed, in Chromium:

   ```sh
   npm run build
   SEAM2_PORT=5199 npx playwright test test/seam2/report-back.spec.ts \
     --project=chromium --headed --debug -g "with motion allowed"
   ```

   `--debug` opens the Playwright inspector. The journey ends a few seconds after the
   line starts to shorten, so step through it there to hold the page open.
   `npx playwright` skips the `pretest:seam2` build, which is why `npm run build` comes
   first.

Without a Claude Code session running in this checkout, the Panel shows its
zero-Candidate state and no Pick can be sent. On a machine with no
`~/.claude/sessions/` at all it shows the hook-floor state instead. Rows 1–5 can still be reviewed. For the
Stack to appear with a real Pick in it, start Claude Code at the repository root first.

### The outcome

The gate has **not** run. Nothing in this section records an outcome. Whoever runs it
fills in the lines below.

- **Run by, and when**:
- **Skill version, or the commit of `~/.claude/skills/review-animations/`**:
- **Build reviewed (commit)**:
- **Row 1, the armed-hover morph**: kept as a deviation / changed / withdrawn, and
  why:
- **Row 2, `width`/`height`**: kept as a deviation / changed / withdrawn, and why:
- **Rows 3–6, the gate's findings, and what was changed**:
- **Deviations accepted**, each with its warrant:

If the gate reverses either pre-registered decision, say so here in so many words,
and change spec §5 and §9 to match. A reversal must not be silent.

## How the rule is held

`test/seam1/overlay-build.test.ts` reads the **built** Overlay — what the consumer's
browser actually runs — and asserts three things: motion is declared in the stylesheet
and in no other module, every moving declaration sits inside the one
`prefers-reduced-motion: no-preference` block, and the query is `no-preference` rather
than `reduce`, because `reduce` would be motion by default undone afterwards.

Anything that animates through the Web Animations API instead has to name
`prefers-reduced-motion` in its own file: a script call carries no media query of its
own, so the file that makes one has to ask first.

`test/seam2/highlight.spec.ts` is the other half, in a real browser: what runs on a
first appearance (nothing), what runs on a hover move (`translate`, `width`, `height`,
never `scale`), that the box's border and radius are unchanged in a mid-morph frame,
and that under emulated reduced motion nothing animates at all while every position
still updates.

The test bed holds still on purpose: `examples/react-app/` animates nothing, so those
assertions mean what they say.
