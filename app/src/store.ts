/**
 * The desktop shell's own persisted preferences, kept beside Electron's user
 * data rather than in the harness home: they describe this shell's window and
 * power behavior, which no other harness surface shares.
 * @module @omdsh-plugins/omdsh-desktop/store
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeGeometry, type Rect, type WindowGeometry } from './window-state.ts'

/** The stored document, in whatever shape a previous version wrote it. */
type StoredSettings = Record<string, unknown>

/**
 * Reads and writes the shell's preferences, tolerating a missing or damaged
 * file.
 *
 * Geometry is validated on every read rather than cached, because the answer
 * depends on the displays attached at that moment — a cached one would carry a
 * position that a later read, on a different display layout, must reject.
 */
export class SettingsStore {
  private document: StoredSettings | undefined

  /** @param path - the settings file; its directory is created on first write. */
  constructor(private readonly path: string) {}

  /**
   * Geometry for a new window.
   * @param displays - work areas of the attached displays.
   * @returns stored geometry that lands on one of them, or the default.
   */
  readGeometry(displays: readonly Rect[]): WindowGeometry {
    return normalizeGeometry(this.read().geometry, displays)
  }

  /**
   * Remember a window's geometry.
   * @param geometry - the bounds to store.
   */
  writeGeometry(geometry: WindowGeometry): void {
    this.write({ ...this.read(), geometry })
  }

  /** Whether an idle runtime is stopped to release its memory; on unless stored otherwise. */
  readIdleSuspend(): boolean {
    return this.read().idleSuspend !== false
  }

  /**
   * Remember the idle memory-release setting.
   * @param enabled - the new setting.
   */
  writeIdleSuspend(enabled: boolean): void {
    this.write({ ...this.read(), idleSuspend: enabled })
  }

  /**
   * Bundles this shell has already offered to the harness profile.
   *
   * Kept here rather than in the profile because it records what this
   * application DID, not what the profile holds: a bundle that appears in
   * neither is one the user removed, and telling the two apart is the whole
   * reason a shipped plugin can be uninstalled and stay uninstalled.
   * @returns the recorded names, or none when the file holds no usable list.
   */
  readOfferedBundles(): string[] {
    const stored = this.read().offeredBundles
    if (!Array.isArray(stored)) return []
    return stored.filter((entry): entry is string => typeof entry === 'string')
  }

  /**
   * Remember which bundles have been offered.
   * @param names - the complete list, replacing whatever was stored.
   */
  writeOfferedBundles(names: readonly string[]): void {
    this.write({ ...this.read(), offeredBundles: [...names] })
  }


  /**
   * The stored document, parsed once.
   * @returns the document, or an empty one when the file is absent or unreadable.
   */
  private read(): StoredSettings {
    if (this.document !== undefined) return this.document
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      // No settings yet, or a file this build cannot read: defaults apply and
      // the next write replaces it.
      parsed = undefined
    }
    this.document = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as StoredSettings
      : {}
    return this.document
  }

  /**
   * Replace the stored document.
   * @param document - the values to persist.
   */
  private write(document: StoredSettings): void {
    this.document = document
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, `${JSON.stringify(document, undefined, 2)}\n`)
  }
}
