/**
 * pmScrubbedEnv — the ONE env builder for test-spawned `vibecarbon create`.
 *
 * `create` reads `npm_config_user_agent` on purpose, so that `pnpm dlx
 * vibecarbon …` and `bunx vibecarbon …` produce a project in the manager you
 * invoked it with. Every package manager sets that variable for the scripts it
 * runs — including `pnpm test:integration`, which is how the pre-push hook and
 * CI launch these suites.
 *
 * So a fixture that spawns `create` with the ambient environment does not
 * exercise the DEFAULT; it exercises a property of how the run was started. The
 * same fixture comes out pnpm-based under `pnpm test:integration` and npm-based
 * when vitest is invoked directly, and npm assertions pass locally while
 * failing in CI (or the reverse).
 *
 * Two rounds of this, which is why it lives here rather than inline:
 *
 *  - 2026-07-30: real-project.ts and lint-build.test.ts were each fixed with
 *    their own hand-rolled copy of the scrub.
 *  - Immediately after: create.test.ts's "project creation with default
 *    options" block was found still inheriting it — the sweep that added those
 *    two copies had missed the third site, and the block's `packageManager`
 *    assertion failed against a fixture pinned to the RUNNER's pnpm.
 *
 * That is the sibling-drift shape the registry in
 * tests/unit/lib/shared-helper-consumers.test.ts exists to pin, so this is
 * converged and registered there.
 *
 * Round three was the real-infra e2e harness (2026-07-31), which spawns the CLI
 * through `e2eCliEnv` — that builder spreads `process.env`, and the runner is
 * launched by `pnpm test:e2e`. Every e2e `create` therefore produced a pnpm
 * project, so the matrix never once exercised the npm default a customer gets,
 * and the first real run after the npm migration failed in the pnpm path.
 *
 * Deliberately narrow: ONLY the manager-detection signal is dropped. The rest
 * of the npm_config_* surface (registry, proxy, cache) is what makes installs
 * work on a locked-down machine, and `create` shells out to a real installer.
 *
 * PLAIN JS ON PURPOSE: `tests/e2e/utils/e2e-env.js` consumes this and is itself
 * plain JS because `scripts/iter-step.js` runs under bare `node`, which cannot
 * import a `.ts` module. Types live in JSDoc; `tsconfig.e2e.json` sets
 * `allowJs: true`, so the TypeScript suites import it unchanged.
 */

import { scrubPackageManagerEnv } from '../../src/lib/package-manager-env.js';

/**
 * Round four (2026-08-05) widened this from one variable to the whole wrapper
 * run context, because `npm_config_user_agent` turned out to be the harmless
 * member of the family: pnpm also projects the user's resolved npm config, and
 * npm 12 hard-errors on some of it (EALLOWSCRIPTS). The namespace and the
 * reasoning now live in src/lib/package-manager-env.js — the SAME definition
 * the product uses when it spawns a manager, so the harness and the CLI cannot
 * drift into scrubbing different things.
 *
 * @param {NodeJS.ProcessEnv} [base] Env to copy (default `process.env`).
 * @returns {NodeJS.ProcessEnv} A copy with the wrapper's run context removed.
 */
export function pmScrubbedEnv(base = process.env) {
  return scrubPackageManagerEnv(base);
}
