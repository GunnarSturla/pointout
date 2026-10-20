import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

// pointout asking Next's own server something over loopback, the way a page
// would: the self-check's status request and a client chunk's map.

export interface LoopbackAnswer {
  status: number
  body: string
}

/**
 * One request to this dev server, answered or rejected: with the error, or
 * when no answer has come within `timeoutMs`. A dev server's certificate is
 * its own, and loopback is what is being reached, so it is not checked.
 */
export function askLoopback(
  url: string,
  { method = 'GET', timeoutMs }: { method?: 'GET' | 'HEAD'; timeoutMs: number },
): Promise<LoopbackAnswer> {
  return new Promise((resolve, reject) => {
    const send = url.startsWith('https:') ? httpsRequest : httpRequest
    const outgoing = send(url, { method, rejectUnauthorized: false }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (body += chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    outgoing.setTimeout(timeoutMs, () =>
      outgoing.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)),
    )
    outgoing.on('error', reject)
    outgoing.end()
  })
}
