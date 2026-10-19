import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server as NetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { API_BASE } from '../api.js'

// How the Next.js Connector reaches `/__agent` on Next's own server (ADR-0006).
// Next has no dev-middleware hook, and by the time it reads the config its
// server is already listening, so pointout finds that server among the
// process's live handles and answers its `/__agent` requests before Next's own
// `'request'` listener hears of them. Only that one server is touched, only its
// `'request'` event, and only for `/__agent` paths: every other request, and
// every `'upgrade'` (HMR), reaches Next exactly as it would have.

/** What answers an `/__agent` request; `path` is what follows `/__agent`. */
export type AgentHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
) => void

/**
 * Next's listening server: the HTTP(S) server in this process that is
 * listening on `port`. An HTTP(S) server is the one with a `'request'`
 * listener, which tells it from the reply socket and any other plain socket
 * server. Null when there is none, or more than one.
 */
export function findListeningServer(port: number | null): NetServer | null {
  const found = activeHandles().filter(
    (handle): handle is NetServer =>
      handle instanceof NetServer &&
      handle.listening &&
      handle.listenerCount('request') > 0 &&
      (port === null || (handle.address() as AddressInfo | null)?.port === port),
  )
  return found.length === 1 ? found[0]! : null
}

/** Answer `/__agent` on `server` with `answer`, ahead of the server's own listeners. */
export function interceptAgentRequests(server: NetServer, answer: AgentHandler): void {
  const emit = server.emit
  server.emit = function (this: NetServer, event: string | symbol, ...args: unknown[]) {
    if (event === 'request') {
      const [request, response] = args as [IncomingMessage, ServerResponse]
      const path = agentPath(request.url)
      if (path !== null) {
        // As Connect does for Vite's mount: some handlers read `request.url`,
        // and expect it relative to `/__agent`. Next never sees this request.
        request.url = path
        answer(request, response, path)
        return true
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  } as NetServer['emit']
}

/**
 * What follows `/__agent` in `url`, query included, or null for a path that is
 * not pointout's. `/__agentx` is Next's. The same answer Vite's middleware
 * mount gives the core: always beginning with `/`.
 */
function agentPath(url: string | undefined): string | null {
  if (!url?.startsWith(API_BASE)) return null
  const rest = url.slice(API_BASE.length)
  if (rest === '') return '/'
  if (rest.startsWith('/')) return rest
  if (rest.startsWith('?')) return '/' + rest
  return null
}

/**
 * Node's own list of what keeps the process alive. Undocumented but stable
 * since Node 0.x; it is the only way to reach a server the config did not
 * create. ADR-0006's self-check is what turns its absence into a stated
 * degradation.
 */
function activeHandles(): unknown[] {
  const reader = (process as unknown as { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles
  return typeof reader === 'function' ? reader.call(process) : []
}
