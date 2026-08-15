/**
 * The native menu, built from what the runtime contributes.
 *
 * The shell owns a floor and nothing above it. The floor is the platform's own
 * operations — Quit, the edit roles, the window roles — which have to exist
 * whether or not a runtime is running, because a window with no way to close
 * or quit is not usable. Everything else is a contribution: which commands
 * appear, what they are called, where they sit, and which chord answers to
 * them all arrive from the runtime, so mounting a plugin grows the menu and
 * unmounting it returns to the floor.
 * @module @omdsh-plugins/omdsh-desktop/native-menu
 */

import type { MenuItemConstructorOptions } from 'electron'
import type { MenuDocument, MenuItem, MenuSection, ShellCommand } from './menu-contract.ts'

/** What a contributed item does when pressed. */
export interface MenuHandlers {
  /**
   * Perform one of this shell's native capabilities.
   * @param command - the capability named.
   * @param checked - the new checkbox state, for the items that carry one.
   */
  runShellCommand: (command: ShellCommand, checked: boolean) => void
  /**
   * Hand one item back to the runtime that contributed it.
   *
   * The end of this shell's involvement. Whether the runtime performs it or
   * forwards it to a browser client is decided there, from a document this
   * shell reads only as far as it needs to render a menu.
   * @param id - the item's identity.
   */
  invokeRuntimeCommand: (id: string) => void
  /**
   * The current state of a checkbox item, which the shell owns rather than
   * the contribution.
   * @param command - the capability the checkbox toggles.
   * @returns whether it is currently on.
   */
  checkboxState: (command: ShellCommand) => boolean
}

/**
 * Turn one contributed item into a menu entry.
 * @param item - the contributed item.
 * @param handlers - what its press runs.
 * @returns the entry.
 */
function entryFor(item: MenuItem, handlers: MenuHandlers): MenuItemConstructorOptions {
  const checkbox = item.checkbox === true && item.command.kind === 'shell'
  return {
    label: item.label,
    ...item.accelerator !== undefined && { accelerator: item.accelerator },
    ...checkbox && item.command.kind === 'shell' && {
      type: 'checkbox' as const,
      checked: handlers.checkboxState(item.command.name),
    },
    click: (entry) => {
      // Anything this shell does not perform itself goes back the way it came,
      // named by id and nothing else. Tested against `shell` rather than for
      // each of the others so that a kind added to the document later travels
      // by default instead of silently doing nothing.
      if (item.command.kind !== 'shell') {
        handlers.invokeRuntimeCommand(item.id)
        return
      }
      handlers.runShellCommand(item.command.name, entry.checked)
    },
  }
}

/**
 * The contributed entries of one section.
 * @param document - the contribution.
 * @param section - the section to collect.
 * @param handlers - what each press runs.
 * @returns the entries, in document order.
 */
function section(document: MenuDocument, name: MenuSection, handlers: MenuHandlers): MenuItemConstructorOptions[] {
  return document.items.filter(item => item.section === name).map(item => entryFor(item, handlers))
}

/**
 * Prefix a group with a separator, unless it is empty.
 * @param entries - the group.
 * @returns the group with its separator, or nothing.
 */
function grouped(entries: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return entries.length === 0 ? [] : [{ type: 'separator' }, ...entries]
}

/**
 * Build the whole template.
 *
 * macOS keeps the standard app menu and puts the app-section contributions
 * there. Windows and Linux have no app menu, so those contributions join the
 * File menu beside the file-section ones, which is where that platform's users
 * look for application-wide settings.
 * @param document - what the runtime contributes; an empty one leaves the floor.
 * @param handlers - what a contributed press runs.
 * @param platform - the host OS; defaults to this process.
 * @returns the template to install with `Menu.buildFromTemplate`.
 */
export function buildMenuTemplate(
  document: MenuDocument,
  handlers: MenuHandlers,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin'
  const app = section(document, 'app', handlers)
  const file = section(document, 'file', handlers)
  const view = section(document, 'view', handlers)
  const windowItems = section(document, 'window', handlers)
  const help = section(document, 'help', handlers)

  const template: MenuItemConstructorOptions[] = []
  if (mac) {
    template.push({
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        ...grouped(app),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }
  template.push({
    role: 'fileMenu',
    submenu: mac
      ? [...file, ...file.length > 0 ? [{ type: 'separator' as const }] : [], { role: 'close' }]
      : [...file, ...grouped(app), { type: 'separator' }, { role: 'quit' }],
  })
  template.push({ role: 'editMenu' })
  template.push({
    role: 'viewMenu',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      ...grouped(view),
      { type: 'separator' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  })
  template.push({
    role: 'windowMenu',
    ...windowItems.length > 0 && {
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...mac ? [{ role: 'front' as const }] : [{ role: 'close' as const }],
        ...grouped(windowItems),
      ],
    },
  })
  if (help.length > 0) template.push({ role: 'help', submenu: help })
  return template
}
