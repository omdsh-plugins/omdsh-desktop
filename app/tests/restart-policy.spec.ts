/** Restart pacing: immediate recovery after a served run, backoff and surrender after startup failures. */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RESTART_LIMITS, RestartPolicy } from '../src/restart-policy.ts'

describe('RestartPolicy', () => {
  it('restarts a served run at once', () => {
    const policy = new RestartPolicy()
    expect(policy.recordExit(DEFAULT_RESTART_LIMITS.healthyUptimeMs))
      .toEqual({ action: 'restart', delayMs: 0, attempt: 0 })
  })

  it('doubles the delay for each consecutive startup failure', () => {
    const policy = new RestartPolicy({ ...DEFAULT_RESTART_LIMITS, baseDelayMs: 100, maxDelayMs: 10_000 })
    expect(policy.recordExit(10)).toEqual({ action: 'restart', delayMs: 100, attempt: 1 })
    expect(policy.recordExit(10)).toEqual({ action: 'restart', delayMs: 200, attempt: 2 })
    expect(policy.recordExit(10)).toEqual({ action: 'restart', delayMs: 400, attempt: 3 })
  })

  it('stops doubling at the ceiling', () => {
    const policy = new RestartPolicy({ ...DEFAULT_RESTART_LIMITS, baseDelayMs: 1_000, maxDelayMs: 1_500, maxConsecutiveFailures: 10 })
    policy.recordExit(0)
    expect(policy.recordExit(0)).toEqual({ action: 'restart', delayMs: 1_500, attempt: 2 })
    expect(policy.recordExit(0)).toEqual({ action: 'restart', delayMs: 1_500, attempt: 3 })
  })

  it('gives up past the consecutive-failure bound', () => {
    const policy = new RestartPolicy({ ...DEFAULT_RESTART_LIMITS, maxConsecutiveFailures: 2 })
    policy.recordExit(0)
    policy.recordExit(0)
    expect(policy.recordExit(0)).toEqual({ action: 'give-up', attempt: 3 })
  })

  it('clears the streak once a run serves long enough', () => {
    const policy = new RestartPolicy({ ...DEFAULT_RESTART_LIMITS, baseDelayMs: 100, maxConsecutiveFailures: 2 })
    policy.recordExit(0)
    policy.recordExit(0)
    policy.recordExit(DEFAULT_RESTART_LIMITS.healthyUptimeMs + 1)
    expect(policy.recordExit(0)).toEqual({ action: 'restart', delayMs: 100, attempt: 1 })
  })

  it('forgets the streak on an explicit reset, which is what a retry does', () => {
    const policy = new RestartPolicy({ ...DEFAULT_RESTART_LIMITS, baseDelayMs: 100, maxConsecutiveFailures: 1 })
    policy.recordExit(0)
    expect(policy.recordExit(0).action).toBe('give-up')
    policy.reset()
    expect(policy.recordExit(0)).toEqual({ action: 'restart', delayMs: 100, attempt: 1 })
  })
})
