// Fixture: a web component with an **open** shadow root, holding content React
// rendered into it. `elementsFromPoint` on the document retargets everything in
// a shadow tree to its host, so a pick inside this card lands on
// `<fixture-shadow-card>` unless the hit test pierces the root (ticket 08).
//
// The custom element is written with `createElement` rather than as a JSX tag:
// React 19 renders custom elements happily, but the JSX namespace has no entry
// for a tag this file invents, and adding one would be a type declaration in the
// test bed for the sake of one fixture.

import { createElement, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const TAG = 'fixture-shadow-card'

// Vite re-executes this module on a hot update; defining the tag twice throws.
// A server render (examples/next-app) has no `customElements` and no
// `HTMLElement`, so it defines nothing, and the browser upgrades the tag it
// rendered when this module runs there, before hydration.
if (typeof customElements !== 'undefined' && !customElements.get(TAG)) {
  customElements.define(
    TAG,
    class ShadowCardElement extends HTMLElement {
      constructor() {
        super()
        // In the constructor rather than on connect: the root is then there the
        // moment React has a ref, and the portal needs no second render to find
        // it.
        this.attachShadow({ mode: 'open' })
      }
    },
  )
}

/** What React renders **inside** the shadow root. */
function ShadowCardBody() {
  return (
    <div style={{ font: 'inherit', padding: '0.75rem' }}>
      <p data-fixture="shadow-paragraph" style={{ margin: 0 }}>
        <span data-fixture="shadow-target">Inside the shadow root, owned by React.</span>
      </p>
    </div>
  )
}

export function ShadowRootCard() {
  const host = useRef<HTMLElement>(null)
  const [root, setRoot] = useState<ShadowRoot | null>(null)

  useEffect(() => {
    setRoot(host.current?.shadowRoot ?? null)
  }, [])

  return (
    <section className="fixture" data-fixture="shadow-root-section">
      <h2>Shadow-root web component</h2>
      {createElement(TAG, {
        ref: host,
        className: 'shadow-card',
        'data-fixture': 'shadow-host',
      })}
      {root && createPortal(<ShadowCardBody />, root)}
    </section>
  )
}
