// Fixture: a same-origin iframe with React-rendered content inside it. The
// frame has no `src`, so its document is `about:blank` and inherits this page's
// origin — `contentDocument` is readable and React can portal into it.
//
// Two things have to survive the frame boundary (ticket 08): the point has to go
// *in* — converted out of the top document's coordinates and into the frame's —
// and the element's box has to come back *out*, or the Highlight is drawn where
// the frame begins rather than where the element is.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** What React renders **inside** the frame's document. */
function FrameBody() {
  return (
    <div style={{ font: '0.875rem/1.5 system-ui, sans-serif', padding: '0.5rem' }}>
      <p data-fixture="iframe-paragraph" style={{ margin: 0 }}>
        <span data-fixture="iframe-target">Inside the frame, owned by React.</span>
      </p>
    </div>
  )
}

export function SameOriginIframe() {
  const frame = useRef<HTMLIFrameElement>(null)
  const [body, setBody] = useState<HTMLElement | null>(null)

  useEffect(() => {
    const element = frame.current
    if (!element) return
    // An engine may replace the initial `about:blank` document when the frame
    // loads, which would leave the portal rendering into a detached body.
    const attach = () => setBody(element.contentDocument?.body ?? null)
    attach()
    element.addEventListener('load', attach)
    return () => element.removeEventListener('load', attach)
  }, [])

  return (
    <section className="fixture" data-fixture="same-origin-iframe-section">
      <h2>Same-origin iframe</h2>
      <iframe
        ref={frame}
        className="fixture-frame"
        data-fixture="same-origin-iframe"
        // `allow-same-origin` and nothing else: the frame keeps this page's
        // origin, which is the whole point of the fixture, and runs no script.
        sandbox="allow-same-origin"
        title="A same-origin frame holding React-rendered content"
      />
      {body && createPortal(<FrameBody />, body)}
    </section>
  )
}
