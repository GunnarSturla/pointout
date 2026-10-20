import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ChunkSource } from '../server/frame-resolver.js'

// One source of a Turbopack chunk's map, as a file on this machine. Both of
// the Next.js Connector's resolvers read their chunk's sources this way; each
// says against what moment, and in what words, a changed file is approximate.
// Neither resolver imports the other (ADR-0005).

/**
 * A `file:///` source as a file, and whether it changed after `baseline`, in
 * epoch milliseconds; `reason` is the sentence a changed one is stated with.
 * Turbopack names its own runtime `turbopack:///[turbopack]/…`, which is no
 * file, and a file that is no longer on disk has no location: both are null.
 */
export function chunkSource(
  name: string,
  baseline: number,
  reason: string,
): ChunkSource | null {
  let file: string
  try {
    file = fileURLToPath(name)
  } catch {
    return null
  }
  let modified: number
  try {
    modified = statSync(file).mtimeMs
  } catch {
    return null
  }
  return {
    file,
    dependency: file.includes('/node_modules/'),
    drift: modified > baseline ? { mode: 'no-transform-timestamp', reason } : null,
  }
}
