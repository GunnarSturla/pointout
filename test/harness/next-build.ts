import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { groupMembers } from './next-server.js'
import { nextAppRoot } from './paths.js'

// `next build` of `examples/next-app`, with its config wrapped in
// `withPointout()` as a consumer's is, into an output folder of its own. Like
// every harness module it imports Next (by resolving its bin), never `src/`.
//
// It runs as a process group of its own, as `next dev` does in next-server.ts,
// and `cleanup()` ends only that group.

const require = createRequire(import.meta.url)
const NEXT_BIN = require.resolve('next/dist/bin/next')

export interface NextBuild {
  /** What `next build` exited with. */
  code: number | null
  /** Everything it printed. */
  log: string
  /** The output folder, absolute. */
  distPath: string
  /** Delete the output folder and the tsconfig the build was handed. */
  cleanup(): void
}

let built = 0

export async function buildNextApp({
  deadlineMs,
}: {
  deadlineMs: number
}): Promise<NextBuild> {
  const name = `build-${process.pid}-${++built}`
  const distDir = `.next/${name}`
  const distPath = join(nextAppRoot, distDir)
  // The same reason as a dev server's (next-server.ts): Next rewrites the
  // tsconfig it is handed, and the committed one is never edited by a run.
  const tsconfigDir = join(nextAppRoot, '.harness', name)
  mkdirSync(tsconfigDir, { recursive: true })
  writeFileSync(
    join(tsconfigDir, 'tsconfig.json'),
    JSON.stringify({ extends: '../../tsconfig.json' }, null, 2) + '\n',
  )

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value
  // Vitest sets `test`; a build sets its own.
  delete env.NODE_ENV
  Object.assign(env, {
    POINTOUT_EXAMPLE_DIST_DIR: distDir,
    POINTOUT_EXAMPLE_TSCONFIG: `.harness/${name}/tsconfig.json`,
    NEXT_TELEMETRY_DISABLED: '1',
  })

  const child = spawn(process.execPath, [NEXT_BIN, 'build'], {
    cwd: nextAppRoot,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pid = child.pid
  let log = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (log += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (log += chunk))

  const endGroup = () => {
    if (pid === undefined) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  const cleanup = () => {
    endGroup()
    rmSync(distPath, { recursive: true, force: true })
    rmSync(tsconfigDir, { recursive: true, force: true })
  }

  let timer: NodeJS.Timeout | undefined
  const code = await new Promise<number | null>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`next build did not finish within ${deadlineMs / 1000} s:\n${log}`),
      )
    }, deadlineMs)
    child.once('exit', (exitCode) => resolve(exitCode))
    child.once('error', reject)
  }).catch((error: unknown) => {
    cleanup()
    throw error
  })
  clearTimeout(timer)

  // The build's own workers are in its group; none outlives it.
  if (pid !== undefined && groupMembers(pid).length > 0) endGroup()

  return { code, log, distPath, cleanup }
}
