// Regenerate tests/fixtures/supabase-chart-workloads.json from the PINNED
// supabase chart. Run on every chart pin bump (4th lockstep artifact — see
// SUPABASE_HELM_CHART_VERSION in src/lib/deploy/k8s/k3s.js).
// Requires: helm + the supabase-community repo added locally.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const k3s = readFileSync(join(root, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
const version = k3s.match(/SUPABASE_HELM_CHART_VERSION = '([^']+)'/)[1];

// Render with OUR values template (dummy-substituted) so component toggles
// (functions/analytics/vector disabled) match what deploy actually installs.
const values = readFileSync(join(root, 'carbon/k8s/values/supabase.values.yaml'), 'utf-8')
  .replace(/\{\{[A-Z0-9_]+\}\}/g, 'placeholder');
const tmp = join(root, 'tests/fixtures/.render-values.tmp.yaml');
writeFileSync(tmp, values);
const manifest = execFileSync(
  'helm',
  ['template', 'supabase', 'supabase-community/supabase', '--version', version, '-n', 'vibecarbon', '-f', tmp],
  { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
);
const docs = manifest.split(/^---$/m);
const nameOf = (d) => d.match(/^  name: (\S+)/m)?.[1] ?? '';
const strip = (n) => n.replace(/^supabase-supabase-/, '');
const deployments = [...new Set(docs.filter((d) => /^kind: Deployment$/m.test(d)).map(nameOf).map(strip))].sort();
const statefulsets = [...new Set(docs.filter((d) => /^kind: StatefulSet$/m.test(d)).map(nameOf).map(strip))].sort();
// PVCs render as `supabase-<persistence-key>` (single prefix, unlike the
// workload names) — the stripped name IS the chart's `persistence.<key>`.
// The standby zero-overlay must disable persistence for every key not
// consumed by the db StatefulSet: a WaitForFirstConsumer PVC whose only
// consumer is a zeroed Deployment sits Pending forever and blocks
// `helm --wait` (RCA 2026-07-17 e4 rig).
const stripPvc = (n) => n.replace(/^supabase-/, '');
const pvcs = [...new Set(docs.filter((d) => /^kind: PersistentVolumeClaim$/m.test(d)).map(nameOf).map(stripPvc))].sort();
writeFileSync(
  join(root, 'tests/fixtures/supabase-chart-workloads.json'),
  JSON.stringify({ chartVersion: version, deployments, statefulsets, pvcs }, null, 2) + '\n',
);
execFileSync('rm', ['-f', tmp]);
console.log(`chartVersion ${version}: deployments=[${deployments}] statefulsets=[${statefulsets}] pvcs=[${pvcs}]`);
