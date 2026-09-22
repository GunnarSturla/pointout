import { defineConfig, devices } from '@playwright/test'

// Seam 2: the browser, in all three engines, against the same dev server seam 1
// boots — the harness faked at the same four boundaries.
//
// The server is started by `globalSetup` rather than by `webServer`: the module
// that boots it is TypeScript, Playwright compiles its own, and `node` on this
// repo's Node floor cannot run it. The port is bound strictly, so a leftover
// server fails the run loudly instead of being attached to (see serve.ts).
const port = Number(process.env.SEAM2_PORT ?? 5178)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: 'test/seam2',
  testMatch: '**/*.spec.ts',
  globalSetup: './test/harness/serve.ts',
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
