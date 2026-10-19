import { defineConfig, devices } from '@playwright/test'

// Not a seam: the recorder for `test/fixtures/next-frames/`. It starts the
// Next.js test bed itself, reads the owner stacks React keeps on real pages in
// each engine, and writes them out, so tickets 07 and 08 can test their
// resolvers through seam 1 without a browser. `npm run capture:next-frames`
// runs it; commit what it writes. Nothing in `npm test` runs it.
export default defineConfig({
  testDir: 'test/capture',
  testMatch: '**/*.capture.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
