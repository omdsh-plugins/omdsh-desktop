import { defineConfig } from 'vitest/config'

/**
 * Source-plane tests: workspace imports resolve through the base config's
 * `paths` to `src`, so a clean tree needs no build to test. Published harness
 * packages resolve as ordinary npm dependencies through their own `exports`.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    include: ['app/tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.ts'],
  },
})
