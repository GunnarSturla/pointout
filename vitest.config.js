import { defineConfig } from 'vitest/config'

// Seam 1: the dev server's HTTP surface, plus the repo-shape checks that have
// nowhere else to live. This is the default run. Seam 3 has its own config and
// its own command, and is never included here (see docs/agents/testing.md).
export default defineConfig({
  test: {
    name: 'seam1',
    include: ['test/seam1/**/*.test.js'],
    environment: 'node',
    // Servers, builds and child processes; and each file owns `process.env`
    // while it runs, so files do not overlap.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
