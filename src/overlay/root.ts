// The one open shadow root the whole Overlay lives in, on a fixed, full-inset
// host (spec §3). Style isolation is a property of the Overlay, not of its
// parts, which is why there is exactly one of these.
//
// Every node in the Overlay is built with `createElement` and `textContent`, and
// none is ever built from a markup string: a consumer with
// `require-trusted-types-for 'script'` would throw on that, and it costs nothing
// to never write it. A seam-1 test reads the emitted file for the property, so
// the prose here does not name the API either.

import { HOST_STYLE, OVERLAY_STYLESHEET } from './styles.js'

/**
 * The host's tag. Its own name, so that a Pick which somehow reached it would
 * say so in the Pointer rather than looking like one of the app's divs — and so
 * a reader of the consumer's DOM knows at a glance what it is.
 */
export const HOST_TAG = 'vite-agent-inspect'

export interface OverlayRoot {
  host: HTMLElement
  shadow: ShadowRoot
}

export function mountOverlayRoot(document: Document): OverlayRoot {
  const host = document.createElement(HOST_TAG)
  host.setAttribute('data-part', 'host')
  host.style.cssText = HOST_STYLE

  const shadow = host.attachShadow({ mode: 'open' })
  const sheet = document.createElement('style')
  sheet.textContent = OVERLAY_STYLESHEET
  shadow.append(sheet)

  // On the document element rather than in the body: the body is the app's, and
  // a framework that replaces it should not take the Overlay with it.
  document.documentElement.append(host)
  return { host, shadow }
}

/** Every element the Overlay draws carries the name a test reads it by. */
export function part<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  name: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = name
  element.setAttribute('data-part', name)
  return element
}
