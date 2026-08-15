/** What this shell accepts as a menu contribution, and what it drops. */

import { describe, expect, it } from 'vitest'
import { EMPTY_DOCUMENT, parseMenuDocument, parseMenuItem } from '../src/menu-contract.ts'

/** A contribution naming one native capability. */
const SHELL_ITEM = {
  id: 'new-window',
  label: 'New Window',
  section: 'file',
  command: { kind: 'shell', name: 'new-window' },
  accelerator: 'CmdOrCtrl+N',
}

describe('parseMenuItem', () => {
  it('reads an item naming a capability this shell has', () => {
    expect(parseMenuItem(SHELL_ITEM)).toEqual({
      id: 'new-window',
      label: 'New Window',
      section: 'file',
      command: { kind: 'shell', name: 'new-window' },
      accelerator: 'CmdOrCtrl+N',
    })
  })

  it('reads an item the runtime performs itself, which needs no capability name', () => {
    expect(parseMenuItem({ id: 'x', label: 'X', section: 'help', command: { kind: 'runtime' } }))
      .toEqual({ id: 'x', label: 'X', section: 'help', command: { kind: 'runtime' } })
  })

  it('reads an item a browser client performs, which this shell only forwards', () => {
    expect(parseMenuItem({ id: 'ask', label: 'Ask', section: 'help', command: { kind: 'browser' }, accelerator: 'CmdOrCtrl+K' }))
      .toEqual({ id: 'ask', label: 'Ask', section: 'help', command: { kind: 'browser' }, accelerator: 'CmdOrCtrl+K' })
  })

  it('keeps the native chord and drops the web one, which is not this shell to hold', () => {
    // `webAccelerator` addresses an in-page listener. The shell renders a menu
    // bar, so reading it would be reading somebody else's binding.
    expect(parseMenuItem({
      id: 'ask',
      label: 'Ask',
      section: 'help',
      command: { kind: 'browser' },
      accelerator: 'CmdOrCtrl+K',
      webAccelerator: 'CmdOrCtrl+Shift+K',
    })).toEqual({ id: 'ask', label: 'Ask', section: 'help', command: { kind: 'browser' }, accelerator: 'CmdOrCtrl+K' })
  })

  it('drops an item naming a capability this build does not have', () => {
    // Rendering it would put an entry on the menu bar that does nothing.
    expect(parseMenuItem({ ...SHELL_ITEM, command: { kind: 'shell', name: 'launch-the-missiles' } }))
      .toBeUndefined()
  })

  it('drops an item in a section this build does not render', () => {
    expect(parseMenuItem({ ...SHELL_ITEM, section: 'sidebar' })).toBeUndefined()
  })

  it('drops an item missing the fields an entry cannot be built without', () => {
    expect(parseMenuItem({ ...SHELL_ITEM, id: '   ' })).toBeUndefined()
    expect(parseMenuItem({ ...SHELL_ITEM, label: '' })).toBeUndefined()
    expect(parseMenuItem({ ...SHELL_ITEM, command: undefined })).toBeUndefined()
    expect(parseMenuItem('not an object')).toBeUndefined()
  })

  it('keeps a checkbox only when it is spelled as one', () => {
    expect(parseMenuItem({ ...SHELL_ITEM, checkbox: true })?.checkbox).toBe(true)
    expect(parseMenuItem({ ...SHELL_ITEM, checkbox: 'yes' })?.checkbox).toBeUndefined()
  })
})

describe('parseMenuDocument', () => {
  it('reads the items it understands, in document order', () => {
    const document = parseMenuDocument({
      version: 1,
      items: [SHELL_ITEM, { id: 'r', label: 'R', section: 'help', command: { kind: 'runtime' } }],
    })
    expect(document.items.map(item => item.id)).toEqual(['new-window', 'r'])
  })

  it('keeps the first of two items sharing an id, because an invocation names one', () => {
    const document = parseMenuDocument({
      version: 1,
      items: [SHELL_ITEM, { ...SHELL_ITEM, label: 'Impostor' }],
    })
    expect(document.items).toHaveLength(1)
    expect(document.items[0]?.label).toBe('New Window')
  })

  it('refuses a whole document whose version this build does not speak', () => {
    // Half a menu read from a plugin that meant something else by these fields
    // is worse than none.
    expect(parseMenuDocument({ version: 2, items: [SHELL_ITEM] })).toEqual(EMPTY_DOCUMENT)
  })

  it('answers the empty document for anything that is not one', () => {
    expect(parseMenuDocument(undefined)).toEqual(EMPTY_DOCUMENT)
    expect(parseMenuDocument({ version: 1 })).toEqual(EMPTY_DOCUMENT)
    expect(parseMenuDocument({ version: 1, items: 'no' })).toEqual(EMPTY_DOCUMENT)
  })

  it('drops the unusable items and keeps the rest', () => {
    const document = parseMenuDocument({
      version: 1,
      items: [SHELL_ITEM, { nonsense: true }, { ...SHELL_ITEM, id: 'other', section: 'nowhere' }],
    })
    expect(document.items.map(item => item.id)).toEqual(['new-window'])
  })
})
