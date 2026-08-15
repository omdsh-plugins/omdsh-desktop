/**
 * The native menu: the floor that stands without a runtime, and what a
 * contribution adds to it.
 */

import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_DOCUMENT, type MenuDocument } from '../src/menu-contract.ts'
import { buildMenuTemplate, type MenuHandlers } from '../src/native-menu.ts'

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'win32']

/**
 * Every entry in a template, submenus included.
 * @param template - the template to walk.
 * @returns the entries, depth first.
 */
function flatten(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((entry) => {
    const submenu = Array.isArray(entry.submenu) ? flatten(entry.submenu) : []
    return [entry, ...submenu]
  })
}

/**
 * Find one entry by its label.
 * @param template - the template to search.
 * @param label - the label to find.
 * @returns the entry.
 */
function item(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = flatten(template).find(entry => entry.label === label)
  if (found === undefined) throw new Error(`no menu item labelled ${label}`)
  return found
}

/**
 * Handlers that record what they were asked to do.
 * @param checked - what the checkbox state reads as.
 * @returns the handlers and their recordings.
 */
function recording(checked = true) {
  const handlers: MenuHandlers = {
    runShellCommand: vi.fn(),
    invokeRuntimeCommand: vi.fn(),
    checkboxState: () => checked,
  }
  return handlers
}

/** A contribution exercising every kind of item. */
const DOCUMENT: MenuDocument = {
  version: 1,
  items: [
    { id: 'new-window', label: 'New Window', section: 'file', command: { kind: 'shell', name: 'new-window' }, accelerator: 'CmdOrCtrl+N' },
    { id: 'restart', label: 'Restart Harness Runtime', section: 'view', command: { kind: 'shell', name: 'restart-runtime' } },
    { id: 'idle', label: 'Release Memory When Idle', section: 'app', command: { kind: 'shell', name: 'toggle-idle-suspend' }, checkbox: true },
    { id: 'say-hello', label: 'Say Hello', section: 'help', command: { kind: 'runtime' } },
    { id: 'ask', label: 'Ask Here', section: 'help', command: { kind: 'browser' }, accelerator: 'CmdOrCtrl+K' },
  ],
}

describe('the floor, with nothing contributed', () => {
  it.each(PLATFORMS)('still offers quit and the window operations on %s', (platform) => {
    const template = buildMenuTemplate(EMPTY_DOCUMENT, recording(), platform)
    const roles = flatten(template).map(entry => entry.role)
    expect(roles).toContain('quit')
    expect(roles).toContain('editMenu')
    expect(roles).toContain('windowMenu')
  })

  it.each(PLATFORMS)('carries no contributed entry and no help menu on %s', (platform) => {
    const template = buildMenuTemplate(EMPTY_DOCUMENT, recording(), platform)
    expect(flatten(template).filter(entry => entry.click !== undefined)).toHaveLength(0)
    expect(template.map(entry => entry.role)).not.toContain('help')
  })
})

describe('a contribution', () => {
  it.each(PLATFORMS)('renders every item with the chord it claims on %s', (platform) => {
    const template = buildMenuTemplate(DOCUMENT, recording(), platform)
    expect(item(template, 'New Window').accelerator).toBe('CmdOrCtrl+N')
    expect(item(template, 'Restart Harness Runtime')).toBeDefined()
    expect(item(template, 'Say Hello')).toBeDefined()
  })

  it('puts an app-section item in the app menu on macOS', () => {
    const template = buildMenuTemplate(DOCUMENT, recording(), 'darwin')
    const appMenu = template.find(entry => entry.role === 'appMenu')
    const labels = Array.isArray(appMenu?.submenu) ? flatten(appMenu.submenu).map(entry => entry.label) : []
    expect(labels).toContain('Release Memory When Idle')
  })

  it('puts it on the File menu where there is no app menu', () => {
    const template = buildMenuTemplate(DOCUMENT, recording(), 'win32')
    const fileMenu = template.find(entry => entry.role === 'fileMenu')
    const labels = Array.isArray(fileMenu?.submenu) ? flatten(fileMenu.submenu).map(entry => entry.label) : []
    expect(labels).toContain('Release Memory When Idle')
    expect(labels).toContain('New Window')
  })

  it('renders a checkbox from the state the shell owns, not from the document', () => {
    const on = buildMenuTemplate(DOCUMENT, recording(true), 'darwin')
    expect(item(on, 'Release Memory When Idle').type).toBe('checkbox')
    expect(item(on, 'Release Memory When Idle').checked).toBe(true)
    const off = buildMenuTemplate(DOCUMENT, recording(false), 'darwin')
    expect(item(off, 'Release Memory When Idle').checked).toBe(false)
  })

  it('runs a shell item here and hands a runtime item back', () => {
    const handlers = recording()
    const template = buildMenuTemplate(DOCUMENT, handlers, 'darwin')
    const press = (label: string, checked = false): void => {
      const entry = item(template, label)
      entry.click?.({ checked } as never, undefined, {} as never)
    }
    press('New Window')
    expect(handlers.runShellCommand).toHaveBeenCalledWith('new-window', false)
    press('Release Memory When Idle', true)
    expect(handlers.runShellCommand).toHaveBeenCalledWith('toggle-idle-suspend', true)
    press('Say Hello')
    expect(handlers.invokeRuntimeCommand).toHaveBeenCalledWith('say-hello')
  })

  it('hands a browser item back the same way, having no page of its own to reach', () => {
    // The chord was claimed natively here, so the press starts in this process
    // and the page never heard it. Everything past this call is the runtime's
    // problem: which client is in front, and whether one is connected at all.
    const handlers = recording()
    const template = buildMenuTemplate(DOCUMENT, handlers, 'darwin')
    item(template, 'Ask Here').click?.({ checked: false } as never, undefined, {} as never)
    expect(handlers.invokeRuntimeCommand).toHaveBeenCalledWith('ask')
    expect(handlers.runShellCommand).not.toHaveBeenCalled()
  })

  it('grows a help menu only when something is contributed to it', () => {
    const template = buildMenuTemplate(DOCUMENT, recording(), 'darwin')
    expect(template.map(entry => entry.role)).toContain('help')
  })
})
