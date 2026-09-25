// Borrowed: icon artwork, the SVG path of each icon below, on a 24-unit grid
// From: Remix Icon — https://github.com/Remix-Design/remixicon
// Version: 4.9.1 (2026-09-25)
// License: Remix Icon License v1.0 — full text in LICENSE-THIRDPARTY
// Changes: none to the artwork. Each is drawn inline, 16 px, in `currentColor`.

/** Remix Icon `crosshair-line`, from `icons/Design/crosshair-line.svg`. */
const CROSSHAIR_LINE =
  'M13 19.9381C16.6187 19.4869 19.4869 16.6187 19.9381 13H17V11H19.9381C19.4869 7.38128 16.6187 4.51314 13 4.06189V7H11V4.06189C7.38128 4.51314 4.51314 7.38128 4.06189 11H7V13H4.06189C4.51314 16.6187 7.38128 19.4869 11 19.9381V17H13V19.9381ZM12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 14C10.8954 14 10 13.1046 10 12C10 10.8954 10.8954 10 12 10C13.1046 10 14 10.8954 14 12C14 13.1046 13.1046 14 12 14Z'

// --- end of borrowed code ---

// The Overlay's icons, all of them Remix Icon artwork: one icon set per file,
// and this file's header credits the set. A later icon from the same set needs
// no new credit, only its path here (docs/agents/provenance.md).

/**
 * An icon is decoration beside words that already say what the control does,
 * so it is hidden from assistive technology and takes its colour from the text.
 */
function Icon({ path }: { path: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  )
}

/** The Picker's mark: what it arms is pointing at something. */
export function CrosshairIcon() {
  return <Icon path={CROSSHAIR_LINE} />
}
