/**
 * The local boot surface as the shell serves it: what each waiting state says,
 * the way out every one of them carries, and the keys the page answers itself.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM, VirtualConsole, type DOMWindow } from 'jsdom'
import { describe, expect, it } from 'vitest'

const page = readFileSync(join(import.meta.dirname, '..', 'resources', 'boot.html'), 'utf8')

/**
 * Render the surface the way the window host loads it.
 * @param state - the surface to show.
 * @param note - what else the shell knows about this state, when it knows something.
 * @returns the rendered document, its window, and everything its script reported.
 */
function render(state: string, note?: string): { document: Document; window: DOMWindow; errors: string[] } {
  const query = new URLSearchParams({ state, ...note !== undefined && { note } })
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error: Error) => {
    // "Not implemented" names a browser API jsdom lacks, not something the
    // page got wrong.
    if (!error.message.startsWith('Not implemented:')) errors.push(error.message)
  })
  const dom = new JSDOM(page, {
    url: `file:///boot.html?${query.toString()}`,
    runScripts: 'dangerously',
    virtualConsole,
  })
  return { document: dom.window.document, window: dom.window, errors }
}

/**
 * Press one key on the surface, from the element that holds focus.
 * @param window - the rendered window.
 * @param key - the pressed key.
 * @param from - the focused element; the body when nothing is focused.
 */
function press(window: DOMWindow, key: string, from: Element): void {
  from.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
}

/**
 * Count what one control is asked to do.
 * @param element - the control to watch.
 * @returns a function returning how many clicks it has taken.
 */
function clicks(element: Element): () => number {
  let count = 0
  element.addEventListener('click', () => { count += 1 })
  return () => count
}

/**
 * The destinations of the buttons one surface carries.
 * @param document - the rendered document.
 * @returns each action link's href, in the order rendered.
 */
function actions(document: Document): (string | null)[] {
  return [...document.querySelectorAll('.actions a')].map(link => link.getAttribute('href'))
}

describe('the boot surface', () => {
  it('shows what a slow start is doing rather than only a spinner', () => {
    const { document, errors } = render('starting', 'booting the harness')
    expect(errors).toEqual([])
    expect(document.querySelector('#message')?.textContent).toBe('booting the harness…')
  })

  it('gives a slow start a way out, so a stall is not a force-quit', () => {
    const { document } = render('starting', 'booting the harness')
    expect(actions(document)).toEqual([
      'dsh-action:cancel-start',
      'dsh-action:open-log',
      'dsh-action:quit',
    ])
  })

  it('offers to start a stopped runtime again rather than claiming it is starting', () => {
    const { document } = render('stopped')
    expect(document.querySelector('.actions a.primary')?.getAttribute('href')).toBe('dsh-action:retry')
    expect(document.querySelector('#headline')?.textContent).toContain('not running')
  })

  it('explains a failed start and offers to try it again', () => {
    const { document, errors } = render('failed', 'the runtime exited immediately')
    expect(errors).toEqual([])
    expect(document.body.className).toBe('failed')
    expect(document.querySelector('#detail')?.textContent).toBe('the runtime exited immediately')
    expect(actions(document)).toEqual([
      'dsh-action:retry',
      'dsh-action:open-log',
      'dsh-action:quit',
    ])
  })

  it('says so plainly when a failure reported no reason', () => {
    const { document } = render('failed')
    expect(document.querySelector('#detail')?.textContent).toBe('No reason was reported.')
  })

  it('stops a slow start on Escape, which is the way out of a boot that stalls', () => {
    const { document, window } = render('starting', 'booting the harness')
    const stop = document.querySelector('.actions a[href="dsh-action:cancel-start"]')
    if (stop === null) throw new Error('a starting surface offers no way out')
    const taken = clicks(stop)
    press(window, 'Escape', document.body)
    expect(taken()).toBe(1)
  })

  it('retries a failed start on Enter while nothing else holds focus', () => {
    const { document, window } = render('failed')
    const retry = document.querySelector('.actions a.primary')
    if (retry === null) throw new Error('the failed surface offers no retry')
    const taken = clicks(retry)
    press(window, 'Enter', document.body)
    press(window, 'Enter', retry)
    // The focused link answers Enter with itself; the surface must not run it twice.
    expect(taken()).toBe(1)
  })
})
