// The Overlay's whole stylesheet, as one string set with `textContent` on a
// `<style>` inside the shadow root (spec §3).
//
// It is also the only file in the Overlay that may declare motion. Anything
// that moves is declared in one place, the single opt-in block at the bottom,
// which nothing outside `prefers-reduced-motion: no-preference` may leave; a
// fade is not movement, and is declared just above that block for every
// developer. A seam-1 test reads the built Overlay and holds the rule — see
// `docs/motion.md` before adding any.

/** The host itself, as an inline style: page CSS does not get a vote on it. */
export const HOST_STYLE = [
  'position: fixed',
  'inset: 0',
  'z-index: 2147483647',
  // The host takes no pointer of its own; the Picker and the Panel opt back in.
  'pointer-events: none',
  'color-scheme: light dark',
].join('; ')

const FONT = "13px/1.5 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"

export const OVERLAY_STYLESHEET = `
:host { all: initial }

/* The design tokens (docs/overlay-design.md), for the whole Overlay. Each
   colour has a light and a dark value, chosen by the host's own
   \`color-scheme: light dark\`. Tints are mixed from these with \`color-mix\`,
   never written as new hex values. \`all: initial\` leaves custom properties
   alone, so they are set on the host after it. */
:host {
  --surface: light-dark(#ffffff, #1e2026);
  --surface-sunken: light-dark(#f3f4f7, #17181d);
  --ink: light-dark(#1b1d22, #e6e8ee);
  --ink-muted: light-dark(#5b606b, #a3a8b3);
  --line: light-dark(#d6d9e0, #3a3d46);
  --line-strong: light-dark(#8c919b, #6f7480);
  /* Blue means the pick: the Highlight, the focus ring, the chosen row. The
     dark value is for the ring and accent text only; the Highlight itself
     stays #4f7cff in both schemes. */
  --accent: light-dark(#4f7cff, #6f95ff);
  /* The armed Picker's fill, the one solid blue control: white on it is
     4.84:1, where #4f7cff would be 3.71. */
  --accent-strong: #3a66f0;
  --on-accent: #ffffff;
  --ready: light-dark(#1f8a4c, #3fbf73);
  --working: light-dark(#b06f00, #e0a526);
  --needs: light-dark(#c8322b, #f06a60);
  --idle: light-dark(#7a7f8a, #8a909c);

  --font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  /* The three steps of the type scale, in px so the page's root size cannot
     leak in. Two weights only: 400, and 600 for names and button labels. */
  --type-note: 13px/18px var(--font-family);
  --type-ui: 12px/16px var(--font-family);
  --type-small: 11px/14px var(--font-family);
}

/* Forced colours: every token becomes the system colour for its role, so the
   Overlay does what the operating system says. */
@media (forced-colors: active) {
  :host {
    --surface: Canvas;
    --surface-sunken: Canvas;
    --ink: CanvasText;
    --ink-muted: CanvasText;
    --line: CanvasText;
    --line-strong: CanvasText;
    --accent: Highlight;
    --accent-strong: Highlight;
    --on-accent: HighlightText;
    --ready: CanvasText;
    --working: CanvasText;
    --needs: CanvasText;
    --idle: GrayText;
  }
}

*, *::before, *::after { box-sizing: border-box }

/* The shield: raised instead of the armed rule on a page too dense to restyle
   (spec §4). It is invisible, takes the pointer so the page beneath it does not,
   and is skipped by the hit test's first rule like everything else the host
   draws. */
.shield {
  position: fixed;
  inset: 0;
  pointer-events: auto;
}

/* A frame shield: the same, over one frame the Overlay cannot hear and nothing
   else, so the pointer above that frame stays in the page the Overlay listens
   in. Placed with \`translate\`, like the Highlight. */
.frame-shield {
  position: fixed;
  top: 0;
  left: 0;
  pointer-events: auto;
}

/* Placed with \`translate\` from the page's origin rather than with \`top\` and
   \`left\`, because \`translate\` is what the morph animates and the two ways of
   saying where a box is cannot both be in play. */
.highlight {
  position: fixed;
  top: 0;
  left: 0;
  pointer-events: none;
  outline: 1.5px solid #4f7cff;
  background: rgb(79 124 255 / 10%);
}

.highlight[hidden] { display: none }

/* Painting order, by role rather than by where a box sits in the shadow root:
   the Stack's resting marks lowest, the open Pick's mark over them, the live
   mark that follows the pointer while Alt is held over a Panel over both — it
   is the one being pointed at — and every surface over all of them. */
.highlight { z-index: 1 }

.highlight[data-mark='current'] { z-index: 2 }

.highlight[data-mark='live'] { z-index: 3 }

.stack,
.picker-peek,
.panel { z-index: 4 }

/* The element this was on has left the page (spec §5), or this was the live
   mark and it has been let go of. The box fades where it stood — it never
   flies off, and a Pick made of it still sends. */
.highlight[data-gone],
.highlight[data-fading] { opacity: 0 }

/* The shutter (spec §10): closed for the frame a Screen Capture is taken in.
   It takes only what would pollute the capture: the Highlight's fill, which
   would tint the element, and its chip, which would cover the page beside it.
   The outline stays — it marks the picked element inside the capture's
   margin, and the setup skill tells the agent so. The Stack, the Picker and
   the Panel are nowhere near the element and stay too. Closing is always
   instant, so no capture ever catches the fill halfway out; only the opening
   is eased, and it is a fade (see the fades, below). */
:host([data-shutter]) .highlight { background-color: transparent }

:host([data-shutter]) .chip { opacity: 0 }

.chip {
  position: absolute;
  inset-inline-start: 0;
  inset-block-end: calc(100% + 4px);
  display: flex;
  gap: 6px;
  max-width: 340px;
  padding: 2px 6px;
  border-radius: 4px;
  background: #4f7cff;
  color: #fff;
  font: 500 11px/1.6 ui-sans-serif, system-ui, sans-serif;
  white-space: nowrap;
  overflow: hidden;
}

.chip[data-below] {
  inset-block-end: auto;
  inset-block-start: calc(100% + 4px);
}

.chip-file { opacity: 0.8 }

/* The resting Highlight of a submitted Pick (spec §5): a thin outline, no fill
   and no chip, desaturated — the Pick is still marked on the page, and the page
   is still readable under it. Hovering its chip in the Stack takes the attribute
   off and the box is the live treatment again. The open Pick's own mark wears
   it too while the live mark shows what an Alt-click would pick instead. */
.highlight[data-resting] {
  outline-width: 1px;
  outline-color: rgb(127 127 127 / 75%);
  background: none;
}

.highlight[data-resting] .chip { opacity: 0 }

/* What the Picker peeks out of (spec §8). It is the part that moves, so the
   button inside it keeps one job. Full width and pointer-transparent: this
   element is never a hit target, its buttons are, and :hover still reaches it
   from whichever one is under the pointer — so the reveal needs no invisible
   hitbox of its own. */
.picker-peek {
  position: fixed;
  inset-block-end: 0;
  inset-inline: 0;
  display: flex;
  justify-content: center;
  align-items: flex-end;
  gap: 6px;
  pointer-events: none;
  /* The peek. Less than half the Picker's height, so the point a developer aims
     at while it is tucked is still on the Picker once it has come out. */
  translate: 0 13px;
}

/* Out, and staying out: focused, or holding something unresolved — and
   hovered, where there is a pointer that hovers. A tap on a touch screen
   leaves a hover behind, and the Picker would come out and stay out for it. */
.picker-peek[data-out],
.picker-peek:focus-within {
  translate: 0 0;
}

@media (hover: hover) and (pointer: fine) {
  .picker-peek:hover { translate: 0 0 }
}

/* The Picker's row is centred on the Picker alone: "Back to your pick" hangs
   off its right edge, out of flow, so it never pushes the Picker off centre. */
.picker-anchor { position: relative }

/* An edge tab (docs/overlay-design.md): attached to the viewport's bottom,
   so its bottom is square and it has no shadow. */
.picker,
.picker-back {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  /* The bottom padding is the peek's 13 px and a little more, so a tucked
     Picker still shows its whole icon and label. */
  padding: 8px 12px 14px;
  border: 1px solid var(--line);
  border-block-end: 0;
  border-radius: 6px 6px 0 0;
  background-color: var(--surface);
  color: var(--ink);
  font: 600 var(--type-ui);
  white-space: nowrap;
  cursor: pointer;
  transform-origin: 50% 100%;
}

.picker { justify-content: center }

.picker-back {
  position: absolute;
  inset-block-end: 0;
  inset-inline-start: calc(100% + 6px);
}

.icon { flex: none }

/* "ing…", zero wide until the Picker is armed. It is always in the Picker
   rather than swapped in with the word, because a width can only ease between
   two values the element has: from zero to its own width, here, where the
   movement block below lets \`interpolate-size\` ease it. */
.picker-tail {
  display: inline-block;
  overflow: hidden;
  vertical-align: bottom;
  width: 0;
}

.picker[data-armed] .picker-tail { width: auto }

/* Armed: the one solid blue control. Its border turns the fill's colour, so
   the two merge. */
.picker[data-armed] {
  border-color: var(--accent-strong);
  background-color: var(--accent-strong);
  color: var(--on-accent);
}

@media (hover: hover) and (pointer: fine) {
  .picker:hover,
  .picker-back:hover {
    background-color: color-mix(in srgb, var(--ink) 6%, var(--surface));
  }

  .picker[data-armed]:hover {
    border-color: color-mix(in srgb, var(--accent-strong) 88%, black);
    background-color: color-mix(in srgb, var(--accent-strong) 88%, black);
  }
}

.picker:active,
.picker-back:active {
  background-color: color-mix(in srgb, var(--ink) 12%, var(--surface));
}

.picker[data-armed]:active {
  border-color: color-mix(in srgb, var(--accent-strong) 78%, black);
  background-color: color-mix(in srgb, var(--accent-strong) 78%, black);
}

/* The ring sits on a band of surface that fills its offset, so it is always
   read against the surface (3.71 light, 5.75 dark), over the page or over the
   blue fill alike. */
.picker:focus-visible,
.picker-back:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 2px var(--surface);
}

/* Under forced colours the system would repaint the fill as a plain button;
   the armed Picker keeps its highlight colours instead, so armed still looks
   different from not. */
@media (forced-colors: active) {
  .picker[data-armed] { forced-color-adjust: none }
}

/* The Stack (spec §8): bottom-right, and only while something is outstanding. */
.stack {
  position: fixed;
  inset-block-end: 12px;
  inset-inline-end: 12px;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  max-width: 320px;
  font: ${FONT};
}

.summary {
  padding-inline: 4px;
  font-size: 11px;
  text-align: end;
  opacity: 0.75;
}

.stack-chip {
  padding: 6px 10px;
  border: 1px solid rgb(127 127 127 / 45%);
  border-radius: 8px;
  background: Canvas;
  color: CanvasText;
  box-shadow: 0 4px 16px rgb(0 0 0 / 14%);
  font-size: 12px;
  cursor: default;
}

.stack-chip[data-state='failed'] { border-color: #b3261e }

.stack-chip[data-state='failed'] .chip-words { color: #b3261e }

.chip-words { font-weight: 500 }

.chip-next {
  margin-block-start: 2px;
  font-size: 11px;
  opacity: 0.8;
}

/* The report-back offer (spec §8, §17): the chip expanded in place. */
.offer {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.offer-question { font-size: 11px }

.offer-answers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.offer-elsewhere,
.offer-leave {
  padding: 3px 8px;
  border: 1px solid rgb(127 127 127 / 45%);
  border-radius: 6px;
  background: none;
  color: inherit;
  font: ${FONT};
  font-size: 11px;
  cursor: pointer;
}

.offer-refusal {
  font-size: 11px;
  color: #b3261e;
}

/* The countdown: a thin line whose length is the time left, set once a second
   from script as --left. Under reduce it shortens in those whole steps; the
   movement block below draws --next instead and eases between them. Scaled
   rather than resized: a 2px line has no border or radius for scaling to
   distort. */
.countdown {
  height: 2px;
  border-radius: 0;
  background: #4f7cff;
  transform-origin: 0 50%;
  transform: scaleX(var(--left, 1));
}

/* The paused report-back clock's footer: the Target is blocked on a prompt. */
.stack-waiting {
  display: flex;
  flex-direction: column;
  padding-inline: 4px;
  font-size: 11px;
  text-align: end;
}

.panel {
  position: fixed;
  inset-block-start: 0;
  inset-inline-start: 0;
  width: 380px;
  max-width: calc(100vw - 16px);
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid rgb(127 127 127 / 45%);
  border-radius: 8px;
  background: Canvas;
  color: CanvasText;
  box-shadow: 0 6px 24px rgb(0 0 0 / 18%);
  font: ${FONT};
}

.note {
  width: 100%;
  min-height: 64px;
  padding: 6px 8px;
  resize: vertical;
  border: 1px solid rgb(127 127 127 / 45%);
  border-radius: 6px;
  background: Field;
  color: FieldText;
  font: ${FONT};
}

.footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.target {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: ${FONT};
  font-size: 12px;
  text-align: start;
  opacity: 0.75;
  cursor: default;
}

.target[data-expandable] { cursor: pointer }

.target-line {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target-action {
  flex: none;
  font-weight: 600;
}

.targets {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid rgb(127 127 127 / 45%);
  border-radius: 6px;
  padding: 4px;
}

.target-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  padding: 4px 6px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: inherit;
  font: ${FONT};
  font-size: 12px;
  text-align: start;
  cursor: pointer;
}

.target-row[data-chosen] { background: rgb(79 124 255 / 14%) }

.row-name { font-weight: 600 }

.row-status,
.row-idle,
.row-waiting { opacity: 0.75 }

.started-badge {
  padding: 0 5px;
  border: 1px solid #4f7cff;
  border-radius: 999px;
  color: #4f7cff;
  font-size: 11px;
}

.empty {
  padding: 6px 2px;
  font-size: 12px;
}

/* The camera toggle, leftmost in the footer (spec §7). Off is quiet, on is the
   accent, and one this dev server cannot honour is visibly unavailable — still
   there, still asking to be clicked for its reason. */
.camera {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid rgb(127 127 127 / 45%);
  border-radius: 6px;
  background: none;
  color: inherit;
  opacity: 0.75;
  cursor: pointer;
}

.camera[data-on] {
  border-color: #4f7cff;
  background: rgb(79 124 255 / 14%);
  color: #4f7cff;
  opacity: 1;
}

.camera[aria-disabled='true'] {
  border-style: dashed;
  opacity: 0.45;
  cursor: help;
}

.camera-off,
.camera-failed {
  font-size: 12px;
  opacity: 0.85;
}

.camera-failed { color: #b3261e }

.cancel {
  flex: none;
  padding: 5px 10px;
  border: 1px solid rgb(127 127 127 / 45%);
  border-radius: 6px;
  background: none;
  color: inherit;
  font: ${FONT};
  cursor: pointer;
}

.send {
  flex: none;
  padding: 5px 10px;
  border: 1px solid #4f7cff;
  border-radius: 6px;
  background: #4f7cff;
  color: #fff;
  font: 500 ${FONT};
  cursor: pointer;
}

.send:disabled {
  opacity: 0.6;
  cursor: default;
}

.status { font-size: 12px }

.status[data-refused] { color: #b3261e }

.status-reason {
  font-size: 12px;
  opacity: 0.85;
}

/* The Note counter: quiet until the cap, and at the cap it is the reason the
   Send button is off, so it stops being quiet (spec §7). */
.counter {
  align-self: flex-end;
  font-size: 11px;
  opacity: 0.6;
}

.counter[data-over] {
  opacity: 1;
  font-weight: 600;
}

/* Excerpts the 32 KiB cap took out: one quiet informational line, deliberately
   not the refusal colour above — the Pick was accepted (spec §7, §13). */
.trimmed {
  font-size: 12px;
  opacity: 0.85;
}

/* ------------------------------------------------------------------------
   Fades, for every developer (spec §9: "under reduce ... panels cross-fade").

   A fade is not movement: nothing travels, nothing changes size, and what
   appears or leaves does so where it already is. So the Overlay's fades ease
   for a developer who asked their system for less motion too — the
   review-animations gate's reading of reduced motion as gentler, not zero.
   Only a fade may ease out here — \`opacity\`, \`color\`, \`background-color\`,
   \`border-color\` and \`outline-color\` — and \`transition: none\` may stop
   one; a seam-1 test reads the built file to hold both.

   The Highlight fades three ways: its opacity when it leaves (its element
   gone, or a live mark let go of), its fill when the shutter opens, and its
   fill and outline colour when it drops to rest and relights. The chip fades
   with it. The outline's width changes too when it rests, and that is a
   change of size, so it is never eased.

   The curve is the strong ease-out: a fade is something leaving or arriving.
   ------------------------------------------------------------------------ */
.highlight {
  transition:
    opacity 120ms cubic-bezier(0.23, 1, 0.32, 1),
    background-color 120ms cubic-bezier(0.23, 1, 0.32, 1),
    outline-color 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.chip { transition: opacity 120ms cubic-bezier(0.23, 1, 0.32, 1) }

/* The Picker's colours: armed and back, hovered and pressed. */
.picker,
.picker-back {
  transition:
    color 120ms cubic-bezier(0.23, 1, 0.32, 1),
    background-color 120ms cubic-bezier(0.23, 1, 0.32, 1),
    border-color 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

/* The box is being placed rather than moved — a first appearance, or the
   element it is already on measured again after a scroll, a resize or a hot
   update. Neither is travel, and neither may animate. */
.highlight[data-placing] { transition: none }

/* The shutter (spec §10). Closing is never eased: no capture may catch the
   fill or the chip halfway out, and an opening that started from a
   half-finished close would not read the same twice. The opening is the fade
   above. A mark already fading out when the shutter closes — the one an
   Alt-click left behind — keeps fading: only its opacity eases, and nothing
   of it travels while the shutter is closed.

   These rules and the placing one outrank the plain selectors in the
   movement block below by specificity, so they hold under no-preference too. */
:host([data-shutter]) .highlight {
  transition: opacity 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

:host([data-shutter]) .chip { transition: none }

/* ------------------------------------------------------------------------
   Movement, and the only place in the Overlay there is any (spec §9).

   Everything that moves lives inside this block, so a developer who has asked
   their system for less motion is not opted out of anything — they were never
   opted in. Nothing outside it may declare an animation, a set of keyframes,
   or a transition of anything but a fade, and a seam-1 test reads the built
   file to say so. A rule here that lists a Highlight's transitions restates
   its fades too, because it replaces the whole list above.

   The Highlight's morph animates \`translate\`, \`width\` and \`height\` on a box
   that is one fixed element outside the host's layout flow. \`scale\` is
   rejected: it distorts the box's own border and its radius while it travels,
   and a morph may not distort its own edges. Animating \`width\` and \`height\`
   knowingly spends a performance rule, and the record of what that buys is in
   \`docs/motion.md\`. It is 120 ms on the strong ease-out since the
   review-animations gate: a box that follows the pointer has to start moving
   at once, and the ease-in-out it had spent most of its time catching up.

   Rules added here by other tickets go inside this block and nowhere else.
   ------------------------------------------------------------------------ */
@media (prefers-reduced-motion: no-preference) {
  .highlight {
    transition:
      translate 120ms cubic-bezier(0.23, 1, 0.32, 1),
      width 120ms cubic-bezier(0.23, 1, 0.32, 1),
      height 120ms cubic-bezier(0.23, 1, 0.32, 1),
      opacity 120ms cubic-bezier(0.23, 1, 0.32, 1),
      background-color 120ms cubic-bezier(0.23, 1, 0.32, 1),
      outline-color 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  /* The Picker's reveal (spec §8): 180 ms, out of the peek and back into it.
     Under reduce it still moves between exactly these two positions — it
     arrives at once, which is the whole difference. */
  .picker-peek { transition: translate 180ms cubic-bezier(0.23, 1, 0.32, 1) }

  /* Armed, the Picker lifts 2 px off the edge, on the reveal's timing. A press
     presses it in, from its bottom edge. Its colours are restated because this
     list replaces the fades above. */
  .picker,
  .picker-back {
    transition:
      translate 180ms cubic-bezier(0.23, 1, 0.32, 1),
      scale 120ms cubic-bezier(0.23, 1, 0.32, 1),
      color 120ms cubic-bezier(0.23, 1, 0.32, 1),
      background-color 120ms cubic-bezier(0.23, 1, 0.32, 1),
      border-color 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  .picker[data-armed] { translate: 0 -2px }

  .picker:active,
  .picker-back:active { scale: 0.97 }

  /* "Pick" widening to "Picking…": the tail eases from zero to its own width.
     \`interpolate-size\` lets a width ease to \`auto\` where the engine has it;
     elsewhere the width snaps, and nothing stands in for it in script. */
  .picker {
    interpolate-size: allow-keywords;
  }

  .picker-tail { transition: width 180ms cubic-bezier(0.23, 1, 0.32, 1) }

  /* The report-back countdown (spec §8, story 47): script sets where the line
     will be one step from now as --next, and it eases linearly across that
     second, so it reads as one steady shortening that empties when the thirty
     seconds do. Under reduce it draws --left, the time actually left, in
     one-second steps — never less than there is. */
  .countdown {
    transform: scaleX(var(--next, 1));
    transition: transform 1000ms linear;
  }
}
`
