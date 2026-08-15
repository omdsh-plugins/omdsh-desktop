/**
 * Supervision against a stand-in runtime: readiness, the state sequence a
 * window follows, restart after an unexpected exit, and bounded shutdown.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localRuntimeLaunch } from '../src/runtime-launch.ts'
import { RuntimeSupervisor, type RuntimeState, type RuntimeSupervisorOptions } from '../src/runtime-supervisor.ts'

/**
 * A stand-in for the harness launcher: it prints the readiness line the real
 * runtime prints and then serves until it is signalled.
 */
const SERVING_RUNTIME = `
process.stdout.write('boot line\\n')
process.stdout.write('dsh web: http://127.0.0.1:65000\\n')
setInterval(() => {}, 1000)
`

/** A launcher that fails during startup, which is what a broken closure looks like. */
const FAILING_RUNTIME = `
process.stderr.write('cannot mount the plugin tree\\n')
process.exit(3)
`

/** The ports a carried launch is tested against. */

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-supervisor-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/**
 * Write one stand-in runtime.
 * @param source - the script body.
 * @returns its path.
 */
async function writeRuntime(source: string): Promise<string> {
  const path = join(directory, 'runtime.cjs')
  await writeFile(path, source)
  return path
}

/**
 * Build a supervisor over a stand-in runtime, recording every transition.
 * @param entry - the stand-in runtime path.
 * @param limits - restart pacing overrides.
 * @returns the supervisor, the recorded states, and the captured output.
 */
function supervise(entry: string, limits?: RuntimeSupervisorOptions['limits']) {
  const states: RuntimeState[] = []
  let output = ''
  const supervisor = new RuntimeSupervisor({
    prepareLaunch: () => Promise.resolve(
      localRuntimeLaunch({ entry, nodePath: process.execPath, maxOldSpaceMb: 512 }),
    ),
    cwd: directory,
    env: { PATH: process.env.PATH ?? '' },
    onOutput: (chunk) => { output += chunk },
    ...limits !== undefined && { limits },
  })
  supervisor.subscribe(state => states.push(state))
  return { supervisor, states, output: () => output }
}

/**
 * Wait for the supervisor to reach a condition.
 * @param supervisor - the supervisor to watch.
 * @param predicate - the condition.
 * @returns the matching state.
 */
async function waitFor(supervisor: RuntimeSupervisor, predicate: (state: RuntimeState) => boolean): Promise<RuntimeState> {
  if (predicate(supervisor.current)) return supervisor.current
  return new Promise((resolve) => {
    const unsubscribe = supervisor.subscribe((state) => {
      if (!predicate(state)) return
      unsubscribe()
      resolve(state)
    })
  })
}

describe('RuntimeSupervisor', () => {
  it('reports the URL the runtime prints and stops it on request', async () => {
    const { supervisor, states } = supervise(await writeRuntime(SERVING_RUNTIME))
    supervisor.start()
    await waitFor(supervisor, state => state.status === 'ready')
    expect(supervisor.url).toBe('http://127.0.0.1:65000')
    expect(supervisor.pid).toBeGreaterThan(0)
    await supervisor.stop()
    expect(supervisor.current).toEqual({ status: 'stopped' })
    expect(states.map(state => state.status)).toEqual(['starting', 'ready', 'stopped'])
  })

  it('captures runtime output for the log', async () => {
    const { supervisor, output } = supervise(await writeRuntime(SERVING_RUNTIME))
    supervisor.start()
    await waitFor(supervisor, state => state.status === 'ready')
    await supervisor.stop()
    expect(output()).toContain('boot line')
  })

  it('does not start a second runtime while one is running', async () => {
    const { supervisor, states } = supervise(await writeRuntime(SERVING_RUNTIME))
    supervisor.start()
    await waitFor(supervisor, state => state.status === 'ready')
    supervisor.start()
    await supervisor.stop()
    expect(states.filter(state => state.status === 'starting')).toHaveLength(1)
  })

  it('restarts an unexpected exit and gives up on a repeating failure', async () => {
    const { supervisor, states } = supervise(await writeRuntime(FAILING_RUNTIME), {
      healthyUptimeMs: 60_000,
      baseDelayMs: 1,
      maxDelayMs: 2,
      maxConsecutiveFailures: 2,
    })
    supervisor.start()
    const failure = await waitFor(supervisor, state => state.status === 'failed')
    if (failure.status !== 'failed') throw new Error(`expected a failure, got ${failure.status}`)
    expect(failure.reason).toContain('3 times in a row')
    expect(states.filter(state => state.status === 'restarting')).toHaveLength(2)
  })

  it('starts again after a failure, which is what the retry action does', async () => {
    const entry = join(directory, 'runtime.cjs')
    await writeFile(entry, FAILING_RUNTIME)
    const { supervisor } = supervise(entry, {
      healthyUptimeMs: 60_000,
      baseDelayMs: 1,
      maxDelayMs: 2,
      maxConsecutiveFailures: 1,
    })
    supervisor.start()
    await waitFor(supervisor, state => state.status === 'failed')
    await writeFile(entry, SERVING_RUNTIME)
    supervisor.start()
    await waitFor(supervisor, state => state.status === 'ready')
    expect(supervisor.url).toBe('http://127.0.0.1:65000')
    await supervisor.stop()
  })

  it('reports no process once stopped', async () => {
    const { supervisor } = supervise(await writeRuntime(SERVING_RUNTIME))
    supervisor.start()
    await waitFor(supervisor, state => state.status === 'ready')
    await supervisor.stop()
    expect(supervisor.pid).toBeUndefined()
    expect(supervisor.url).toBeUndefined()
  })

  it('resolves a stop that had nothing to stop', async () => {
    const { supervisor } = supervise(await writeRuntime(SERVING_RUNTIME))
    await supervisor.stop()
    expect(supervisor.current).toEqual({ status: 'stopped' })
  })
})
