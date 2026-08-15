/**
 * The runtime process's log file, plus the in-memory tail the boot window
 * shows when a start fails.
 * @module @omdsh-plugins/omdsh-desktop/runtime-log
 */

import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Size at which the log rolls over to `<name>.1`, keeping one previous run's bytes. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** Lines kept in memory for the failure surface. */
const TAIL_LINES = 200

/** Log destination and rotation bound. */
export interface RuntimeLogOptions {
  /** Directory to write into; created when absent. */
  directory: string
  /** Log filename. */
  filename: string
  /** Rotation threshold in bytes; defaults to 4 MiB. */
  maxBytes?: number
}

/**
 * Keep the last {@link TAIL_LINES} lines of a text stream that arrives in
 * arbitrary chunks.
 */
export class LogTail {
  private lines: string[] = []
  private partial = ''

  /**
   * Consume one chunk.
   * @param chunk - decoded output text.
   */
  push(chunk: string): void {
    const parts = (this.partial + chunk).split('\n')
    this.partial = parts.pop() ?? ''
    this.lines.push(...parts)
    if (this.lines.length > TAIL_LINES) this.lines = this.lines.slice(-TAIL_LINES)
  }

  /**
   * Read the retained tail.
   * @returns the kept lines, oldest first, including any unterminated last line.
   */
  read(): readonly string[] {
    return this.partial === '' ? [...this.lines] : [...this.lines, this.partial]
  }
}

/** A log file the supervisor appends runtime output to. */
export interface RuntimeLog {
  /** Absolute path of the current log file. */
  readonly path: string
  /**
   * Append one chunk, rotating first when the file has reached its bound.
   * @param chunk - decoded output text.
   */
  write(chunk: string): void
  /**
   * Read the retained tail of this process's output.
   * @returns the kept lines, oldest first.
   */
  tail(): readonly string[]
  /** Truncate the file, which a fresh runtime start does so one file holds one run. */
  reset(): void
}

/**
 * Open the runtime log.
 *
 * Writes are synchronous because they happen on stdout chunks and on the quit
 * path, where an asynchronous queue could lose the last lines — exactly the
 * ones that explain a failure.
 * @param options - destination and rotation bound.
 * @returns the log handle.
 */
export function openRuntimeLog(options: RuntimeLogOptions): RuntimeLog {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const path = join(options.directory, options.filename)
  const tail = new LogTail()
  mkdirSync(options.directory, { recursive: true })

  const rotate = (): void => {
    let size = 0
    try {
      size = statSync(path).size
    } catch {
      // No file yet, or one removed underneath us: the append below recreates it.
      return
    }
    if (size < maxBytes) return
    renameSync(path, `${path}.1`)
  }

  return {
    path,
    write(chunk: string): void {
      tail.push(chunk)
      rotate()
      appendFileSync(path, chunk)
    },
    tail: () => tail.read(),
    reset(): void {
      writeFileSync(path, '')
    },
  }
}
