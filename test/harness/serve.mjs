// Playwright's web server: the same seam-1 dev server, on a fixed port, held
// open for the browser suite. Started by playwright.config.js.
import { startExampleServer } from './dev-server.mjs'

const port = Number(process.env.SEAM2_PORT ?? 5178)
const { url, close } = await startExampleServer({ port })

process.stdout.write(`seam 2 dev server listening on ${url}\n`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    close().finally(() => process.exit(0))
  })
}
