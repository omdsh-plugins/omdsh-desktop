/**
 * The menu contribution over a real socket.
 *
 * The unit tests either side of this one check the parsing and the template
 * against values handed to them directly. This one puts an actual HTTP server
 * on loopback, serving the bytes the contract describes, and drives the whole
 * consumer path across it: stream framing, JSON, the parse that rejects what
 * this build cannot render, and the template that comes out. What it does not
 * cover is the Cordis mounting that puts the publisher inside a runtime —
 * that is composition, not wire.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { MENU_EVENTS_PATH, MENU_INVOKE_PATH, type MenuDocument } from '../src/menu-contract.ts'
import { followMenu, invokeRuntimeCommand } from '../src/menu-channel.ts'
import { buildMenuTemplate, type MenuHandlers } from '../src/native-menu.ts'

/** The document a publisher serves, in the contract's own shape. */
const PUBLISHED = {
  version: 1,
  items: [
    { id: 'new-window', label: 'New Window', section: 'file', command: { kind: 'shell', name: 'new-window' }, accelerator: 'CmdOrCtrl+N' },
    { id: 'idle', label: 'Release Memory When Idle', section: 'app', command: { kind: 'shell', name: 'toggle-idle-suspend' }, checkbox: true },
    { id: 'say-hello', label: 'Say Hello', section: 'help', command: { kind: 'runtime' } },
    // A capability no shell has: it must not reach the menu bar.
    { id: 'ghost', label: 'Ghost', section: 'view', command: { kind: 'shell', name: 'summon-a-ghost' } },
  ],
}

let server: Server | undefined

afterEach(async () => {
  const running = server
  server = undefined
  if (running !== undefined) await new Promise<void>(resolve => running.close(() => resolve()))
})

/**
 * Serve one publisher on loopback.
 * @param routes - what each path answers.
 * @returns the origin it listens on.
 */
async function publish(routes: {
  events?: (write: (chunk: string) => void) => void
  invoke?: (body: string) => number
}): Promise<string> {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === MENU_EVENTS_PATH && routes.events !== undefined) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      routes.events(chunk => res.write(chunk))
      return
    }
    if (path === MENU_INVOKE_PATH && routes.invoke !== undefined) {
      let body = ''
      req.on('data', chunk => { body += String(chunk) })
      req.on('end', () => {
        res.writeHead(routes.invoke?.(body) ?? 200, { 'content-type': 'application/json' })
        res.end('{}')
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
  const port = (server?.address() as AddressInfo).port
  return `http://127.0.0.1:${String(port)}`
}

/**
 * Wait for a condition the channel reaches asynchronously.
 * @param predicate - the condition.
 */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('the condition was never reached')
}

/** Handlers recording what a press asked for. */
function recording(): MenuHandlers & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    runShellCommand: (command, checked) => calls.push(`shell:${command}:${String(checked)}`),
    invokeRuntimeCommand: id => calls.push(`runtime:${id}`),
    checkboxState: () => true,
  }
}

describe('a contribution carried over loopback', () => {
  it('becomes a menu, with the item this build cannot perform left out', async () => {
    const origin = await publish({
      events: write => { write(`data: ${JSON.stringify(PUBLISHED)}\n\n`) },
    })
    const seen: MenuDocument[] = []
    const stop = followMenu({ origin, onDocument: d => seen.push(d), onLog: () => {} })
    await until(() => seen.length > 0)
    stop()

    const document = seen[0] as MenuDocument
    expect(document.items.map(item => item.id)).toEqual(['new-window', 'idle', 'say-hello'])

    const handlers = recording()
    const template = buildMenuTemplate(document, handlers, 'darwin')
    const labels = JSON.stringify(template)
    expect(labels).toContain('New Window')
    expect(labels).toContain('Say Hello')
    // The unknown capability never reaches the menu bar as a dead entry.
    expect(labels).not.toContain('Ghost')
  })

  it('carries a revision on the same stream, which is what a reconfigured plugin looks like', async () => {
    const revised = { version: 1, items: [{ id: 'only', label: 'Only', section: 'help', command: { kind: 'runtime' } }] }
    const origin = await publish({
      events: (write) => {
        write(`data: ${JSON.stringify(PUBLISHED)}\n\n`)
        setTimeout(() => { write(`data: ${JSON.stringify(revised)}\n\n`) }, 10)
      },
    })
    const seen: MenuDocument[] = []
    const stop = followMenu({ origin, onDocument: d => seen.push(d), onLog: () => {} })
    await until(() => seen.length > 1)
    stop()
    expect(seen[1]?.items.map(item => item.id)).toEqual(['only'])
  })

  it('falls back to the empty menu when nothing publishes one', async () => {
    // A runtime with no such plugin answers 404, which is a composition this
    // shell serves rather than a fault.
    const origin = await publish({})
    const seen: MenuDocument[] = []
    const stop = followMenu({ origin, onDocument: d => seen.push(d), onLog: () => {} })
    await until(() => seen.length > 0)
    stop()
    expect(seen[0]?.items).toEqual([])
    const template = buildMenuTemplate(seen[0] as MenuDocument, recording(), 'darwin')
    // The floor still stands: quit is always reachable.
    expect(JSON.stringify(template)).toContain('"quit"')
  })

  it('posts a runtime item back to the publisher that owns it', async () => {
    const bodies: string[] = []
    const origin = await publish({
      invoke: (body) => { bodies.push(body); return 200 },
    })
    await invokeRuntimeCommand(origin, 'say-hello', () => {})
    expect(bodies).toEqual([JSON.stringify({ id: 'say-hello' })])
  })

  it('reports a refusal rather than failing silently', async () => {
    const logged: string[] = []
    const origin = await publish({ invoke: () => 404 })
    await invokeRuntimeCommand(origin, 'gone', message => logged.push(message))
    expect(logged.join('')).toContain('refused the menu command gone')
  })
})
