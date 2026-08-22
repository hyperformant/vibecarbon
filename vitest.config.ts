import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Global test configuration
    globals: true,
    environment: 'node',

    // Root directory for tests
    root: '.',

    // Include patterns
    include: ['tests/**/*.test.ts'],

    // Exclude patterns
    exclude: [
      'node_modules',
      'carbon',
      'tests/_shared/**',
      'tests/e2e/**/*.test.ts',
    ],

    // Setup files
    setupFiles: ['tests/setup/global-setup.ts'],

    // Coverage configuration.
    // Informational only — coverage is a report, not a CI gate (there is no
    // --coverage in the release pipeline). `include` targets the real CLI
    // source; the previous list named three files (create-vibecarbon.js,
    // create-env.js, destroy-env.js) that were deleted in a refactor, so the
    // report measured nothing and the thresholds passed vacuously. If a gate
    // is wanted later, add realistic thresholds here and wire `--coverage`
    // into CI in the same change.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.js'],
      exclude: [
        'node_modules',
        'carbon',
        'tests',
        'src/autoscaler/protos/**',
      ],
    },

    // Reporter configuration
    reporters: process.env.CI ? ['junit', 'default'] : ['default'],
    outputFile: {
      junit: 'test-results.xml',
    },

    // Project configurations — 4 clean tiers (see docs/tests.md).
    // Each tier has a one-sentence definition with no overlap.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // Pure, in-process. No child processes, no I/O outside tmp dirs.
          include: ['tests/unit/**/*.test.ts'],
          exclude: [
            'tests/integration/**',
            'tests/loadtest/**',
            'tests/e2e/**',
            'tests/_shared/**',
          ],
          testTimeout: 5_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          // Spawns the CLI against fixture projects with cloud/SSH/exec
          // stubbed; real Pulumi runs against file:// backend.
          include: ['tests/integration/**/*.test.ts'],
          exclude: [
            'tests/unit/**',
            'tests/loadtest/**',
            'tests/e2e/**',
            'tests/_shared/**',
          ],
          // testTimeout AND hookTimeout BOTH 240s — first call to
          // realProject() in each worker runs real `vibecarbon create`
          // (~7s in isolation; up to ~3 min under full-suite parallel
          // load on cold caches when every worker races to populate
          // ensureCached() while the PM-matrix tests in
          // template/create.test.ts also fan out their own creates).
          // Subsequent calls clone (~50ms).
          //
          // Three pre-push ETIMEDOUT modes were chased separately on
          // 2026-05-07 before pinning all three:
          //   1. `bun create` test: ETIMEDOUT in execSync's 120s
          //      timeout — bumped PM_CREATE_TIMEOUT to 240s.
          //   2. `deploy → prints help` test: ETIMEDOUT in
          //      ensureCached's 120s execFileSync timeout — bumped
          //      real-project.ts:83 to 240s.
          //   3. `_harness/assertions` test: vitest aborted the test
          //      body at 60s testTimeout while ensureCached was still
          //      running — fixed here.
          //
          // All three timeouts (test, hook, exec) now align at 240s
          // so a slow-but-completing realProject() finishes before
          // any of the three layers aborts.
          testTimeout: 240_000,
          hookTimeout: 240_000,
        },
      },
      {
        test: {
          name: 'loadtest',
          globals: true,
          environment: 'node',
          root: '.',
          include: ['tests/loadtest/**/*.perf.test.ts'],
          exclude: ['node_modules', 'carbon'],
          setupFiles: ['tests/setup/global-setup.ts'],
          testTimeout: 120_000,
          fileParallelism: false,
        },
      },
      // No 'e2e' vitest project: real-infra e2e runs exclusively through the
      // interactive runner (`pnpm test:e2e` → tests/e2e/runner.ts), which owns
      // metrics, retries, and the README perf table. The old vitest wrapper
      // (tests/e2e/e2e.test.ts + test:e2e:ci) was removed with the legacy
      // tests/e2e/single/ suite.
    ],
  },
});
