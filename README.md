# omdsh-desktop

English | [中文](README.zh.md)

The [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) desktop application: an Electron shell that supervises a harness runtime and adds the native surface around it — windows, menus, activity, restart policy, and the boot screen a starting runtime is watched from.

The shell is not part of the harness. It spawns the runtime as a child process and talks to it over loopback HTTP, so a runtime that crashes or exhausts its heap is restarted under a policy the shell owns, without taking the window with it.

[`app/README.md`](app/README.md) is that shell in detail — the runtime process and its restart ladder, the login-environment probe, window and menu behaviour, the attention streams, and the memory policy. This page is the repository around it.

## Layout

| Directory | What it is |
|---|---|
| `app/` | The Electron main process (`@omdsh-plugins/omdsh-desktop`); `tsdown` bundles it to one `lib/main.mjs` |
| `runtime/` | A dependency-only manifest naming the harness release this application ships, and the omdsh bundles it carries |
| `scripts/` | The packaging pipeline — closure, `electron-builder`, boot smoke, disk image, NSIS setup — and the harness- and plugin-pin switches |
| `assets/` | Application icon artwork |

## The harness release it ships

Three files name it and they name the same one, `0.1.0-rc.6` today — the third being the application's own version, because the artifact's name is what tells somebody which runtime is inside it. `runtime/package.json` is what the packaging pipeline installs: it is a deploy root outside the workspace, where a `catalog:` reference would have nothing to resolve against, so it restates the version literally. `pnpm-workspace.yaml`'s catalog is what `app` resolves its API client from. `pnpm run check:harness-pin` is the proof that the two agree — and it fails while either one is on a `link:`.

The workspace installs that release under `runtime/`, so a checkout run supervises the same runtime a packaged one embeds — which is what makes running from source representative. Packaging reads the same file.

```sh
pnpm run check:harness-pin        # the manifests, the catalog, and the version name one release
pnpm run check:harness-outdated   # fail when the registry has a newer release than this pin
pnpm run harness:latest           # move to it: catalog, runtime pin, and this application's version
pnpm run harness:npm              # build against the published release (the default), and take its version
pnpm run harness:local ../../deepseek-harness   # build against a sibling checkout instead
```

`harness:latest` is the whole move when the harness publishes a new release: it reads what the registry has, refuses anything that is not newer than the current pin, requires the API client to publish the SAME release, writes both catalog entries, and then does what `harness:npm` does. `check:harness-outdated` is the same reading without the writing, so a scheduled job can say a release is waiting.

Neither consults a `latest` dist-tag, and that is not caution for its own sake: `@deepseek-ai/dsh-host-apiproxy` publishes `0.1.0-rc.6` while its `latest` still points at `0.0.1-rc.1`, so a command that trusted the tag would have answered that this application must move its API client back a minor version.

`harness:npm` sets `package.json` and `app/package.json` to the release it points at, and `check:harness-pin` fails when they drift — so moving to a new harness is one command rather than one command plus a manifest edit somebody has to remember. A rebuild of the SAME release is named `<release>+<n>`: semver ignores build metadata for precedence, which is right, because such a build is not a newer release.

The local mode points `@deepseek-ai/dsh` and the API client at a harness checkout through `link:`. pnpm does not install a linked package's own dependencies, so that checkout must be installed and built (`pnpm run build`) first. Use it to see unreleased harness work in the shell; switch back with `harness:npm` before packaging anything you intend to ship.

## The plugins it ships

The installer carries [`omdsh-plughub`](https://github.com/omdsh-plugins/omdsh-plughub) and [`omdsh-base`](https://github.com/omdsh-plugins/omdsh-base). Each is there for a different reason, and neither generalizes to a third.

**The hub is the one plugin that cannot be installed by the mechanism it provides.** Installing a plugin is `dsh plugin --profile web add <package>` in a terminal, and a machine that has just run an installer has no `dsh` on its `PATH` — so a freshly installed application would open a harness with no route to a second plugin.

**The mode system is the peer nothing auto-installs.** It contributes no mode of its own and shows no switch on its own; it is the registry every mode plugin registers into, declared by each of them as a `peerDependency`. The profile is installed with `autoInstallPeers: false`, so installing Chat or Code through the hub does NOT bring it, and a mode plugin without it loads inert — no switch, no segment, no error. Shipping it means one click gets a working mode instead of a silent one.

The cost is real and worth naming: a shared library in the installer is pinned to this application's release cadence while the packages that depend on it update freely. Two things keep that from biting. Its dependents declare it as `*`, so no version of it blocks one of them; and the hub can install a newer copy into the profile itself, which is nearer on the resolution walk than the one this application links, so an installation is never stuck with the bundled one.

Everything past these two is a plugin the hub can install, and the reasoning above is what a third would have to earn.

Which bundles ship is declared as the `@omdsh-plugins/*` entries of the catalog, and `runtime/package.json` must name all of them at the same version — `omdsh-base` and `omdsh-plughub`, both `0.1.1` today. Two files, for the reason the harness release is also stated twice: the closure installs outside this workspace, where a `catalog:` reference has nothing to resolve against.

```sh
pnpm run check:plugin-pin       # the runtime manifest and the catalog name one release
pnpm run plugins:npm            # ship the published versions (the default)
pnpm run plugins:local ..       # ship the sibling checkouts instead
pnpm run plugins:none           # ship none
```

A default build carries both, and packaging names what it carries on every run.

What must never be committed is a `link:`. pnpm resolves it against the declaring manifest, so a clone without the sibling checkouts warns, exits zero, and leaves a dangling symlink — which packaging then carries into the `.app`, where macOS refuses to sign the bundle at all. `check:plugin-pin` fails on one, and CONVENTIONS rule 8 is the same rule. Use `plugins:local ..` to package unreleased plugin work, and `plugins:npm` before committing.

Packaging is otherwise untroubled by a local bundle: `scripts/bundled-plugins.ts` packs each into a tarball and installs the closure from that, so what ships is real files rather than a symlink. `pnpm pack` runs each package's `prepare`, so those checkouts must be installed. A version pin needs none of that — pnpm resolves it from the registry like anything else.

### How a shipped bundle reaches the profile

Three things have to be true, and shipping the files is only the first.

| | What it takes | Where |
|---|---|---|
| The closure carries it | a `runtime/package.json` dependency, hoisted beside every peer it declares | `scripts/runtime-closure.ts` |
| The profile names it | appended to `dsh.profile.bundles`, which the launcher's shipped `web` template does not | `app/src/bundled-plugins.ts` |
| Its rows resolve | a symlink in `$DSH_HOME/profiles/node_modules`, which the closure is not reachable from | `app/src/bundled-plugins.ts` |

The third is the one that looks done and is not. The Loader's `baseUrl` is the profile directory, so a bundle patch's row specifiers are found by Node's walk up from `$DSH_HOME/profiles/<name>/` — which reaches the flat fallback the launcher maintains, one symlink per package in the dsh installation's own dependency closure. A plugin shipped BESIDE that installation is not in it, so the shell links it there itself. The launcher only ever adds to that directory, so the link stands.

Seeding runs before the runtime starts, once per bundle. A bundle this shell added and the user then took out of `dsh.profile.bundles` stays out — the shell records what it has offered in its own settings file, so a withdrawal is not undone on the next launch. What it does maintain on every launch is the symlink, because replacing the application replaces what it points at; and a bundle that is listed but resolves nowhere is dropped, because that one is fatal to the launcher rather than merely missing.

The hub lists a seeded bundle as not removable, and correctly: it marks a bundle removable only when the profile depends on it, and a seeded bundle is a layer the profile was given rather than a dependency pnpm installed. That is the tier the launcher's own `dsh-base` and `dsh-web-app` sit in — and the right one for a hub, which could otherwise uninstall itself and leave no way to put it back.

The profile itself is not written here. When it is absent the launcher is run once with `--dump-default-config`, which resolves the profile and exits — about a third of a second — so this repository carries no copy of the profile template, whose pnpm settings decide how the hub's own installs behave.

## What the shell does not own

The runtime is the one beside the window, and that is the whole of it. Serving
from another host, and every other capability beyond showing the harness, is
the runtime's to grow through a plugin rather than something the shell reaches
around it for. The installer makes that concrete rather than contradicting it:
it carries plugins in the closure — the hub because a machine that has just run
an installer has no `dsh` on its `PATH` and therefore no way to install a first
one. Those are bundles the runtime loads, not capabilities the shell holds. The closure the packaging
pipeline embeds is built by [`scripts/runtime-closure.ts`](scripts/runtime-closure.ts)
here.

## The keyboard map

Which chords the shell claims lives in [`omdsh-shortcuts`](https://github.com/omdsh-plugins/omdsh-shortcuts), a sibling repository: the application menu that carries the map, the window-level function row a menu item cannot hold, and the unit test that keeps both clear of the roles' chords and of the harness UI's own. This repository owns what those chords run — the windows, the runtime, the log — and the boot surface's own `Escape` and `Enter`, which mean something only while that page is on screen.

## Install

Node `^22.19.0 || >=24.0.0` and pnpm 11.7.0, as `engines` and `packageManager` state. pnpm 10+ refuses to run any dependency's install script until it is reviewed, and `pnpm-workspace.yaml` reviews them: `electron` is allowed there because its install script is what fetches the Electron binary the shell runs on. An install that skipped that approval leaves no binary to start.

### From source

```sh
pnpm install
pnpm run build
pnpm --filter @omdsh-plugins/omdsh-desktop exec electron .
```

Electron loads `app/lib/main.mjs`, which is what `pnpm run build` writes, so the build has to have run at least once — there is no watch mode and no `dev` script. The shell then supervises `runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`, the pinned release rather than whatever `dsh` is on your `PATH`, against your ordinary `~/.dsh` and on an OS-assigned port, so it does not collide with a `dsh web` already running in a terminal.

A checkout run takes the same single-instance lock the installed application does, because that lock is keyed on the application name. Started while an installed **DeepSeek Harness** is open, the checkout copy quits at once and raises the installed window instead. Give it a user-data directory of its own to run both:

```sh
pnpm --filter @omdsh-plugins/omdsh-desktop exec electron . --user-data-dir=/tmp/dsh-desktop-dev
```

### From a built artifact

`pnpm run package:desktop` writes a disk image on macOS or an NSIS setup on Windows. Neither carries a certificate the platform trusts, so installing one takes a step:

- **macOS.** The bundle is ad-hoc signed, not notarized, so a copy carried to another machine arrives quarantined. Drag it to `/Applications` and clear the flag once:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"
  ```

- **Windows.** The setup is unsigned, so SmartScreen interposes a warning. **More info → Run anyway.**

The installed application carries the Electron runtime, the harness closure, and the built frontend inside its own bundle. It needs no checkout, no Node installation, and no package manager on the machine it lands on.

## Commands

```sh
pnpm install
pnpm run build              # tsc emits lib/types, tsdown bundles the Electron entry
pnpm run typecheck          # app sources, tests, and the packaging scripts
pnpm run test               # vitest
pnpm run check:harness-pin  # the runtime manifest and the catalog name one release
pnpm run harness:npm        # build against the published release (the default)
pnpm run harness:local ../../deepseek-harness   # build against a sibling checkout
pnpm run check:plugin-pin   # the runtime manifest is in a state a bare clone can install
pnpm run plugins:npm        # ship the published bundles (the default)
pnpm run plugins:local ..   # ship the sibling checkouts instead
pnpm run plugins:none       # ship none
pnpm run package:desktop    # the full artifact
pnpm run clean              # remove app/lib, dist-desktop, and the tsbuildinfo files
```

`package:desktop` installs the pinned release into a symlink-free closure, prunes it for the target, boots it once as a smoke test, packs the application around it, and produces a disk image on macOS or an NSIS setup on Windows.

Its own flags go after a `--`, which is what stops pnpm from reading them as its own:

```sh
pnpm run package:desktop -- --platform mac|win --arch arm64|x64 --out <dir>
pnpm run package:desktop -- --skip-deploy --skip-smoke --skip-dmg --skip-installer
```

`--platform` and `--arch` both default to this machine, `--arch` to `x64` for a Windows target even on Apple silicon. The four `--skip-*` flags each drop one stage — reuse the closure already staged, skip the boot smoke, stop before the disk image, stop before the installer — and exist for iterating on the stage after the one being skipped, never for producing something to ship.

Each target writes to its own directory — `dist-desktop/dist-mac` or `dist-desktop/dist-win` — because the closure staged under it is pruned for one platform's natives. Building the other target would otherwise find the previous build's tree standing where its own belongs. `--out` overrides the directory and is taken verbatim.

## Where this came from

Split out of a fork of the harness monorepo, where it was `apps/desktop`. Its 197-entry generated runtime manifest is gone: the closure now resolves from the registry, so the release it ships is one version number. The design rationale is the Agent Note `2026-08-13-electron-desktop-application`, on that fork's `legacy/all-in-one` branch, which also still carries the superseded `package:mac` and `package:win` launcher scripts that wrapped a monorepo checkout.

## Known limitations

The repository's own limits; [`app/README.md`](app/README.md#known-limitations) carries the shell's.

- **macOS and Windows only.** Packaging refuses any other host outright, and there is no Linux target to ask for: the product is a `.dmg` and an NSIS setup. Linux is unsupported for building and for shipping alike.
- **A Windows artifact can be packed from macOS, but not proven there.** Optional natives are prebuilt and the NSIS target needs no Wine, so the pack succeeds — but a Windows Electron binary cannot run on macOS, so the boot smoke is skipped and the artifact is unsmoked. A macOS artifact needs a macOS host.
- **A cross-built Windows closure gets its `pnpm.cmd` written by hand.** pnpm creates `.bin` entries for the platform it installs ON, so a Windows closure built from macOS carries POSIX symlinks Windows cannot run and the hub does not look for. `scripts/runtime-closure.ts` writes the shim, and packaging fails if the command is missing — but the shim itself has only ever been exercised on Windows by hand, never by a smoke.
- **A plugin installed from a git specifier can fail in a way no allowlist reaches.** Preparing a git-hosted package runs `pnpm install` under pnpm's store to fetch that plugin's devDependencies; when that nested install is the one whose build scripts are blocked, it surfaces as `ERR_PNPM_PREPARE_PACKAGE` and the profile's `allowBuilds` does not apply to it. Publishing the plugin is what avoids it — a registry install downloads a built tree and runs no build. (The build itself is fine under the shipped Node: `tsdown` and its Rolldown binding load under `ELECTRON_RUN_AS_NODE`, because that binding is N-API and ABI-stable across Node and Electron.)
- **Nothing is signed by a certificate a platform trusts.** The macOS bundle is ad-hoc signed rather than notarized and the Windows setup is unsigned, so both need the step under `## Install` on any machine but the one that built them.
- **The runtime serves on loopback with an OS-assigned port and no authentication**, which is the posture `dsh web` already has: any process running as the same user can reach the API.
- **No CI gate covers the application.** Packaging needs macOS or Windows and exercising the shell needs a windowing session, so a same-machine packaging run's boot smoke is what proves the closure it ships.
- **Closing the last window quits on Windows and stops the runtime**; on macOS it does not, and the Dock tile stays.
- **Running from source needs a build first, and a lock of its own.** There is no `dev` script and no watch mode, and an unmodified checkout run cannot start beside an installed copy — both are `## Install`'s problem to work around rather than something this repository solves.
