// One signal for "the page moved": a scroll, a resize, or whatever a hot update
// did to the element under a surface. The controller raises it once per event,
// and every surface anchored to an element measures again on it — the Panel and
// each resting Highlight. One emitter rather than one observer set per surface:
// a second would be a second answer to "when does the Overlay re-measure", and
// the page gives one.

export interface Reflow {
  /** Run `listener` on every reflow until the returned function is called. */
  subscribe(listener: () => void): () => void
  emit(): void
}

export function createReflow(): Reflow {
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit() {
      for (const listener of listeners) listener()
    },
  }
}
