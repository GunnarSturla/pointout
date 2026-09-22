import { fileURLToPath } from 'node:url'

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
export const exampleAppRoot = fileURLToPath(
  new URL('../../examples/react-app', import.meta.url),
)
