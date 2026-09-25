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

/**
 * Every Overlay control but the Picker, which has rules of its own: Send,
 * Cancel, the camera toggle, the Target row, the Session list rows and the
 * offer's answers. The plan's states table (docs/overlay-design.md) applies to
 * each, so each state's rule is written once, for the whole list.
 */
const CONTROLS = [
  '.cancel',
  '.offer-elsewhere',
  '.offer-leave',
  '.camera',
  '.target',
  '.target-row',
  '.send',
]

/**
 * How a control is named in a hover or a press rule: the Target row takes one
 * only when it has rows to open, and Send only while it is enabled.
 */
const WHEN_ABLE: Record<string, string> = {
  '.target': '.target[data-expandable]',
  '.send': '.send:not(:disabled)',
}

/** The selector list naming each of `these` controls in one state. */
function each(state: string, these: string[] = CONTROLS): string {
  return these.map((control) => `${control}${state}`).join(',\n')
}

/** The same, for a state a control takes only when it is able to. */
function eachAble(state: string, these: string[] = CONTROLS): string {
  return each(
    state,
    these.map((control) => WHEN_ABLE[control] ?? control),
  )
}

/** Every control but Send, which is filled and has its own tints. */
const QUIET = CONTROLS.filter((control) => control !== '.send')

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
  font: var(--type-ui);
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

.offer-refusal {
  font: var(--type-small);
  color: var(--needs);
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

/* The open Panel: the floating card (docs/overlay-design.md), the outermost
   radius, and the shadow of a thing furthest from the page. */
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
  border: 1px solid var(--line);
  border-radius: 10px;
  background-color: var(--surface);
  color: var(--ink);
  box-shadow:
    0 2px 4px rgb(0 0 0 / 10%),
    0 12px 32px -8px rgb(0 0 0 / 28%);
  font: var(--type-ui);
}

/* The Note: three lines to begin with, growing with what is typed to twelve,
   then scrolling. \`field-sizing: content\` is progressive: an engine without
   it keeps the three lines and scrolls, and keeps the resize handle there
   instead. Growing with typing is the field's own size and is never eased.
   The heights are in lines of the Note's own type step, plus its padding and
   border (14 px). */
.note {
  width: 100%;
  min-height: calc(3lh + 14px);
  max-height: calc(12lh + 14px);
  padding: 6px 8px;
  resize: vertical;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background-color: var(--surface-sunken);
  color: var(--ink);
  font: var(--type-note);
}

@supports (field-sizing: content) {
  .note {
    field-sizing: content;
    resize: none;
  }
}

.note::placeholder { color: var(--ink-muted) }

/* The Note is a field, not a button: its ring is drawn over its own edge
   rather than 2 px outside it, because the field runs the Panel's full width
   and a ring outside would sit in the Panel's padding, nearly at its border. */
.note:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
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
  gap: 8px;
  align-items: baseline;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background-color: transparent;
  color: var(--ink-muted);
  font: var(--type-ui);
  text-align: start;
  cursor: default;
}

.target[data-expandable] { cursor: pointer }

/* The Target row reads dot, name (600), status word (muted), age (11 px):
   separate elements, spaced by the row, with no glyph between them. What
   can run long, here and in the Session list, shortens with an ellipsis. */
.target-line,
.target-name,
.row-name,
.row-waiting,
.row-started {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target-name {
  color: var(--ink);
  font-weight: 600;
}

.target-status { flex: none }

/* A session's health (docs/overlay-design.md): an 8 px dot in its status
   colour, always beside the word that says the same thing. Grey is a status
   the Overlay has no word for. Under no-preference Working pulses and Needs
   you rings, in the movement block below; here it holds still. */
.dot {
  position: relative;
  flex: none;
  align-self: center;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: var(--idle);
}

.dot[data-status='ready'] { background-color: var(--ready) }
.dot[data-status='working'] { background-color: var(--working) }
.dot[data-status='needs'] { background-color: var(--needs) }

/* The idle age: short, and in figures that line up down the Session list.
   Its title says it in full. */
.target-age,
.row-age {
  flex: none;
  font: var(--type-small);
  font-variant-numeric: tabular-nums;
  color: var(--ink-muted);
}

.target-action {
  flex: none;
  color: var(--ink);
  font-weight: 600;
}

/* Blocked on a permission prompt, the row is a sentence and an imperative,
   and the two do not fit one line beside Send: the imperative takes the second
   line, under the sentence rather than under the dot, and the sentence wraps
   rather than losing what the session is blocked on. Only this row wraps; the
   others shorten the name instead. */
.target:has(> .target-action) {
  flex-wrap: wrap;
  row-gap: 2px;
}

.target:has(> .target-action) > .target-line {
  flex: 1 1 0;
  white-space: normal;
}

.target:has(> .target-action) > .target-action {
  flex-basis: 100%;
  padding-inline-start: 16px;
}

/* The Session list. Its rows share one grid — dot | name | status | age or
   what it waits for | the chosen mark — through \`subgrid\`, so the words
   line up down the list. The first and last tracks are sized by content, not
   fixed, because a subgrid row's own padding is laid into its edge tracks. */
.targets {
  display: grid;
  grid-template-columns: max-content fit-content(45%) max-content minmax(0, 1fr) max-content;
  gap: 2px 8px;
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px;
  background-color: var(--surface-sunken);
}

.target-row {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  align-items: baseline;
  padding: 4px 8px;
  border: 0;
  border-radius: 4px;
  background-color: transparent;
  color: var(--ink);
  font: var(--type-ui);
  text-align: start;
  cursor: pointer;
}

.target-row[data-chosen] {
  background-color: color-mix(in srgb, var(--accent) 12%, var(--surface));
}

.target-row > .dot { grid-column: 1 }

.row-name {
  grid-column: 2;
  font-weight: 600;
}

.row-status {
  grid-column: 3;
  color: var(--ink-muted);
}

.row-detail {
  grid-column: 4;
  display: flex;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
}

/* What it waits for, and who started this server: facts, in the small step,
   and never chrome such as a pill. */
.row-waiting,
.row-started {
  font: var(--type-small);
  color: var(--ink-muted);
}

.row-chosen {
  grid-column: 5;
  color: var(--accent);
  font-weight: 600;
}

.empty {
  padding: 6px 2px;
  font: var(--type-ui);
}

/* The camera toggle, leftmost in the Panel footer (spec §7). Off is quiet, on
   is the accent, and one this dev server cannot honour is visibly
   unavailable: a dashed edge and a muted icon, still there, still asking to
   be clicked for its reason. */
.camera {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background-color: transparent;
  color: var(--ink-muted);
  cursor: pointer;
}

.camera[data-on] {
  border-color: var(--accent);
  background-color: color-mix(in srgb, var(--accent) 12%, var(--surface));
  color: var(--accent);
}

.camera[aria-disabled='true'] {
  border-style: dashed;
  border-color: var(--line-strong);
  color: var(--ink-muted);
  cursor: help;
}

.camera-off,
.camera-failed {
  font: var(--type-ui);
  color: var(--ink-muted);
}

.camera-failed { color: var(--needs) }

/* The quiet buttons: Cancel beside Send, and the report-back offer's answers. */
.cancel,
.offer-elsewhere,
.offer-leave {
  flex: none;
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background-color: transparent;
  color: var(--ink);
  font: 600 var(--type-ui);
  cursor: pointer;
}

/* The offer's answers sit inside a Stack chip, one step smaller. */
.offer-elsewhere,
.offer-leave {
  padding: 3px 8px;
  font: 600 var(--type-small);
}

/* Send is ink, not blue: blue is kept for the pick (docs/overlay-design.md). */
.send {
  flex: none;
  padding: 5px 12px;
  border: 1px solid var(--ink);
  border-radius: 6px;
  background-color: var(--ink);
  color: var(--surface);
  font: 600 var(--type-ui);
  cursor: pointer;
}

.send:disabled {
  border-color: var(--line);
  background-color: var(--surface-sunken);
  color: var(--ink-muted);
  cursor: default;
}

/* The states every control answers (docs/overlay-design.md): rest, hover,
   press, keyboard focus, in that order, because a press comes after a hover
   and has to win over it. Hover only where there is a pointer that hovers: a
   tap leaves a hover behind. Tints are the ink, or the accent where the
   control is on, mixed into the surface. An unavailable camera still tints:
   unlike a disabled control it is there to be clicked, for its reason. */
@media (hover: hover) and (pointer: fine) {
  ${eachAble(':hover', QUIET)} {
    background-color: color-mix(in srgb, var(--ink) 6%, var(--surface));
  }

  .camera[data-on]:hover,
  .target-row[data-chosen]:hover {
    background-color: color-mix(in srgb, var(--accent) 18%, var(--surface));
  }

  .send:not(:disabled):hover {
    border-color: color-mix(in srgb, var(--ink) 86%, var(--surface));
    background-color: color-mix(in srgb, var(--ink) 86%, var(--surface));
  }
}

${eachAble(':active', QUIET)} {
  background-color: color-mix(in srgb, var(--ink) 12%, var(--surface));
}

.camera[data-on]:active,
.target-row[data-chosen]:active {
  background-color: color-mix(in srgb, var(--accent) 24%, var(--surface));
}

.send:not(:disabled):active {
  border-color: color-mix(in srgb, var(--ink) 76%, var(--surface));
  background-color: color-mix(in srgb, var(--ink) 76%, var(--surface));
}

/* The ring, the same on every control as on the Picker: on a band of surface
   that fills its offset, so it is always read against the surface. */
${each(':focus-visible')} {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 2px var(--surface);
}

.status { font: var(--type-ui) }

.status[data-refused] { color: var(--needs) }

.status-reason {
  font: var(--type-ui);
  color: var(--ink-muted);
}

/* The Note counter: quiet until the cap, and at the cap it is the reason the
   Send button is off, so it stops being quiet (spec §7). */
.counter {
  align-self: flex-end;
  font: var(--type-small);
  font-variant-numeric: tabular-nums;
  color: var(--ink-muted);
}

.counter[data-over] {
  color: var(--ink);
  font-weight: 600;
}

/* Excerpts the 32 KiB cap took out: one quiet informational line, deliberately
   not the refusal colour above — the Pick was accepted (spec §7, §13). */
.trimmed {
  font: var(--type-ui);
  color: var(--ink-muted);
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

/* Every other control's colours: hovered, pressed, on and off, enabled and
   not. The camera's on and off is one of them. */
${each('')} {
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

  /* Every other control presses in too, from its centre (the default origin),
     on the same timing. Its colours are restated because this list replaces
     the fades above. */
  ${each('')} {
    transition:
      scale 120ms cubic-bezier(0.23, 1, 0.32, 1),
      color 120ms cubic-bezier(0.23, 1, 0.32, 1),
      background-color 120ms cubic-bezier(0.23, 1, 0.32, 1),
      border-color 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  ${eachAble(':active')} { scale: 0.97 }

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

  /* A session's health, beside its word in the Target row and the Session
     list. Quiet by default, loud only when it is waiting on the developer:
     Working breathes, gently, and Needs you sends out two rings, one second
     apart. Ready holds still. Under reduce neither moves, and the colour and
     the word still say it. The pulse is a loop rather than an arrival, so it
     eases in and out; a ring is something leaving, on the strong ease-out. */
  .dot[data-status='working'] { animation: dot-working 2000ms ease-in-out infinite }

  .dot[data-status='needs']::before,
  .dot[data-status='needs']::after {
    content: '';
    position: absolute;
    inset: 0;
    border: 1.5px solid var(--needs);
    border-radius: 50%;
    opacity: 0;
    animation: dot-needs 2000ms cubic-bezier(0.23, 1, 0.32, 1) infinite;
  }

  .dot[data-status='needs']::after { animation-delay: 1000ms }

  @keyframes dot-working {
    50% {
      opacity: 0.5;
      scale: 0.8;
    }
  }

  @keyframes dot-needs {
    from {
      opacity: 0.8;
      scale: 1;
    }

    to {
      opacity: 0;
      scale: 2.25;
    }
  }
}
`
