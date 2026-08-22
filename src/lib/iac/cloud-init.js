/**
 * Shared helpers for loading + rendering the k3s cloud-init scripts in
 * `carbon/cloud-init/k3s/` (master-init.sh / supabase-init.sh /
 * worker-init.sh).
 *
 * Used by:
 *   - `src/lib/iac/programs/hetzner-k8s.js` to render user_data baked
 *     into the master/supabase/static-worker servers at Pulumi up.
 *   - `src/lib/deploy/k8s/k3s.js` (`renderCarbonAutoscalerConfig`) to
 *     render the worker-init.sh body that the carbon-autoscaler sidecar
 *     reads from its `carbon-autoscaler-config` Secret's `config.json`
 *     (`nodeGroups['worker-pool'].cloudInit`). The sidecar spawns workers
 *     on demand and passes this body as user-data on each `createServer`.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cloud-init scripts live in carbon/cloud-init/k3s/.
// Relative to this file: src/lib/iac/ → ../../../carbon/cloud-init/k3s
const CLOUD_INIT_DIR = join(__dirname, '../../../carbon/cloud-init/k3s');

/**
 * `# @include <basename>` on a line of its own. Resolved by
 * `resolveIncludes()` below.
 */
const INCLUDE_DIRECTIVE = /^#[ \t]*@include[ \t]+(\S+)[ \t]*$/gm;

/**
 * Read a template and splice in any `# @include <file>` directives,
 * replacing each directive line with the named file's contents.
 *
 * WHY this lives in the loader rather than being a `renderScript` var: the
 * three Hetzner role scripts (master/supabase/worker) each need a
 * byte-identical copy of the private-NIC guard, and the registry-mirror
 * block above it already documents that hand-copied three-way duplication
 * is the status quo only because "extracting a shared snippet would
 * require restructuring the renderScript() pipeline". Resolving at load
 * time means EVERY consumer gets the snippet for free — hetzner-k8s.js's
 * Pulumi render, the provider `getK8s*UserData` statics, and
 * `renderCarbonAutoscalerConfig`'s node template all funnel through
 * `loadCloudInit`. A `${placeholder}` would instead have to be plumbed to
 * each call site independently, and the site that forgot would ship a
 * literal `${...}` into a `set -u` script — an unbound-variable abort on a
 * node nobody is watching.
 *
 * Includes are NOT recursive: a snippet may not itself include. One level
 * is all the duplication problem needs, and it keeps the contract
 * trivially cycle-free.
 *
 * @param {string} name  Basename of the template inside `dir`.
 * @param {string} [dir] Directory to resolve from (defaults to the shipped
 *   carbon/cloud-init/k3s/; parameterised for tests).
 * @returns {string}     Template with all directives resolved.
 */
export function resolveIncludes(name, dir = CLOUD_INIT_DIR) {
  const template = readFileSync(join(dir, name), 'utf-8');
  return template.replace(INCLUDE_DIRECTIVE, (_line, target) => {
    // SECURITY: directives are repo-authored, never user input. The
    // basename-only contract keeps it that way by construction, so a
    // future templating change can't turn this into an arbitrary file read.
    if (basename(target) !== target) {
      throw new Error(
        `cloud-init: "${name}" has an invalid @include "${target}" — must be a basename inside ` +
          'carbon/cloud-init/k3s/ (no path separators, no traversal)',
      );
    }
    let body;
    try {
      body = readFileSync(join(dir, target), 'utf-8');
    } catch (err) {
      throw new Error(
        `cloud-init: "${name}" includes "${target}", which could not be read: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // Drop one trailing newline: the directive line's own newline is
    // preserved by String#replace, so keeping the snippet's would insert a
    // blank line and make the shared-snippet-is-verbatim assertions noisy.
    return body.endsWith('\n') ? body.slice(0, -1) : body;
  });
}

/**
 * Read a cloud-init script template by basename (e.g. 'master-init.sh'),
 * with `# @include` directives resolved. Returns the raw template —
 * `${var}` placeholders are NOT yet substituted; pass to `renderScript()`
 * to substitute.
 *
 * @param {string} name  Basename inside carbon/cloud-init/k3s/.
 * @returns {string}     UTF-8 contents of the script.
 */
export function loadCloudInit(name) {
  return resolveIncludes(name);
}

/**
 * Substitute ${var} placeholders in a cloud-init script template with
 * values from a JS object. Used to render the master/supabase/worker
 * cloud-init scripts at deploy time.
 *
 * @param {string} tmpl
 * @param {Record<string, unknown>} vars
 * @returns {string}
 */
export function renderScript(tmpl, vars) {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), String(v ?? '')),
    tmpl,
  );
}
