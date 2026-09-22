import type { Parsed, Pick } from './pick.js'
import { renderPicks } from './render.js'
import type { RenderOptions } from './render.js'

// The 32 KiB cap on a rendered Pick (spec §13), enforced before the write and
// nowhere else — a cap checked after the bytes have left is a cap that has
// already failed.
//
// The rule it implements has two halves. **Excerpts are all that may be
// trimmed**, rendered text before attribute values, and every trim is said in
// the payload and in the Panel. **The Pointer and the Note are never trimmed**:
// a Pick that does not fit once every Excerpt is gone is refused at Send, with
// the part that does not fit named, so the developer can shorten it rather than
// wonder what arrived.

/** Spec §13, in bytes, because bytes are what is written. */
const PAYLOAD_MAX_BYTES = 32 * 1024

/**
 * One rung of the trim ladder: which Excerpts survive it, and what the payload
 * and the Panel are told about the ones that did not. The order is §13's — the
 * rendered text first, then the attribute values, then everything.
 */
interface Rung {
  keeps(kind: string): boolean
  said: string | null
}

const said = (what: string) =>
  `The 32 KiB payload cap was reached, so ${what} did not travel. The pointer ` +
  'and the note are never trimmed.'

const LADDER: Rung[] = [
  { keeps: () => true, said: null },
  {
    keeps: (kind) => kind !== 'rendered-text',
    said: said("this element's rendered text"),
  },
  {
    keeps: (kind) => kind !== 'rendered-text' && kind !== 'attributes',
    said: said("this element's rendered text and its attribute values"),
  },
  { keeps: () => false, said: said('every excerpt this pick carried') },
]

/**
 * Render one Pick small enough to write, trimming its Excerpts by §13's ladder
 * and **mutating the Pick** to match: the entry the queue keeps, and the body a
 * later drain renders from it, are the one that was cut down, not the one that
 * was picked. A Pick nothing fits is refused with the part named.
 */
export function fitPayload(pick: Pick, options: RenderOptions): Parsed<string> {
  const whole = pick.pointer.excerpts

  for (const rung of LADDER) {
    pick.pointer.excerpts = whole.filter((excerpt) => rung.keeps(excerpt.kind))
    pick.trimNote = rung.said
    const body = renderPicks([pick], options)
    if (Buffer.byteLength(body, 'utf8') <= PAYLOAD_MAX_BYTES) {
      return { ok: true, value: body }
    }
  }

  // Every Excerpt is gone and it still does not fit. Nothing else may be
  // shortened, so nothing is: the Pick is refused and the developer keeps what
  // they wrote (spec §7, §13, §21).
  const body = renderPicks([pick], options)
  const size = bytes(body)
  const part = largestPart(pick)
  return {
    ok: false,
    refusal: {
      status: 413,
      body: {
        error: 'payload-too-large',
        reason:
          `refused a Pick that renders to ${size} bytes, over the ` +
          `${PAYLOAD_MAX_BYTES} a write may carry. Every excerpt was trimmed away ` +
          `and it still does not fit; the pointer and the note are never trimmed. ` +
          `The part that does not fit is ${part}. Nothing was sent, and the note ` +
          'is untouched.',
      },
    },
  }
}

/**
 * Which part of an un-trimmable Pick is the one to shorten. Named in the
 * refusal, because a 4xx that says only *too large* leaves the developer with
 * nothing to do about it (spec §7).
 */
function largestPart(pick: Pick): string {
  const { url, ownerChain, descriptor } = pick.pointer
  const parts: Array<[string, number]> = [
    ['the page url', bytes(url)],
    ['the note', bytes(pick.note ?? '')],
    [
      'the owner chain',
      ownerChain.reduce(
        (total, link) => total + bytes(link.name ?? '') + bytes(link.location ?? ''),
        0,
      ),
    ],
    ['the element descriptor', bytes(JSON.stringify(descriptor))],
  ]
  const [name = 'the pointer', size = 0] = parts.reduce((largest, part) =>
    part[1] > largest[1] ? part : largest,
  )
  return `${name}, at ${size} bytes`
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}
