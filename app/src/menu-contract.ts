/**
 * The menu document the runtime contributes, and what this shell will accept
 * as one.
 *
 * The shape is restated here rather than imported from the plugin that
 * publishes it. The two travel separately by design — a plugin is mounted and
 * unmounted against a shell that is already installed — so a shared type would
 * be a build-time coupling standing in for a wire contract that has to be
 * checked at runtime anyway. Everything arriving here is parsed as untrusted
 * input, and anything this build does not understand is dropped rather than
 * rendered as an item that would do nothing when pressed.
 * @module @omdsh-plugins/omdsh-desktop/menu-contract
 */

/** The wire version this build speaks. */
export const MENU_CONTRACT_VERSION = 1

/** Where the document is read from. */
export const MENU_PATH = '/api/desktop/menu'

/** Where a runtime-owned command is posted back to. */
export const MENU_INVOKE_PATH = '/api/desktop/menu.invoke'

/** The stream carrying the document and its later revisions. */
export const MENU_EVENTS_PATH = '/api/desktop/menu.events'

/** The native capabilities this shell performs, and the only ones it will render. */
export const SHELL_COMMANDS = [
  'new-window',
  'restart-runtime',
  'reveal-log',
  'open-in-browser',
  'toggle-idle-suspend',
] as const

/** One native capability. */
export type ShellCommand = (typeof SHELL_COMMANDS)[number]

/** The top-level menus an item may join. */
export const MENU_SECTIONS = ['app', 'file', 'view', 'window', 'help'] as const

/** Which top-level menu an item joins. */
export type MenuSection = (typeof MENU_SECTIONS)[number]

/**
 * What pressing one item does.
 *
 * Only the first kind is this shell's work. For the other two it posts the id
 * back and stops caring: whether the runtime performs the command itself or
 * hands it on to whichever browser client is in front is a routing decision
 * behind that one route, and one this shell is in no position to make. It
 * distinguishes them at all only because the document does, and dropping a
 * distinction on the way in would mean re-deriving it on the way out.
 */
export type MenuCommand =
  /** This shell performs it. */
  | { kind: 'shell'; name: ShellCommand }
  /** The shell posts the id back and the runtime performs it. */
  | { kind: 'runtime' }
  /** The shell posts the id back and the runtime forwards it to a browser client. */
  | { kind: 'browser' }

/** One menu item, as this build understands it. */
export interface MenuItem {
  id: string
  label: string
  section: MenuSection
  command: MenuCommand
  accelerator?: string
  checkbox?: boolean
}

/** A whole contribution. */
export interface MenuDocument {
  version: number
  items: MenuItem[]
}

/** The document a shell shows when no runtime contributes one. */
export const EMPTY_DOCUMENT: MenuDocument = { version: MENU_CONTRACT_VERSION, items: [] }

/**
 * Read one field as a non-empty string.
 * @param source - the object to read.
 * @param key - the field name.
 * @returns the trimmed value, or `undefined` when it is not usable text.
 */
function text(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Read one item's command.
 * @param value - the `command` field as it arrived.
 * @returns the command, or `undefined` when this build cannot perform it.
 */
function parseCommand(value: unknown): MenuCommand | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value as Record<string, unknown>
  if (source.kind === 'runtime') return { kind: 'runtime' }
  if (source.kind === 'browser') return { kind: 'browser' }
  if (source.kind !== 'shell') return undefined
  const name = source.name
  // A capability this build does not have: dropping the item is the honest
  // answer, because rendering it would put a dead entry on the menu bar.
  if (!(SHELL_COMMANDS as readonly unknown[]).includes(name)) return undefined
  return { kind: 'shell', name: name as ShellCommand }
}

/**
 * Read one item.
 * @param value - the item as it arrived.
 * @returns the item, or `undefined` when it is not one this build can render.
 */
export function parseMenuItem(value: unknown): MenuItem | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value as Record<string, unknown>
  const id = text(source, 'id')
  const label = text(source, 'label')
  const section = text(source, 'section')
  const command = parseCommand(source.command)
  if (id === undefined || label === undefined || command === undefined) return undefined
  if (section === undefined || !(MENU_SECTIONS as readonly string[]).includes(section)) return undefined
  const accelerator = text(source, 'accelerator')
  return {
    id,
    label,
    section: section as MenuSection,
    command,
    ...accelerator !== undefined && { accelerator },
    ...source.checkbox === true && { checkbox: true },
  }
}

/**
 * Read a whole contribution.
 *
 * A document whose version this build does not speak is empty rather than
 * partially understood: the shell would otherwise render half a menu from a
 * plugin that meant something else by the same fields.
 * @param value - the document as it arrived.
 * @returns the items this build can render, in document order.
 */
export function parseMenuDocument(value: unknown): MenuDocument {
  if (typeof value !== 'object' || value === null) return EMPTY_DOCUMENT
  const source = value as Record<string, unknown>
  if (source.version !== MENU_CONTRACT_VERSION) return EMPTY_DOCUMENT
  if (!Array.isArray(source.items)) return EMPTY_DOCUMENT
  const items: MenuItem[] = []
  const seen = new Set<string>()
  for (const entry of source.items) {
    const item = parseMenuItem(entry)
    // A repeated id would make an invocation ambiguous; the first wins, which
    // is the same rule the publisher enforces before it serves the document.
    if (item === undefined || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  return { version: MENU_CONTRACT_VERSION, items }
}
