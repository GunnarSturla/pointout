// The Overlay's one tick (spec §14): about a second and a half, running only
// while something is watching — a Panel open, the Target rows expanded, or (when
// tickets 11 and 12 join this module) a Pick still outstanding. An idle page, a
// collapsed Overlay and an empty Stack read nothing at all.
//
// One timer, not one per watcher: a second interval would be a second answer to
// "how often does this page talk to the dev server", and the spec gives one.

/** Spec §14: "about one to two seconds". */
const TICK_MS = 1500

interface Ticking {
  handle: number
  watchers: Set<() => void>
}

const ticking = new WeakMap<Window, Ticking>()

/**
 * Run `watcher` on every tick until the returned function is called. The timer
 * starts with the first watcher and stops with the last, so nothing is polled
 * while nothing is being watched.
 */
export function watchTick(view: Window, watcher: () => void): () => void {
  let running = ticking.get(view)
  if (!running) {
    const watchers = new Set<() => void>()
    const handle = view.setInterval(() => {
      for (const each of watchers) each()
    }, TICK_MS)
    running = { handle, watchers }
    ticking.set(view, running)
  }

  const started = running
  started.watchers.add(watcher)

  let stopped = false
  return function stopWatching() {
    if (stopped) return
    stopped = true
    started.watchers.delete(watcher)
    if (started.watchers.size > 0) return
    view.clearInterval(started.handle)
    ticking.delete(view)
  }
}
