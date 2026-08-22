/**
 * k8s resource-naming parity — cross-file structural pin (M3 Task 6, closes
 * residual #4).
 *
 * `renderCarbonAutoscalerConfig` (src/lib/deploy/k8s/k3s.js) bakes
 * `sshKeyName`/`firewallName`/`networkName` templates into the
 * carbon-autoscaler config it kubectl-applies into the cluster; the sidecar
 * then resolves those NAMES against the real cloud resources at runtime
 * (groups.js's `_lookupNetworkId`/`_lookupFirewallId`/`sshKeyName` reads —
 * see that function's own doc). Both k8s Pulumi programs
 * (hetzner-k8s.js, digitalocean-k8s.js) declare the actual `Network`/
 * `Vpc`/`Firewall`/`SshKey` resources those names must resolve to. There is
 * no shared constant tying the three together — the naming template is
 * duplicated by hand in three places — so a refactor that renames or
 * re-templates the pattern in ONE file but not the other two would silently
 * break CA-spawned worker creation on whichever provider drifted (workers
 * would come up unable to find their network/firewall/ssh key by name).
 *
 * This test reads SOURCE TEXT (not behavior) from all three files and
 * asserts each one still contains the exact naming template. It is
 * deliberately whitespace-tolerant (so reformatting doesn't false-fail) and
 * positive-controlled: every assertion is an unconditional `toMatch`
 * against real file content, so a regex that stops matching — because the
 * template moved, was renamed, or the file was restructured — fails this
 * test loudly instead of the check silently never running. The "regex
 * sanity" block below double-checks the regexes are actually selective
 * (not accidentally permissive enough to match anything).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const K3S_PATH = 'src/lib/deploy/k8s/k3s.js';
// Every provider's k8s Pulumi program, discovered by walking the programs
// directory (this list was three hardcoded paths until the 2026-08-07
// test-architecture audit — a new provider's <id>-k8s.js program shipped
// with its naming templates unpinned).
const PROGRAMS_DIR = join('src', 'lib', 'iac', 'programs');
const K8S_PROGRAM_PATHS = readdirSync(PROGRAMS_DIR)
  .filter((f) => f.endsWith('-k8s.js'))
  .map((f) => join(PROGRAMS_DIR, f));

// Scoped to renderCarbonAutoscalerConfig's own body (not the whole 4000-line
// k3s.js file) so this test pins the naming templates AT THEIR ACTUAL
// CONSUMPTION SITE — a `${clusterName}-network`-shaped string appearing
// elsewhere in k3s.js for an unrelated reason must not satisfy this test.
// Throws loudly (not a silent empty-string match) if either marker moves,
// which itself is a signal the function was restructured enough to warrant
// re-reading this test.
function extractBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`extractBetween: start marker not found: ${JSON.stringify(startMarker)}`);
  }
  const end = source.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(
      `extractBetween: end marker not found after start: ${JSON.stringify(endMarker)}`,
    );
  }
  return source.slice(start, end);
}

const k3sSource = readFileSync(K3S_PATH, 'utf-8');
const renderCarbonAutoscalerConfigSource = extractBetween(
  k3sSource,
  'export async function renderCarbonAutoscalerConfig(',
  'return JSON.stringify(config, null, 2);\n}',
);

// Whitespace-tolerant (`\s*` around the interpolated names) — reformatting
// (e.g. prettier adding/removing a space inside `${ }`) must not false-fail.
const NETWORK_NAME_RE = /\$\{\s*clusterName\s*\}-network/;
const FIREWALL_NAME_RE = /\$\{\s*clusterName\s*\}-firewall/;
// renderCarbonAutoscalerConfig's own parameter is named `region`; both
// Pulumi programs read the same value off `config.location` (see
// digitalocean-k8s.js's K8sStackConfig.location doc — "DigitalOcean region
// slug"). Same VALUE, different local identifier — the pin tolerates either
// spelling (with or without a `config.` prefix) since it's the naming
// TEMPLATE `<cluster>-<region-or-location>-key` that must agree, not the
// variable name.
const SSH_KEY_NAME_RE = /\$\{\s*clusterName\s*\}-\$\{\s*(?:config\.)?(?:region|location)\s*\}-key/;

describe('k8s program discovery', () => {
  it('the programs walk still sees every provider k8s program (not vacuously green)', () => {
    // 2 programs existed when this was written (hetzner, digitalocean); if
    // the directory or the -k8s.js convention changes, fix the walk, not
    // the floor.
    expect(K8S_PROGRAM_PATHS.length).toBeGreaterThanOrEqual(2);
    expect(K8S_PROGRAM_PATHS.some((p) => p.endsWith('hetzner-k8s.js'))).toBe(true);
  });
});

describe.each([
  ['renderCarbonAutoscalerConfig (k3s.js)', () => renderCarbonAutoscalerConfigSource],
  ...K8S_PROGRAM_PATHS.map((path): [string, () => string] => [
    path,
    () => readFileSync(path, 'utf-8'),
  ]),
])('%s', (_label, getSource) => {
  it('names its network resource <clusterName>-network', () => {
    expect(getSource()).toMatch(NETWORK_NAME_RE);
  });

  it('names its firewall resource <clusterName>-firewall', () => {
    expect(getSource()).toMatch(FIREWALL_NAME_RE);
  });

  it('names its ssh key resource <clusterName>-<region|location>-key', () => {
    expect(getSource()).toMatch(SSH_KEY_NAME_RE);
  });
});

// Builds a literal `${name}` substring via REAL JS interpolation, so the
// near-miss/accepted fixtures below never contain a plain string with a
// literal `${...}` sequence sitting in it — biome's noTemplateCurlyInString
// rule (rightly) flags those as probable template-literal mistakes; this
// isn't working around the lint, the fixtures genuinely need to build the
// literal text `${clusterName}` as DATA, not interpolate a real variable.
const DOLLAR = '$';
function ph(name: string): string {
  return `${DOLLAR}{${name}}`;
}

// Near-miss/accepted fixtures for the "regex sanity" checks below.
const NETWORK_NEAR_MISSES = [
  `${ph('clusterName')}_network`,
  `network-${ph('clusterName')}`,
  `${ph('clusterId')}-network`,
];
const FIREWALL_NEAR_MISSES = [
  `${ph('clusterName')}_firewall`,
  `firewall-${ph('clusterName')}`,
  `${ph('clusterId')}-firewall`,
];
const SSH_KEY_NEAR_MISSES = [
  `${ph('clusterName')}-key`,
  `${ph('region')}-${ph('clusterName')}-key`,
  `${ph('clusterName')}-${ph('zone')}-key`,
];
const SSH_KEY_ACCEPTED_SPELLINGS = [
  `${ph('clusterName')}-${ph('region')}-key`,
  `${ph('clusterName')}-${ph('config.location')}-key`,
  `${ph('clusterName')}-${ph('location')}-key`,
];

describe('regex sanity (not vacuously permissive)', () => {
  it('NETWORK_NAME_RE rejects near-miss shapes', () => {
    for (const s of NETWORK_NEAR_MISSES) expect(s).not.toMatch(NETWORK_NAME_RE);
  });

  it('FIREWALL_NAME_RE rejects near-miss shapes', () => {
    for (const s of FIREWALL_NEAR_MISSES) expect(s).not.toMatch(FIREWALL_NAME_RE);
  });

  it('SSH_KEY_NAME_RE rejects near-miss shapes (missing segment, reversed order, wrong variable)', () => {
    for (const s of SSH_KEY_NEAR_MISSES) expect(s).not.toMatch(SSH_KEY_NAME_RE);
  });

  it('SSH_KEY_NAME_RE accepts both the bare `region` and `config.location` spellings', () => {
    for (const s of SSH_KEY_ACCEPTED_SPELLINGS) expect(s).toMatch(SSH_KEY_NAME_RE);
  });
});
