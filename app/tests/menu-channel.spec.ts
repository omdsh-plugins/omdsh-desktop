/**
 * Following a contribution that comes and goes: the stream's framing, and what
 * the shell shows when the publisher is not there.
 */

import { describe, expect, it, vi } from 'vitest'
import { EMPTY_DOCUMENT, type MenuDocument } from '../src/menu-contract.ts'
import { followMenu, readEventStream } from '../src/menu-channel.ts'

/**
 * A body that yields the given chunks and then ends.
 * @param chunks - the bytes to deliver, in order.
 * @returns the async iterable a response body is.
 */
function body(...chunks: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield encoder.encode(chunk)
    },
  }
}

/**
 * Collect everything a stream yields.
 * @param stream - the stream to drain.
 * @returns the payloads.
 */
async function collect(stream: AsyncIterable<Uint8Array>): Promise<string[]> {
  const out: string[] = []
  for await (const payload of readEventStream(stream)) out.push(payload)
  return out
}

/**
 * Wait for a condition the channel reaches asynchronously.
 * @param predicate - the condition.
 */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('the condition was never reached')
}

describe('readEventStream', () => {
  it('yields one payload per event', async () => {
    expect(await collect(body('data: one\n\ndata: two\n\n'))).toEqual(['one', 'two'])
  })

  it('joins an event split across chunks, which is the ordinary case', async () => {
    expect(await collect(body('data: {"ver', 'sion":1}\n\n'))).toEqual(['{"version":1}'])
  })

  it('joins the data lines of one multi-line event', async () => {
    expect(await collect(body('data: first\ndata: second\n\n'))).toEqual(['first\nsecond'])
  })

  it('ignores the comments and retry lines a stream may carry', async () => {
    expect(await collect(body(': keep-alive\n\ndata: real\n\n'))).toEqual(['real'])
  })

  it('drops an event the stream never terminated', async () => {
    expect(await collect(body('data: complete\n\ndata: truncated'))).toEqual(['complete'])
  })
})

describe('followMenu', () => {
  it('publishes each document the stream carries', async () => {
    const document: MenuDocument = {
      version: 1,
      items: [{ id: 'a', label: 'A', section: 'help', command: { kind: 'runtime' } }],
    }
    const seen: MenuDocument[] = []
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      body: body(`data: ${JSON.stringify(document)}\n\n`),
    }))
    const stop = followMenu({
      origin: 'http://127.0.0.1:1234',
      onDocument: d => seen.push(d),
      onLog: () => {},
    })
    await until(() => seen.length > 0)
    stop()
    expect(seen[0]?.items.map(i => i.id)).toEqual(['a'])
    vi.unstubAllGlobals()
  })

  it('treats a runtime that mounts no such plugin as an empty menu, and does not retry it', async () => {
    const seen: MenuDocument[] = []
    const fetched = vi.fn(async () => ({ ok: false, status: 404, body: null }))
    vi.stubGlobal('fetch', fetched)
    const stop = followMenu({
      origin: 'http://127.0.0.1:1234',
      onDocument: d => seen.push(d),
      onLog: () => {},
    })
    await until(() => seen.length > 0)
    stop()
    // No plugin is a composition this shell serves, not a fault to retry into.
    expect(seen[0]).toEqual(EMPTY_DOCUMENT)
    expect(fetched).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('drops to the empty menu when the publisher ends the stream', async () => {
    const document: MenuDocument = {
      version: 1,
      items: [{ id: 'a', label: 'A', section: 'help', command: { kind: 'runtime' } }],
    }
    const seen: MenuDocument[] = []
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      body: body(`data: ${JSON.stringify(document)}\n\n`),
    }))
    const stop = followMenu({
      origin: 'http://127.0.0.1:1234',
      onDocument: d => seen.push(d),
      onLog: () => {},
    })
    // One document, then the empty one the ended stream means.
    await until(() => seen.length > 1)
    stop()
    expect(seen[0]?.items).toHaveLength(1)
    expect(seen[seen.length - 1]).toEqual(EMPTY_DOCUMENT)
    vi.unstubAllGlobals()
  })

  it('shows no contributed menu when the runtime cannot be reached', async () => {
    const seen: MenuDocument[] = []
    vi.stubGlobal('fetch', async () => { throw new Error('connection refused') })
    const stop = followMenu({
      origin: 'http://127.0.0.1:1234',
      onDocument: d => seen.push(d),
      onLog: () => {},
    })
    await until(() => seen.length > 0)
    stop()
    expect(seen[0]).toEqual(EMPTY_DOCUMENT)
    vi.unstubAllGlobals()
  })
})
