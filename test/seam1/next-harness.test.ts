import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startNextServer } from '../harness/next-server.js'
import { nextAppRoot } from '../harness/paths.js'

// Ticket 03 of the Next.js Connector: the harness's promises about a `next dev`
// it spawned. Next allows one dev server per output folder, and seam 1 runs
// four files side by side, so two servers must never collide; and a server the
// harness closed must leave nothing running and nothing on disk. Read off the
// machine: the process table, the files, and HTTP.

/** The pids in process group `pgid`, from the process table. */
function group(pgid: number): number[] {
  return execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, rowGroup]) => rowGroup === pgid)
    .map(([pid]) => pid as number)
}

/** The pids whose command line names `text`. */
function naming(text: string): number[] {
  return execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(text))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
}

describe('two Next servers at once', () => {
  it('each get a port and an output folder of their own, and both answer', async () => {
    const [first, second] = await Promise.all([startNextServer(), startNextServer()])
    try {
      expect(first.port).not.toBe(second.port)
      expect(first.distDir).not.toBe(second.distDir)
      for (const server of [first, second]) {
        expect((await fetch(server.url + '/')).status).toBe(200)
      }
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  }, 120_000)
})

describe('closing a Next server', () => {
  it('ends its whole process group and leaves nothing behind', async () => {
    const server = await startNextServer()
    // A page request makes Next start its worker and Turbopack's pool.
    expect((await fetch(server.url + '/')).status).toBe(200)
    expect(group(server.pid).length).toBeGreaterThan(1)
    const folder = join(nextAppRoot, server.distDir)

    await server.close()

    expect(group(server.pid)).toEqual([])
    // A detached child, such as Next's telemetry flush, leaves the group but
    // names the output folder on its command line.
    expect(naming(folder)).toEqual([])
    expect(existsSync(folder)).toBe(false)
    await expect(fetch(server.url + '/')).rejects.toThrow('fetch failed')
  }, 120_000)
})
