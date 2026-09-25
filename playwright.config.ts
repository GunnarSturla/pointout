import { defineConfig, devices } from '@playwright/test'
import { SEAM2_LOCK_WAIT_MS } from './test/harness/seam2-lock.js'

// Seam 2: the browser, in all three engines, against the same dev server seam 1
// boots — the harness faked at the same four boundaries.
//
// The server is started by `globalSetup` rather than by `webServer`: the module
// that boots it is TypeScript, Playwright compiles its own, and `node` on this
// repo's Node floor cannot run it. The port is bound strictly, so a leftover
// server fails the run loudly instead of being attached to (see serve.ts).
const port = Number(process.env.SEAM2_PORT ?? 5178)
const baseURL = `http://127.0.0.1:${port}`

/**
 * What a whole run may take once it holds the machine's seam-2 lock. A healthy
 * all-engine run takes a few minutes; this bounds a stall, such as one the
 * machine's sleep caused. Playwright counts `globalSetup` in `globalTimeout`,
 * so the wait for the lock is added on top.
 */
const RUN_BUDGET_MS = 15 * 60 * 1000

export default defineConfig({
  testDir: 'test/seam2',
  testMatch: '**/*.spec.ts',
  globalSetup: './test/harness/serve.ts',
  globalTimeout: RUN_BUDGET_MS + SEAM2_LOCK_WAIT_MS,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'list' : [['list']],
  use: { baseURL, trace: 'on-first-retry' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
