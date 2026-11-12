/**
 * The Pulumi PROJECT scopes state keys: the DIY backend stores every checkpoint
 * as `.pulumi/stacks/<project>/<stack>.json`. This used to be the constant
 * 'vibecarbon', which made state keys collide the moment two vibecarbon
 * projects shared one state bucket — exactly what the project-level
 * `stateBucket` pin and the e2e shared bucket introduced. Two projects pinned
 * to one bucket with an env name in common would silently ADOPT each other's
 * live state: select succeeds on the other project's stack file, URNs match
 * (program logical names are constants), and `up` reconciles someone else's
 * servers. (Review finding, 2026-08-15.)
 *
 * So the project name is now the vibecarbon PROJECT'S name, required
 * explicitly: state keys become `.pulumi/stacks/<projectName>/<stack>.json`,
 * distinct per project, and a shared bucket is safe by construction.
 *
 * REQUIRED, never defaulted: a call site that fell back to a constant would
 * read a DIFFERENT key than the one the deploy wrote, see "no stack", and take
 * the create-or-orphan paths — the silent-split failure mode is strictly worse
 * than a loud throw. Pre-release, so no migration shim for state written under
 * the old constant key.
 *
 * Its own module so the k3s token derivation (k3s-token.js) names the project
 * exactly as the stack's state key does, without loading the Pulumi runtime.
 *
 * @param {{ projectName?: unknown }} [options]
 * @returns {string}
 */
export function requirePulumiProject(options) {
  const name = options?.projectName;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(
      'iac: options.projectName is required: Pulumi state keys are scoped per project ' +
        '(.pulumi/stacks/<projectName>/<stack>.json). Pass the vibecarbon projectName from ' +
        'projectConfig; a defaulted name would read a different key than the deploy wrote.',
    );
  }
  return name.trim();
}
