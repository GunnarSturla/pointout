// The Panel (spec §7): the surface a Pick opens, where the Note is written, the
// Target is shown, and the Pick's outcome is read.
//
// Element-anchored through Floating UI with `flip`, `shift` and `autoUpdate`.
// Native CSS anchor positioning is not an option here and never will be: anchor
// names are tree-scoped and cannot cross a shadow boundary by spec (§3).
//
// Ticket 04 builds the first journey through it. The full Target row and the
// in-Panel picker are ticket 10, the character counter and the cap are ticket 07,
// the Stack chip a submitted Pick minimizes into is ticket 12.

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { preselect, readCandidates, sendPick } from './client.js'
import type { Candidate, PickBody } from './client.js'
import { part } from './root.js'

/** Spec §7: "about 380px wide", advisory — and the gap to the element. */
const ELEMENT_GAP = 8
const VIEWPORT_PADDING = 8

/** Spec §7's two labels. A Pick with no Note asks the agent to stand by. */
const STAND_BY = 'Locate & stand by'
const SEND = 'Send'

/** Everything the Panel needs from the Overlay around it. */
export interface PanelDeps {
  document: Document
  shadow: ShadowRoot
  /** The picked element the Panel anchors to. */
  element: Element
  /** The Pointer half of the body, measured at send time. */
  pointer(): Omit<PickBody, 'note' | 'target'>
}

export interface Panel {
  close(): void
}

export function openPanel(deps: PanelDeps): Panel {
  const { document, shadow, element } = deps

  const panel = part(document, 'div', 'panel')
  const note = part(document, 'textarea', 'note')
  note.rows = 3
  note.placeholder = 'What about this element?'

  const footer = part(document, 'div', 'footer')
  const target = part(document, 'span', 'target')
  const primary = part(document, 'button', 'send')
  primary.type = 'button'
  primary.textContent = STAND_BY

  footer.append(target, primary)
  panel.append(note, footer)
  shadow.append(panel)

  let chosen: Candidate | null = null
  let sent = false
  let sending = false

  const relabel = () => {
    primary.textContent = note.value.length > 0 ? SEND : STAND_BY
  }

  const say = (text: string, refused: boolean, extra?: string) => {
    for (const stale of panel.querySelectorAll(
      '[data-part="status"], [data-part="status-reason"]',
    )) {
      stale.remove()
    }
    const status = part(document, 'div', 'status')
    status.textContent = text
    if (refused) status.setAttribute('data-refused', '')
    panel.append(status)
    if (!extra) return
    const line = part(document, 'div', 'status-reason')
    line.textContent = extra
    panel.append(line)
  }

  const send = async () => {
    if (sent || sending) return
    sending = true
    primary.disabled = true

    const body: PickBody = {
      ...deps.pointer(),
      // An empty Note is no Note at all: a Pick without one is meaningful
      // rather than degenerate (`CONTEXT.md`), and the payload says so.
      note: note.value.length > 0 ? note.value : null,
      target: chosen ? { sessionId: chosen.sessionId, pid: chosen.pid } : null,
    }

    const outcome = await sendPick(body)
    sending = false
    if (!outcome.ok) {
      // Fail closed, say so out loud (spec §21): the server's own reason, at the
      // point it happened, with the Note untouched so nothing written is lost.
      primary.disabled = false
      say(outcome.reason, true)
      return
    }

    sent = true
    // A 200 that went nowhere is not silent either: the server says why, and so
    // does the Panel, beside the plain confirmation.
    say('Sent', false, outcome.reason)
  }

  note.addEventListener('input', relabel)
  note.addEventListener('keydown', (event: KeyboardEvent) => {
    // `Shift+Enter` is a newline, which is the textarea's own behaviour: it is
    // left alone rather than re-implemented.
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void send()
  })
  primary.addEventListener('click', () => void send())

  const reanchor = async () => {
    const { x, y } = await computePosition(element, panel, {
      strategy: 'fixed',
      placement: 'bottom-start',
      middleware: [
        offset(ELEMENT_GAP),
        flip({ padding: VIEWPORT_PADDING }),
        shift({ padding: VIEWPORT_PADDING }),
      ],
    })
    panel.style.left = `${x}px`
    panel.style.top = `${y}px`
  }

  const stopFollowing = autoUpdate(element, panel, () => void reanchor())

  // Spec §7: auto-focus on the Panel's own opening, and never again. Nothing
  // below this line calls `focus`.
  note.focus()

  void (async () => {
    const read = await readCandidates()
    if (!panel.isConnected) return
    if (!read.ok) {
      target.textContent = read.reason
      return
    }
    chosen = preselect(read.candidates)
    target.textContent = chosen ? chosen.name : 'No session is running in this folder'
  })()

  return {
    close() {
      stopFollowing()
      panel.remove()
    },
  }
}
