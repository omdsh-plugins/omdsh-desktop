/**
 * Supervision of one `dsh --profile web` runtime: start, readiness, restart
 * pacing, and bounded shutdown. The runtime serves either from this machine or
 * from a host reached over SSH; which one is a property of the launch the
 * supervisor is handed, not of the supervision.
 *
 * The runtime runs as a child rather than inside the main process so a harness
 * fault, a memory climb, or a wedged plugin tree costs a restart instead of the
 * window, and so its heap is sized independently of Chromium's. A remote
 * runtime keeps the same arrangement: the child is then the `ssh` session that
 * carries it, and its exit is the runtime's exit.
 * @module @omdsh-plugins/omdsh-desktop/runtime-supervisor
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { ReadinessScanner } from './readiness.ts'
import { DEFAULT_RESTART_LIMITS, RestartPolicy, type RestartLimits } from './restart-policy.ts'
import type { RuntimeLaunch } from './runtime-launch.ts'

/**
 * Grace between one step of the shutdown ladder and the next. The runtime
 * bounds its own disposal at five seconds and then force-exits, so each step
 * waits out that bound before escalating.
 */
const SHUTDOWN_GRACE_MS = 8_000

/**
 * Output kept from the current attempt so an exit can be explained.
 *
 * A remote launch reports what went wrong — a refused key, an unresolved host,
 * a missing remote launcher — as ordinary output, and the exit code alone
 * cannot tell those apart.
 */
const OUTPUT_TAIL_BYTES = 8 * 1024

/** Observable condition of the supervised runtime. */
export type RuntimeState =
  /** No process, and none requested. */
  | { status: 'stopped' }
  /**
   * A process is running but has not reported its URL. `detail` carries what
   * the launch says it is doing, when it says anything — a boot that
   * a host the shell provisions spends minutes there before the runtime starts.
   */
  | { status: 'starting'; attempt: number; detail?: string }
  /** The runtime reported this URL and is serving. */
  | { status: 'ready'; url: string }
  /** The previous process exited; the next start is scheduled. */
  | { status: 'restarting'; attempt: number; delayMs: number }
  /** Startup failed repeatedly, or fatally; nothing further is scheduled. */
  | { status: 'failed'; reason: string }

/** Everything the supervisor needs from the application around it. */
export interface RuntimeSupervisorOptions {
  /**
   * Prepare the next launch.
   *
   * Called once per start rather than once per supervisor, because a remote
   * launch occupies a fresh pair of ports every time and because the person
   * may have chosen a different host since the last one. Preparation can take
   * minutes when it puts a server payload on a host, so it reports what it is
   * doing through `report`.
   * @param report - receives one short present-tense note per step.
   * @param signal - aborts when the start is cancelled, so work that runs before the child exists stops with it.
   * @returns the launch to spawn.
   */
  prepareLaunch: (report: (detail: string) => void, signal: AbortSignal) => Promise<RuntimeLaunch>
  /** Working directory of the runtime, which becomes a new session's default project directory. */
  cwd: string
  /** Environment for the runtime, already merged from the login shell. */
  env: Readonly<Record<string, string>>
  /** Receives every stdout and stderr chunk verbatim. */
  onOutput: (chunk: string) => void
  /** Restart pacing; defaults to {@link DEFAULT_RESTART_LIMITS}. */
  limits?: RestartLimits
}

/** Owns one runtime process at a time and the schedule for replacing it. */
export class RuntimeSupervisor {
  private state: RuntimeState = { status: 'stopped' }
  private child: ChildProcess | undefined
  private launch: RuntimeLaunch | undefined
  private readonly policy: RestartPolicy
  private readonly watchers = new Set<(state: RuntimeState) => void>()
  private scanner = new ReadinessScanner()
  private outputTail = ''
  private startedAt = 0
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private stopRequested = false
  private preparing = false
  private preparation: AbortController | undefined
  private fatalReason: string | undefined
  private exitWaiters: (() => void)[] = []
  private ladderTimers: ReturnType<typeof setTimeout>[] = []

  /** @param options - launch preparation, environment, and pacing. */
  constructor(private readonly options: RuntimeSupervisorOptions) {
    this.policy = new RestartPolicy(options.limits ?? DEFAULT_RESTART_LIMITS)
  }

  /** The current condition. */
  get current(): RuntimeState {
    return this.state
  }

  /** The serving URL, or `undefined` unless the runtime is ready. */
  get url(): string | undefined {
    return this.state.status === 'ready' ? this.state.url : undefined
  }

  /**
   * Process id of the running child, or `undefined` when none is running.
   *
   * For a remote launch this is the `ssh` session, whose resident memory says
   * nothing about the runtime; the resource policy reads it only for a local
   * one.
   */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /**
   * Observe condition changes.
   * @param listener - called on every transition, never for the current value.
   * @returns the unsubscribe function.
   */
  subscribe(listener: (state: RuntimeState) => void): () => void {
    this.watchers.add(listener)
    return () => this.watchers.delete(listener)
  }

  /**
   * Start the runtime unless one is already running or scheduled. Clears a
   * previous give-up, so this is also how the user retries after a failure.
   */
  start(): void {
    this.stopRequested = false
    if (this.child !== undefined || this.restartTimer !== undefined || this.preparing) return
    if (this.state.status === 'failed') this.policy.reset()
    void this.spawnRuntime(this.state.status === 'restarting' ? this.state.attempt : 0)
  }

  /**
   * Replace the running runtime. Sessions are durable, so a restart costs an
   * in-flight turn and nothing else. Switching to another host is a restart:
   * the next launch is prepared from the current choice.
   */
  async restart(): Promise<void> {
    await this.stop()
    this.policy.reset()
    this.start()
  }

  /**
   * Stop the runtime and cancel any scheduled start.
   *
   * A local runtime is asked with `SIGTERM`, which makes it dispose its own
   * plugin tree and subprocesses. A remote one is asked by closing the `ssh`
   * session's stdin, which its own script turns into the same `SIGTERM` on the
   * far side; signalling `ssh` instead would leave that runtime orphaned.
   * Windows has no `SIGTERM`: Node maps that signal to `TerminateProcess`, so
   * a local runtime does not run its disposer and sessions survive because they
   * are durable. Only when the child outlives the ladder does the escalation
   * reach the process tree, which is what catches subprocesses that a wedged
   * runtime never reaped.
   */
  async stop(): Promise<void> {
    this.stopRequested = true
    this.clearRestartTimer()
    // Preparation runs before any child exists, so a cancel has to reach it
    // launcher on the host — so stopping has to reach it there as well.
    this.preparation?.abort()
    const child = this.child
    if (child === undefined) {
      this.publish({ status: 'stopped' })
      return
    }
    const exited = new Promise<void>((resolve) => { this.exitWaiters.push(resolve) })
    this.beginTermination(child)
    await exited
  }

  /**
   * Walk one child down the shutdown ladder, without deciding what its exit
   * means: the caller owns whether this is a requested stop or a fatal one.
   * @param child - the running child.
   */
  private beginTermination(child: ChildProcess): void {
    if (this.ladderTimers.length > 0) return
    const steps = this.launch?.stopsOnStdinEnd === true
      ? [() => { child.stdin?.end() }, () => child.kill('SIGTERM'), () => { this.killGroup(child) }]
      : [() => child.kill('SIGTERM'), () => { this.killGroup(child) }]
    const [first, ...rest] = steps
    first?.()
    this.ladderTimers = rest.map((step, index) =>
      setTimeout(step, SHUTDOWN_GRACE_MS * (index + 1)))
  }

  /** Cancel every pending shutdown step. */
  private clearLadder(): void {
    for (const timer of this.ladderTimers) clearTimeout(timer)
    this.ladderTimers = []
  }

  /**
   * Signal the whole process tree, which reaches subprocesses the runtime
   * started and did not reap.
   * @param child - the runtime process, which is its group leader on Unix.
   */
  private killGroup(child: ChildProcess): void {
    if (child.pid === undefined) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      return
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The group is already gone: the exit handler has run or is about to.
    }
  }

  /**
   * Prepare and launch one runtime, then wire its output.
   * @param attempt - consecutive startup failures preceding this launch.
   */
  private async spawnRuntime(attempt: number): Promise<void> {
    this.preparing = true
    this.scanner = new ReadinessScanner()
    this.outputTail = ''
    this.fatalReason = undefined
    this.startedAt = Date.now()
    this.publish({ status: 'starting', attempt })
    const preparation = new AbortController()
    this.preparation = preparation
    let launch: RuntimeLaunch
    try {
      launch = await this.options.prepareLaunch((detail) => {
        if (this.state.status === 'starting') this.publish({ status: 'starting', attempt, detail })
      }, preparation.signal)
    } catch (error: unknown) {
      this.preparing = false
      this.preparation = undefined
      // A cancelled preparation is a stop, not a failure to report.
      if (this.stopRequested) this.publish({ status: 'stopped' })
      else this.publish({ status: 'failed', reason: error instanceof Error ? error.message : String(error) })
      return
    }
    this.preparing = false
    this.preparation = undefined
    if (this.stopRequested) {
      this.publish({ status: 'stopped' })
      return
    }
    this.launch = launch
    this.options.onOutput(`desktop: starting the harness runtime on ${launch.description}\n`)
    const child = spawn(
      launch.command,
      [...launch.args],
      {
        cwd: this.options.cwd,
        env: { ...this.options.env, ...launch.env },
        stdio: [launch.stdin, 'pipe', 'pipe'],
        // Its own process group, so shutdown can reach subprocesses as a unit.
        detached: true,
        windowsHide: true,
      },
    )
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { this.consume(chunk) })
    child.stderr?.on('data', (chunk: string) => { this.consume(chunk) })
    // Swallows the EPIPE this pipe reports when the far side goes first: the
    // shell never writes to it and holds it open only so that closing it is the
    // stop signal, so the exit handler already owns what that means.
    child.stdin?.on('error', () => {})
    child.once('error', (error) => {
      this.options.onOutput(`desktop: runtime failed to launch: ${error.message}\n`)
    })
    child.once('exit', (code, signal) => { this.handleExit(code, signal) })
  }

  /**
   * Route one output chunk to the log, to the retained tail, and to readiness
   * detection.
   * @param chunk - decoded stdout or stderr text.
   */
  private consume(chunk: string): void {
    this.options.onOutput(chunk)
    this.outputTail = (this.outputTail + chunk).slice(-OUTPUT_TAIL_BYTES)
    const reported = this.scanner.push(chunk)
    if (reported === undefined) {
      // Only while starting: a note that arrived after the runtime is serving
      // describes work the window is no longer waiting on.
      if (this.state.status !== 'starting') return
      const detail = this.launch?.progress?.(chunk)
      if (detail !== undefined) this.publish({ status: 'starting', attempt: this.state.attempt, detail })
      return
    }
    const address = this.launch?.address(reported) ?? { status: 'ready' as const, url: reported }
    if (address.status === 'ready') {
      this.publish({ status: 'ready', url: address.url })
      return
    }
    // Restarting cannot fix a runtime that is serving somewhere else, so the
    // exit handler publishes this reason instead of scheduling another attempt.
    this.fatalReason = address.reason
    const child = this.child
    if (child !== undefined) this.beginTermination(child)
  }

  /**
   * Account for the runtime process ending.
   * @param code - exit code, or `null` when a signal ended it.
   * @param signal - the signal that ended it, when one did.
   */
  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const launch = this.launch
    this.child = undefined
    this.launch = undefined
    this.clearLadder()
    const waiters = this.exitWaiters
    this.exitWaiters = []
    for (const resolve of waiters) resolve()
    const fatal = this.fatalReason
    this.fatalReason = undefined
    if (fatal !== undefined) {
      this.publish({ status: 'failed', reason: fatal })
      return
    }
    if (this.stopRequested) {
      this.publish({ status: 'stopped' })
      return
    }
    const decision = this.policy.recordExit(Date.now() - this.startedAt)
    if (decision.action === 'give-up') {
      const exit = { exitCode: code, signal, output: this.outputTail, attempts: decision.attempt }
      this.publish({
        status: 'failed',
        reason: launch?.explain(exit)
          ?? `the harness runtime stopped ${String(decision.attempt)} times in a row`,
      })
      return
    }
    const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${String(code)}`
    this.options.onOutput(`desktop: runtime ended (${cause}); restarting in ${String(decision.delayMs)}ms\n`)
    this.publish({ status: 'restarting', attempt: decision.attempt, delayMs: decision.delayMs })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.stopRequested) return
      void this.spawnRuntime(decision.attempt)
    }, decision.delayMs)
  }

  /** Cancel a scheduled start. */
  private clearRestartTimer(): void {
    if (this.restartTimer === undefined) return
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
  }

  /**
   * Record and broadcast one condition.
   * @param state - the new condition.
   */
  private publish(state: RuntimeState): void {
    this.state = state
    for (const watcher of this.watchers) watcher(state)
  }
}
