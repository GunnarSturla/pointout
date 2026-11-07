import type { PointoutOptions } from '../server/index.js'
import { startPointout } from './start.js'

export type { PointoutOptions }

// The Next.js Connector's entry, `@gunnarsturla/pointout/next` (ADR-0005, ADR-0006). A
// consumer wraps their config in `withPointout()`, and the `dev` script stays
// `next dev`.
//
// It acts in exactly one process: Next's worker child, the one that owns the
// listening socket, under `next dev` with Turbopack. `next dev`'s own command
// process never reads the config; `next build` and `next start` read it in
// another phase; and on shutdown Next spawns a detached telemetry flush that
// reads it again, in the development phase but with no `NEXT_PRIVATE_WORKER`.
// Anything started outside the worker would outlive the server in that orphan.
//
// Nothing here imports Next, not even its types: `next`'s declarations make
// `process.env.NODE_ENV` required everywhere they are loaded. A config is
// whatever object the consumer hands over, and comes back with its own type.

/** The phase Next reads the config in under `next dev` (`next/constants`). */
const PHASE_DEVELOPMENT_SERVER = 'phase-development-server'

/** The Overlay's entry for Next, as the consumer's project resolves it. */
const OVERLAY_ENTRY = '@gunnarsturla/pointout/next/overlay'

/** Next's function form of a config, for a config object of type `Config`. */
export type NextConfigFunction<Config extends object = object> = (
  phase: string,
  context: { defaultConfig: Config },
) => Config | Promise<Config>

/**
 * Wrap a Next config, in either form, so that `next dev` serves pointout.
 * Everywhere but Next's dev worker the config comes back as it was given.
 */
export function withPointout<Config extends object>(
  config: Config | NextConfigFunction<Config>,
  options: PointoutOptions = {},
): Config | NextConfigFunction<Config> {
  // Not the worker: `next build`, `next start`, the telemetry flush, or a
  // script that imported the config. The config is handed back untouched.
  if (process.env.NEXT_PRIVATE_WORKER !== '1') return config

  return async (phase, context) => {
    const given = typeof config === 'function' ? await config(phase, context) : config
    if (phase !== PHASE_DEVELOPMENT_SERVER) return given
    startPointout(options)
    // Under `--webpack` pointout serves nothing, so the page gets no Overlay
    // that could not reach it (`start.ts` says so in the log).
    if (!process.env.TURBOPACK) return given
    return withOverlay(given)
  }
}

/**
 * The page's half: the Overlay's entry, run on every page of both routers
 * ahead of hydration (`instrumentationClientInject`, Next 16.3). It is added to
 * whatever the config already injects, never in place of it.
 */
function withOverlay<Config extends object>(config: Config): Config {
  const given = (config as { instrumentationClientInject?: unknown })
    .instrumentationClientInject
  const already = Array.isArray(given) ? (given as unknown[]) : []
  return { ...config, instrumentationClientInject: [...already, OVERLAY_ENTRY] }
}

export default withPointout
