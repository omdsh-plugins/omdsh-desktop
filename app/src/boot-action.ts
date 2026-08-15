/**
 * What the local boot surface can ask the shell to do, and how one of its
 * requests is read.
 *
 * The surface is a sandboxed page with no preload, so it reaches the shell by
 * navigating to a scheme the window host intercepts. That navigation is a wire
 * between two processes: this module is where its text becomes a typed request,
 * and where a request this build does not serve stops.
 * @module @omdsh-plugins/omdsh-desktop/boot-action
 */

/** Scheme the boot surface uses for its buttons; navigation to it never happens. */
export const ACTION_SCHEME = 'dsh-action:'

/** What the boot surface can ask the shell to do. */
export type BootAction =
  /** Start the runtime again after a failure. */
  | { kind: 'retry' }
  /** Reveal the runtime log. */
  | { kind: 'open-log' }
  /** Quit the application. */
  | { kind: 'quit' }
  /** Stop a start that is taking too long, without scheduling another. */
  | { kind: 'cancel-start' }

/**
 * Read one intercepted navigation as a request.
 * @param url - the whole intercepted URL, scheme included.
 * @returns the request, or `undefined` when this build serves no such action.
 */
export function parseBootAction(url: string): BootAction | undefined {
  if (!url.startsWith(ACTION_SCHEME)) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // A URL the surface could not have produced; there is nothing to run.
    return undefined
  }
  switch (parsed.pathname) {
    case 'retry':
    case 'open-log':
    case 'quit':
    case 'cancel-start':
      return { kind: parsed.pathname }
    default:
      // An action this build does not serve. The surface and the shell ship
      // together, so nothing else can produce one.
      return undefined
  }
}
