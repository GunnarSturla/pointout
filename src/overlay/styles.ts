// The Overlay's whole stylesheet, as one string set with `textContent` on a
// `<style>` inside the shadow root (spec §3).
//
// Zero motion: not one moving declaration is written here. Ticket 09 opts in
// under `prefers-reduced-motion: no-preference`, and a seam-1 test reads the
// built Overlay to prove the opt-in has not happened yet.

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

.highlight {
  position: fixed;
  pointer-events: none;
  outline: 1.5px solid #4f7cff;
  background: rgb(79 124 255 / 10%);
}

.highlight[hidden] { display: none }

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

.picker {
  position: fixed;
  inset-block-end: 12px;
  inset-inline-start: 50%;
  margin-inline-start: -32px;
  width: 64px;
  pointer-events: auto;
  padding: 4px 0;
  border: 1px solid rgb(127 127 127 / 45%);
  border-radius: 999px;
  background: Canvas;
  color: CanvasText;
  font: 500 11px/1.4 ui-sans-serif, system-ui, sans-serif;
  text-align: center;
  cursor: pointer;
}

.picker[data-armed] {
  border-color: #4f7cff;
  color: #4f7cff;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  opacity: 0.75;
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
`
