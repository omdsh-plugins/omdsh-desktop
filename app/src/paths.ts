/**
 * Filesystem layout of the two trees the desktop shell runs from: its own
 * Electron app directory, and the harness runtime closure beside it.
 * @module @omdsh-plugins/omdsh-desktop/paths
 */

import { join } from 'node:path'

/** Directory under the Electron `resources` tree holding the deployed harness closure. */
export const RUNTIME_DIRECTORY = 'backend'

/** Path of the `dsh` launcher inside a deployed closure, relative to its root. */
export const RUNTIME_ENTRY_RELATIVE = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** Where the shell is running from, as Electron reports it. */
export interface RuntimeLayout {
  /** Whether this is an installed application rather than a checkout run. */
  packaged: boolean
  /** `process.resourcesPath`. */
  resourcesPath: string
  /** `app.getAppPath()` — the checkout's `app` directory when unpackaged. */
  appPath: string
}

/**
 * Workspace directory whose manifest names the published harness release this
 * application ships. A checkout run supervises the same release the packaged
 * application would, installed under this directory.
 */
const CHECKOUT_RUNTIME_DIRECTORY = 'runtime'

/**
 * Resolve the root of the harness closure this shell runs from.
 *
 * A packaged application owns a deployed closure under its own resources. A
 * checkout run has no deployed closure, so it uses the tree installed for the
 * `runtime` workspace member — the same release the packaged application
 * ships, which is what makes a checkout run representative.
 *
 * The root is worth naming separately from the launcher inside it: the
 * bundles this application ships are installed into the same `node_modules`,
 * beside the launcher rather than under it.
 * @param layout - the running application's layout.
 * @returns the absolute directory whose `node_modules` is the closure.
 */
export function resolveRuntimeRoot(layout: RuntimeLayout): string {
  if (layout.packaged) return join(layout.resourcesPath, RUNTIME_DIRECTORY)
  return join(layout.appPath, '..', CHECKOUT_RUNTIME_DIRECTORY)
}

/**
 * Resolve the harness launcher this shell supervises.
 * @param layout - the running application's layout.
 * @returns the absolute path of the `dsh` launcher.
 */
export function resolveRuntimeEntry(layout: RuntimeLayout): string {
  return join(resolveRuntimeRoot(layout), RUNTIME_ENTRY_RELATIVE)
}
