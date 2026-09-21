// Fixture: an SVG icon. A pick inside an SVG lands on an `SVGElement`, whose
// `className` is an `SVGAnimatedString` rather than a string, and whose subtree
// has no `innerText` — enough to break a descriptor written for HTML only.

function TagIcon() {
  return (
    <svg
      className="icon"
      data-fixture="svg-icon"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M3 3h8l10 10-8 8L3 11V3Z" data-fixture="svg-icon-path" />
      <circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function SvgIcon() {
  return (
    <section className="fixture" data-fixture="svg-icon-section">
      <h2>SVG icon</h2>
      <p className="icon-row">
        <TagIcon />
        <span>An icon, and the path inside it, are both pickable.</span>
      </p>
    </section>
  )
}
