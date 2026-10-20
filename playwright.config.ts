import { defineConfig, devices } from '@playwright/test'
import { PARAMETERIZED_SUITES, SEAM2_PORT, TEST_BEDS } from './test/harness/hosts.js'
import { SEAM2_LOCK_WAIT_MS } from './test/harness/seam2-lock.js'

// Seam 2: the browser, in all three engines, against the same dev server seam 1
// boots — the harness faked at the same four boundaries.
//
// The server is started by `globalSetup` rather than by `webServer`: the module
// that boots it is TypeScript, Playwright compiles its own, and `node` on this
// repo's Node floor cannot run it. The port is bound strictly, so a leftover
// server fails the run loudly instead of being attached to (see serve.ts).
const baseURL = `http://127.0.0.1:${SEAM2_PORT}`

const ENGINES = [
  { name: 'chromium', device: devices['Desktop Chrome'] },
  { name: 'firefox', device: devices['Desktop Firefox'] },
  { name: 'webkit', device: devices['Desktop Safari'] },
]

/**
 * What a whole run may take once it holds the machine's seam-2 lock. A healthy
 * all-engine run took 12.4 minutes at a load of 10 to 20 once ten suites ran on
 * Next's two test beds as well (Next.js Connector ticket 06), and overran 15 at a
 * load of 36; this bounds a stall, such as one the machine's sleep caused.
 * Playwright counts `globalSetup` in `globalTimeout`, so the wait for the lock is
 * added on top.
 */
const RUN_BUDGET_MS = 40 * 60 * 1000

export default defineConfig({
  testDir: 'test/seam2',
  testMatch: '**/*.spec.ts',
  globalSetup: './test/harness/serve.ts',
  globalTimeout: RUN_BUDGET_MS + SEAM2_LOCK_WAIT_MS,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'list' : [['list']],
  use: { baseURL, trace: 'on-first-retry' },
  // One project per engine and test bed (test/harness/hosts.ts): Vite's runs
  // every spec, and each of Next's two routes runs the suites that hold on
  // every Host.
  projects: ENGINES.flatMap(({ name, device }) =>
    TEST_BEDS.map((bed) => ({
      name: name + bed.suffix,
      use: { ...device, baseURL: bed.baseURL },
      ...(bed.suffix ? { testMatch: PARAMETERIZED_SUITES } : {}),
    })),
  ),
})
