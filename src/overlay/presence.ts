// How a surface leaves the page, and how it changes place (spec §7, §9;
// docs/motion.md). The Panel leaves, and moves, through it; a sent Panel
// shrinks into its slot in the Stack through it, and a submitted one grows out
// of that slot and back into it.
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

/**
 * How long a copy that lands somewhere stays: longer than the 240 ms it takes
 * to get there in `styles.ts`, and the fade that ends it. Keep them in step.
 */
const LANDING_FOR_MS = 320

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
 * surfaces' own container (`surfaces.tsx`), outside everything React draws,
 * so every live surface paints over it.
 *
 * It is what was drawn: where the surface was on its way to somewhere else,
 * the copy starts there, and what was typed into a field is in the copy's
 * field too — a clone's field is not reliably given what was typed. A surface
 * placed inside another one rather than on the viewport is pinned where it was
 * laid out, since its copy is not inside that other one.
 *
 * A copy made `landing` is going somewhere rather than only fading: `landIn`
 * says where, once that is known, and it stays long enough to get there.
 */
export function leaveBehind(
  node: HTMLElement,
  view: Window,
  { landing = false }: { landing?: boolean } = {},
): HTMLElement {
  const style = view.getComputedStyle(node)
  const drawnAt = style.translate
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
  if (style.position !== 'fixed') pinAtLayout(node, copy)
  copy.style.transform = ''
  copy.removeAttribute('data-placing')
  copy.removeAttribute('data-arriving')
  copy.setAttribute('data-leaving', '')
  if (landing) copy.setAttribute('data-landing', '')
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true
  ;(node.closest('[data-part="surfaces"]') ?? node.parentElement ?? node).before(copy)
  view.setTimeout(() => copy.remove(), landing ? LANDING_FOR_MS : LEFT_FOR_MS)
  return copy
}

/**
 * Send a `landing` copy into `into`, a box in the viewport: from its own box
 * to that one, in one change of place and size, which `styles.ts` eases where
 * movement is allowed. Under reduce the stylesheet draws none of it, and the
 * copy only fades where it stood.
 */
export function landIn(copy: HTMLElement, into: DOMRect): void {
  const from = copy.getBoundingClientRect()
  if (from.width === 0 || from.height === 0) return
  copy.style.setProperty('--land', towards(from, into))
}

/**
 * Bring `node` into the page out of `from`, a box in the viewport: drawn at
 * first as if it filled that box, and let go to its own, where movement is
 * allowed. Either way it starts unseen and is let go to be seen, so under
 * reduce it only fades in where it is.
 */
export function growFrom(node: HTMLElement, view: Window, from: DOMRect): void {
  node.setAttribute('data-arriving', '')
  if (movementAllowed(view)) {
    const now = node.getBoundingClientRect()
    if (now.width > 0 && now.height > 0) node.style.transform = towards(now, from)
  }
  node.getBoundingClientRect()
  node.removeAttribute('data-arriving')
  node.style.transform = ''
}

/**
 * What takes a box drawn at `from` to `to`, measured from its top left corner,
 * which is where `styles.ts` puts the origin of anything landing or growing.
 */
function towards(from: DOMRect, to: DOMRect): string {
  const x = to.left - from.left
  const y = to.top - from.top
  return `translate(${x}px, ${y}px) scale(${to.width / from.width}, ${to.height / from.height})`
}

/**
 * Put `copy` on the viewport where `node` is laid out, ignoring whatever it is
 * drawn through: the copy of a surface that was placed inside another one.
 */
function pinAtLayout(node: HTMLElement, copy: HTMLElement): void {
  const parent = node.offsetParent?.getBoundingClientRect()
  copy.style.position = 'fixed'
  copy.style.inset = 'auto'
  copy.style.margin = '0'
  copy.style.boxSizing = 'border-box'
  copy.style.left = `${(parent?.left ?? 0) + node.offsetLeft}px`
  copy.style.top = `${(parent?.top ?? 0) + node.offsetTop}px`
  copy.style.width = `${node.offsetWidth}px`
  copy.style.height = `${node.offsetHeight}px`
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
