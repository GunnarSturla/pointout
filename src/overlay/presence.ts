// How a surface leaves the page, and how it changes place (spec §7, §9;
// docs/motion.md). The Panel is the first to use it; a sent Panel shrinking
// into the Stack is meant to be the next.
//
// Script only says *what* happens here — a copy is left behind, an offset is
// committed and let go — and `styles.ts` says how each of those is drawn, in
// the one opt-in block for anything that moves and just above it for a fade.
// The one thing script has to decide for itself is which of two different
// things a change of place is, and a script call carries no media query of its
// own, so it asks `prefers-reduced-motion` here.

/** The one query everything that moves is opted into (`styles.ts`). */
const MOVEMENT_ALLOWED = '(prefers-reduced-motion: no-preference)'

/**
 * How long a copy left behind stays in the page. Longer than the 120 ms its
 * fade takes in `styles.ts`; keep the two in step, as `highlight.ts` does.
 */
const LEFT_FOR_MS = 200

/** Whether the developer's system lets things move, rather than only fade. */
function movementAllowed(view: Window): boolean {
  return view.matchMedia(MOVEMENT_ALLOWED).matches
}

/**
 * Leave a still copy of `node` where it stands, marked `data-leaving`, and take
 * the copy out once `styles.ts` has faded it. The surface itself can then go
 * at once: nothing can type into it, press it or read it as the surface while
 * it is on its way out, because what is on its way out is not it.
 *
 * So the copy is inert, hidden from assistive technology, and carries no part
 * name, on itself or on anything inside it. It goes just ahead of the
 * container the surface is in (the surfaces' own, in `surfaces.tsx`), so
 * every live surface paints over it.
 *
 * It is what was drawn: where the surface was on its way to somewhere else,
 * the copy starts there, and what was typed into a field is in the copy's
 * field too — a clone's field is not reliably given what was typed.
 */
export function leaveBehind(node: HTMLElement, view: Window): void {
  const drawnAt = view.getComputedStyle(node).translate
  const copy = node.cloneNode(true) as HTMLElement
  for (const named of [copy, ...copy.querySelectorAll('[data-part]')]) {
    named.removeAttribute('data-part')
  }
  const fields = node.querySelectorAll('textarea, input')
  copy
    .querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input')
    .forEach((field, at) => {
      const typed = fields[at] as HTMLTextAreaElement | HTMLInputElement | undefined
      if (typed) field.value = typed.value
    })
  if (drawnAt !== 'none') copy.style.translate = drawnAt
  copy.removeAttribute('data-placing')
  copy.removeAttribute('data-arriving')
  copy.setAttribute('data-leaving', '')
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true
  ;(node.parentElement ?? node).before(copy)
  view.setTimeout(() => copy.remove(), LEFT_FOR_MS)
}

/**
 * Put `node` somewhere else with `place`, from where it is drawn now.
 *
 * Where movement is allowed it goes there: it is placed at once, drawn back
 * where it was by a `translate` committed with `data-placing` on, and let go,
 * which `styles.ts` eases. A placement made while it is on its way — its
 * element scrolled, say — moves where it is going, not the offset, so it still
 * arrives on its element. Under reduce nothing goes anywhere: a copy fades out
 * where it was, and the surface fades in where it is now.
 */
export function relocate(node: HTMLElement, view: Window, place: () => void): void {
  if (!movementAllowed(view)) {
    leaveBehind(node, view)
    place()
    commitWith(node, 'data-arriving')
    return
  }
  const was = node.getBoundingClientRect()
  node.setAttribute('data-placing', '')
  node.style.translate = ''
  place()
  const now = node.getBoundingClientRect()
  node.style.translate = `${was.left - now.left}px ${was.top - now.top}px`
  node.getBoundingClientRect()
  node.removeAttribute('data-placing')
  node.style.translate = ''
}

/**
 * Draw `node` once with `attribute` on, and take it off again: what the
 * attribute says is where it starts from.
 */
function commitWith(node: HTMLElement, attribute: string): void {
  node.setAttribute(attribute, '')
  node.getBoundingClientRect()
  node.removeAttribute(attribute)
}
