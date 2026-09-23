import type { Logger } from 'vite'

/** Which of the logger's methods a message went through. */
export type LogLevel = 'info' | 'warn' | 'error'

/** One call to the logger, as it was made. */
export interface LogEntry {
  level: LogLevel
  message: string
}

/** A recorder and the `Logger` it records through. */
export interface RecordingLogger {
  /** Everything logged so far, one line per call, oldest first. */
  text(): string
  /** The same calls, with the level each was made at. */
  entries(): LogEntry[]
  logger: Logger
}

/**
 * A Vite `Logger` that records every line instead of printing it. Seam 1 reads
 * the startup posture block through this: the block is the server's own
 * output, which is exactly the kind of outside-in observation the testing
 * conventions ask for.
 */
export function createRecordingLogger(): RecordingLogger {
  const lines: LogEntry[] = []

  const at = (level: LogLevel) => (message: string) => {
    lines.push({
      level,
      message: typeof message === 'string' ? message : String(message),
    })
  }
  const info = at('info')
  const warn = at('warn')
  const error = at('error')

  return {
    text: () => lines.map(({ message }) => message).join('\n'),
    entries: () => [...lines],
    logger: {
      hasWarned: false,
      info,
      warn(message) {
        this.hasWarned = true
        warn(message)
      },
      warnOnce(message) {
        this.hasWarned = true
        warn(message)
      },
      error(message) {
        error(message)
      },
      clearScreen() {},
      hasErrorLogged: () => false,
    },
  }
}
