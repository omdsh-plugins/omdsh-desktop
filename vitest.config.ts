import { defineConfig } from 'vitest/config'

/**
 * Source-plane tests: specs import `../src/*.ts` directly, so a clean tree
 * needs no build to test, and the published harness packages resolve as
 * ordinary npm dependencies through their own `exports`. No tsconfig here
 * defines `paths`, so nothing needs a resolver plugin to find.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['app/tests/**/*.spec.ts'],
  },
})
