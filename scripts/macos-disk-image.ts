/**
 * The drag-to-install disk image both macOS packagers produce: the application
 * beside an `/Applications` symlink, compressed.
 * @module @omdsh-plugins/omdsh-desktop/scripts/macos-disk-image
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

/** What one disk image needs. */
export interface DiskImageOptions {
  /** The `.app` bundle to pack. */
  appPath: string
  /** Volume name shown when the image is mounted. */
  volumeName: string
  /** Absolute path of the image to write; an existing image is replaced. */
  dmgPath: string
}

/**
 * Pack an application bundle into a compressed disk image.
 * @param options - the bundle, volume name, and destination.
 * @returns the image path.
 */
export async function createDiskImage(options: DiskImageOptions): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), 'dsh-dmg-'))
  try {
    await cp(options.appPath, join(staging, basename(options.appPath)), { recursive: true, verbatimSymlinks: true })
    await symlink('/Applications', join(staging, 'Applications'))
    const result = spawnSync('hdiutil', [
      'create',
      '-volname',
      options.volumeName,
      '-srcfolder',
      staging,
      '-ov',
      '-format',
      'UDZO',
      '-quiet',
      options.dmgPath,
    ], { encoding: 'utf8' })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(`hdiutil exited ${String(result.status)}\n${result.stdout}${result.stderr}`)
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return options.dmgPath
}
