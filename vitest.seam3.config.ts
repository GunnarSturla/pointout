import { defineConfig } from 'vitest/config'

// Seam 3: contract canaries against a real Claude Code harness. Its own command
// (`npm run test:seam3`), never part of the default run: it spawns a real
// session on the developer's account and touches the real registry.
export default defineConfig({
  test: {
    name: 'seam3',
    include: ['test/seam3/**/*.test.ts'],
    globalSetup: ['test/seam3/global-setup.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
