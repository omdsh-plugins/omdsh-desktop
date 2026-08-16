import { defineConfig } from 'vitest/config'

/**
 * Source-plane tests: specs import `../src/*.ts` directly, so a clean tree
 * needs no build to test, and the published harness packages resolve as
 * ordinary npm dependencies through their own `exports`. No tsconfig here
 * defines `paths`, so nothing needs a resolver plugin to find.
 *
 * The packaging scripts have specs of their own, under the directory they
 * test rather than beside the shell's: `tsconfig.checks.json` already
 * typechecks `scripts`, and a spec for a build step is not part of the
 * application.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['app/tests/**/*.spec.ts', 'scripts/tests/**/*.spec.ts'],
  },
})
