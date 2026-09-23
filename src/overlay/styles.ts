// The Overlay's whole stylesheet, as one string set with `textContent` on a
// `<style>` inside the shadow root (spec §3).
//
// It is also the only file in the Overlay that may declare motion, and it may
// declare it in only one place: the single opt-in block at the bottom, which
// nothing outside `prefers-reduced-motion: no-preference` may leave. A seam-1
// test reads the built Overlay and holds both halves of that rule — see
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

/* The element this was on has left the page (spec §5). The box fades where it
   stood — it never flies off, and the Pick made of it still sends. */
.highlight[data-gone] { opacity: 0 }

/* The shutter (spec §10): closed for the frame a Screen Capture is taken in.
   Everything the Overlay draws on the page leaves it at once — the Highlight
   and its chip, the resting Highlights, the Stack and the Picker — and the
   Panel stays, because its entrance is never gated on a capture. Closing is
   always instant, so no capture ever catches the Overlay halfway out; only
   the opening is eased, and only inside the opt-in block below. */
:host([data-shutter]) .highlight,
:host([data-shutter]) .stack,
:host([data-shutter]) .picker-peek {
  visibility: hidden;
  opacity: 0;
}

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
   off and the box is the live treatment again. */
.highlight[data-resting] {
  outline-width: 1px;
  outline-color: rgb(127 127 127 / 75%);
  background: none;
}

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

/* Out, and staying out: hovered, focused, or holding something unresolved. */
.picker-peek[data-out],
.picker-peek:hover,
.picker-peek:focus-within {
  translate: 0 0;
}

.picker,
.picker-back {
  pointer-events: auto;
  padding: 10px 12px;
  border: 1px solid rgb(127 127 127 / 45%);
  border-block-end: 0;
  border-radius: 999px 999px 0 0;
  background: Canvas;
  color: CanvasText;
  font: 500 11px/1.4 ui-sans-serif, system-ui, sans-serif;
  text-align: center;
  cursor: pointer;
}

.picker { width: 72px }

.picker[data-armed] {
  border-color: #4f7cff;
  color: #4f7cff;
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
   opt-in block below eases between them. Scaled rather than resized: a 2px
   line has no border or radius for scaling to distort. */
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
   Motion, and the only place in the Overlay there is any (spec §9).

   Everything that moves lives inside this block, so a developer who has asked
   their system for less motion is not opted out of anything — they were never
   opted in. Nothing outside it may declare a transition, an animation or a set
   of keyframes, and a seam-1 test reads the built file to say so.

   The Highlight's morph animates \`translate\`, \`width\` and \`height\` on a box
   that is one fixed element outside the host's layout flow. \`scale\` is
   rejected: it distorts the box's own border and its radius while it travels,
   and a morph may not distort its own edges. Animating \`width\` and \`height\`
   knowingly spends a performance rule, and the record of what that buys is in
   \`docs/motion.md\`.

   Rules added here by other tickets go inside this block and nowhere else.
   ------------------------------------------------------------------------ */
@media (prefers-reduced-motion: no-preference) {
  .highlight {
    transition:
      translate 170ms cubic-bezier(0.77, 0, 0.175, 1),
      width 170ms cubic-bezier(0.77, 0, 0.175, 1),
      height 170ms cubic-bezier(0.77, 0, 0.175, 1),
      opacity 120ms linear;
  }

  /* The box is being placed rather than moved — a first appearance, or the
     element it is already on measured again after a scroll, a resize or a hot
     update. Neither is travel, and neither may animate. */
  .highlight[data-placing] { transition: none }

  /* The Picker's reveal (spec §8): 220 ms, out of the peek and back into it.
     Under reduce it still moves between exactly these two positions — it
     arrives at once, which is the whole difference. */
  .picker-peek {
    transition:
      translate 220ms cubic-bezier(0.23, 1, 0.32, 1),
      opacity 120ms linear;
  }

  /* The shutter opening (spec §10): what closed at once comes back over the
     same 120 ms the Highlight fades by when its element leaves. The Highlight
     already eases its opacity above and the Picker beside its reveal; the
     Stack has nothing else that moves. Under reduce it is all there again at
     once, which is the whole difference. */
  .stack { transition: opacity 120ms linear }

  /* Closing is never eased: no capture may catch the Overlay halfway out, and
     an opening that started from a half-finished close would not read the
     same twice. */
  :host([data-shutter]) .highlight,
  :host([data-shutter]) .stack,
  :host([data-shutter]) .picker-peek { transition: none }

  /* The report-back countdown (spec §8, story 47): script sets the line one
     step ahead each second, and it eases linearly across that second, so it
     reads as one steady shortening that empties when the thirty seconds do.
     Under reduce it shortens in one-second steps, which is the whole
     difference. */
  .countdown { transition: transform 1000ms linear }
}
`
