import { defineConfig, devices } from '@playwright/test'

// Seam 2: the browser, in all three engines, against the same dev server seam 1
// boots — the harness faked at the same four boundaries.
const port = Number(process.env.SEAM2_PORT ?? 5178)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: 'test/seam2',
  testMatch: '**/*.spec.js',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'list' : [['list']],
  use: { baseURL, trace: 'on-first-retry' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node test/harness/serve.mjs',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
    env: { SEAM2_PORT: String(port) },
  },
})
