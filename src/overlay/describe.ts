// Borrowed: the attribute allowlist a picked element is described by, and the
//   rule that an input of type `password` or `hidden` carries no value
// From: UI-Locator — https://github.com/amir1824/UI-Locator
// Version: vite-plugin-source-locator@1.5.0 (2026-09-22)
// License: MIT — full text in LICENSE-THIRDPARTY
// Changes: three names are off the list. `id`, `class`, `role` and `aria-*` are
//   dropped because the descriptor already carries them and would carry them
//   differently — the descriptor names at most two classes, and an uncut `class`
//   attribute beside it would undo that. `value` is dropped because §13 caps an
//   input's value at 1,000 characters and gives it an Excerpt of its own, so an
//   uncapped copy of it in the attributes would defeat that cap; upstream's
//   redaction moves with it and now guards that Excerpt instead. And the
//   redaction is *stated* rather than silently skipped, because an omission
//   nobody is told about is a silent truncation (spec §21).
//   Not taken: the compact HTML rendering with its escaping, the 80-character
//   clamp and the six-key computed-style summary. This Pointer carries no markup
//   and no styles, and the caps live below with the rest of them.

/**
 * What may be lifted off a picked element, beyond what the descriptor already
 * names and beyond the value that has an Excerpt of its own.
 */
const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'type',
  'name',
  'href',
  'title',
  'placeholder',
  'alt',
  'for',
])

/** The two input types whose value never travels, in any form (spec §13). */
const REDACTED_INPUT_TYPES: ReadonlySet<string> = new Set(['password', 'hidden'])

/**
 * Whether this element's value is withheld, and by which rule. The attribute is
 * read before the property, because a `type` the browser does not recognise
 * falls back to `text` on the property and would read as safe.
 */
function redactsItsValue(element: Element): string | null {
  if (element.tagName !== 'INPUT') return null
  const declared = element.getAttribute('type')
  const type = (declared ?? (element as HTMLInputElement).type).toLowerCase()
  return REDACTED_INPUT_TYPES.has(type) ? type : null
}

/** The allowlisted attributes, in document order. */
function allowedAttributes(element: Element): Array<[string, string]> {
  const kept: Array<[string, string]> = []
  for (const attribute of Array.from(element.attributes)) {
    if (!ALLOWED_ATTRIBUTES.has(attribute.name)) continue
    kept.push([attribute.name, attribute.value])
  }
  return kept
}

// --- end of borrowed code ---

/** Spec §13: every value lifted off the page, capped at this many characters. */
const VALUE_MAX_CHARACTERS = 1000

/** Spec §13: the rendered subtree text, as one line of at most this many. */
const RENDERED_TEXT_MAX_CHARACTERS = 80

/** Spec §13: the descriptor names at most this many classes, and no selector. */
const CLASS_MAX = 2

/**
 * The kinds of Excerpt v0 lifts. The set is closed because the kind is written
 * into the Fence, and a kind the server did not recognise would be a Fence
 * whose shape the page chose (`CONTEXT.md`, spec §13).
 */
export type ExcerptKind =
  | 'rendered-text'
  | 'input-value'
  | 'textarea'
  | 'select'
  | 'contenteditable'
  | 'attributes'

/** One piece of evidence lifted from the page (`CONTEXT.md`: Excerpt). */
export interface Excerpt {
  kind: ExcerptKind
  text: string
  /**
   * How many characters were on the page, when that is more than are carried
   * here. Absent when nothing was trimmed: trimming is annotated, never silent.
   */
  captured?: number
}

/** The element descriptor, as the wire carries it (spec §13). */
export interface Descriptor {
  tag: string
  id?: string
  testId?: string
  role?: string
  aria?: Record<string, string>
  classes?: string[]
}

/** Everything the page can say about the picked element itself. */
export interface ElementDescription {
  descriptor: Descriptor
  excerpts: Excerpt[]
  /**
   * Why something was withheld — one of the redacted input types. The server
   * writes the sentence; the page only says which rule fired, so a Pointer can
   * never be made to carry prose the page chose.
   */
  redactions: string[]
}

/**
 * Cap a lifted value in **code points**, so an emoji costs what it looks like it
 * costs. The server's Note cap counts the same way (ticket 03), and two caps
 * that counted differently would disagree at the boundary.
 */
function cap(text: string, max: number): { text: string; captured?: number } {
  const points = [...text]
  if (points.length <= max) return { text }
  return { text: points.slice(0, max).join(''), captured: points.length }
}

/** One line: a stray newline inside a lifted value must not split the block. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The descriptor and the Excerpts for one picked element (spec §13).
 *
 * Read at Send rather than at pick time, like the geometry: a Pick that was
 * moved, or a field that was typed into while the Note was being written,
 * carries what the element says now.
 */
export function describeElement(element: Element): ElementDescription {
  const excerpts: Excerpt[] = []
  const redactions: string[] = []

  const redacted = redactsItsValue(element)
  if (redacted !== null) redactions.push(redacted)

  const rendered = oneLine(element.textContent ?? '')
  if (rendered) {
    excerpts.push({
      kind: 'rendered-text',
      ...cap(rendered, RENDERED_TEXT_MAX_CHARACTERS),
    })
  }

  const value = redacted === null ? valueExcerpt(element) : null
  if (value) excerpts.push(value)

  const attributes = allowedAttributes(element)
  if (attributes.length > 0) {
    excerpts.push({
      kind: 'attributes',
      text: attributes.map(([name, text]) => `${name} = ${oneLine(text)}`).join('\n'),
    })
  }

  return { descriptor: describe(element), excerpts, redactions }
}

/**
 * The one Excerpt that is the element's *contents* rather than its markup. An
 * empty one is no Excerpt at all: a fence around nothing says less than its
 * absence does.
 */
function valueExcerpt(element: Element): Excerpt | null {
  const kind = valueKind(element)
  if (!kind) return null
  const text = valueText(element, kind)
  return text ? { kind, ...cap(text, VALUE_MAX_CHARACTERS) } : null
}

function valueKind(
  element: Element,
): Exclude<ExcerptKind, 'rendered-text' | 'attributes'> | null {
  if (element.tagName === 'INPUT') return 'input-value'
  if (element.tagName === 'TEXTAREA') return 'textarea'
  if (element.tagName === 'SELECT') return 'select'
  // `isContentEditable` and not the attribute: an element inside an editable
  // region is editable too, and its text is as much the developer's as the
  // region's own.
  if (element instanceof HTMLElement && element.isContentEditable) {
    return 'contenteditable'
  }
  return null
}

function valueText(element: Element, kind: ExcerptKind): string {
  if (kind === 'select') {
    // The chosen option, by the label the developer reads, not by its value.
    return Array.from((element as HTMLSelectElement).selectedOptions)
      .map((option) => option.label || option.text)
      .join(', ')
  }
  if (kind === 'contenteditable') return oneLine(element.textContent ?? '')
  return (element as HTMLInputElement | HTMLTextAreaElement).value
}

/** Tag, `id`, `data-testid`, `role`, `aria-*` and two classes — no more (§13). */
function describe(element: Element): Descriptor {
  const descriptor: Descriptor = { tag: element.tagName.toLowerCase() }

  const id = element.id || undefined
  if (id) descriptor.id = id
  const testId = element.getAttribute('data-testid') || undefined
  if (testId) descriptor.testId = testId
  const role = element.getAttribute('role') || undefined
  if (role) descriptor.role = role

  const aria: Record<string, string> = {}
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name.startsWith('aria-'))
      aria[attribute.name] = oneLine(attribute.value)
  }
  if (Object.keys(aria).length > 0) descriptor.aria = aria

  // At most two, and the first two: a descriptor is an introduction, not a
  // selector, and a selector is the one thing §13 says it must never be.
  const classes = Array.from(element.classList).slice(0, CLASS_MAX)
  if (classes.length > 0) descriptor.classes = classes

  return descriptor
}
