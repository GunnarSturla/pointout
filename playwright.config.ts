import { defineConfig, devices } from '@playwright/test'
import { BROWSER_PORT, nextBedSuites, TEST_BEDS } from './test/harness/hosts.js'
import { BROWSER_LOCK_WAIT_MS } from './test/harness/browser-lock.js'

// The browser suite: the browser, in all three engines, against the same dev server the server suite
// boots — the harness faked at the same four boundaries.
//
// The server is started by `globalSetup` rather than by `webServer`: the module
// that boots it is TypeScript, Playwright compiles its own, and `node` on this
// repo's Node floor cannot run it. The port is bound strictly, so a leftover
// server fails the run loudly instead of being attached to (see serve.ts).
const baseURL = `http://127.0.0.1:${BROWSER_PORT}`

const ENGINES = [
  { name: 'chromium', device: devices['Desktop Chrome'] },
  { name: 'firefox', device: devices['Desktop Firefox'] },
  { name: 'webkit', device: devices['Desktop Safari'] },
]

/**
 * What a whole run may take once it holds the machine's browser-suite lock. A healthy
 * run takes about 5 minutes (docs/agents/testing.md); this bounds a stall, such as one
 * the machine's sleep caused, and leaves a loaded machine plenty of room.
 * Playwright counts `globalSetup` in `globalTimeout`, so the wait for the lock is
 * added on top.
 */
const RUN_BUDGET_MS = 40 * 60 * 1000

export default defineConfig({
  testDir: 'test/browser',
  testMatch: '**/*.spec.ts',
  globalSetup: './test/harness/serve.ts',
  globalTimeout: RUN_BUDGET_MS + BROWSER_LOCK_WAIT_MS,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'list' : [['list']],
  use: { baseURL, trace: 'on-first-retry' },
  // One project per engine and test bed (test/harness/hosts.ts): Vite's runs
  // every spec, and each of Next's two routes runs what `nextBedSuites` names.
  projects: ENGINES.flatMap(({ name, device }) =>
    TEST_BEDS.map((bed) => ({
      name: name + bed.suffix,
      use: { ...device, baseURL: bed.baseURL },
      ...(bed.suffix ? { testMatch: nextBedSuites(name, bed) } : {}),
    })),
  ),
})
