import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startExampleServer } from '../harness/dev-server.js'
import type { HarnessServer } from '../harness/dev-server.js'

// Ticket 03 of the Next.js Connector. `examples/next-app` is the second test
// bed, built from the fixtures `examples/react-app` renders, and the harness
// starts it as a `next dev` of its own. pointout is not in it yet (ticket 04),
// so everything here is Next's own behaviour, read over HTTP and off its log.

let server!: HarnessServer

beforeAll(async () => {
  server = await startExampleServer({ on: 'next' })
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

  it('answers nothing under /__agent, since pointout is not in it', async () => {
    expect((await fetch(server.url + '/__agent/status')).status).toBe(404)
  }, 60_000)
})
