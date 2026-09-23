import { defineConfig } from 'vitest/config'

// Seam 3: contract canaries against a real Claude Code harness. Its own command,
// never part of the default run: it spawns a real session on the developer's
// account and touches the real registry. Two tiers, one config:
//
// - `npm run test:seam3` is the no-model tier (ticket 20). Free, run it often.
// - `npm run test:seam3:model` is the model tier (ticket 21), selected with
//   `--mode model`. It spends a handful of turns on the cheapest model, and only
//   that mode includes its files at all — the model test file also refuses to
//   run a turn unless this config put it in that mode.
export default defineConfig(({ mode }) => {
  const model = mode === 'model'
  return {
    test: {
      name: model ? 'seam3-model' : 'seam3',
      include: model
        ? [
            'test/seam3/model/**/*.test.ts',
            'test/seam3/shipped.test.ts',
            'test/seam3/fixture-allowlist.test.ts',
          ]
        : ['test/seam3/*.test.ts'],
      globalSetup: [
        model ? 'test/seam3/model/global-setup.ts' : 'test/seam3/global-setup.ts',
      ],
      // Written only by the model tier, and only when every test in it passed.
      reporters: model
        ? ['default', './test/seam3/model/record-version.ts']
        : ['default'],
      env: { SEAM3_TIER: model ? 'model' : 'no-model' },
      environment: 'node',
      testTimeout: 300_000,
      hookTimeout: 180_000,
      fileParallelism: false,
    },
  }
})
