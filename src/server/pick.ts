import { randomBytes, randomUUID } from 'node:crypto'
import { EXCERPT_KINDS, NOTE_MAX_CHARACTERS, REDACTION_REASONS } from '../wire.js'
import type {
  CaptureRequest,
  ElementDescriptor,
  Excerpt,
  ExcerptKind,
  Geometry,
  NamedTarget,
  PickBody,
  RedactionReason,
  Target,
  Viewport,
} from '../wire.js'
import { now } from './clock.js'
import { parseOwnerChain } from './owner-chain.js'
import type { OwnerLink } from './owner-chain.js'
import { isFiniteNumber, isRecord, isText, refuse } from './parse.js'
import type { Parsed } from './parse.js'

// Pick ingress: what arrives on the wire from the Overlay, what is refused, and
// the Pick that comes out the other side (spec §11, §13). Nothing here renders
// and nothing here delivers.

/** Spec §13: an introduction, never a selector. */
const DESCRIPTOR_CLASS_MAX = 2

/** The machine-generated half of a Pick (`GLOSSARY.md`). */
export interface Pointer {
  url: string
  viewport: Viewport
  descriptor: ElementDescriptor
  geometry: Geometry
  /**
   * The Owner chain, innermost first, remapped through the module graph at
   * ingest. Empty for an element React never owned.
   */
  ownerChain: OwnerLink[]
  /** How many DOM levels the Overlay walked up to find a fiber (spec §4, §12). */
  walkUp: number
  /**
   * The Excerpts, in the order the Overlay lifted them, less whatever the 32 KiB
   * cap took away before the write — which `trimNote` states (spec §13).
   */
  excerpts: Excerpt[]
  /**
   * Which redaction rules fired in the page. The sentence is written here rather
   * than sent, so a Pointer can never be made to carry prose the page chose.
   */
  redactions: RedactionReason[]
}

/**
 * One selection, as the server holds it from ingest onwards. Never mutated: the
 * payload cap answers a new Pick rather than trimming this one in place.
 */
export interface Pick {
  id: string
  /** 12 hex characters: the Fence nonce and the ack and done credential. */
  nonce: string
  createdAt: number
  pointer: Pointer
  note: string | null
  /**
   * The Target the Pick was resolved to at ingest, named so the sentences about
   * it can say who. Null when nothing could be addressed: the Pick waits for the
   * hook floor.
   */
  target: NamedTarget | null
  /**
   * The Pointer's Screen Capture line — a file path, or the statement that a
   * capture was intended and failed — and null when the Pick carries none.
   */
  captureLine: string | null
  /**
   * The Screen Capture file kept for the agent, which a Withdraw deletes. Null
   * when the Pick keeps none. Set once the capture is taken, after the fit.
   */
  captureFile: string | null
  /**
   * The Target an earlier id of this Pick was written to, when a retarget made
   * it a new Pick. That write happened, and a Withdraw must still say so.
   */
  writtenBefore: string | null
  /**
   * What the 32 KiB cap took out of this Pick's Excerpts, in the words both the
   * payload and the Panel use. Null when the Pick fitted as it was (spec §13).
   */
  trimNote: string | null
}

/** Everything ingest worked out about a checked body before the Pick is made. */
export interface Resolved {
  ownerChain: OwnerLink[]
  target: NamedTarget | null
  captureLine: string | null
}

/** Mint the Pick: the checked body, plus what ingest resolved from it. */
export function mintPick(body: PickBody, resolved: Resolved): Pick {
  return {
    id: randomUUID(),
    nonce: randomBytes(6).toString('hex'),
    createdAt: now(),
    pointer: {
      url: body.url,
      viewport: body.viewport,
      descriptor: body.descriptor,
      geometry: body.geometry,
      ownerChain: resolved.ownerChain,
      walkUp: body.walkUp,
      excerpts: body.excerpts,
      redactions: body.redactions,
    },
    note: body.note,
    target: resolved.target,
    captureLine: resolved.captureLine,
    captureFile: null,
    writtenBefore: null,
    trimNote: null,
  }
}

/**
 * The same Pick, sent again to another Target (spec §17's retarget). A fresh
 * body — new id, new nonce, new age — because the harness refuses a
 * byte-identical one as a duplicate, and because the old id's ack and done URLs
 * must never be able to answer for the new delivery. The Pointer, the Note and
 * the Screen Capture line are what the developer made, and travel unchanged.
 * `writtenBefore` is who already has the old one, if anybody does.
 */
export function reissuePick(
  pick: Pick,
  target: NamedTarget,
  writtenBefore: string | null,
): Pick {
  return {
    ...pick,
    id: randomUUID(),
    nonce: randomBytes(6).toString('hex'),
    createdAt: now(),
    target,
    writtenBefore,
  }
}

/**
 * The ingest check on the body itself (spec §11). Every refusal names the part
 * it refused. What comes out is the body in its normal form: every optional
 * field present, as a value or as null.
 */
export function parsePickBody(text: string): Parsed<PickBody> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return refuse(
      400,
      'malformed-json',
      `refused a Pick whose body is not JSON: ${(error as Error).message}`,
    )
  }
  if (!isRecord(parsed)) {
    return refuse(
      400,
      'malformed-json',
      'refused a Pick whose body is not a JSON object.',
    )
  }

  const note = parsed.note
  if (note !== undefined && note !== null && typeof note !== 'string') {
    return refuse(400, 'note-not-text', 'refused a Pick whose note is not text.')
  }
  // Counted in code points: §11 says characters, and an emoji is one character
  // to the developer who typed it however many UTF-16 units it takes.
  const noteLength = typeof note === 'string' ? [...note].length : 0
  if (noteLength > NOTE_MAX_CHARACTERS) {
    return refuse(
      400,
      'note-too-long',
      `refused a Pick whose note is ${noteLength} characters, over the ` +
        `${NOTE_MAX_CHARACTERS} allowed. It is refused rather than shortened, ` +
        'so nothing the developer wrote is lost.',
    )
  }

  const { url } = parsed
  if (typeof url !== 'string' || url.length === 0) {
    return refuse(
      400,
      'pointer-incomplete',
      'refused a Pick whose pointer names no page url.',
    )
  }
  const viewport = parseSize(parsed.viewport, 'viewport')
  if (!viewport.ok) return viewport
  const geometry = parseGeometry(parsed.geometry)
  if (!geometry.ok) return geometry
  const descriptor = parseDescriptor(parsed.descriptor)
  if (!descriptor.ok) return descriptor
  const excerpts = parseExcerpts(parsed.excerpts)
  if (!excerpts.ok) return excerpts
  const redactions = parseRedactions(parsed.redactions)
  if (!redactions.ok) return redactions
  const owners = parseOwnerChain(parsed)
  if (!owners.ok) return owners
  const target = parseTarget(parsed.target)
  if (!target.ok) return target
  const capture = parseCaptureRequest(parsed.capture)
  if (!capture.ok) return capture

  return {
    ok: true,
    value: {
      url,
      viewport: viewport.value,
      descriptor: descriptor.value,
      geometry: geometry.value,
      ownerChain: owners.value.ownerChain,
      walkUp: owners.value.walkUp,
      excerpts: excerpts.value,
      redactions: redactions.value,
      note: typeof note === 'string' ? note : null,
      target: target.value,
      capture: capture.value,
    },
  }
}

/**
 * The capture half of the body (spec §20). Absent is the ordinary case — most
 * Picks carry no Screen Capture — and one that is malformed is refused rather
 * than dropped, because a Pick that silently lost its capture looks like one
 * that never asked for one.
 */
function parseCaptureRequest(value: unknown): Parsed<CaptureRequest | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) {
    return refuse(
      400,
      'capture-unreadable',
      'refused a Pick whose capture names no id. A capture is one this dev ' +
        'server started, or there is none.',
    )
  }
  if (typeof value.keep !== 'boolean') {
    return refuse(
      400,
      'capture-unreadable',
      'refused a Pick whose capture does not say whether the camera toggle was ' +
        'on: the image is kept or deleted, and this server will not guess which.',
    )
  }
  return { ok: true, value: { id: value.id, keep: value.keep } }
}

function parseSize(value: unknown, part: string): Parsed<Viewport> {
  if (!isRecord(value) || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)) {
    return refuse(
      400,
      'pointer-incomplete',
      `refused a Pick whose ${part} is not a width and a height.`,
    )
  }
  return { ok: true, value: { width: value.width, height: value.height } }
}

function parseGeometry(value: unknown): Parsed<Geometry> {
  const size = parseSize(value, 'geometry')
  if (!size.ok) return size
  const record = value as Record<string, unknown>
  if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y)) {
    return refuse(
      400,
      'pointer-incomplete',
      'refused a Pick whose geometry names no position.',
    )
  }
  return { ok: true, value: { ...size.value, x: record.x, y: record.y } }
}

function parseDescriptor(value: unknown): Parsed<ElementDescriptor> {
  if (!isRecord(value) || typeof value.tag !== 'string' || value.tag.length === 0) {
    return refuse(
      400,
      'pointer-incomplete',
      'refused a Pick whose descriptor names no element tag.',
    )
  }

  // Refused rather than filtered. Dropping the parts of a descriptor that are
  // not text would point the agent at an element described by less than the
  // Overlay sent, and say nothing about it (spec §21).
  const descriptor: ElementDescriptor = { tag: value.tag }
  for (const field of ['id', 'testId', 'role'] as const) {
    const given = value[field]
    if (given === undefined) continue
    if (!isText(given)) {
      return refuse(
        400,
        'pointer-incomplete',
        `refused a Pick whose descriptor has a ${field} that is not text.`,
      )
    }
    descriptor[field] = given
  }
  if (value.aria !== undefined) {
    if (!isRecord(value.aria) || !Object.values(value.aria).every(isText)) {
      return refuse(
        400,
        'pointer-incomplete',
        'refused a Pick whose descriptor has aria attributes that are not text.',
      )
    }
    if (Object.keys(value.aria).length > 0) {
      descriptor.aria = value.aria as Record<string, string>
    }
  }
  if (value.classes !== undefined) {
    if (!Array.isArray(value.classes) || !value.classes.every(isText)) {
      return refuse(
        400,
        'pointer-incomplete',
        'refused a Pick whose descriptor has class names that are not text.',
      )
    }
    // Refused rather than sliced, for the same reason the Note is: a descriptor
    // quietly cut down to two classes is one that describes less than the
    // Overlay sent and says nothing about it (spec §13, §21).
    if (value.classes.length > DESCRIPTOR_CLASS_MAX) {
      return refuse(
        400,
        'pointer-incomplete',
        `refused a Pick whose descriptor carries ${value.classes.length} classes. ` +
          `A descriptor names at most two classes, because it is an introduction ` +
          'and never a selector path.',
      )
    }
    if (value.classes.length > 0) descriptor.classes = value.classes as string[]
  }
  return { ok: true, value: descriptor }
}

/**
 * The Excerpts, as the page lifted them (spec §13). The kind is checked against
 * a closed set because it is written into the Fence; the text is checked for
 * being text, and nothing else — the caps belong where the lifting happened, and
 * the 32 KiB payload cap is what bounds what is written.
 */
function parseExcerpts(value: unknown): Parsed<Excerpt[]> {
  if (value === undefined || value === null) return { ok: true, value: [] }
  if (!Array.isArray(value)) {
    return refuse(
      400,
      'excerpt-unreadable',
      'refused a Pick whose excerpts are not a list.',
    )
  }

  const excerpts: Excerpt[] = []
  for (const given of value) {
    if (!isRecord(given) || typeof given.kind !== 'string') {
      return refuse(
        400,
        'excerpt-unreadable',
        'refused a Pick carrying an excerpt that names no kind.',
      )
    }
    if (!isExcerptKind(given.kind)) {
      return refuse(
        400,
        'excerpt-unreadable',
        `refused a Pick carrying an excerpt of kind "${given.kind}", which this ` +
          `dev server does not lift. The kinds it renders are ` +
          `${EXCERPT_KINDS.join(', ')}.`,
      )
    }
    if (!isText(given.text)) {
      return refuse(
        400,
        'excerpt-unreadable',
        `refused a Pick whose ${given.kind} excerpt is not text.`,
      )
    }
    const captured = given.captured
    if (captured !== undefined && !isFiniteNumber(captured)) {
      return refuse(
        400,
        'excerpt-unreadable',
        `refused a Pick whose ${given.kind} excerpt does not say how much was ` +
          'captured in a number.',
      )
    }
    excerpts.push({
      kind: given.kind,
      text: given.text,
      ...(captured === undefined ? {} : { captured }),
    })
  }
  return { ok: true, value: excerpts }
}

/**
 * Which redaction rules the page reports having applied. A reason this server
 * has no sentence for is refused rather than dropped: a redaction nobody is told
 * about is exactly the silence §21 forbids.
 */
function parseRedactions(value: unknown): Parsed<RedactionReason[]> {
  if (value === undefined || value === null) return { ok: true, value: [] }
  if (!Array.isArray(value)) {
    return refuse(
      400,
      'redaction-unreadable',
      'refused a Pick whose redactions are not a list.',
    )
  }
  const reasons: RedactionReason[] = []
  for (const reason of value) {
    if (!isText(reason) || !isRedactionReason(reason)) {
      return refuse(
        400,
        'redaction-unreadable',
        `refused a Pick naming "${String(reason)}" as a redaction. This dev ` +
          `server states ${REDACTION_REASONS.join(' and ')}, and will not repeat ` +
          'a reason it has no words for.',
      )
    }
    reasons.push(reason)
  }
  return { ok: true, value: reasons }
}

function parseTarget(value: unknown): Parsed<Target | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (
    !isRecord(value) ||
    typeof value.sessionId !== 'string' ||
    !isFiniteNumber(value.pid)
  ) {
    return refuse(
      400,
      'target-unreadable',
      'refused a Pick whose target names no sessionId and pid. A Pick is addressed ' +
        'to exactly one session, or to none.',
    )
  }
  return { ok: true, value: { sessionId: value.sessionId, pid: value.pid } }
}

function isExcerptKind(value: string): value is ExcerptKind {
  return (EXCERPT_KINDS as readonly string[]).includes(value)
}

function isRedactionReason(value: string): value is RedactionReason {
  return (REDACTION_REASONS as readonly string[]).includes(value)
}
