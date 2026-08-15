/**
 * A restarting subscription over one of the harness API's server-to-client
 * streams.
 *
 * A stream ends whenever the runtime restarts, so the shell reopens it rather
 * than treating the end as terminal; the runtime's own state is authoritative
 * on reconnect, and every frame union the shell folds is a full snapshot or a
 * self-contained transition.
 * @module @omdsh-plugins/omdsh-desktop/frame-stream
 */

import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'

/** Delay before reopening a stream that ended or failed. */
const DEFAULT_RETRY_MS = 1_000

/** How to open one stream and what to do with its frames. */
export interface FrameStreamOptions<F> {
  /**
   * Open the stream.
   * @param signal - aborted when the subscription stops.
   * @returns the frame iterable.
   */
  open: (signal: AbortSignal) => AsyncIterable<RpcRequest<F>>
  /**
   * Handle one frame.
   * @param request - the narrow server-request form, whose `rpcId` identifies answerable frames.
   */
  onFrame: (request: RpcRequest<F>) => void
  /**
   * Report a stream that ended unexpectedly.
   * @param message - a one-line diagnostic.
   */
  onLog?: (message: string) => void
  /** Delay before reopening; defaults to one second. */
  retryDelayMs?: number
}

/**
 * Subscribe to a stream until the returned disposer runs.
 * @param options - stream opener, frame handler, and retry pacing.
 * @returns the disposer, which aborts the open stream and cancels any pending retry.
 */
export function startFrameStream<F>(options: FrameStreamOptions<F>): () => void {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_MS
  let stopped = false
  let controller = new AbortController()
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  // The resolver is held so the disposer can SETTLE a pending retry, not only
  // cancel its timer. Clearing the timeout alone leaves `run()` suspended on a
  // promise nothing will ever resolve, and that suspension retains `options` —
  // and through it the API client and the application's callbacks — for the
  // life of the process. `closeStreams()` runs on every non-ready runtime
  // transition, so a restart landing inside a retry window leaks one each time.
  let wake: (() => void) | undefined
  const wait = (): Promise<void> => new Promise((resolve) => {
    wake = resolve
    retryTimer = setTimeout(resolve, retryDelayMs)
  })

  const run = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController()
      try {
        for await (const request of options.open(controller.signal)) {
          options.onFrame(request)
        }
      } catch (error) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the disposer can stop this while the stream is awaited.
        if (!stopped) options.onLog?.(`desktop: event stream ended: ${error instanceof Error ? error.message : String(error)}`)
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the disposer can stop the subscription while the stream is awaited.
      if (stopped) return
      await wait()
    }
  }

  void run()

  return () => {
    stopped = true
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    // Resumes `run()`, which sees `stopped` and returns.
    wake?.()
    controller.abort()
  }
}
