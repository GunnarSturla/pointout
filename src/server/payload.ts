import type { ExcerptKind } from '../wire.js'
import type { Parsed } from './parse.js'
import type { Pick } from './pick.js'
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
  keeps(kind: ExcerptKind): boolean
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

/** A Pick small enough to write, and the body that was written for it. */
export interface Fitted {
  /** The Pick as it travelled: the one the ledger keeps and a later drain renders. */
  pick: Pick
  body: string
}

/**
 * Render one Pick small enough to write, trimming its Excerpts by §13's ladder.
 * The Pick handed in is left alone; the one handed back is the one that was cut
 * down, so the entry the ledger keeps is the Pick that travelled, not the one
 * that was picked. A Pick nothing fits is refused with the part named.
 */
export function fitPayload(pick: Pick, options: RenderOptions): Parsed<Fitted> {
  let bare = ''
  for (const rung of LADDER) {
    const fitted: Pick = {
      ...pick,
      pointer: {
        ...pick.pointer,
        excerpts: pick.pointer.excerpts.filter((excerpt) => rung.keeps(excerpt.kind)),
      },
      trimNote: rung.said,
    }
    const body = renderPicks([fitted], options)
    if (bytes(body) <= PAYLOAD_MAX_BYTES)
      return { ok: true, value: { pick: fitted, body } }
    bare = body
  }

  // Every Excerpt is gone and it still does not fit. Nothing else may be
  // shortened, so nothing is: the Pick is refused and the developer keeps what
  // they wrote (spec §7, §13, §21).
  const part = largestPart(pick)
  return {
    ok: false,
    refusal: {
      status: 413,
      body: {
        error: 'payload-too-large',
        reason:
          `refused a Pick that renders to ${bytes(bare)} bytes, over the ` +
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
