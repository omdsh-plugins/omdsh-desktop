/**
 * Following the runtime's menu contribution for as long as it serves.
 *
 * The stream is the whole subscription: it publishes the current document as
 * soon as it opens, so there is no separate read, and it carries every later
 * revision on the same connection. What matters here is that the menu tracks a
 * plugin that comes and goes — a runtime serving no such route has simply not
 * mounted one, which is an empty menu rather than an error, and a stream that
 * ends is a plugin that left.
 * @module @omdsh-plugins/omdsh-desktop/menu-channel
 */

import { EMPTY_DOCUMENT, MENU_EVENTS_PATH, MENU_INVOKE_PATH, parseMenuDocument, type MenuDocument } from './menu-contract.ts'

/** How long a dropped stream waits before reconnecting. */
const RETRY_DELAY_MS = 2_000

/** What the channel needs to run. */
export interface MenuChannelOptions {
  /** The runtime's loopback origin. */
  origin: string
  /**
   * Receives every document, starting with the first one the stream carries.
   * @param document - the contribution, empty when the runtime has none.
   */
  onDocument: (document: MenuDocument) => void
  /**
   * Report something worth a line in the runtime log.
   * @param message - the line.
   */
  onLog: (message: string) => void
}

/**
 * Split a server-sent event stream into the payloads of its `data:` lines.
 *
 * Events are separated by a blank line and a payload may span several `data:`
 * lines, so the buffer is drained only at a separator — a partial event held
 * across chunk boundaries is the normal case, not a fault.
 * @param stream - the response body.
 * @returns each event's payload text, in arrival order.
 */
export async function* readEventStream(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let separator = buffer.indexOf('\n\n')
    while (separator !== -1) {
      const event = buffer.slice(0, separator)
      buffer = buffer.slice(separator + 2)
      const payload = event
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trim())
        .join('\n')
      if (payload.length > 0) yield payload
      separator = buffer.indexOf('\n\n')
    }
  }
}

/**
 * Follow one runtime's menu contribution until the subscription is stopped.
 *
 * The document is published as `EMPTY_DOCUMENT` whenever the contribution is
 * unavailable — no such route, an unreadable body, a dropped stream — so the
 * shell's menu falls back to its floor instead of holding entries whose
 * publisher is gone.
 * @param options - the origin to follow and where its documents go.
 * @returns a function ending the subscription.
 */
export function followMenu(options: MenuChannelOptions): () => void {
  const controller = new AbortController()
  let retry: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (retry !== undefined) clearTimeout(retry)
    controller.abort()
  }

  const schedule = (): void => {
    if (stopped) return
    retry = setTimeout(() => { void run() }, RETRY_DELAY_MS)
  }

  const run = async (): Promise<void> => {
    if (stopped) return
    let response: Response
    try {
      response = await fetch(new URL(MENU_EVENTS_PATH, options.origin), {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      })
    }
    catch {
      // The runtime is not answering yet, or went away between the readiness
      // report and this request. Either way there is no menu to show now.
      options.onDocument(EMPTY_DOCUMENT)
      schedule()
      return
    }
    if (response.status === 404) {
      // No plugin contributes a menu right now. That is a composition this
      // shell serves — the platform's own menu — so it is published rather
      // than reported as a failure.
      //
      // But it is not necessarily permanent, so it is retried like any other
      // answer. omdsh-shortcuts registers this route inside a `ctx.effect`,
      // which means the route goes away and comes back whenever that plugin
      // reloads; treating the 404 as terminal left the menu empty until the
      // application was restarted.
      options.onDocument(EMPTY_DOCUMENT)
      schedule()
      return
    }
    if (!response.ok || response.body === null) {
      options.onLog(`desktop: the menu stream answered ${String(response.status)}; showing no contributed menu`)
      options.onDocument(EMPTY_DOCUMENT)
      schedule()
      return
    }
    try {
      for await (const payload of readEventStream(response.body)) {
        let parsed: unknown
        try {
          parsed = JSON.parse(payload)
        }
        catch {
          // One malformed event costs that event, not the subscription.
          continue
        }
        options.onDocument(parseMenuDocument(parsed))
      }
    }
    catch {
      // An aborted read is the stop path; anything else is a dropped stream.
    }
    if (stopped) return
    // The publisher ended the stream: it unmounted, or the runtime is going
    // down. Drop to the floor and wait for it to come back.
    options.onDocument(EMPTY_DOCUMENT)
    schedule()
  }

  void run()
  return stop
}

/**
 * Hand one item back to the runtime that contributed it.
 * @param origin - the runtime's loopback origin.
 * @param id - the item's identity.
 * @param onLog - reports a refusal, which means the shell and the publisher disagree about the document.
 */
export async function invokeRuntimeCommand(
  origin: string,
  id: string,
  onLog: (message: string) => void,
): Promise<void> {
  try {
    const response = await fetch(new URL(MENU_INVOKE_PATH, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!response.ok) onLog(`desktop: the runtime refused the menu command ${id} (${String(response.status)})\n`)
  }
  catch {
    onLog(`desktop: the runtime could not be reached for the menu command ${id}\n`)
  }
}
