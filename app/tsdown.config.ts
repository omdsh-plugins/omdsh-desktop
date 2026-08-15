import { defineConfig } from 'tsdown'

/**
 * The desktop app ships one Electron entry, the main process. It emits `.mjs`
 * so the extension states the module kind Electron loads it as, independent of
 * the package manifest that ships beside it.
 *
 * Unlike the CLI, this bundle inlines its workspace imports (`noExternal`):
 * the packaged application ships `lib/` inside the Electron app directory
 * while the harness closure lives under `resources`, so a bare
 * workspace specifier left in the output would have no `node_modules` to
 * resolve against at runtime.
 */
export default defineConfig({
  entry: ['lib/types/main.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  outExtensions: () => ({ js: '.mjs' }),
  // Electron resolves from its own binary, never from node_modules.
  external: ['electron'],
  noExternal: [/^@deepseek-ai\//, 'zod'],
  fixedExtension: false,
  dts: false,
  clean: false,
})
