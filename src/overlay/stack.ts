// The Stack (spec §8, §17): where submitted Picks rest while their fate is
// unsettled. Bottom-right, one chip per submitted Pick, no cap — and gone
// entirely the moment nothing is outstanding, which is the whole of what
// separates it from the Picker (`CONTEXT.md`).
//
// Each chip says only what is known about *its own* Pick. The states come from
// `/__agent/status`, which carries Pick-specific evidence; the Target's live
// status never reaches this module, so §17's rule — session-level evidence
// colours the Target row and never moves a chip — holds by construction.
//
// A chip owns the resting Highlight of its Pick as well as its words: the two
// are one thing to the developer, and hovering the chip is what re-lights the
// box. The resting treatment is this file's; the Highlight's lifecycle and its
// motion are ticket 09's.

import { viewportBox } from './deep-element.js'
import { readStatus } from './client.js'
import { part } from './root.js'
import { watchTick } from './tick.js'
import {
  NEXT_PROMPT,
  NOT_DELIVERED,
  SEND_AGAIN,
  SENT,
  doneReportedBy,
  noneAcknowledgedYet,
  workingOn,
} from './words.js'

/**
 * Spec §8: a `done` chip dismisses itself on a plain timer of about eight
 * seconds. Plain is the point — no condition, no hover to keep it alive.
 */
const DISMISS_DONE_MS = 8000

/** The states the Stack has words for. Anything else is left as it arrived. */
const QUEUED_UNADDRESSED = 'queued-unaddressed'
const STATE_SENT = 'sent'
const STATE_WORKING = 'working'
const STATE_DONE = 'done'
const STATE_FAILED = 'failed'

/** The chip reads **Sent** in both of these; only the sub-line tells them apart. */
const UNACKNOWLEDGED: readonly string[] = [STATE_SENT, QUEUED_UNADDRESSED]

/** What the Overlay hands the Stack when a Pick is accepted. */
export interface Submitted {
  pickId: string
  /** The element the Pick was made on: its resting Highlight goes here. */
  element: Element
  /** The Target's name as the Panel knew it, for as long as it stays known. */
  targetName: string | null
}

export interface StackDeps {
  document: Document
  /** The page's own window: the tick and the dismissal timer run on it. */
  view: Window
  shadow: ShadowRoot
  /** A chip appeared or left. The Picker may not tuck while any chip exists. */
  changed(): void
  /** This Pick is over: whatever else the Overlay still shows of it goes too. */
  dismissed(pickId: string): void
}

export interface Stack {
  /** One chip, and one resting Highlight, for a Pick that has just been sent. */
  add(pick: Submitted): void
  /** How many Picks are outstanding. Zero means there is no Stack at all. */
  size(): number
  /** Re-measure every resting Highlight after a scroll, resize or hot update. */
  remeasure(): void
}

interface Entry extends Submitted {
  chip: HTMLElement
  words: HTMLElement
  box: HTMLElement
  state: string
  /** Set once, when `done` first arrives: a second poll must not restart it. */
  dismissing: boolean
}

export function createStack(deps: StackDeps): Stack {
  const { document, view, shadow } = deps

  const stack = part(document, 'div', 'stack')
  const summary = part(document, 'div', 'summary')

  const entries = new Map<string, Entry>()
  let stopTicking: (() => void) | null = null

  /**
   * A resting box is placed and re-measured, and it never travels: it belongs to
   * one element for as long as the Pick is outstanding. `data-placing` is how
   * ticket 09's Highlight says exactly that, and it stays on for good here.
   */
  const place = (entry: Entry) => {
    // The element a Pick was made on can leave the page while the Pick is still
    // in flight (spec §5). A detached element measures 0×0 at the page's corner,
    // so the box goes rather than marking nothing, and the Pick carries on.
    entry.box.hidden = !entry.element.isConnected
    if (entry.box.hidden) return

    const rect = viewportBox(entry.element)
    entry.box.style.translate = `${rect.left}px ${rect.top}px`
    entry.box.style.width = `${rect.width}px`
    entry.box.style.height = `${rect.height}px`
  }

  /** The words for one Pick, from Pick-specific evidence and nothing else. */
  const say = (entry: Entry, state: string, reason: string | null, name: string) => {
    entry.state = state
    entry.chip.setAttribute('data-state', state)
    entry.words.textContent =
      state === STATE_WORKING
        ? workingOn(name)
        : state === STATE_DONE
          ? doneReportedBy(name)
          : state === STATE_FAILED
            ? (reason ?? NOT_DELIVERED)
            : SENT

    // The sub-line is the next action, or the route a Pick nobody is addressed
    // to will actually take. Both are facts about this Pick; neither is a guess.
    const next =
      state === STATE_FAILED
        ? SEND_AGAIN
        : state === QUEUED_UNADDRESSED
          ? NEXT_PROMPT
          : null

    entry.chip.querySelector('[data-part="chip-next"]')?.remove()
    if (!next) return
    const line = part(document, 'div', 'chip-next')
    line.textContent = next
    entry.chip.append(line)
  }

  const renderSummary = () => {
    // One Pick says everything about itself on its own chip; the summary exists
    // for the case story 49 names, which is several Picks in flight.
    const unacknowledged = [...entries.values()].filter((entry) =>
      UNACKNOWLEDGED.includes(entry.state),
    ).length
    if (entries.size < 2 || unacknowledged === 0) {
      summary.remove()
      return
    }
    summary.textContent = noneAcknowledgedYet(unacknowledged)
    stack.prepend(summary)
  }

  const remove = (entry: Entry) => {
    entries.delete(entry.pickId)
    entry.chip.remove()
    entry.box.remove()
    if (entries.size === 0) {
      stack.remove()
      stopTicking?.()
      stopTicking = null
    }
    renderSummary()
    deps.changed()
    deps.dismissed(entry.pickId)
  }

  const poll = async () => {
    const read = await readStatus()
    // A poll that could not be answered changes nothing: a chip may only move on
    // evidence, and a failed read is the absence of evidence (spec §17, §21).
    if (!read.ok) return

    for (const status of read.picks) {
      const entry = entries.get(status.pickId)
      if (!entry) continue
      const name = status.target?.name ?? entry.targetName ?? ''
      say(entry, status.state, status.reason, name)
      if (status.state !== STATE_DONE || entry.dismissing) continue
      entry.dismissing = true
      view.setTimeout(() => remove(entry), DISMISS_DONE_MS)
    }
    renderSummary()
  }

  return {
    add(pick) {
      if (entries.has(pick.pickId)) return

      const box = part(document, 'div', 'highlight')
      // The resting treatment (spec §5): thin outline, no fill, no chip, and
      // desaturated. The chip's own hover is what lifts it again. There is no
      // chip element here at all, so "no chip" is a fact about the box rather
      // than a rule that could be overridden.
      box.setAttribute('data-resting', '')
      box.setAttribute('data-placing', '')
      shadow.append(box)

      const chip = part(document, 'div', 'stack-chip')
      chip.setAttribute('data-pick', pick.pickId)
      const words = part(document, 'div', 'chip-words')
      chip.append(words)

      chip.addEventListener('pointerenter', () => box.removeAttribute('data-resting'))
      chip.addEventListener('pointerleave', () => box.setAttribute('data-resting', ''))

      const entry: Entry = {
        ...pick,
        chip,
        words,
        box,
        state: STATE_SENT,
        dismissing: false,
      }
      entries.set(pick.pickId, entry)
      place(entry)
      // Sent is what is known the moment the server accepted it; the first poll
      // is what tells an addressed Pick from one the hook floor will carry.
      say(entry, STATE_SENT, null, pick.targetName ?? '')

      if (!stack.isConnected) shadow.append(stack)
      stack.append(chip)
      renderSummary()
      stopTicking ??= watchTick(view, () => void poll())
      deps.changed()
    },

    size: () => entries.size,

    remeasure() {
      for (const entry of entries.values()) place(entry)
    },
  }
}
