import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startExampleServer } from '../harness/dev-server.js'
import { sharedFixturesRoot } from '../harness/paths.js'
import { tempApps } from '../harness/temp-app.js'

// Ticket 25. The plugin contributes `server.fs.allow` so the Overlay can be
// served from inside its own package, and Vite treats any contribution as a
// replacement for its workspace-root default. A consumer whose app is not
// inside this package then gets 403 Restricted for their own source.
//
// The example app cannot show this: it lives inside the package root, so it
// stays allowed however the list is computed. A temp app is outside it, which
// is the only place the bug is visible — and asking for a temp app's own
// source is the request no test made until this one.

function writeModule(appDir: string) {
  mkdirSync(join(appDir, 'src'), { recursive: true })
  writeFileSync(join(appDir, 'src', 'consumer-module.js'), MODULE_SOURCE)
}

const apps = tempApps()
afterEach(apps.cleanup)

const MODULE_PATH = '/src/consumer-module.js'
const MODULE_SOURCE = 'export const servedFromTheConsumersOwnRoot = true\n'

describe("a consumer's own source, from outside the package root", () => {
  it('is served', async () => {
    const app = apps.create({ git: true })
    writeModule(app.appDir)
    const server = await apps.serve(app)

    const response = await fetch(server.url + MODULE_PATH)

    // Before the fix this was 403, with Vite's own "Restricted" body.
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('servedFromTheConsumersOwnRoot')
  })

  it('is still served when the consumer sets no fs.allow at all', async () => {
    const app = apps.create({ git: true, viteConfig: { server: {} } })
    writeModule(app.appDir)
    const server = await apps.serve(app)

    expect((await fetch(server.url + MODULE_PATH)).status).toBe(200)
  })

  it('keeps exactly what a consumer who narrowed fs.allow asked for', async () => {
    // Someone who narrows the list deliberately keeps their narrowing: the
    // package root is added so the Overlay loads, the workspace root is not.
    const app = apps.create({ git: true })
    writeModule(app.appDir)
    app.writeConfig(null, { server: { fs: { allow: [join(app.appDir, 'nothing')] } } })
    const server = await apps.serve(app)

    expect((await fetch(server.url + MODULE_PATH)).status).toBe(403)
  })
})

describe("the example app's shared fixtures, outside its root", () => {
  // Next.js Connector 03 moved them to `examples/shared/`, beside both example
  // apps, so an Owner chain names the same file on either Host. The Vite app's
  // config lets the folder in, and Vite serves it under `/@fs/`.
  it('are served under /@fs/', async () => {
    const server = await startExampleServer()
    try {
      const url =
        server.url + '/@fs' + join(sharedFixturesRoot, 'fixtures', 'OwnerChainDepth.tsx')
      const response = await fetch(url)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('ChainLeaf')
    } finally {
      await server.close()
    }
  })
})
