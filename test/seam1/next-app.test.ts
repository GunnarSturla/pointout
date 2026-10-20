import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startNextServer } from '../harness/next-server.js'
import type { NextHarnessServer } from '../harness/next-server.js'
import { nextAppRoot, repoRoot } from '../harness/paths.js'

// Ticket 03 of the Next.js Connector. `examples/next-app` is the second test
// bed, built from the fixtures `examples/react-app` renders, and the harness
// starts it as a `next dev` of its own. Here it runs with its config exported
// bare, without `withPointout()`, so everything here is Next's own behaviour,
// read over HTTP and off its log. next-connector.test.ts has it with pointout.

let server!: NextHarnessServer

beforeAll(async () => {
  server = await startNextServer({ pointout: false })
}, 120_000)

afterAll(async () => {
  await server?.close()
})

describe('the Next.js test bed, with no pointout', () => {
  it('is a Next.js 16.4 dev server under Turbopack', () => {
    expect(server.log()).toMatch(/Next\.js 16\.4\.\d+ \(Turbopack\)/)
  })

  it('serves the App Router route, with the shared fixtures and its own', async () => {
    const response = await fetch(server.url + '/')
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('data-fixture="owner-chain-depth"')
    expect(html).toContain('data-fixture="nested-owners"')
    expect(html).toContain('data-fixture="server-owner"')
    expect(html).toContain('data-fixture="client-leaf"')
    expect(html).toMatch(/<iframe[^>]*data-fixture="framed-route"[^>]*src="\/framed"/)
  }, 60_000)

  it('serves the Pages Router route, with the shared fixtures', async () => {
    const response = await fetch(server.url + '/pages-router')
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('data-fixture="owner-chain-depth"')
    expect(html).toContain('data-fixture="nested-owners"')
  }, 60_000)

  it('serves the route its same-origin frame loads', async () => {
    const response = await fetch(server.url + '/framed')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('data-fixture="framed-page"')
  }, 60_000)

  it('answers nothing under /__agent, since pointout is not in this one', async () => {
    expect((await fetch(server.url + '/__agent/status')).status).toBe(404)
  }, 60_000)
})

describe('the captured frames in test/fixtures/next-frames/', () => {
  // Tickets 07 and 08 test their resolvers against these, through seam 1, by
  // putting this server's origin and output folder back into the placeholders.
  // That works only while Turbopack still names and fills its chunks as it did
  // when they were captured; if this fails, run `npm run capture:next-frames`.
  //
  // They were captured with pointout in the app, and the Overlay it injects is
  // in the client chunks, which changes their names (ticket 06). So they are
  // checked against a server with pointout, as the resolvers' tests use them.
  let server!: NextHarnessServer

  beforeAll(async () => {
    server = await startNextServer()
  }, 120_000)

  afterAll(async () => {
    await server?.close()
  })
  const folder = join(repoRoot, 'test', 'fixtures', 'next-frames')
  const text = readdirSync(folder)
    .map((file) => readFileSync(join(folder, file), 'utf8'))
    .join('\n')
  const clientChunks = [
    ...new Set(text.match(/\{origin\}\/_next\/static\/chunks\/[^:)\s]+\.js/g)),
  ]
  const serverChunks = [
    ...new Set(
      text.match(/about:\/\/React\/Server\/file:\/\/\{distDir\}\/[^?:)\s]+\.js/g),
    ),
  ]

  it('hold client frames on both routers and Server Component frames', () => {
    expect(text).toContain('"router": "app"')
    expect(text).toContain('"router": "pages"')
    expect(clientChunks.length).toBeGreaterThan(1)
    expect(serverChunks.length).toBeGreaterThan(0)
  })

  it('name client chunks this server serves, and the map each one names', async () => {
    // A page is what makes Turbopack build its chunks.
    for (const route of ['/', '/pages-router'])
      await (await fetch(server.url + route)).text()
    const failed: string[] = []
    let mapped = 0
    for (const chunk of clientChunks) {
      const url = chunk.replace('{origin}', server.url)
      const response = await fetch(url)
      if (response.status !== 200) failed.push(`${response.status} ${url}`)
      // Measured: not every chunk names a map. Turbopack's own runtime chunk
      // for the Pages Router, `turbopack-…pages__app_….js`, names none, and its
      // `.map` is a 404.
      const named = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(await response.text())?.[1]
      if (!named) continue
      mapped += 1
      const map = new URL(named, url).href
      const mapStatus = (await fetch(map)).status
      if (mapStatus !== 200) failed.push(`${mapStatus} ${map}`)
    }
    expect(failed).toEqual([])
    expect(mapped).toBeGreaterThan(1)
  }, 60_000)

  it('name server chunks this server wrote, each with its map beside it', () => {
    const paths = serverChunks.map((chunk) =>
      decodeURIComponent(
        chunk.replace(
          'about://React/Server/file://{distDir}',
          join(nextAppRoot, server.distDir),
        ),
      ),
    )
    const missing = paths
      .flatMap((path) => [path, path + '.map'])
      .filter((path) => !existsSync(path))
    expect(missing).toEqual([])
  })
})
