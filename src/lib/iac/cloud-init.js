/**
 * Shared helpers for loading + rendering the k3s cloud-init scripts in
 * `carbon/cloud-init/k3s/` (master-init.sh / worker-init.sh; the database
 * node boots from its provider's worker template, see loadCloudInit).
 *
 * Used by:
 *   - `src/lib/iac/programs/hetzner-k8s.js` to render user_data baked
 *     into the master/database/static-worker servers at Pulumi up.
 *   - `src/lib/deploy/k8s/k3s.js` (`renderCarbonAutoscalerConfig`) to
 *     render the worker-init.sh body that the carbon-autoscaler sidecar
 *     reads from its `carbon-autoscaler-config` Secret's `config.json`
 *     (`nodeGroups['worker-pool'].cloudInit`). The sidecar spawns workers
 *     on demand and passes this body as user-data on each `createServer`.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { csiInstallImageRewrites } from '../images.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cloud-init scripts live in carbon/cloud-init/k3s/.
// Relative to this file: src/lib/iac/ → ../../../carbon/cloud-init/k3s
// Exported for the k3s-apply gate, which digests the tree (buildK3sApplyInputs).
export const CLOUD_INIT_DIR = join(__dirname, '../../../carbon/cloud-init/k3s');

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
 * three Hetzner role scripts (master/database/worker) each need a
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
 * `omit` names snippets to leave out: each one's directive line goes, with
 * the blank line after it, so the script reads as if the include had never
 * been written. A template without that directive throws, so a renamed
 * snippet cannot quietly start shipping where it was left out.
 *
 * @param {string} name  Basename of the template inside `dir`.
 * @param {string} [dir] Directory to resolve from (defaults to the shipped
 *   carbon/cloud-init/k3s/; parameterised for tests).
 * @param {{ omit?: string[] }} [options]
 * @returns {string}     Template with all directives resolved.
 */
export function resolveIncludes(name, dir = CLOUD_INIT_DIR, { omit = [] } = {}) {
  let template = readFileSync(join(dir, name), 'utf-8');
  for (const target of omit) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const directive = new RegExp(`^#[ \\t]*@include[ \\t]+${escaped}[ \\t]*\\n(?:\\n)?`, 'm');
    if (!directive.test(template)) {
      throw new Error(`cloud-init: "${name}" has no @include ${target} to leave out`);
    }
    template = template.replace(directive, '');
  }
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
 * The roles a k3s agent template (a provider's worker-init.sh) boots as,
 * filled into the template's role slots by loadCloudInit: `@{role_flags}` ends
 * the k3s agent's argument list, and `@{role_label}` / `@{role_name}` name the
 * node in its install log lines. A slot left unfilled would ship as literal
 * text, so loading checks that none remains.
 *
 * The dedicated database node runs its provider's worker bootstrap with three
 * differences:
 *  - k3s agent flags that pin database workloads to it and repel everything
 *    else (dedicated=db, which the db StatefulSet's nodeSelector requires and
 *    WORKER_NODE_SELECTOR in src/lib/deploy/k8s/node-roles.js excludes). They
 *    are boot-time flags rather than a post-join `kubectl label`/`kubectl
 *    taint`, so the node is never briefly schedulable for general workloads
 *    between join and label.
 *  - its name in the install log lines.
 *  - no host reporter. The deploy installs it on the db node and the master
 *    over SSH on every run (prePullImages in src/lib/deploy/k8s/k3s.js); only
 *    autoscaler-spawned workers, which no deploy session reaches, need it in
 *    their user data.
 */
const AGENT_ROLES = {
  worker: {
    slots: { role_flags: '', role_label: 'worker', role_name: 'worker' },
    omit: [],
  },
  db: {
    slots: {
      role_flags: [
        ' \\',
        '      --node-label="dedicated=db" \\',
        '      --node-label="node-pool=db-pool" \\',
        '      --node-taint="dedicated=db:NoSchedule"',
      ].join('\n'),
      role_label: 'database-node',
      role_name: 'database node',
    },
    omit: ['_host-reporter.sh'],
  },
};

const ROLE_SLOT = /@\{(role_[a-z_]+)\}/g;

/**
 * Fill a template's role slots for `role`. A template with no slots (a
 * master) loads only as a worker, unchanged; any other template must carry
 * every slot the role fills.
 *
 * @param {string} template
 * @param {keyof typeof AGENT_ROLES} role
 * @param {string} name  For error messages.
 * @returns {string}
 */
function fillRoleSlots(template, role, name) {
  const { slots } = AGENT_ROLES[role];
  const present = new Set(Array.from(template.matchAll(ROLE_SLOT), (m) => m[1]));
  if (present.size > 0 || role !== 'worker') {
    const missing = Object.keys(slots).filter((slot) => !present.has(slot));
    if (missing.length > 0) {
      throw new Error(`cloud-init: "${name}" lacks the role slot(s) ${missing.join(', ')}`);
    }
  }
  // A replacement function, so a `$` in a slot value is never a pattern.
  return template.replace(ROLE_SLOT, (token, slot) => {
    if (!Object.hasOwn(slots, slot)) {
      throw new Error(`cloud-init: "${name}" has an unknown role slot ${token}`);
    }
    return slots[slot];
  });
}

/**
 * Read a cloud-init script template by basename (e.g. 'master-init.sh'),
 * with `# @include` directives resolved and role slots filled. Returns the
 * raw template: `${var}` placeholders are NOT yet substituted; pass to
 * `renderScript()` to substitute.
 *
 * The database node has no template of its own: its provider's static loads
 * the worker template with `{ role: 'db' }` (AGENT_ROLES.db), so the two
 * cannot drift.
 *
 * @param {string} name  Basename inside carbon/cloud-init/k3s/.
 * @param {{ role?: keyof typeof AGENT_ROLES }} [options]
 * @returns {string}     UTF-8 contents of the script.
 */
export function loadCloudInit(name, { role = 'worker' } = {}) {
  if (!Object.hasOwn(AGENT_ROLES, role)) {
    throw new Error(`cloud-init: unknown role "${role}"`);
  }
  const template = resolveIncludes(name, CLOUD_INIT_DIR, { omit: AGENT_ROLES[role].omit });
  return fillRoleSlots(template, role, name);
}

/**
 * The `${csi_image_rewrites}` value a k3s master template's CSI install reads
 * (_csi-image-mirror.sh): one "<upstream ref> <mirror ref>" pair per line,
 * from csiInstallImageRewrites (src/lib/images.js). Each provider's
 * getK8sMasterUserData adds it to the vars it renders with (masterAddedVars),
 * so no caller of that static has it to pass, and none can leave it out.
 *
 * Throws for a provider with no rewrite: its master would install a CSI
 * driver whose sidecars pull from registry.k8s.io, and the template's own
 * check would refuse the empty list on the node, where nobody watches.
 *
 * @param {string} providerId - 'hetzner' | 'digitalocean' | 'linode'
 * @returns {{ csi_image_rewrites: string }}
 */
export function csiImageRewriteVars(providerId) {
  const rewrites = csiInstallImageRewrites(providerId);
  if (rewrites.length === 0) {
    throw new Error(`cloud-init: provider "${providerId}" has no CSI image rewrites`);
  }
  return { csi_image_rewrites: rewrites.map(({ from, to }) => `${from} ${to}`).join('\n') };
}

/**
 * The CSI manifests a k3s master carries in its user data, by provider: a
 * driver that publishes no release manifest, only a Helm chart, has the
 * chart's render committed beside the boot scripts (`file`, its header says
 * how to re-render it). The master decodes `var` to `path` and installs it
 * from there through csi_fetch_mirrored, as every other master installs its
 * driver's manifest from a URL. Nothing is fetched at boot, so a chart
 * release can never change what a node installs.
 *
 * @type {Readonly<Record<string, Readonly<{ var: string, file: string, path: string }>>>}
 */
export const EMBEDDED_CSI_MANIFESTS = Object.freeze({
  scaleway: Object.freeze({
    var: 'scaleway_csi_manifest',
    file: '_scaleway-csi.yaml',
    path: '/root/scaleway-csi.upstream.yaml',
  }),
});

/** @type {Map<string, Record<string, string>>} */
const embeddedVarsCache = new Map();

/**
 * The embedded CSI manifest's var for a provider's master: the committed
 * file, gzip -9, base64, so it fits in user data. Empty for a provider that
 * fetches its manifest.
 *
 * @param {string} providerId
 * @returns {Record<string, string>}
 */
function embeddedManifestVars(providerId) {
  const embedded = EMBEDDED_CSI_MANIFESTS[providerId];
  if (!embedded) return {};
  let vars = embeddedVarsCache.get(providerId);
  if (!vars) {
    const gz = gzipSync(readFileSync(join(CLOUD_INIT_DIR, embedded.file)), { level: 9 });
    vars = { [embedded.var]: gz.toString('base64') };
    embeddedVarsCache.set(providerId, vars);
  }
  return vars;
}

/**
 * What a provider's getK8sMasterUserData adds to its caller's vars: the CSI
 * install's image rewrites (csiImageRewriteVars) and, for a driver the
 * master carries, its manifest (EMBEDDED_CSI_MANIFESTS).
 *
 * @param {string} providerId
 * @returns {Record<string, string>}
 */
export function masterAddedVars(providerId) {
  return { ...csiImageRewriteVars(providerId), ...embeddedManifestVars(providerId) };
}

/**
 * Substitute ${var} placeholders in a cloud-init script template with
 * values from a JS object. Used to render the master/database/worker
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
