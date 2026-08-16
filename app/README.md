# @omdsh-plugins/omdsh-desktop

English | [中文](README.zh.md)

The macOS and Windows desktop application: an Electron shell that supervises one embedded `dsh --profile web` runtime and shows it in a native window. It ships as an unsigned `.dmg` (macOS) or NSIS `.exe` (Windows) built by [`scripts/package-desktop-app.ts`](../scripts/package-desktop-app.ts), and it is self-contained — the Electron runtime, the harness closure, and the built frontend all live inside the bundle, so the installed application needs no checkout, no Node installation, and no package manager. The decision record is the Agent Note `2026-08-13-electron-desktop-application` on the harness fork's `legacy/all-in-one` branch.

The shell adds no harness capability. It reuses the shipped Web surface verbatim over the runtime's loopback server, and owns only what a browser tab cannot: process supervision, the user's shell environment, native window and menu behavior, attention signals, and a memory policy. Everything else the product may grow is the runtime's to load as a plugin, which is why the shell knows about no capability of its own.


## The runtime process

[`src/runtime-supervisor.ts`](src/runtime-supervisor.ts) runs the harness as a child process rather than inside the main process, so a harness fault costs a restart instead of the window and its heap is bounded independently of Chromium's. The child is Electron's own binary in `ELECTRON_RUN_AS_NODE` mode, which is why the bundle carries no second Node runtime.

| Concern | Behavior |
|---|---|
| Launch | [`src/runtime-launch.ts`](src/runtime-launch.ts) owns the command line. It includes `--expose-internals`: Electron cannot load the `node-addon-require-builtin` addon Cordis otherwise uses to reach Node's internal module loader, so without that flag the HMR service refuses to start and takes the boot with it. |
| Readiness | The `dsh web: <url>` line, not the port answering. [`src/readiness.ts`](src/readiness.ts) joins it across chunk boundaries and only reports a complete line. |
| Port | `--port 0`, so the shell never collides with a `dsh web` started in a terminal. |
| Restart | [`src/restart-policy.ts`](src/restart-policy.ts) restarts a served run at once, backs off exponentially through startup failures, and stops after five in a row. Sessions are durable, so a restart costs an in-flight turn and nothing else. |
| Shutdown | The runtime is asked with `SIGTERM`, which disposes its own plugin tree and subprocesses within its own five-second bound; Windows has no `SIGTERM` and terminates the process instead. The process tree is signalled only after the ladder's grace (`taskkill /T` on Windows), which is what catches subprocesses a wedged runtime never reaped. |
| Log | Electron's logs directory: `~/Library/Logs/DeepSeek Harness/runtime.log` on macOS, `%APPDATA%\DeepSeek Harness\logs\runtime.log` on Windows; truncated per run and rotated at 4 MiB. |

## The plugins the installer carries

[`src/bundled-plugins.ts`](src/bundled-plugins.ts) runs once before the supervisor starts, and offers the profile the bundles this build ships — today the plugin hub, which is the one plugin that cannot be installed by the mechanism it provides. Which bundles those are is discovered in the closure rather than listed here, so adding one is a `runtime/package.json` dependency and nothing else.

| Concern | Behavior |
|---|---|
| The profile | Written by the launcher, not here: when it is absent the launcher is run once with `--dump-default-config`, which resolves it and exits. The alternative was a copy of its template, whose pnpm settings decide how the hub's own installs behave. |
| Resolution | A bundle patch's rows resolve from the PROFILE directory, not the closure, so the shipped copy is symlinked into `$DSH_HOME/profiles/node_modules` — the launcher's flat fallback, which it only ever adds to. Maintained on every launch, because replacing the application replaces what the link points at. |
| Withdrawal | Each bundle is offered once. The store records what was offered, so one the user took out of `dsh.profile.bundles` stays out rather than reappearing on the next launch. The hub itself lists a seeded bundle as not removable — it removes dependencies, and a seeded bundle is a layer the profile was given — which is the tier the launcher's own bundles sit in. |
| Safety | A listed bundle that resolves nowhere stops the launcher dead, so one this build no longer carries is dropped from the list; and a shipped package that declares no `dsh.bundle` is never listed at all. Every other failure leaves the profile untouched and says so in the log. |

## The user's environment

A Finder launch inherits launchd's environment, whose `PATH` is four system directories. The agent runs the user's tools from that `PATH`, so [`src/login-environment.ts`](src/login-environment.ts) runs `$SHELL -ilc` once at startup and reads the environment the profile composes, framed by markers so a profile banner cannot corrupt the payload. The probe is skipped when `PATH` already carries a profile entry, is bounded at five seconds, and falls back to the inherited environment. Windows Explorer and a Linux desktop session already hand the user `PATH` to a GUI application, so they never probe.

## Window behavior

Windows load the runtime's loopback origin directly and carry no preload, so the harness UI runs sandboxed and context-isolated. The boot surface ([`resources/boot.html`](resources/boot.html)) is a local file the shell navigates to whenever the runtime is not serving; its buttons are links in a `dsh-action:` scheme that [`src/windows.ts`](src/windows.ts) intercepts. Geometry is validated against the attached displays before a window opens ([`src/window-state.ts`](src/window-state.ts)), so a window stored on a monitor that is gone does not open off-screen.

Every window is one origin's web content, and the harness UI keeps the session a window shows per window rather than per origin, so the shell's part is saying which windows are new ones. **New Window** loads the runtime address with the UI's `new` parameter and the window starts on a session of its own; the first window and a Dock activation load it plain and restore the last session. The request is spent on that first load, because a runtime restart re-routes the windows already open and each of those is the same window, not another new one.

## The menu and the keyboard

The shell installs a floor and nothing above it: Quit, the edit roles, the window roles — the operations that must exist whether or not a runtime is running. Everything above the floor is contributed by the runtime and rebuilt whenever it changes, so mounting a plugin grows the menu and unmounting it returns to the floor, with the shell neither rebuilt nor restarted.

The split follows what each side can do. Only the main process can build a native menu or claim an application chord, so the shell publishes a fixed vocabulary of native capabilities — `new-window`, `restart-runtime`, `reveal-log`, `open-in-browser`, `toggle-idle-suspend` — and a contribution decides which appear, where they sit, and which chord answers to them. An item may instead be the runtime's own, in which case the shell posts its id back rather than performing it.

| File | What it owns |
|---|---|
| [`src/menu-contract.ts`](src/menu-contract.ts) | What this build accepts as a contribution |
| [`src/menu-channel.ts`](src/menu-channel.ts) | Following the stream that carries it |
| [`src/native-menu.ts`](src/native-menu.ts) | The floor, and the template a contribution adds to it |

Everything arriving over that channel is untrusted input. A capability name this build does not have is dropped rather than rendered as an entry that would do nothing when pressed, and a document version it does not speak is refused whole rather than half-read — which is what lets a contribution and a shell travel separately, as a plugin mounted against an installed application must.

A checkbox item's state belongs to the shell rather than the contribution: the shell reads its own stored setting when it builds the entry, so a rebuild cannot make the tick drift from what it describes.

The contribution the desktop is developed against is [`@omdsh-plugins/omdsh-shortcuts`](https://github.com/omdsh-plugins/omdsh-shortcuts/blob/HEAD/README.md), which is a runtime plugin rather than a dependency of this package — this repository has no build-time knowledge of it.

The harness window is web content this shell does not extend, so every key the menu does not claim belongs to the UI inside it — which is why contributed chords stay off the printable range.

The boot surface is the one keyboard this repository holds, because its keys mean something only while that page is what the window shows: `Escape` stops a start that is taking too long, and `Enter` on a failed start tries again.

## Attention and power

[`src/activity.ts`](src/activity.ts) folds the runtime's own frames, read through a [`AbstractApiClient`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/apiproxy/README.md) subclass over the WebSocket downlink:

- The **host stream** stays open while the runtime serves. It reports which sessions are running, which drives the power-save blocker held exactly while a turn runs, and the "task finished" notification raised only when no window has focus.
- The **mux stream** opens only while no window has focus, and carries the approval and question frames that mean the agent is blocked on the user. A visible window already shows those requests, so subscribing while the user is watching would double the runtime's frame serialization for no signal. Pending requests appear as the Dock badge.

## Memory policy

[`src/resource-governor.ts`](src/resource-governor.ts) samples the runtime every 30 seconds and applies one rule set whose first clause is that agent work is never interrupted: every reclamation applies to an idle runtime only. An idle runtime with no window open for ten minutes is stopped and restarted on the next activation; an idle runtime holding more than 35% of physical memory is restarted in place. Idle stopping is a checkbox in the application menu.

## Known limitations

- The runtime serves on loopback with an OS-assigned port and no authentication, which is the posture `dsh web` already has: any process running as the same user can reach the API. An Electron IPC carrier would remove the port, at the cost of reimplementing the plugin-bundle endpoint, the boot-manifest injection, and the downlink that the Web carrier already provides.
- Stopping an idle runtime also stops whatever the schedule and job plugins would have run while it was idle. The menu checkbox turns the behavior off; a policy that distinguishes scheduled work from idleness is deferred.
- The downlink pathnames are restated here because the constants live in a `packages/client` package, which the host TypeScript program deliberately cannot see.
- The macOS bundle is ad-hoc signed, not notarized: a copy carried to another machine needs `xattr -dr com.apple.quarantine <app>`. The Windows setup is unsigned; SmartScreen will warn.
- No CI gate covers the application. Packaging needs macOS or Windows, and exercising the shell needs a windowing session; a same-machine packaging run's boot smoke is what proves the closure it ships. A Windows installer built on macOS is unsmoked.
- The NSIS setup replaces electron-builder's check for a running application with [`build/close-app-processes.nsh`](build/close-app-processes.nsh), because the runtime shares the shell's executable and restarts itself faster than the default check gives up. A macOS build host proves only that the script compiles; the close path needs an upgrade install over a running application on Windows.
- Closing the last window on Windows quits the application and stops the runtime; on macOS it does not.
