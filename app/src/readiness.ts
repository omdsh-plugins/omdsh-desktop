/**
 * Readiness detection over the embedded runtime's standard output.
 *
 * `dsh --profile web` prints its URL line only after the Loader tree settles,
 * so that line — not the port answering — is what tells the shell a window may
 * be pointed at the server.
 * @module @omdsh-plugins/omdsh-desktop/readiness
 */

/**
 * The readiness line, as `dsh-web-app` prints it. The optional LAN suffix is
 * outside the capture: the desktop shell always loads the loopback URL.
 *
 * The trailing newline is part of the match because output arrives in chunks
 * that split anywhere: without it, a chunk ending mid-URL matches and reports
 * a truncated address.
 */
const READY_LINE = /^dsh web: (\S+).*\n/m

/**
 * Bytes of unmatched output kept while waiting. The line arrives within the
 * first output of a healthy boot; a backend that instead logs continuously
 * must not grow this buffer for the life of the process.
 */
const SCAN_WINDOW = 64 * 1024

/**
 * Incremental scanner over stdout chunks, which split the readiness line at
 * arbitrary byte offsets.
 */
export class ReadinessScanner {
  /** Unmatched tail of the output seen so far; cleared once the URL is found. */
  private buffer = ''
  private found: string | undefined

  /** The URL the runtime reported, or `undefined` while it has not reported one. */
  get url(): string | undefined {
    return this.found
  }

  /**
   * Consume one chunk of runtime output.
   * @param chunk - decoded stdout text, in arrival order.
   * @returns the URL when this chunk completed the readiness line, otherwise `undefined`.
   */
  push(chunk: string): string | undefined {
    if (this.found !== undefined) return undefined
    this.buffer += chunk
    const match = READY_LINE.exec(this.buffer)
    if (match?.[1] === undefined) {
      // Keep the window's worth of tail: a boundary-split line stays joinable.
      if (this.buffer.length > SCAN_WINDOW) this.buffer = this.buffer.slice(-SCAN_WINDOW)
      return undefined
    }
    this.buffer = ''
    this.found = match[1]
    return this.found
  }
}
