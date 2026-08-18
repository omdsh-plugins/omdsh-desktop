/**
 * Seeding the profile with the bundles the installer carries: what is offered,
 * what is withdrawn, and the two failures that would otherwise stop the
 * launcher dead — a listed bundle that resolves nowhere, and one that declares
 * no patch layer.
 */

import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverBundledPlugins, resolveHome, seedBundledPlugins } from '../src/bundled-plugins.ts'
import { RUNTIME_PROFILE } from '../src/runtime-launch.ts'

const HUB = '@omdsh-plugins/omdsh-plughub'
const MODE = '@omdsh-plugins/omdsh-basemode'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fresh scratch directory, removed after the test that made it. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-seed-'))
  roots.push(root)
  return root
}

/** Write a package directory holding the given manifest. */
function writePackage(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  return dir
}

/** A closure carrying one bundle, or one package that is not a bundle. */
function closure(root: string, options: { bundle?: boolean } = {}): string {
  const runtimeRoot = join(root, 'backend')
  writePackage(join(runtimeRoot, 'node_modules', ...HUB.split('/')), {
    name: HUB,
    version: '0.1.0',
    ...options.bundle !== false && { dsh: { bundle: { patch: './cordis.patch.yml' } } },
  })
  return runtimeRoot
}

/** A Harness home whose profile manifest lists the given bundles. */
function home(root: string, bundles: readonly string[], extra: Record<string, unknown> = {}): string {
  const dshHome = join(root, 'dsh')
  writePackage(join(dshHome, 'profiles', RUNTIME_PROFILE), {
    name: `dsh-profile-${RUNTIME_PROFILE}`,
    private: true,
    ...extra,
    dsh: { profile: { bundles: [...bundles] } },
  })
  return dshHome
}

/** The bundles a profile manifest now lists. */
function listed(dshHome: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(dshHome, 'profiles', RUNTIME_PROFILE, 'package.json'), 'utf8'),
  ) as { dsh?: { profile?: { bundles?: string[]; disabled?: string[] } } }
  return manifest.dsh?.profile?.bundles ?? []
}

/** The bundles a profile manifest has parked. */
function parked(dshHome: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(dshHome, 'profiles', RUNTIME_PROFILE, 'package.json'), 'utf8'),
  ) as { dsh?: { profile?: { disabled?: string[] } } }
  return manifest.dsh?.profile?.disabled ?? []
}

/** Park names on the profile without taking them off `bundles` yourself. */
function writeDisabled(dshHome: string, names: readonly string[]): void {
  const path = join(dshHome, 'profiles', RUNTIME_PROFILE, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    dsh: { profile: { bundles: string[]; disabled?: string[] } }
  }
  manifest.dsh.profile.disabled = [...names]
  writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/** Run one seeding pass with the noise discarded. */
async function seed(options: {
  runtimeRoot: string
  home: string
  offered?: readonly string[]
  initProfile?: () => Promise<void>
  log?: (message: string) => void
}): ReturnType<typeof seedBundledPlugins> {
  return seedBundledPlugins({
    runtimeRoot: options.runtimeRoot,
    home: options.home,
    offered: options.offered ?? [],
    initProfile: options.initProfile ?? (() => Promise.resolve()),
    log: options.log ?? (() => {}),
  })
}

describe('resolveHome', () => {
  it('defaults to ~/.dsh', () => {
    expect(resolveHome({})).toBe(join(homedir(), '.dsh'))
  })

  it('reads a blank override as unset, so the home is never the working directory', () => {
    expect(resolveHome({ DSH_HOME: '   ' })).toBe(join(homedir(), '.dsh'))
  })

  it('expands a leading tilde', () => {
    expect(resolveHome({ DSH_HOME: '~/elsewhere' })).toBe(join(homedir(), 'elsewhere'))
  })
})

describe('discoverBundledPlugins', () => {
  it('finds the bundles the closure carries', () => {
    expect(discoverBundledPlugins(closure(scratch()))).toEqual([HUB])
  })

  it('ignores a scope package that declares no patch layer', () => {
    expect(discoverBundledPlugins(closure(scratch(), { bundle: false }))).toEqual([])
  })

  it('answers nothing for a tree with no closure', () => {
    expect(discoverBundledPlugins(join(scratch(), 'absent'))).toEqual([])
  })
})

describe('seedBundledPlugins', () => {
  it('appends a shipped bundle and links it into the module fallback', async () => {
    const root = scratch()
    const runtimeRoot = closure(root)
    const dshHome = home(root, [])

    const outcome = await seed({ runtimeRoot, home: dshHome })

    expect(outcome.changed).toBe(true)
    expect(outcome.offered).toEqual([HUB])
    expect(listed(dshHome)).toEqual([HUB])
    expect(readlinkSync(join(dshHome, 'profiles', 'node_modules', ...HUB.split('/'))))
      .toBe(join(runtimeRoot, 'node_modules', ...HUB.split('/')))
  })

  it('preserves every other field of the profile manifest', async () => {
    const root = scratch()
    const dshHome = home(root, ['@deepseek-ai/dsh-base'], { dependencies: { left: '1.0.0' } })

    await seed({ runtimeRoot: closure(root), home: dshHome })

    const manifest = JSON.parse(
      readFileSync(join(dshHome, 'profiles', RUNTIME_PROFILE, 'package.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(manifest['dependencies']).toEqual({ left: '1.0.0' })
    expect(manifest['private']).toBe(true)
    expect(listed(dshHome)).toEqual(['@deepseek-ai/dsh-base', HUB])
  })

  it('initializes an absent profile before seeding it', async () => {
    const root = scratch()
    const runtimeRoot = closure(root)
    const dshHome = join(root, 'dsh')
    let initialized = 0

    const outcome = await seed({
      runtimeRoot,
      home: dshHome,
      initProfile: () => {
        initialized += 1
        home(root, [])
        return Promise.resolve()
      },
    })

    expect(initialized).toBe(1)
    expect(outcome.changed).toBe(true)
    expect(listed(dshHome)).toEqual([HUB])
  })

  it('gives up quietly when the profile does not appear', async () => {
    const root = scratch()
    const messages: string[] = []

    const outcome = await seed({
      runtimeRoot: closure(root),
      home: join(root, 'dsh'),
      log: message => messages.push(message),
    })

    expect(outcome).toEqual({ offered: [], changed: false })
    expect(messages.join('')).toContain('did not initialize')
  })

  it('puts back a bundle that was offered and removed, because a shipped plugin cannot be uninstalled', async () => {
    const root = scratch()
    const dshHome = home(root, [])

    const outcome = await seed({ runtimeRoot: closure(root), home: dshHome, offered: [HUB] })

    expect(outcome.changed).toBe(true)
    expect(listed(dshHome)).toEqual([HUB])
  })

  it('leaves a disabled bundle off the stack', async () => {
    const root = scratch()
    const runtimeRoot = closure(root)
    writePackage(join(runtimeRoot, 'node_modules', ...MODE.split('/')), {
      name: MODE,
      version: '0.1.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    const dshHome = home(root, [HUB])
    writeDisabled(dshHome, [MODE])
    const messages: string[] = []

    const outcome = await seed({
      runtimeRoot,
      home: dshHome,
      offered: [HUB, MODE],
      log: message => messages.push(message),
    })

    expect(outcome.changed).toBe(false)
    expect(listed(dshHome)).toEqual([HUB])
    expect(parked(dshHome)).toEqual([MODE])
    expect(messages.join('')).toContain('is disabled')
  })

  it('puts a disabled hub back on the stack', async () => {
    const root = scratch()
    const dshHome = home(root, [])
    writeDisabled(dshHome, [HUB])
    const messages: string[] = []

    const outcome = await seed({
      runtimeRoot: closure(root),
      home: dshHome,
      offered: [HUB],
      log: message => messages.push(message),
    })

    expect(outcome.changed).toBe(true)
    expect(listed(dshHome)).toEqual([HUB])
    expect(parked(dshHome)).toEqual([])
    expect(messages.join('')).toContain('cannot be disabled')
  })

  it('clears a park mark when the hub is already listed', async () => {
    const root = scratch()
    const dshHome = home(root, [HUB])
    writeDisabled(dshHome, [HUB])

    const outcome = await seed({ runtimeRoot: closure(root), home: dshHome, offered: [HUB] })

    expect(outcome.changed).toBe(true)
    expect(listed(dshHome)).toEqual([HUB])
    expect(parked(dshHome)).toEqual([])
  })

  it('records a bundle the profile already lists without rewriting the manifest', async () => {
    const root = scratch()
    const dshHome = home(root, [HUB])
    const before = statSync(join(dshHome, 'profiles', RUNTIME_PROFILE, 'package.json')).mtimeMs

    const outcome = await seed({ runtimeRoot: closure(root), home: dshHome })

    expect(outcome).toEqual({ offered: [HUB], changed: false })
    expect(statSync(join(dshHome, 'profiles', RUNTIME_PROFILE, 'package.json')).mtimeMs).toBe(before)
  })

  it('drops a listed bundle this build no longer resolves, which would stop the launcher', async () => {
    const root = scratch()
    const dshHome = home(root, ['@deepseek-ai/dsh-base', HUB])
    const messages: string[] = []

    const outcome = await seed({
      runtimeRoot: join(root, 'absent'),
      home: dshHome,
      offered: [HUB],
      log: message => messages.push(message),
    })

    expect(outcome.changed).toBe(true)
    expect(listed(dshHome)).toEqual(['@deepseek-ai/dsh-base'])
    expect(messages.join('')).toContain('no longer resolves')
  })

  it('keeps a listed bundle the profile itself installed, even when the build stops shipping it', async () => {
    const root = scratch()
    const dshHome = home(root, [HUB])
    writePackage(join(dshHome, 'profiles', RUNTIME_PROFILE, 'node_modules', ...HUB.split('/')), {
      name: HUB,
      version: '0.2.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })

    const outcome = await seed({ runtimeRoot: join(root, 'absent'), home: dshHome, offered: [HUB] })

    expect(outcome.changed).toBe(false)
    expect(listed(dshHome)).toEqual([HUB])
  })

  it('never lists a shipped package that declares no patch layer', async () => {
    const root = scratch()
    const dshHome = home(root, [])

    const outcome = await seed({ runtimeRoot: closure(root, { bundle: false }), home: dshHome })

    expect(outcome.changed).toBe(false)
    expect(listed(dshHome)).toEqual([])
  })

  it('does not relink a bundle the profile has installed as a dependency', async () => {
    const root = scratch()
    const dshHome = home(root, [HUB], { dependencies: { [HUB]: '0.2.4' } })
    const link = join(dshHome, 'profiles', 'node_modules', ...HUB.split('/'))
    mkdirSync(join(dshHome, 'profiles', 'node_modules', '@omdsh-plugins'), { recursive: true })
    const updated = join(root, 'user-updated')
    symlinkSync(updated, link, process.platform === 'win32' ? 'junction' : undefined)

    await seed({ runtimeRoot: closure(root), home: dshHome, offered: [HUB] })

    expect(readlinkSync(link)).toBe(updated)
  })

  it('re-points a link left by a previous installation', async () => {
    const root = scratch()
    const runtimeRoot = closure(root)
    const dshHome = home(root, [HUB])
    const link = join(dshHome, 'profiles', 'node_modules', ...HUB.split('/'))
    mkdirSync(join(dshHome, 'profiles', 'node_modules', '@omdsh-plugins'), { recursive: true })
    symlinkSync(join(root, 'previous-app'), link, process.platform === 'win32' ? 'junction' : undefined)

    await seed({ runtimeRoot, home: dshHome, offered: [HUB] })

    expect(readlinkSync(link)).toBe(join(runtimeRoot, 'node_modules', ...HUB.split('/')))
  })

  it('leaves a real directory in the module fallback to whatever owns it', async () => {
    const root = scratch()
    const dshHome = home(root, [HUB])
    const installed = writePackage(join(dshHome, 'profiles', 'node_modules', ...HUB.split('/')), {
      name: HUB,
      version: '0.3.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    const messages: string[] = []

    await seed({ runtimeRoot: closure(root), home: dshHome, offered: [HUB], log: message => messages.push(message) })

    expect(statSync(installed).isDirectory()).toBe(true)
    expect(messages.join('')).toContain('leaving')
  })

  it('refuses to rewrite a profile manifest it cannot parse', async () => {
    const root = scratch()
    const dshHome = home(root, [])
    const manifestPath = join(dshHome, 'profiles', RUNTIME_PROFILE, 'package.json')
    writeFileSync(manifestPath, '{ not json')

    const outcome = await seed({ runtimeRoot: closure(root), home: dshHome })

    expect(outcome).toEqual({ offered: [], changed: false })
    expect(readFileSync(manifestPath, 'utf8')).toBe('{ not json')
  })
})
