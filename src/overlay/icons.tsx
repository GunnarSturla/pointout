// Borrowed: icon artwork, the SVG path of each icon below, on a 24-unit grid
// From: Remix Icon — https://github.com/Remix-Design/remixicon
// Version: 4.9.1 (2026-09-25)
// License: Remix Icon License v1.0 — full text in LICENSE-THIRDPARTY
// Changes: none to the artwork. Each is drawn inline in `currentColor`, 16 px
// unless its use asks for smaller.

/** Remix Icon `crosshair-line`, from `icons/Design/crosshair-line.svg`. */
const CROSSHAIR_LINE =
  'M13 19.9381C16.6187 19.4869 19.4869 16.6187 19.9381 13H17V11H19.9381C19.4869 7.38128 16.6187 4.51314 13 4.06189V7H11V4.06189C7.38128 4.51314 4.51314 7.38128 4.06189 11H7V13H4.06189C4.51314 16.6187 7.38128 19.4869 11 19.9381V17H13V19.9381ZM12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 14C10.8954 14 10 13.1046 10 12C10 10.8954 10.8954 10 12 10C13.1046 10 14 10.8954 14 12C14 13.1046 13.1046 14 12 14Z'

/** Remix Icon `camera-line`, from `icons/Media/camera-line.svg`. */
const CAMERA_LINE =
  'M9.82843 5L7.82843 7H4V19H20V7H16.1716L14.1716 5H9.82843ZM9 3H15L17 5H21C21.5523 5 22 5.44772 22 6V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V6C2 5.44772 2.44772 5 3 5H7L9 3ZM12 18C8.96243 18 6.5 15.5376 6.5 12.5C6.5 9.46243 8.96243 7 12 7C15.0376 7 17.5 9.46243 17.5 12.5C17.5 15.5376 15.0376 18 12 18ZM12 16C13.933 16 15.5 14.433 15.5 12.5C15.5 10.567 13.933 9 12 9C10.067 9 8.5 10.567 8.5 12.5C8.5 14.433 10.067 16 12 16Z'

// --- end of borrowed code ---

// The Overlay's icons, all of them Remix Icon artwork: one icon set per file,
// and this file's header credits the set. A later icon from the same set needs
// no new credit, only its path here (docs/agents/provenance.md).

/**
 * An icon is decoration beside words that already say what the control does,
 * so it is hidden from assistive technology and takes its colour from the text.
 */
function Icon({ path, size = 16 }: { path: string; size?: number }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
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

/** A Screen Capture went with this Pick: drawn small, beside a line of words. */
export function CameraIcon() {
  return <Icon path={CAMERA_LINE} size={14} />
}
