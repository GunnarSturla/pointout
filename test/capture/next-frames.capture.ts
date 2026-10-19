import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { startExampleServer } from '../harness/dev-server.js'
import type { NextHarnessServer } from '../harness/next-server.js'
import { nextAppRoot, repoRoot } from '../harness/paths.js'

// The recorder for `test/fixtures/next-frames/<engine>.json` (ticket 03 of the
// Next.js Connector). Run it with `npm run capture:next-frames` and commit what
// it writes; it is not part of `npm test`.
//
// For each picked element it walks the Owner chain React keeps, from the
// element's fiber up through `_debugOwner`, and records each link's name and
// the raw stack React captured where that link was created: `_debugStack` on a
// fiber, `debugStack` on the record a Server Component leaves. Those stacks hold
// real Turbopack frames: client chunks on both routers, and the
// `about://React/Server/…` frames of a server chunk.
//
// Two parts of every frame belong to the run that captured it, and are written
// as placeholders so a later test can put its own server's back:
//
// - `{origin}` — the dev server's origin, whose port Next chose;
// - `{distDir}` — the absolute path of that server's output folder, which the
//   harness names per server and deletes on close.
//
// The chunk names and positions are Turbopack's, and change when a fixture or
// Next itself does; capture again then.

interface Link {
  /** A fiber's component or tag name, or a Server Component's name. */
  name: string
  /** `fiber` for a client fiber, `server` for a Server Component's record. */
  kind: 'fiber' | 'server'
  /** The raw stack React captured where this link was created, or null. */
  stack: string | null
}

interface Capture {
  route: string
  router: 'app' | 'pages'
  /** The `data-fixture` selector the walk started from. */
  element: string
  chain: Link[]
}

/** What each walk starts from, on which route. */
const PICKS: { route: string; router: Capture['router']; element: string }[] = [
  { route: '/', router: 'app', element: '[data-fixture="chain-leaf"]' },
  { route: '/', router: 'app', element: '[data-fixture="passed-down-badge"]' },
  {
    route: '/',
    router: 'app',
    element: '[data-fixture="server-owner"] [data-fixture="client-leaf"]',
  },
  { route: '/pages-router', router: 'pages', element: '[data-fixture="chain-leaf"]' },
  {
    route: '/pages-router',
    router: 'pages',
    element: '[data-fixture="passed-down-badge"]',
  },
]

let server!: NextHarnessServer

test.beforeAll(async () => {
  server = await startExampleServer({ on: 'next' })
})

test.afterAll(async () => {
  await server?.close()
})

test('capture the owner stacks of the Next.js test bed', async ({ page }, info) => {
  const captures: Capture[] = []
  for (const pick of PICKS) {
    await page.goto(server.url + pick.route)
    // Hydrated: the decoy's control answers only once React owns the page.
    await page.locator('[data-fixture="full-viewport-decoy-restore"]').waitFor()
    captures.push({ ...pick, chain: await ownerChain(page, pick.element) })
  }

  const distDir = join(nextAppRoot, server.distDir)
  const text = JSON.stringify(
    {
      engine: info.project.name,
      next: /Next\.js (\S+)/.exec(server.log())?.[1] ?? null,
      captures,
    },
    null,
    2,
  )
    .replaceAll(server.url, '{origin}')
    .replaceAll(distDir, '{distDir}')
    .replaceAll(encodeURI(distDir), '{distDir}')

  const out = join(repoRoot, 'test', 'fixtures', 'next-frames')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `${info.project.name}.json`), text + '\n')
})

/** The Owner chain React keeps for the element `selector` matches. */
async function ownerChain(page: Page, selector: string): Promise<Link[]> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      // React's own field names, which this repo reads and does not choose.
      type Owner = {
        name?: string
        env?: string
        owner?: Owner | null
        debugStack?: { stack?: string } | null
        type?: unknown
        tag?: number
        _debugOwner?: Owner | null
        _debugStack?: { stack?: string } | null
      }
      const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'))
      if (!key) throw new Error('the element carries no React fiber')
      let at = (element as unknown as Record<string, Owner>)[key] ?? null

      const links: Link[] = []
      while (at) {
        const isFiber = typeof at.tag === 'number'
        if (isFiber) {
          const type = at.type as { name?: string; displayName?: string } | string | null
          const name =
            typeof type === 'string'
              ? type
              : (type?.displayName ?? type?.name ?? '(anonymous)')
          links.push({ name, kind: 'fiber', stack: at._debugStack?.stack ?? null })
          at = at._debugOwner ?? null
        } else {
          links.push({
            name: at.name ?? '(anonymous)',
            kind: 'server',
            stack: at.debugStack?.stack ?? null,
          })
          at = at.owner ?? null
        }
      }
      return links
    })
}
