import { request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startExampleServer } from '../harness/dev-server.mjs'
import { tempApps } from '../harness/temp-app.mjs'

const SESSIONS = '/__agent/sessions'
const PICK = '/__agent/pick'

/** A non-loopback address of this machine, if it has one to be reached on. */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}

describe('the Guard', () => {
  let server

  beforeAll(async () => {
    server = await startExampleServer({ host: '0.0.0.0' })
  })

  afterAll(async () => {
    await server?.close()
  })

  const post = (path, headers = {}) =>
    fetch(server.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{}',
    })

  it('serves a same-origin GET that carries no Origin at all', async () => {
    const response = await fetch(server.url + SESSIONS)

    // Browsers send no Origin on a same-origin GET. Requiring one here would
    // refuse the Overlay's own reads.
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/application\/json/)
  })

  it('refuses a Pick with no Origin, rather than waving it through', async () => {
    const response = await post(PICK)

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    const body = await response.json()
    expect(body.reason).toMatch(/origin/i)
  })

  it('refuses a Pick whose Origin is not this server', async () => {
    const response = await post(PICK, { origin: 'http://evil.example:5173' })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect((await response.json()).reason).toMatch(/origin/i)
  })

  it('refuses a Pick whose Origin is unparseable', async () => {
    const response = await post(PICK, { origin: 'null' })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect((await response.json()).reason).toMatch(/origin/i)
  })

  it('accepts a Pick from every loopback spelling of its own origin', async () => {
    for (const host of ['127.0.0.1', 'localhost']) {
      const { body } = await rawPost(server.port, PICK, {
        host: `${host}:${server.port}`,
        origin: `http://${host}:${server.port}`,
      })

      expect(JSON.parse(body).reason).not.toMatch(/origin/i)
    }
  })

  it('answers a known path asked with the wrong method', async () => {
    const response = await fetch(server.url + PICK)

    expect(response.status).toBe(405)
    expect((await response.json()).reason).toMatch(/POST/)
  })

  it('lets a Pick from this very origin past the Guard', async () => {
    const response = await post(PICK, { origin: server.url })

    // Ticket 03 builds the ingest; until then the path answers 4xx for a
    // reason of its own, which is not an Origin refusal.
    const body = await response.json()
    expect(body.reason).not.toMatch(/origin/i)
  })

  it('answers an unknown endpoint with a reason', async () => {
    const response = await fetch(server.url + '/__agent/nope')

    expect(response.status).toBe(404)
    expect(typeof (await response.json()).reason).toBe('string')
  })

  it('logs every refusal it makes', async () => {
    await post(PICK, { origin: 'http://evil.example:5173' })

    expect(server.log()).toMatch(/origin/i)
  })
})

/** A POST over raw http, so the test can set `Host` — fetch will not. */
function rawPost(port, path, headers) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port, path: '/__agent' + path.replace('/__agent', ''), method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (body += chunk))
        response.on('end', () => resolve({ status: response.statusCode, body }))
      },
    )
    outgoing.on('error', reject)
    outgoing.end('{}')
  })
}

describe('the Guard against a hostname that merely resolves to loopback', () => {
  // DNS rebinding: a page served from a name the attacker controls, pointed at
  // 127.0.0.1. The connection really is loopback and the Origin really does
  // agree with the Host it sent — which is why Host is not the thing ingress is
  // compared against. Vite's own host check refuses such a Host by default, so
  // this stands the consumer up the way one who widened `allowedHosts` would,
  // to reach the Guard behind it.
  const apps = tempApps()
  afterEach(apps.cleanup)

  const rebound = (port) => ({
    host: `evil.test:${port}`,
    origin: `http://evil.test:${port}`,
  })

  it('refuses the Pick even when Vite itself lets the host through', async () => {
    const { server } = await apps.start({
      app: { git: true, viteConfig: { server: { allowedHosts: ['evil.test'] } } },
    })

    const { status, body } = await rawPost(server.port, PICK, rebound(server.port))

    expect(status).toBe(403)
    expect(JSON.parse(body).reason).toMatch(/origin/i)
    expect(JSON.parse(body).error).toBe('origin-mismatch')
  })

  it('still reads sessions, which carry no Origin and change nothing', async () => {
    const { server } = await apps.start({
      app: { git: true, viteConfig: { server: { allowedHosts: ['evil.test'] } } },
    })

    expect((await fetch(server.url + SESSIONS)).status).toBe(200)
  })
})

describe('the Guard on a non-loopback interface', () => {
  const address = lanAddress()
  let server

  beforeAll(async () => {
    if (address) server = await startExampleServer({ host: '0.0.0.0' })
  })

  afterAll(async () => {
    await server?.close()
  })

  it.skipIf(!address)('refuses a request that did not come from this machine', async () => {
    const response = await fetch(`http://${address}:${server.port}${SESSIONS}`)

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    const body = await response.json()
    expect(body.reason).toMatch(/loopback/i)
  })

  it.skipIf(!address)('still serves the same endpoint on loopback', async () => {
    expect((await fetch(server.url + SESSIONS)).status).toBe(200)
  })
})
