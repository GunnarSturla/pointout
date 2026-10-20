import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FixtureEnv } from './fixture-env.js'

// A registry entry that already owns the dev server's reply socket path when
// the server starts. The path is `<socketDir>/<serving pid>.sock`. On Vite the
// serving pid is this process, so a test writes the entry before it serves. On
// Next it is the dev worker's, which does not exist until `next dev` forks it:
// so the entry is written from inside the worker, by a module preloaded into it
// through `NODE_OPTIONS`, before the worker reads the config and pointout
// starts. Either way the server meets the same thing: an entry naming its path.
//
// The field names are the harness's, written out as `registry.ts` writes them.

/** What the entry is: a session the registry can read, or a shape it cannot. */
export type SquatterShape = 'session' | 'unrecognised'

const SQUATTER_ENV = 'POINTOUT_TEST_SQUATTER'

const PRELOAD = `import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const spec = process.env.${SQUATTER_ENV}
if (spec && process.env.NEXT_PRIVATE_WORKER === '1') {
  const { registryDir, socketDir, cwd, shape, version } = JSON.parse(spec)
  const pid = process.pid
  const messagingSocketPath = join(socketDir, pid + '.sock')
  const record =
    shape === 'session'
      ? { pid, sessionId: 'session-' + pid, cwd, status: 'idle', name: 'session ' + pid, messagingSocketPath, version }
      : { messagingSocketPath }
  writeFileSync(join(registryDir, pid + '.json'), JSON.stringify(record, null, 2))
}
`

/**
 * The environment that makes Next's worker write, as it starts, an entry of
 * `shape` naming its own reply socket path. Merge it into the server's env.
 */
export function squatInNextWorker(
  fixture: Pick<FixtureEnv, 'dir' | 'registryDir' | 'socketDir'>,
  entry: { cwd: string; shape: SquatterShape; version?: string },
): Record<string, string> {
  const preload = join(fixture.dir, 'squatter-preload.mjs')
  writeFileSync(preload, PRELOAD)
  return {
    NODE_OPTIONS: `--import ${preload}`,
    [SQUATTER_ENV]: JSON.stringify({
      registryDir: fixture.registryDir,
      socketDir: fixture.socketDir,
      ...entry,
    }),
  }
}
