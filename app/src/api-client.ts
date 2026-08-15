/**
 * The desktop shell's client on the harness API.
 *
 * The shell is an ordinary protocol client: it subclasses the shipped client
 * base so envelope parsing, frame validation, and rpcId discipline are the same
 * code the browser client runs. Only the two platform aspects differ — the
 * transport, and the downlink, which the Web carrier serves over WebSocket and
 * answers `426 Upgrade Required` for any plain request.
 * @module @omdsh-plugins/omdsh-desktop/api-client
 */

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { ApiProxy, HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import type { RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'

/** Downlink pathnames, as the Web carrier registers its upgrade routes. */
const MUX_EVENTS_PATH = '/api/events.mux'
const HOST_EVENTS_PATH = '/api/events.host'

/** One item in a socket's inbox: a validated frame, or the end of the stream. */
type SocketItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }

/** The frame validator for one stream. */
interface FrameParser<F> {
  parse: (value: unknown) => F
}

/**
 * Client bound to one runtime origin.
 *
 * The base class resolves a browser's same-origin base from `location`, which
 * a main process does not have, so the origin is supplied instead.
 */
export class DesktopApiClient extends AbstractApiClient {
  /** @param origin - the runtime's loopback origin, as it reported it. */
  constructor(private readonly origin: string) {
    super()
  }

  /**
   * The base every request path resolves against.
   * @returns the runtime origin.
   */
  protected override resolveBase(): string {
    return this.origin
  }

  /**
   * Carry one request over the loopback HTTP server.
   * @param input - absolute request URL.
   * @param init - fetch options, including the stream's abort signal.
   * @returns the response.
   */
  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init)
  }

  /**
   * Open the all-session mux downlink.
   * @param _payload - the stream's request payload; the resume hook is unimplemented.
   * @param signal - aborted when the subscription stops.
   * @param onOpen - called once the socket is open.
   * @returns the frame iterable.
   */
  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket(MUX_EVENTS_PATH, signal, muxFrameSchema, onOpen)
  }

  /**
   * Open the host-level downlink.
   * @param _payload - the stream's empty request payload.
   * @param signal - aborted when the subscription stops.
   * @param onOpen - called once the socket is open.
   * @returns the frame iterable.
   */
  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket(HOST_EVENTS_PATH, signal, hostFrameSchema, onOpen)
  }

  /**
   * Read one downlink socket until it closes or the subscription aborts.
   *
   * A malformed frame is dropped rather than ending the stream: the frame
   * unions are merge-extensible, so a runtime one version ahead can legitimately
   * push something this build cannot parse, and losing the whole stream over it
   * would cost every frame that follows.
   * @param path - the downlink pathname.
   * @param signal - aborted when the subscription stops.
   * @param frameSchema - validator for this stream's frame union.
   * @param onOpen - called once the socket is open.
   * @returns the frames, in arrival order.
   */
  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: FrameParser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    socket.addEventListener('open', () => { onOpen?.() })
    socket.addEventListener('message', (event: MessageEvent) => {
      let full: ServerRequest
      let frame: F
      try {
        if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
        full = serverRequestSchema.parse(JSON.parse(event.data))
        frame = frameSchema.parse(full.payload)
      } catch {
        // Dropping one frame keeps the stream; the fold's own default already
        // covers a frame type this build does not recognize.
        return
      }
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    })
    socket.addEventListener('close', () => { enqueue({ kind: 'end' }) }, { once: true })
    const abort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    socket.addEventListener('error', () => { enqueue({ kind: 'end' }) }, { once: true })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem<F>
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', abort)
      abort()
    }
  }
}
