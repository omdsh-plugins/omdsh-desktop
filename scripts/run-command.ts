/**
 * Run one labelled subprocess as a step of the packaging pipeline.
 *
 * The pipeline's long steps — `npm pack`, electron-builder, its NSIS pass —
 * are external programs whose failure has to arrive as a diagnosable error
 * rather than a bare exit code, and whose progress has to be visible while
 * they run: a signed build takes minutes, and silence there is indistinguishable
 * from a hang. So the child's output is forwarded as it arrives AND kept, and a
 * non-zero exit throws with the tail of what was said.
 *
 * The short steps in the pipeline keep using `spawnSync` directly. This exists
 * for the ones that are slow enough to need the progress, or whose command line
 * is assembled from enough parts to need the label.
 * @module @omdsh-plugins/omdsh-desktop/scripts/run-command
 */

import { spawn } from 'node:child_process'

/** How much of a failed step's output the error carries. */
const FAILURE_TAIL_BYTES = 8192

/** One external step of the pipeline. */
export interface RunCommandOptions {
  /** What the progress line and any failure call this step. */
  readonly label: string
  /** The executable, resolved by the caller. */
  readonly command: string
  /** Its arguments, already split. */
  readonly args: readonly string[]
  /** Directory to run it in. */
  readonly cwd: string
  /** Diagnostic prefix on this step's logs and errors. */
  readonly prefix: string
  /** Report what would run and return without running it. */
  readonly dryRun: boolean
  /** Variables added to the inherited environment. */
  readonly extraEnv?: Readonly<Record<string, string>>
}

/**
 * The last {@link FAILURE_TAIL_BYTES} of a step's output.
 *
 * A failed electron-builder run can say megabytes, and the part that names the
 * failure is at the end. Quoting all of it turns one error into a transcript.
 * @param output - everything the step said.
 * @returns the tail, marked when anything was dropped.
 */
function tail(output: string): string {
  if (output.length <= FAILURE_TAIL_BYTES) return output
  return `[…${String(output.length - FAILURE_TAIL_BYTES)} earlier bytes omitted]\n${output.slice(-FAILURE_TAIL_BYTES)}`
}

/**
 * Run one step to completion.
 * @param options - the step.
 * @returns nothing; the step's effect is on disk.
 * @throws Error when the command cannot start, is killed, or exits non-zero.
 */
export async function runCommand(options: RunCommandOptions): Promise<void> {
  const printable = [options.command, ...options.args].join(' ')
  if (options.dryRun) {
    console.log(`${options.prefix}: ${options.label} (dry run): ${printable}`)
    return
  }
  console.log(`${options.prefix}: ${options.label}: ${printable}`)

  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.extraEnv },
    // Nothing here is interactive: a step that stops to ask would hang a build
    // that no one is watching.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let output = ''
  const consume = (chunk: Buffer, to: NodeJS.WriteStream): void => {
    const text = chunk.toString('utf8')
    output += text
    to.write(text)
  }
  child.stdout.on('data', (chunk: Buffer) => { consume(chunk, process.stdout) })
  child.stderr.on('data', (chunk: Buffer) => { consume(chunk, process.stderr) })

  await new Promise<void>((resolveStep, reject) => {
    // `error` fires instead of `close` when the executable is absent, which is
    // the common failure for a path assembled from node_modules/.bin.
    child.once('error', (error: Error) => {
      reject(new Error(`${options.prefix}: ${options.label} could not start (${printable}): ${error.message}`))
    })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal !== null) {
        reject(new Error(`${options.prefix}: ${options.label} was killed by ${signal}\n${tail(output)}`))
        return
      }
      if (code !== 0) {
        reject(new Error(`${options.prefix}: ${options.label} exited ${String(code)}\n${tail(output)}`))
        return
      }
      resolveStep()
    })
  })
}
