import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NextHarnessServer } from './next-server.js'
import { repoRoot } from './paths.js'

// The owner stacks `npm run capture:next-frames` recorded on the Next.js test
// bed (`test/fixtures/next-frames/<engine>.json`), put back on a running
// server: its origin where the capture wrote `{origin}`, its output folder
// where it wrote `{distDir}`. The server suite has no browser, so these are how a test
// sends a frame a real engine printed against a real Turbopack chunk.

/** The engines a capture was made in; V8, Gecko and JavaScriptCore grammar. */
export type CapturedEngine = 'chromium' | 'firefox' | 'webkit'

interface CapturedLink {
  name: string
  kind: 'fiber' | 'server'
  stack: string | null
}

interface Capture {
  route: string
  router: 'app' | 'pages'
  element: string
  chain: CapturedLink[]
}

function capturesOf(engine: CapturedEngine): Capture[] {
  const file = join(repoRoot, 'test', 'fixtures', 'next-frames', `${engine}.json`)
  return (JSON.parse(readFileSync(file, 'utf8')) as { captures: Capture[] }).captures
}

/** One captured link's raw stack, on `server`. */
export function capturedStack(
  server: NextHarnessServer,
  engine: CapturedEngine,
  pick: { route: string; element: string; link: string },
): string {
  const capture = capturesOf(engine).find(
    (each) => each.route === pick.route && each.element === pick.element,
  )
  const link = capture?.chain.find((each) => each.name === pick.link)
  if (!link?.stack) {
    throw new Error(
      `no captured ${engine} stack for ${pick.link} under ${pick.element} on ` +
        `${pick.route}; run npm run capture:next-frames`,
    )
  }
  return onServer(server, link.stack)
}

/** A captured text with this server's origin and output folder put back. */
function onServer(server: NextHarnessServer, text: string): string {
  const distDir = join(server.appRoot, server.distDir)
  return text.replaceAll('{origin}', server.url).replaceAll('{distDir}', distDir)
}

/**
 * Load what a browser would have loaded before it printed these frames: both
 * routes, which makes Turbopack write their chunks, and every client chunk the
 * captures name, which is the request a page makes for it.
 */
export async function loadCapturedChunks(server: NextHarnessServer): Promise<void> {
  for (const route of ['/', '/pages-router']) {
    const page = await fetch(server.url + route)
    if (page.status !== 200) throw new Error(`GET ${route} answered ${page.status}`)
    await page.text()
  }

  const chunks = new Set<string>()
  for (const engine of ['chromium', 'firefox', 'webkit'] as const) {
    for (const capture of capturesOf(engine)) {
      for (const link of capture.chain) {
        for (const found of (link.stack ?? '').matchAll(
          /\{origin\}(\/_next\/static\/chunks\/[^\s:)]+)/g,
        )) {
          if (found[1]) chunks.add(found[1])
        }
      }
    }
  }
  for (const chunk of chunks) {
    const response = await fetch(server.url + chunk)
    if (response.status !== 200) {
      throw new Error(
        `GET ${chunk} answered ${response.status}; run npm run capture:next-frames`,
      )
    }
    await response.arrayBuffer()
  }
}
