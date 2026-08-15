/**
 * Window ownership: creation, geometry persistence, navigation policy, and
 * routing between the boot surface and the running harness UI.
 *
 * Windows render the harness UI over the runtime's loopback origin, so they
 * carry no preload and stay fully sandboxed; the boot surface reaches the
 * shell through a scheme this module intercepts instead.
 * @module @omdsh-plugins/omdsh-desktop/windows
 */

import { BrowserWindow, screen, shell } from 'electron'
import { ACTION_SCHEME, parseBootAction, type BootAction } from './boot-action.ts'
import type { RuntimeState } from './runtime-supervisor.ts'
import { surfaceFor } from './surface.ts'
import type { SettingsStore } from './store.ts'
import { MIN_HEIGHT, MIN_WIDTH, type Rect } from './window-state.ts'

/** Window background, matched to the boot surface so a cold start shows no white flash. */
const BACKGROUND_COLOR = '#101014'

/** Delay between a geometry change and writing it, so a drag writes once. */
const GEOMETRY_WRITE_DELAY_MS = 500

/**
 * Address parameter that asks the harness UI to start the window on a session
 * of its own rather than the one this browser profile last selected. The web
 * client owns the parameter and spends it on the first load.
 */
const NEW_SESSION_PARAM = 'new'

/** What the window host needs from the application. */
export interface WindowHostOptions {
  /** Absolute path of the boot surface HTML file. */
  bootPage: string
  /** Store the restored geometry comes from and is written back to. */
  settings: SettingsStore
  /**
   * Handle a boot-surface button.
   * @param action - the requested action.
   */
  onAction: (action: BootAction) => void
  /** Called whenever the number of open windows changes. */
  onWindowCountChange: () => void
}

/**
 * The runtime address that asks the harness UI for a session of this window's
 * own.
 * @param url - the runtime origin.
 * @returns the address to load.
 */
function withNewSession(url: string): string {
  const target = new URL(url)
  target.searchParams.set(NEW_SESSION_PARAM, '1')
  return target.href
}

/** Owns every window and keeps each one pointed at the right surface. */
export class WindowHost {
  private readonly windows = new Set<BrowserWindow>()
  private readonly routed = new WeakMap<BrowserWindow, string>()
  /** Windows still owed their own session; membership is spent on the first load of the harness UI. */
  private readonly owedFreshSession = new WeakSet<BrowserWindow>()
  /** The runtime's condition, as its supervisor last reported. */
  private state: RuntimeState | undefined
  private geometryTimer: ReturnType<typeof setTimeout> | undefined

  /** @param options - boot surface, settings store, and shell callbacks. */
  constructor(private readonly options: WindowHostOptions) {}

  /** How many windows are open. */
  get count(): number {
    return this.windows.size
  }

  /** Whether any window currently has focus. */
  get anyFocused(): boolean {
    for (const window of this.windows) {
      if (window.isFocused()) return true
    }
    return false
  }

  /** Work areas of the attached displays, which geometry validation is checked against. */
  private get displays(): Rect[] {
    return screen.getAllDisplays().map(display => display.workArea)
  }

  /**
   * Open one window, restoring the stored geometry.
   * @param options - `freshSession` starts the window on a session of its own instead of the last selected one.
   */
  open(options: { freshSession?: boolean } = {}): void {
    const geometry = this.options.settings.readGeometry(this.displays)
    const window = new BrowserWindow({
      width: geometry.width,
      height: geometry.height,
      ...geometry.x !== undefined && geometry.y !== undefined && { x: geometry.x, y: geometry.y },
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      backgroundColor: BACKGROUND_COLOR,
      show: false,
      title: 'DeepSeek Harness',
      webPreferences: {
        // The harness UI is ordinary web content this shell does not extend,
        // so it runs with the strongest defaults Electron offers.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: true,
      },
    })
    this.windows.add(window)
    if (options.freshSession === true) this.owedFreshSession.add(window)
    this.attach(window)
    this.route(window)
    window.once('ready-to-show', () => { window.show() })
    this.options.onWindowCountChange()
  }

  /** Open a window when none is open, which is what a Dock activation asks for. */
  ensureOpen(): void {
    if (this.windows.size === 0) this.open()
  }

  /**
   * The window a menu command acts on: the focused one, else any open one.
   * @returns that window, or `undefined` when none is open.
   */
  current(): BrowserWindow | undefined {
    const focused = BrowserWindow.getFocusedWindow()
    return focused !== null && this.windows.has(focused) ? focused : [...this.windows][0]
  }

  /**
   * Bring the application forward: raise an existing window, or open one.
   * A notification the user clicked has to land on a visible session.
   */
  present(): void {
    const window = BrowserWindow.getFocusedWindow() ?? [...this.windows][0]
    if (window === undefined) {
      this.open()
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /**
   * Point every window at the surface the runtime's condition calls for.
   * @param state - the runtime's current condition.
   */
  applyRuntimeState(state: RuntimeState): void {
    this.state = state
    for (const window of this.windows) this.route(window)
  }

  /** Persist the geometry of the frontmost window before the application exits. */
  flushGeometry(): void {
    if (this.geometryTimer !== undefined) clearTimeout(this.geometryTimer)
    this.geometryTimer = undefined
    const window = BrowserWindow.getFocusedWindow() ?? [...this.windows][0]
    if (window === undefined || window.isDestroyed()) return
    this.writeGeometry(window)
  }

  /**
   * Wire one window's lifecycle, navigation policy, and crash recovery.
   * @param window - the window to attach to.
   */
  private attach(window: BrowserWindow): void {
    const scheduleGeometry = (): void => {
      if (this.geometryTimer !== undefined) clearTimeout(this.geometryTimer)
      this.geometryTimer = setTimeout(() => {
        this.geometryTimer = undefined
        if (!window.isDestroyed()) this.writeGeometry(window)
      }, GEOMETRY_WRITE_DELAY_MS)
    }
    window.on('resize', scheduleGeometry)
    window.on('move', scheduleGeometry)
    window.once('closed', () => {
      this.windows.delete(window)
      this.options.onWindowCountChange()
    })
    window.on('close', () => { this.writeGeometry(window) })


    window.webContents.setWindowOpenHandler(({ url }) => {
      // Everything the harness UI opens in a new context is an external
      // destination; the shell has one window kind and it is this one.
      this.openExternal(url)
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith(ACTION_SCHEME)) {
        event.preventDefault()
        const action = parseBootAction(url)
        if (action !== undefined) this.options.onAction(action)
        return
      }
      if (this.isOwnSurface(url)) return
      event.preventDefault()
      this.openExternal(url)
    })
    window.webContents.on('render-process-gone', () => {
      // The renderer is replaceable: reopening the current surface costs a
      // reload, while leaving the window blank costs the session's window.
      this.routed.delete(window)
      if (!window.isDestroyed()) this.route(window)
    })
  }

  /**
   * Whether a navigation target is a surface this shell serves.
   * @param url - the navigation target.
   * @returns true for the boot file and the running runtime's origin.
   */
  private isOwnSurface(url: string): boolean {
    if (url.startsWith('file://')) return true
    if (this.state?.status !== 'ready') return false
    return url.startsWith(this.state.url)
  }

  /**
   * Open a destination outside the shell in the user's browser.
   * @param url - the destination; non-web schemes are refused.
   */
  private openExternal(url: string): void {
    if (!url.startsWith('http://') && !url.startsWith('https://')) return
    void shell.openExternal(url)
  }

  /**
   * Load the surface the current condition calls for, skipping a load the
   * window is already showing.
   * @param window - the window to route.
   */
  private route(window: BrowserWindow): void {
    const surface = surfaceFor(this.state)
    if (surface.kind === 'boot') {
      this.routeBootPage(window, surface.state, surface.note)
      return
    }
    const key = `app:${surface.url}`
    if (this.routed.get(window) === key) return
    this.routed.set(window, key)
    // Spent on the first load of the harness UI rather than on every route:
    // a runtime restart re-routes the windows that are already open, and
    // each of those is the same window, not another new one.
    const fresh = this.owedFreshSession.delete(window)
    void window.loadURL(fresh ? withNewSession(surface.url) : surface.url)
  }


  /**
   * Load the local boot surface with everything it renders.
   * @param window - the window to route.
   * @param state - the surface the page shows.
   * @param note - what else the shell knows about this state: why a start failed, or what a slow one is doing.
   */
  private routeBootPage(window: BrowserWindow, state: string, note: string): void {
    const key = `boot:${state}:${note}`
    if (this.routed.get(window) === key) return
    this.routed.set(window, key)
    void window.loadFile(this.options.bootPage, {
      query: { state, ...note !== '' && { note } },
    })
  }

  /**
   * Persist one window's geometry, ignoring the transient sizes that
   * maximized and full-screen windows report.
   * @param window - the window to measure.
   */
  private writeGeometry(window: BrowserWindow): void {
    if (window.isMinimized() || window.isMaximized() || window.isFullScreen()) return
    const bounds = window.getBounds()
    this.options.settings.writeGeometry(bounds)
  }
}
