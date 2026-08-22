/**
 * The package-manager run context — one definition, shared by the product and
 * by the test harnesses.
 *
 * npm, pnpm and bun all publish their RESOLVED config into child processes as
 * lowercase `npm_config_*`, alongside `npm_command`, `npm_execpath`,
 * `npm_lifecycle_*`, `npm_package_*`, and pnpm's own `pnpm_config_*`. So a
 * `vibecarbon` reached through `pnpm dlx` / `bunx` — or by anything a user ran
 * under `pnpm run` — hands the WRAPPER's config dialect to the npm we spawn
 * inside the generated project.
 *
 * That went from cosmetic to fatal on 2026-08-05. A host's npm moved 11.16.0 ->
 * 12.0.2 while `~/.npmrc` carried `allow-scripts=vibecarbon`; pnpm resolved it
 * and injected `npm_config_allow_scripts`. npm 11 had only warned "Unknown env
 * config"; npm 12 recognises the setting, forbids it in project-scoped
 * installs, and exits non-zero with EALLOWSCRIPTS.
 *
 * WHERE THE SETTING LIVES IS THE WHOLE POINT, and it is easy to get backwards.
 * npm 12 accepts `allow-scripts` from an npmrc FILE and rejects it in the
 * CLI/env form — its own error says so ("Add the entries to the allowScripts
 * field in package.json, or to .npmrc, instead"). Controlled twice on the host
 * that reproduced it, with `~/.npmrc` left untouched in both runs:
 *
 *   ~/.npmrc has allow-scripts, no env var  -> `npm ci --dry-run` exits 0
 *   ~/.npmrc has allow-scripts, env var set -> exits 1, EALLOWSCRIPTS
 *
 * So deleting the user's npmrc line also "fixes" it — but only because that
 * line is what pnpm projects into the environment. The env is the mechanism;
 * the file is innocent, and editing a user's npm config would be both invasive
 * and beside the point.
 *
 * Matched by NAMESPACE, not by name: the specific setting is incidental, and a
 * known-bad list only ever grows one incident at a time.
 *
 * CASE CARRIES THE INTENT, which is what makes a namespace sweep safe. The
 * managers inject lowercase; exporting `NPM_CONFIG_REGISTRY` is the documented
 * way a human or CI job points npm at a private mirror. Uppercase survives, so
 * installs behind an internal registry keep working. Someone who sets lowercase
 * config by hand loses it here, which is acceptable — npm re-reads the same
 * settings from `.npmrc`, where they are not also a wrapper's leftovers.
 *
 * Deliberately NOT matched: `PNPM_HOME`, `BUN_INSTALL`, `COREPACK_*`. Those say
 * where the tool lives, and dropping them can make the manager we are about to
 * spawn unresolvable.
 *
 * PLAIN JS WITH NO IMPORTS on purpose: `tests/e2e/utils/e2e-env.js` reaches
 * this through `tests/_shared/pm-env.js` and runs under bare `node` via
 * `scripts/iter-step.js`.
 */

/** The lowercase namespaces npm/pnpm/bun/yarn publish their run context into. */
export const PM_RUN_CONTEXT_RE = /^(npm|pnpm|bun|yarn)_/;

/**
 * Uppercase run-context outliers. Everything else uppercase is user
 * environment and is kept.
 */
export const PM_RUN_CONTEXT_VARS = ['PNPM_PACKAGE_NAME'];

/**
 * Drop the wrapper package manager's run context from an environment.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv} a copy; the input is never mutated
 */
export function scrubPackageManagerEnv(env) {
  const clean = { ...env };
  for (const v of PM_RUN_CONTEXT_VARS) delete clean[v];
  for (const key of Object.keys(clean)) {
    if (PM_RUN_CONTEXT_RE.test(key)) delete clean[key];
  }
  return clean;
}
