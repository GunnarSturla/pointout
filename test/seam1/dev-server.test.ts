import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ENV_CLAUDE_PID,
  ENV_PATH,
  ENV_REGISTRY_DIR,
  ENV_SOCKET_DIR,
} from '../harness/fixture-env.js'
import { startExampleServer } from '../harness/dev-server.js'
import type { HarnessServer } from '../harness/dev-server.js'

// How Vite serves the Overlay's virtual module. Written out rather than
// imported: no test imports a server module (docs/agents/testing.md).
const OVERLAY_MODULE_URL = '/@id/__x00__virtual:vite-agent-inspect/overlay'

describe('the seam-1 dev server', () => {
  let server!: HarnessServer

  beforeAll(async () => {
    server = await startExampleServer()
  })

  afterAll(async () => {
    await server?.close()
  })

  it('answers on loopback', async () => {
    const response = await fetch(server.url + '/')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
  })

  it('runs with all four harness overrides in place', () => {
    expect(process.env[ENV_REGISTRY_DIR]).toBe(server.fixture.registryDir)
    expect(process.env[ENV_SOCKET_DIR]).toBe(server.fixture.socketDir)
    expect(process.env[ENV_CLAUDE_PID]).toBe(String(process.pid))
    expect(process.env[ENV_PATH]?.split(':')[0]).toBe(server.fixture.binDir)
  })

  it('has a fake screencapture ahead of the real one', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { existsSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')

    const out = join(server.fixture.dir, 'shot.png')
    await promisify(execFile)('screencapture', ['-x', out], { env: process.env })

    expect(existsSync(out)).toBe(true)
    expect(statSync(out).size).toBeGreaterThan(0)
  })

  it('references the Overlay from the transformed index.html', async () => {
    const html = await (await fetch(server.url + '/')).text()
    expect(html).toContain(OVERLAY_MODULE_URL)
    expect(html).toContain('<div id="root">')
  })

  it('serves the Overlay module', async () => {
    const response = await fetch(server.url + OVERLAY_MODULE_URL)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/javascript/)
  })
})
