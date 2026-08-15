/**
 * Restart pacing for the supervised runtime process.
 *
 * A runtime that exits after serving for a while is a fault to recover from
 * immediately; one that exits during startup is usually a fault that repeats,
 * so repeated attempts back off and eventually stop rather than spin.
 * @module @omdsh-plugins/omdsh-desktop/restart-policy
 */

/** Pacing bounds; every field is a duration in milliseconds except the attempt count. */
export interface RestartLimits {
  /** Uptime that counts as a served run, which clears the failure streak. */
  healthyUptimeMs: number
  /** Delay after the first startup failure; each further failure doubles it. */
  baseDelayMs: number
  /** Ceiling the doubling stops at. */
  maxDelayMs: number
  /** Startup failures in a row before the supervisor stops restarting. */
  maxConsecutiveFailures: number
}

/** What the supervisor does about one runtime exit. */
export type RestartDecision =
  /** Start again after `delayMs`. */
  | { action: 'restart'; delayMs: number; attempt: number }
  /** Stop trying; `attempt` is how many consecutive startup failures were seen. */
  | { action: 'give-up'; attempt: number }

/** Default pacing: recover fast once, then slow to half-minute retries before giving up. */
export const DEFAULT_RESTART_LIMITS: RestartLimits = {
  healthyUptimeMs: 60_000,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxConsecutiveFailures: 5,
}

/** Failure-streak state behind {@link RestartPolicy.recordExit}. */
export class RestartPolicy {
  private failures = 0

  /** @param limits - pacing bounds; defaults to {@link DEFAULT_RESTART_LIMITS}. */
  constructor(private readonly limits: RestartLimits = DEFAULT_RESTART_LIMITS) {}

  /** Forget the failure streak, so the next exit is treated as the first. */
  reset(): void {
    this.failures = 0
  }

  /**
   * Account for one runtime exit.
   * @param uptimeMs - how long the exited runtime ran.
   * @returns whether to start again, and after how long.
   */
  recordExit(uptimeMs: number): RestartDecision {
    if (uptimeMs >= this.limits.healthyUptimeMs) {
      this.failures = 0
      return { action: 'restart', delayMs: 0, attempt: 0 }
    }
    this.failures += 1
    if (this.failures > this.limits.maxConsecutiveFailures) {
      return { action: 'give-up', attempt: this.failures }
    }
    const delayMs = Math.min(this.limits.baseDelayMs * 2 ** (this.failures - 1), this.limits.maxDelayMs)
    return { action: 'restart', delayMs, attempt: this.failures }
  }
}
