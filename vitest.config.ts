import { defineConfig } from 'vitest/config'

// Seam 1: the dev server's HTTP surface, plus the repo-shape checks that have
// nowhere else to live. This is the default run. Seam 3 has its own config and
// its own command, and is never included here (see docs/agents/testing.md).
export default defineConfig({
  test: {
    name: 'seam1',
    include: ['test/seam1/**/*.test.ts'],
    environment: 'node',
    // Files run side by side, each in a forked process of its own. A file owns
    // `process.env` while it runs, and `advanceClock` moves the clock through
    // it, so a file must never share a process with another: `forks`, pinned,
    // and never `threads`, whose workers share one environment.
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: 4,
    // A hung test or a hung close fails in half a minute rather than three. A
    // test that really needs longer says so beside itself.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
