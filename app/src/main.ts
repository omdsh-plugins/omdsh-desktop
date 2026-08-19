/**
 * The desktop application: it supervises one harness runtime, owns the windows
 * that show it, and translates the runtime's own event streams into the
 * native surface — Dock badge or taskbar flash, notifications, sleep prevention, and the
 * resource policy that decides when an idle runtime keeps its memory.
 *
 * The runtime is the one beside the window. Every capability past showing it —
 * another host to serve from, the commands a menu carries — is the runtime's
 * to grow through a plugin rather than something the shell reaches around it
 * for. The menu is the shape of that: the shell holds the platform's own floor
 * and performs the native capabilities it names, while which of them appear,
 * where, and under which chord arrives from the runtime and is rebuilt
 * whenever it changes.
 * @module @omdsh-plugins/omdsh-desktop/main
 */

import { app, Menu, Notification, powerSaveBlocker, shell } from 'electron'
import { execFile } from 'node:child_process'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api/events'
import type { BootAction } from './boot-action.ts'
import {
  applyHostFrame,
  applyMuxFrame,
  attentionCount,
  EMPTY_ATTENTION_STATE,
  EMPTY_RUN_STATE,
  type AttentionState,
  type RunState,
} from './activity.ts'
import { DesktopApiClient } from './api-client.ts'
import { startFrameStream } from './frame-stream.ts'
import {
  mergeLaunchEnvironment,
  needsLoginEnvironment,
  readLoginShellEnvironment,
} from './login-environment.ts'
import { resetInstalledPlugins, resolveHome, seedBundledPlugins } from './bundled-plugins.ts'
import { resolveRuntimeEntry, resolveRuntimeRoot } from './paths.ts'
import {
  decideResourceAction,
  defaultHeapLimitMb,
  defaultRecycleThreshold,
  IDLE_SUSPEND_MS,
  readProcessRss,
  SAMPLE_INTERVAL_MS,
} from './resource-governor.ts'
import { EMPTY_DOCUMENT, type MenuDocument, type ShellCommand } from './menu-contract.ts'
import { followMenu, invokeRuntimeCommand } from './menu-channel.ts'
import { buildMenuTemplate } from './native-menu.ts'
import { openRuntimeLog, type RuntimeLog } from './runtime-log.ts'
import { localRuntimeLaunch, profileInitCommand, type RuntimeLaunch } from './runtime-launch.ts'
import { RuntimeSupervisor, type RuntimeState } from './runtime-supervisor.ts'
import { SettingsStore } from './store.ts'
import { WindowHost } from './windows.ts'

/** Display name; it also names the user-data and log directories. */
const APP_NAME = 'DeepSeek Harness'

/** Runtime log filename under the application's log directory. */
const LOG_FILENAME = 'runtime.log'

/** Settings filename under the application's user-data directory. */
const SETTINGS_FILENAME = 'desktop-settings.json'

/** Boot surface, relative to the Electron app directory. */
const BOOT_PAGE = join('resources', 'boot.html')

/** Window focus settles after a blur/focus pair; the attention stream reacts once it has. */
const FOCUS_SETTLE_MS = 400

/** Fallback login shell when the launch environment names none. */
const FALLBACK_SHELL = '/bin/zsh'

/**
 * How long the one-shot profile initialization may take before the launch
 * proceeds without it. It resolves the profile and exits — a third of a second
 * on a warm machine — so this bound exists to keep a wedged child off the
 * first window, not to accommodate slow ones.
 */
const PROFILE_INIT_TIMEOUT_MS = 20_000

/** Owns the application's whole lifetime. */
class DesktopApplication {
  private readonly settings = new SettingsStore(join(app.getPath('userData'), SETTINGS_FILENAME))
  private readonly log: RuntimeLog = openRuntimeLog({ directory: app.getPath('logs'), filename: LOG_FILENAME })
  private readonly windows: WindowHost
  private supervisor: RuntimeSupervisor | undefined
  private runState: RunState = EMPTY_RUN_STATE
  private attention: AttentionState = EMPTY_ATTENTION_STATE
  private hostStream: (() => void) | undefined
  private muxStream: (() => void) | undefined
  private menuStream: (() => void) | undefined
  private menuDocument: MenuDocument = EMPTY_DOCUMENT
  private runtimeEntry = ''
  private runtimeRoot = ''
  private maxOldSpaceMb = 0
  private powerBlockerId: number | undefined
  private sampleTimer: ReturnType<typeof setInterval> | undefined
  private focusTimer: ReturnType<typeof setTimeout> | undefined
  private lastActiveAt = Date.now()
  private launchEnvironment: Readonly<Record<string, string>> = {}
  private quitting = false

  constructor() {
    this.windows = new WindowHost({
      bootPage: join(app.getAppPath(), BOOT_PAGE),
      settings: this.settings,
      onAction: (action) => { this.handleBootAction(action) },
      onWindowCountChange: () => { this.onWindowCountChange() },
    })
  }

  /** Start the application: window first, then the runtime it will show. */
  async run(): Promise<void> {
    await app.whenReady()
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      copyright: 'DeepSeek Harness',
    })
    // The floor stands before any runtime does: a window that opened with no
    // menu at all would have no Quit until a contribution arrived.
    this.applyMenu()

    // The window opens before the runtime so the user sees the application
    // start, not a bounce followed by silence while the environment probe and
    // the harness boot run.
    this.windows.applyRuntimeState({ status: 'starting', attempt: 0 })
    this.windows.open()

    // AFTER the probe, not before: `activate` calls `runtime()`, which
    // memoizes a supervisor around `launchEnvironment`. The probe is an
    // `await`, so the event loop is free while it runs — a Dock click landing
    // in that window would freeze the un-probed environment into the one
    // supervisor the application ever builds, and a login shell's PATH would
    // be missing for the rest of the session.
    await this.prepareEnvironment()
    // BEFORE `registerAppEvents`, for the reason the probe is: `activate`
    // starts the runtime, and a runtime that started while the profile was
    // half-seeded would compose a tree this launch had already decided to
    // change.
    await this.seedProfile()
    this.registerAppEvents()
    this.runtime().start()
    this.sampleTimer = setInterval(() => { void this.sampleResources() }, SAMPLE_INTERVAL_MS)
  }

  /** Wire the application-level events macOS delivers. */
  private registerAppEvents(): void {
    app.on('activate', () => {
      this.windows.ensureOpen()
      this.runtime().start()
    })
    app.on('second-instance', () => {
      this.windows.present()
      app.focus({ steal: true })
    })
    app.on('window-all-closed', () => {
      // Closing the last window is not quitting on macOS; the Dock tile stays
      // and the runtime keeps serving until the resource policy stops it.
      if (process.platform !== 'darwin') app.quit()
    })
    app.on('browser-window-focus', () => { this.scheduleAttentionUpdate() })
    app.on('browser-window-blur', () => { this.scheduleAttentionUpdate() })
    app.on('before-quit', (event) => {
      if (this.quitting) return
      event.preventDefault()
      this.quitting = true
      void this.shutdown().finally(() => { app.exit(0) })
    })
  }

  /**
   * Recover the user's shell environment and resolve what a launch needs from
   * the installation, once, before the runtime starts.
   */
  private async prepareEnvironment(): Promise<void> {
    const inherited = process.env
    const probe = needsLoginEnvironment(inherited)
      ? await readLoginShellEnvironment({
        shell: inherited.SHELL ?? FALLBACK_SHELL,
        nodePath: process.execPath,
        env: inherited,
      })
      : undefined
    this.log.reset()
    this.log.write(`desktop: ${APP_NAME} ${app.getVersion()} starting\n`)
    this.log.write(probe === undefined
      ? 'desktop: using the inherited environment\n'
      : 'desktop: recovered the login shell environment\n')
    const layout = {
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }
    this.runtimeEntry = resolveRuntimeEntry(layout)
    this.runtimeRoot = resolveRuntimeRoot(layout)
    this.maxOldSpaceMb = defaultHeapLimitMb()
    this.launchEnvironment = mergeLaunchEnvironment(inherited, probe)
  }

  /**
   * Offer the bundles this application ships to the profile it is about to
   * boot.
   *
   * A packaged application whose version this shell has not prepared the
   * home for drops leftover profile plugins first: they compose at boot, and
   * a runtime they were not built for will refuse to start. Settings and
   * credentials stay. A checkout run skips that, because replacing `app/lib`
   * is not installing an application.
   *
   * Nothing here is allowed to stop the application. The seeding module
   * reports its own refusals; this method's own failure mode is the profile
   * initialization below, which is a child process and can fail for reasons
   * that have nothing to do with plugins.
   */
  private async seedProfile(): Promise<void> {
    const home = resolveHome(this.launchEnvironment)
    try {
      this.prepareHomeForRelease(home)
      const outcome = await seedBundledPlugins({
        runtimeRoot: this.runtimeRoot,
        home,
        offered: this.settings.readOfferedBundles(),
        initProfile: () => this.initProfile(),
        log: message => { this.log.write(message) },
      })
      this.settings.writeOfferedBundles(outcome.offered)
    } catch (error) {
      this.log.write(`desktop: seeding the profile failed: ${String(error)}\n`)
    }
  }

  /**
   * On a packaged launch whose version is new to this home, drop installed
   * profile plugins so they cannot compose against this runtime.
   *
   * Recording the version is what makes the next launch of the SAME installer
   * leave whatever the hub then writes. A failure to delete is not recorded,
   * so the next start tries again rather than composing the leftover.
   * @param home - the Harness home this launch will boot against.
   */
  private prepareHomeForRelease(home: string): void {
    if (!app.isPackaged) return
    const release = app.getVersion()
    if (this.settings.readSeededRelease() === release) return
    const outcome = resetInstalledPlugins({
      home,
      log: message => { this.log.write(message) },
    })
    if (!outcome.ok) return
    this.settings.writeOfferedBundles([])
    this.settings.writeSeededRelease(release)
  }

  /**
   * Let the launcher materialize the profile this shell boots.
   *
   * Run only when the profile is absent, and awaited because the manifest it
   * writes is what the seeding step edits next. A failure resolves rather than
   * throws: the launch that follows will report it far better than a boot
   * screen citing a plugin can.
   */
  private async initProfile(): Promise<void> {
    const command = profileInitCommand({ entry: this.runtimeEntry, nodePath: process.execPath })
    await new Promise<void>((done) => {
      execFile(
        command.command,
        [...command.args],
        { env: { ...this.launchEnvironment, ...command.env }, cwd: homedir(), timeout: PROFILE_INIT_TIMEOUT_MS },
        (error) => {
          if (error !== null) this.log.write(`desktop: initializing the profile failed: ${String(error)}\n`)
          done()
        },
      )
    })
  }

  /**
   * The runtime's supervisor, created on first use.
   * @returns the supervisor.
   */
  private runtime(): RuntimeSupervisor {
    if (this.supervisor !== undefined) return this.supervisor
    const supervisor = new RuntimeSupervisor({
      prepareLaunch: () => this.prepareLaunch(),
      // A Finder launch has no meaningful working directory, and this one
      // becomes a session's default project directory.
      cwd: homedir(),
      env: this.launchEnvironment,
      onOutput: (chunk) => { this.log.write(chunk) },
    })
    supervisor.subscribe((state) => { this.onRuntimeState(state) })
    this.supervisor = supervisor
    return supervisor
  }

  /**
   * Prepare the runtime's launch.
   * @returns the launch to spawn.
   */
  private async prepareLaunch(): Promise<RuntimeLaunch> {
    return localRuntimeLaunch({
      entry: this.runtimeEntry,
      nodePath: process.execPath,
      maxOldSpaceMb: this.maxOldSpaceMb,
    })
  }

  /**
   * React to one runtime transition.
   * @param state - the runtime's new condition.
   */
  private onRuntimeState(state: RuntimeState): void {
    this.windows.applyRuntimeState(state)
    if (state.status === 'ready') {
      this.openHostStream(state.url)
      this.openMenuStream(state.url)
      this.scheduleAttentionUpdate()
      return
    }
    // Every fold is about a runtime that is gone; a stale badge or a held
    // power blocker would outlive the work it described.
    this.closeStreams()
    this.runState = EMPTY_RUN_STATE
    this.attention = EMPTY_ATTENTION_STATE
    this.updateBadge()
    this.updatePowerBlocker()
  }

  /**
   * Follow the runtime's host stream, which reports session running state.
   * @param origin - the runtime origin.
   */
  private openHostStream(origin: string): void {
    this.hostStream?.()
    const client = new DesktopApiClient(origin)
    this.hostStream = startFrameStream<HostFrame>({
      open: signal => client.events.host({}, signal),
      onFrame: (request) => { this.onHostFrame(request.payload) },
      onLog: (message) => { this.log.write(`${message}\n`) },
    })
  }

  /**
   * Apply one host frame and update everything derived from running state.
   * @param frame - the frame the runtime pushed.
   */
  private onHostFrame(frame: HostFrame): void {
    const current = this.runState
    const next = applyHostFrame(current, frame)
    const finished = [...current.running].filter(id => !next.running.has(id))
    this.runState = next
    this.markActive()
    this.updatePowerBlocker()
    if (this.windows.anyFocused) return
    if (finished.length > 0) {
      this.notify('Task finished', finished.length === 1
        ? 'A session finished its turn.'
        : `${String(finished.length)} sessions finished their turns.`)
    }
    if (frame.type === 'host/agent-error') this.notify('Agent error', frame.message)
  }

  /**
   * Open or close the mux subscription so it runs only while the user cannot
   * see the requests it exists to announce.
   */
  private updateAttentionSubscription(): void {
    const origin = this.supervisor?.url
    const wanted = !this.windows.anyFocused && origin !== undefined
    if (wanted && this.muxStream === undefined) {
      const client = new DesktopApiClient(origin)
      this.muxStream = startFrameStream<MuxFrame>({
        open: signal => client.events.mux({}, signal),
        onFrame: (request) => { this.onMuxFrame(request) },
        onLog: (message) => { this.log.write(`${message}\n`) },
      })
    }
    else if (!wanted && this.muxStream !== undefined) {
      this.muxStream()
      this.muxStream = undefined
      this.attention = EMPTY_ATTENTION_STATE
    }
    this.updateBadge()
  }

  /**
   * Apply one mux frame and announce a newly blocked agent.
   * @param request - the narrow server-request form carrying the frame.
   */
  private onMuxFrame(request: Parameters<typeof applyMuxFrame>[1]): void {
    const before = attentionCount(this.attention)
    this.attention = applyMuxFrame(this.attention, request)
    const after = attentionCount(this.attention)
    if (after === before) return
    this.updateBadge()
    if (after > before) {
      app.dock?.bounce('informational')
      this.notify('Waiting for you', request.payload.type === 'question/requested'
        ? 'The agent asked a question.'
        : 'The agent is waiting for approval.')
    }
  }

  /** Re-evaluate the mux subscription once window focus has settled. */
  private scheduleAttentionUpdate(): void {
    if (this.focusTimer !== undefined) clearTimeout(this.focusTimer)
    this.focusTimer = setTimeout(() => {
      this.focusTimer = undefined
      this.updateAttentionSubscription()
    }, FOCUS_SETTLE_MS)
  }

  /** Keep the Dock badge equal to the number of requests waiting on the user. */
  private updateBadge(): void {
    const pending = attentionCount(this.attention)
    app.dock?.setBadge(pending > 0 ? String(pending) : '')
  }

  /**
   * Hold a power-save blocker exactly while a session is running, so a long
   * turn is not suspended when the user walks away.
   */
  private updatePowerBlocker(): void {
    const wanted = this.runState.running.size > 0
    if (wanted && this.powerBlockerId === undefined) {
      this.powerBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      return
    }
    if (!wanted && this.powerBlockerId !== undefined) {
      powerSaveBlocker.stop(this.powerBlockerId)
      this.powerBlockerId = undefined
    }
  }

  /** Sample the runtime and apply the resource policy. */
  private async sampleResources(): Promise<void> {
    if (this.quitting) return
    this.markActive()
    const supervisor = this.supervisor
    if (supervisor === undefined) return
    const pid = supervisor.pid
    const decision = decideResourceAction({
      runningSessions: this.runState.running.size,
      openWindows: this.windows.count,
      idleForMs: Date.now() - this.lastActiveAt,
      runtimeRssBytes: pid === undefined ? undefined : await readProcessRss(pid),
      totalMemoryBytes: totalmem(),
    }, {
      idleSuspendMs: this.settings.readIdleSuspend() ? IDLE_SUSPEND_MS : undefined,
      recycleRssBytes: defaultRecycleThreshold(totalmem()),
    })
    switch (decision.action) {
      case 'suspend':
        this.log.write('desktop: stopping the idle runtime to release its memory\n')
        await supervisor.stop()
        return
      case 'recycle':
        this.log.write(`desktop: recycling the idle runtime at ${String(Math.round(decision.rssBytes / (1024 * 1024)))} MiB resident\n`)
        await supervisor.restart()
        return
      case 'none':
        return
      default:
        decision satisfies never
    }
  }

  /** Record that the application is doing something the idle timer must not count. */
  private markActive(): void {
    if (this.windows.count > 0 || this.runState.running.size > 0) this.lastActiveAt = Date.now()
  }

  /** Re-evaluate what the current window count implies for idling and attention. */
  private onWindowCountChange(): void {
    this.markActive()
    this.scheduleAttentionUpdate()
  }

  /**
   * Run one boot-surface action.
   * @param action - the button the user pressed.
   */
  private handleBootAction(action: BootAction): void {
    switch (action.kind) {
      case 'retry':
        this.runtime().start()
        return
      case 'open-log':
        shell.showItemInFolder(this.log.path)
        return
      case 'quit':
        app.quit()
        return
      case 'cancel-start':
        void this.supervisor?.stop()
        return
      default:
        action satisfies never
    }
  }

  /**
   * Show one notification.
   * @param title - the notification title.
   * @param body - the notification body.
   */
  private notify(title: string, body: string): void {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      this.windows.present()
      app.focus({ steal: true })
    })
    notification.show()
  }

  /** Close every stream, and take the contributed menu down with them. */
  private closeStreams(): void {
    this.hostStream?.()
    this.hostStream = undefined
    this.muxStream?.()
    this.muxStream = undefined
    this.menuStream?.()
    this.menuStream = undefined
    if (this.menuDocument.items.length > 0) {
      this.menuDocument = EMPTY_DOCUMENT
      this.applyMenu()
    }
  }

  /**
   * Follow the runtime's menu contribution.
   * @param origin - the runtime origin.
   */
  private openMenuStream(origin: string): void {
    this.menuStream?.()
    this.menuStream = followMenu({
      origin,
      onDocument: (document) => {
        this.menuDocument = document
        this.applyMenu()
      },
      onLog: (message) => { this.log.write(`${message}\n`) },
    })
  }

  /** Rebuild the native menu from the floor and whatever the runtime contributes. */
  private applyMenu(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(this.menuDocument, {
      runShellCommand: (command, checked) => { this.runShellCommand(command, checked) },
      invokeRuntimeCommand: (id) => {
        const origin = this.supervisor?.url
        if (origin === undefined) return
        void invokeRuntimeCommand(origin, id, message => { this.log.write(message) })
      },
      checkboxState: command => command === 'toggle-idle-suspend' && this.settings.readIdleSuspend(),
    })))
  }

  /**
   * Perform one native capability a contribution named.
   * @param command - the capability.
   * @param checked - the new checkbox state, for the items that carry one.
   */
  private runShellCommand(command: ShellCommand, checked: boolean): void {
    switch (command) {
      case 'new-window':
        this.windows.open({ freshSession: true })
        return
      case 'restart-runtime':
        void this.supervisor?.restart()
        return
      case 'reveal-log':
        shell.showItemInFolder(this.log.path)
        return
      case 'open-in-browser': {
        const url = this.supervisor?.url
        if (url !== undefined) void shell.openExternal(url)
        return
      }
      case 'toggle-idle-suspend':
        this.settings.writeIdleSuspend(checked)
        // The checkbox the menu carries is rebuilt from the stored value, so
        // the two cannot drift apart after a rebuild the contribution drives.
        this.applyMenu()
        return
      default:
        command satisfies never
    }
  }

  /** Release every held resource and stop the runtime before the process exits. */
  private async shutdown(): Promise<void> {
    if (this.sampleTimer !== undefined) clearInterval(this.sampleTimer)
    if (this.focusTimer !== undefined) clearTimeout(this.focusTimer)
    this.closeStreams()
    if (this.powerBlockerId !== undefined) powerSaveBlocker.stop(this.powerBlockerId)
    this.windows.flushGeometry()
    this.log.write('desktop: stopping the runtime\n')
    await this.supervisor?.stop()
  }
}

app.setName(APP_NAME)

// A second launch raises the running application instead of starting a second
// runtime against the same harness home.
if (app.requestSingleInstanceLock()) void new DesktopApplication().run()
else app.quit()
