# omdsh-desktop

The [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) desktop application: an Electron shell that supervises a harness runtime and adds the native surface around it — windows, menus, activity, restart policy, and the boot screen a starting runtime is watched from.

The shell is not part of the harness. It spawns the runtime as a child process and talks to it over loopback HTTP, so a runtime that crashes or exhausts its heap is restarted under a policy the shell owns, without taking the window with it.

## Layout

| Directory | What it is |
|---|---|
| `app/` | The Electron main process (`@omdsh-plugins/omdsh-desktop`); `tsdown` bundles it to one `lib/main.mjs` |
| `runtime/` | A dependency-only manifest naming the harness release this application ships |
| `scripts/` | The packaging pipeline: closure, `electron-builder`, boot smoke, disk image, NSIS setup |
| `assets/` | Application icon artwork |

## The harness release it ships

`runtime/package.json` is the one place recording it. The workspace installs that release there, so a checkout run supervises the same runtime a packaged one embeds — which is what makes running from source representative. Packaging reads the same file.

```sh
pnpm run check:harness-pin        # the runtime manifest and the catalog name one release
pnpm run harness:npm              # build against the published release (the default)
pnpm run harness:local ../../deepseek-harness   # build against a sibling checkout instead
```

The local mode points `@deepseek-ai/dsh` and the API client at a harness checkout through `link:`. pnpm does not install a linked package's own dependencies, so that checkout must be installed and built (`pnpm run build`) first. Use it to see unreleased harness work in the shell; switch back with `harness:npm` before packaging anything you intend to ship.

## What the shell does not own

The runtime is the one beside the window, and that is the whole of it. Serving
from another host, and every other capability beyond showing the harness, is
the runtime's to grow through a plugin rather than something the shell reaches
around it for. This repository depends on no sibling: the closure the packaging
pipeline embeds is built by [`scripts/runtime-closure.ts`](scripts/runtime-closure.ts)
here.

## The keyboard map

Which chords the shell claims lives in [`omdsh-shortcuts`](https://github.com/omdsh-plugins/omdsh-shortcuts), a sibling repository: the application menu that carries the map, the window-level function row a menu item cannot hold, and the unit test that keeps both clear of the roles' chords and of the harness UI's own. This repository owns what those chords run — the windows, the runtime, the log — and the boot surface's own `Escape` and `Enter`, which mean something only while that page is on screen.

## Commands

```sh
pnpm install
pnpm run build            # tsc emits lib/types, tsdown bundles the Electron entry
pnpm run typecheck        # app sources, tests, and the packaging scripts
pnpm run test             # vitest
pnpm run package:desktop  # the full artifact; add --platform mac|win, --arch arm64|x64
```

`package:desktop` installs the pinned release into a symlink-free closure, prunes it for the target, boots it once as a smoke test, packs the application around it, and produces a disk image on macOS or an NSIS setup on Windows.

Each target writes to its own directory — `dist-desktop/dist-mac` or `dist-desktop/dist-win` — because the closure staged under it is pruned for one platform's natives. Building the other target would otherwise find the previous build's tree standing where its own belongs. `--out` overrides the directory and is taken verbatim.

## Where this came from

Split out of a fork of the harness monorepo, where it was `apps/desktop`. Its 197-entry generated runtime manifest is gone: the closure now resolves from the registry, so the release it ships is one version number. The design rationale is the Agent Note `2026-08-13-electron-desktop-application`, on that fork's `legacy/all-in-one` branch, which also still carries the superseded `package:mac` and `package:win` launcher scripts that wrapped a monorepo checkout.
