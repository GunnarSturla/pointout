// What the core says out loud goes through this, and nothing else. It is the
// core's own shape rather than a Host's (ADR-0005): each Connector hands over a
// logger that satisfies it, which for Vite is the dev server's `config.logger`.

/** The three levels the core logs at. A Host's own logger usually has more. */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}
