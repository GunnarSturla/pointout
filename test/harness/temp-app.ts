import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './dev-server.js'
import type { HarnessServer, StartServerOptions } from './dev-server.js'
import type { HostName } from './hosts.js'
import { startNextServer } from './next-server.js'
import { repoRoot } from './paths.js'

// A throwaway consumer, laid out so root discovery has something to discover:
//
//   <playground>/                    never a git repository
//   <playground>/node_modules/       @gunnarsturla/pointout, linked as an install
//   <playground>/checkout/           the git repository, when one is asked for
//   <playground>/checkout/app/       the Host's root: Vite's, or Next's
//   <playground>/<worktree>/         linked worktrees, added on demand
//
// A Next.js app (Next.js Connector ticket 05) is the same layout with
// `next.config.mjs` in place of `vite.config.js`, a one-page App Router, and
// `next`, `react` and `react-dom` linked in beside pointout. Its page is never
// compiled: Turbopack refuses packages linked from outside its root, and every
// suite that runs on a temp app talks only to `/__agent`, which pointout
// answers ahead of Next's router.
//
// The config is written rather than imported: a test may not import a server
// module, and writing the config is what a consumer does anyway. It is written
// as JavaScript on purpose — it is fixture output imitating what a consumer
// hands to Vite, not source this repository type-checks.

const INDEX_HTML = `<!doctype html>
<html>
  <head><title>temp app</title></head>
  <body><div id="app">temp app</div></body>
</html>
`

/** Whatever `pointout(...)` should be called with in the written config. */
type PluginOptions = Record<string, unknown> | null
/** Consumer-side Vite settings a test needs Vite itself to have. */
type ViteConfig = Record<string, unknown> | null

/** The Next.js app's two files, enough for `next dev` to start. */
const NEXT_LAYOUT = `export default function Layout({ children }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  )
}
`
const NEXT_PAGE = `export default function Page() {
  return <div id="app">temp app</div>
}
`

/** What a Next.js app links in from this repository's install. */
const NEXT_PACKAGES = ['next', 'react', 'react-dom']

export interface TempAppOptions {
  /** Make the checkout a git repository. */
  git?: boolean
  pluginOptions?: PluginOptions
  viteConfig?: ViteConfig
}

export interface TempApp {
  /** Which Host serves it. */
  host: HostName
  playground: string
  checkout: string
  appDir: string
  configFile: string
  /** Rewrite the consumer config, for options only knowable once it exists. */
  writeConfig(options: PluginOptions, vite?: ViteConfig): void
  /** A linked worktree of the checkout, beside it rather than inside it. */
  addWorktree(name: string): string
  /** An unrelated git repository, to prove Candidates do not leak across them. */
  addSiblingRepo(name: string): string
  cleanup(): void
}

export function createTempApp(
  { git = false, pluginOptions = null, viteConfig = null }: TempAppOptions = {},
  host: HostName = 'vite',
): TempApp {
  const playground = realpathSync(mkdtempSync(join(tmpdir(), 'pointout-app-')))
  const checkout = join(playground, 'checkout')
  const appDir = join(checkout, 'app')
  mkdirSync(appDir, { recursive: true })
  mkdirSync(join(playground, 'node_modules', '@gunnarsturla'), { recursive: true })
  symlinkSync(
    repoRoot,
    join(playground, 'node_modules', '@gunnarsturla', 'pointout'),
    'dir',
  )

  writeFileSync(
    join(appDir, 'package.json'),
    // Its Host is named so `init` reads this app as that Host's, as a consumer's is.
    JSON.stringify(
      {
        name: 'temp-app',
        private: true,
        type: 'module',
        devDependencies: host === 'next' ? { next: '*' } : { vite: '*' },
      },
      null,
      2,
    ) + '\n',
  )
  if (host === 'next') {
    for (const name of NEXT_PACKAGES) {
      symlinkSync(
        join(repoRoot, 'node_modules', name),
        join(playground, 'node_modules', name),
        'dir',
      )
    }
    mkdirSync(join(appDir, 'app'))
    writeFileSync(join(appDir, 'app', 'layout.js'), NEXT_LAYOUT)
    writeFileSync(join(appDir, 'app', 'page.js'), NEXT_PAGE)
  } else {
    writeFileSync(join(appDir, 'index.html'), INDEX_HTML)
  }
  const write = (options: PluginOptions, vite: ViteConfig) => {
    if (host === 'vite') return writeConfig(appDir, options, vite)
    if (vite) throw new Error('a Next.js temp app takes no Vite settings')
    writeNextConfig(appDir, options)
  }
  write(pluginOptions, viteConfig)

  if (git) initRepo(checkout)

  return {
    host,
    playground,
    checkout,
    appDir,
    configFile: join(appDir, host === 'next' ? 'next.config.mjs' : 'vite.config.js'),

    writeConfig(options, vite = viteConfig) {
      write(options, vite)
    },

    addWorktree(name) {
      const path = join(playground, name)
      run(checkout, 'worktree', 'add', '-q', '-b', name, path)
      return realpathSync(path)
    },

    addSiblingRepo(name) {
      const path = join(playground, name)
      mkdirSync(path)
      initRepo(path)
      return realpathSync(path)
    },

    cleanup() {
      rmSync(playground, { recursive: true, force: true })
    },
  }
}

/** Options a test passes for the server, with the app supplying root and config. */
type TempServerOptions = Omit<Partial<StartServerOptions>, 'root' | 'configFile'>

/** Start a dev server on a temp app. */
export async function startTempApp(
  app: TempApp,
  options: TempServerOptions = {},
): Promise<HarnessServer> {
  if (app.host === 'next') {
    const { port, ...next } = options
    if (port !== undefined) throw new Error('Next chooses its own port')
    return startNextServer({ ...next, app: app.appDir })
  }
  return startServer({ root: app.appDir, configFile: app.configFile, ...options })
}

export interface TempApps {
  /** A temp app, torn down at the end of the test. */
  create(options?: TempAppOptions): TempApp
  /** Another dev server on an app that already exists. */
  serve(app: TempApp, options?: TempServerOptions): Promise<HarnessServer>
  /** The common case: one app, one server on it. */
  start(
    options?: TempServerOptions & { app?: TempAppOptions },
  ): Promise<{ app: TempApp; server: HarnessServer }>
  /** Last opened, first closed, so a server always outlives its app. */
  cleanup(): Promise<void>
}

/**
 * The apps and servers one test file opened, and the one call that shuts them
 * again. A file does `const apps = tempApps()` and `afterEach(apps.cleanup)`.
 * Every app it creates is served by `host`: Vite, unless the suite names Next.
 */
export function tempApps(host: HostName = 'vite'): TempApps {
  const teardown: Array<() => void | Promise<void>> = []

  const apps: TempApps = {
    create(options = {}) {
      const app = createTempApp(options, host)
      teardown.push(() => app.cleanup())
      return app
    },

    async serve(app, options = {}) {
      const server = await startTempApp(app, options)
      teardown.push(() => server.close())
      return server
    },

    async start({ app: appOptions, ...serverOptions } = {}) {
      const app = apps.create(appOptions)
      return { app, server: await apps.serve(app, serverOptions) }
    },

    async cleanup() {
      while (teardown.length) await teardown.pop()!()
    },
  }

  return apps
}

function writeConfig(
  appDir: string,
  pluginOptions: PluginOptions,
  viteConfig: ViteConfig,
) {
  const config = {
    ...viteConfig,
    plugins: `@@plugins@@`,
  }
  writeFileSync(
    join(appDir, 'vite.config.js'),
    [
      "import { pointout } from '@gunnarsturla/pointout/vite'",
      '',
      'export default ' +
        JSON.stringify(config, null, 2).replace(
          '"@@plugins@@"',
          `[pointout(${pluginOptions ? JSON.stringify(pluginOptions) : ''})]`,
        ),
      '',
    ].join('\n'),
  )
}

/**
 * The Next.js consumer's config, as a consumer writes it. The output folder is
 * the harness's (next-server.ts): Next allows one `next dev` per folder, and a
 * test may serve one app twice.
 */
function writeNextConfig(appDir: string, pluginOptions: PluginOptions) {
  writeFileSync(
    join(appDir, 'next.config.mjs'),
    [
      "import { withPointout } from '@gunnarsturla/pointout/next'",
      '',
      'const distDir = process.env.POINTOUT_EXAMPLE_DIST_DIR',
      '',
      'export default withPointout(',
      '  { agentRules: false, ...(distDir && { distDir }) },',
      `  ${pluginOptions ? JSON.stringify(pluginOptions) : '{}'},`,
      ')',
      '',
    ].join('\n'),
  )
}

function initRepo(path: string) {
  run(path, 'init', '-q', '-b', 'main')
  run(path, 'commit', '-q', '--allow-empty', '-m', 'root')
}

function run(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  })
}
