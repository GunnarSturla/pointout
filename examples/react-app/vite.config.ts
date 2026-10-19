import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pointout } from 'pointout/vite'

// The test bed renders the fixtures it shares with `examples/next-app`, which
// sit outside this root in `examples/shared/`, so an Owner chain names the same
// file on either Host. Vite serves them under `/@fs/`, and only from a folder
// `server.fs.allow` names: this app's own root, and the shared one.
const appRoot = fileURLToPath(new URL('.', import.meta.url))
const shared = fileURLToPath(new URL('../shared', import.meta.url))

export default defineConfig({
  plugins: [react(), pointout()],
  server: { fs: { allow: [appRoot, shared] } },
})
