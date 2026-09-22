// Seam 2's dev server: the same one seam 1 boots, on a fixed port, held open for
// the browser suite. Playwright's `globalSetup` rather than its `webServer`,
// because Playwright compiles this file's TypeScript and `node` on this repo's
// Node floor does not (see docs/agents/testing.md).
import { startExampleServer } from './dev-server.js'

export const SEAM2_PORT = Number(process.env.SEAM2_PORT ?? 5178)

export default async function serveForSeam2(): Promise<() => Promise<void>> {
  let server
  try {
    server = await startExampleServer({ port: SEAM2_PORT })
  } catch (error) {
    // The port is bound with `strictPort`, so a leftover dev server is a hard
    // failure rather than a silent attach to whatever is already there.
    throw new Error(
      `seam 2 could not bind 127.0.0.1:${SEAM2_PORT}. Something is already on ` +
        'that port — a dev server from an interrupted run, or a second seam-2 ' +
        'run. Close it, or set SEAM2_PORT to another port.',
      { cause: error },
    )
  }

  process.stdout.write(`seam 2 dev server listening on ${server.url}\n`)

  return async function stopServingSeam2() {
    await server.close()
  }
}
