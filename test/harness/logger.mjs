/**
 * A Vite `Logger` that records every line instead of printing it. Seam 1 reads
 * the startup posture block through this: the block is the server's own
 * output, which is exactly the kind of outside-in observation the testing
 * conventions ask for.
 */
export function createRecordingLogger() {
  const lines = []

  const record = (message) => {
    lines.push(typeof message === 'string' ? message : String(message))
  }

  return {
    text: () => lines.join('\n'),
    logger: {
      hasWarned: false,
      info: record,
      warn(message) {
        this.hasWarned = true
        record(message)
      },
      warnOnce(message) {
        this.hasWarned = true
        record(message)
      },
      error(message) {
        record(message)
      },
      clearScreen() {},
      hasErrorLogged: () => false,
    },
  }
}
