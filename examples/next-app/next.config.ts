import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'
import { withPointout } from 'pointout/next'

// The Next.js test bed, with pointout in it the way a consumer adds it.
//
// Its pages render the fixtures it shares with `examples/react-app`, which sit
// outside this app in `examples/shared/`, so an Owner chain names the same file
// on either Host. Turbopack compiles only what is under `turbopack.root`, so the
// root is the repository, which holds both the shared folder and the hoisted
// `node_modules`.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

// Next allows one `next dev` per output folder, and the test harness runs one
// server per test file, side by side. So the harness names a folder for each
// server, below `.next/`, and a developer's own `next dev` keeps the default.
//
// Next also rewrites the tsconfig it is given to include that folder's types,
// so a harness server is handed one of its own, which extends this app's. The
// committed `tsconfig.json` is then never edited by a test run.
const harnessDistDir = process.env.POINTOUT_EXAMPLE_DIST_DIR
const harnessTsconfig = process.env.POINTOUT_EXAMPLE_TSCONFIG

// The harness's way to compare a page with and without pointout: set, the
// config is exported unwrapped. Nothing but the harness sets it.
const withoutPointout = process.env.POINTOUT_EXAMPLE_WITHOUT_POINTOUT === '1'

const config: NextConfig = {
  turbopack: { root: repoRoot },
  ...(harnessDistDir && { distDir: harnessDistDir }),
  ...(harnessTsconfig && { typescript: { tsconfigPath: harnessTsconfig } }),
  // Next 16.4 writes an AGENTS.md into the project on its first dev run.
  agentRules: false,
}

export default withoutPointout ? config : withPointout(config)
