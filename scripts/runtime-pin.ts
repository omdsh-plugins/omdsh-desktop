/**
 * Which harness release this application ships.
 *
 * `runtime/package.json` is the one place that records it: the workspace
 * installs it there so a checkout run supervises the same release a packaged
 * one embeds, and the packaging pipeline reads it here so both come from the
 * same line. A local-harness override replaces its specifier with a `link:`
 * (see `scripts/harness-source.ts`), which this module passes through
 * unchanged — the closure installer materializes whatever it resolves to.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The manifest naming the release the application ships. */
export const RUNTIME_MANIFEST = join('runtime', 'package.json')

/** The npm package whose closure a deployed harness runtime is. */
export const HARNESS_PACKAGE = '@deepseek-ai/dsh'

/** What the runtime manifest declares. */
interface RuntimeManifest {
  /** The pinned harness release, and anything else the closure needs. */
  dependencies?: Record<string, string>
  /** pnpm settings, carrying an `overrides` block when one is active. */
  pnpm?: Record<string, unknown>
}

/** The release the application ships, ready to hand to the closure installer. */
export interface RuntimePin {
  /** The dependency map to install. */
  dependencies: Record<string, string>
  /** pnpm settings the staged install must carry, when the manifest sets any. */
  pnpm?: Record<string, unknown>
  /** The harness specifier itself, for logs and the payload manifest. */
  release: string
}

/**
 * Read the release the application ships.
 * @param root - repository root.
 * @returns the dependency map, pnpm settings, and the harness specifier.
 * @throws Error when the manifest names no harness release.
 */
export async function readRuntimePin(root: string): Promise<RuntimePin> {
  const manifest = JSON.parse(await readFile(join(root, RUNTIME_MANIFEST), 'utf8')) as RuntimeManifest
  const release = manifest.dependencies?.[HARNESS_PACKAGE]
  if (release === undefined) {
    throw new Error(`${RUNTIME_MANIFEST} does not depend on ${HARNESS_PACKAGE}; it must name the release to ship.`)
  }
  return {
    dependencies: manifest.dependencies ?? {},
    ...manifest.pnpm !== undefined && { pnpm: manifest.pnpm },
    release,
  }
}
