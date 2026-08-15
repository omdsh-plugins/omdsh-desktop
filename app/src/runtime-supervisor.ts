/**
 * Supervision of one `dsh --profile web` runtime: start, readiness, restart
 * pacing, and bounded shutdown.
 *
 * The runtime runs as a child rather than inside the main process so a harness
 * fault, a memory climb, or a wedged plugin tree costs a restart instead of the
 * window, and so its heap is sized independently of Chromium's.
 *
 * What the child IS stays a property of the launch this supervisor is handed
 * rather than of the supervision — but there is one launch left, on this
 * machine, and the comments here no longer describe a second one that does not
 * exist.
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
 * A runtime that dies during boot says why on stderr and then exits; the exit
 * code alone cannot tell a missing entry point from a wedged plugin.
 */
const OUTPUT_TAIL_BYTES = 8 * 1024

/** Observable condition of the supervised runtime. */
export type RuntimeState =
  /** No process, and none requested. */
  | { status: 'stopped' }
  /** A process is running but has not reported its URL yet. */
  | { status: 'starting'; attempt: number }
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
   * Called once per start rather than once per supervisor: the runtime asks the
   * OS for a free port, so each attempt is a fresh command line rather than a
   * replay of the last one.
   * @param signal - aborts when the start is cancelled, so work that runs before the child exists stops with it.
   * @returns the launch to spawn.
   */
  prepareLaunch: (signal: AbortSignal) => Promise<RuntimeLaunch>
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

  /** Process id of the running child, or `undefined` when none is running. */
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
   * in-flight turn and nothing else.
   */
  async restart(): Promise<void> {
    await this.stop()
    this.policy.reset()
    this.start()
  }

  /**
   * Stop the runtime and cancel any scheduled start.
   *
   * The runtime is asked with `SIGTERM`, which makes it dispose its own plugin
   * tree and subprocesses. Windows has no `SIGTERM`: Node maps that signal to
   * `TerminateProcess`, so the runtime does not run its disposer and sessions
   * survive because they are durable. Only when the child outlives the ladder
   * does the escalation reach the process tree, which is what catches
   * subprocesses that a wedged runtime never reaped.
   */
  async stop(): Promise<void> {
    this.stopRequested = true
    this.clearRestartTimer()
    // Preparation runs before any child exists, so a cancel has to reach it
    // through its own signal rather than through the process.
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
    // SIGTERM, then the whole group. There used to be a third rung above it,
    // closing an stdin pipe a remote launch script read as its stop signal;
    // the only launch left ignores stdin.
    const steps = [() => child.kill('SIGTERM'), () => { this.killGroup(child) }]
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
    this.startedAt = Date.now()
    this.publish({ status: 'starting', attempt })
    const preparation = new AbortController()
    this.preparation = preparation
    let launch: RuntimeLaunch
    try {
      launch = await this.options.prepareLaunch(preparation.signal)
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
        // The runtime reads nothing from stdin; only its output is consumed.
        stdio: ['ignore', 'pipe', 'pipe'],
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
    if (reported === undefined) return
    // The runtime serves on this machine's loopback, so the address it reports
    // is the address to reach it at. A launch that could serve from elsewhere
    // used to translate this, and could answer that it was unreachable.
    this.publish({ status: 'ready', url: reported })
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
