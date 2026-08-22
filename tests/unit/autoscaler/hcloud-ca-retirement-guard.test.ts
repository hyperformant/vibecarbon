/**
 * M2 retirement guard: the in-tree hcloud cluster-autoscaler cloudprovider
 * wiring is retired for good. Task 8
 * (`feat(deploy): render carbon-autoscaler config Secret; retire hcloud CA
 * wiring`) swapped the base64-encoded `hcloud-cluster-config` Secret (env
 * `HCLOUD_CLUSTER_CONFIG`, built by `renderCAClusterConfig`/
 * `formatCaNodesSpec`) for the plain-JSON `carbon-autoscaler-config` Secret
 * rendered by `renderCarbonAutoscalerConfig`. Task 9 deleted the
 * `updateCaNodesArgs` kubectl-argv re-patch helper (`scale.js`) in favor of
 * `applyCaBoundsToConfig` mutating the Secret directly. The CA container
 * itself no longer runs `--cloud-provider=hetzner` / `--nodes={{CA_NODES_SPEC}}`
 * — it runs `--cloud-provider=externalgrpc` against the in-repo
 * carbon-autoscaler sidecar. There is no longer an "allowed" production or
 * test reference to any of these — the pattern must match NOWHERE in
 * `src/`, `carbon/k8s/`, `.github/workflows/`, or `tests/` other than this
 * guard file.
 *
 * This is a static-source recall test, not a runtime one: it reads each
 * file as one string (not line-by-line), so a pattern split across a
 * line-wrap or reformatted whitespace still matches — same rationale as
 * `no-hardcoded-provider-dispatch.test.ts`'s HARDCODE_PATTERN and
 * `credentials-profiles-retirement-guard.test.ts`'s RETIRED_PATTERN.
 *
 * `tests/` is walked too (not just source): a test fixture or comment can
 * reintroduce a retired literal by hand — a dummy `--nodes=` stdout
 * fixture, or a comment naming the old mechanism — just as easily as
 * production code can. This guard file is the ONLY permitted holder of the
 * tokens anywhere in the walked trees, so it excludes only its own path.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');
const CARBON_K8S_ROOT = join(process.cwd(), 'carbon', 'k8s');
const WORKFLOWS_ROOT = join(process.cwd(), '.github', 'workflows');
const TESTS_ROOT = join(process.cwd(), 'tests');
const GUARD_FILE = join(TESTS_ROOT, 'unit', 'autoscaler', 'hcloud-ca-retirement-guard.test.ts');
// Git-ignored local run artifacts (e2e logs, metrics db). Historical logs
// legitimately quote retired tokens from pre-retirement runs; CI checkouts
// never contain this directory, so without the exclusion the guard is green
// in CI but red on any dev machine holding old logs (observed 2026-07-29).
const RESULTS_ROOT = join(TESTS_ROOT, 'results');

const RETIRED_PATTERN =
  /HCLOUD_CLUSTER_CONFIG|hcloud-cluster-config|formatCaNodesSpec|updateCaNodesArgs|renderCAClusterConfig|CA_NODES_SPEC|cloud-provider=hetzner/;

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (full === RESULTS_ROOT) continue;
      out.push(...walkFiles(full));
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

describe('no src/, carbon/k8s/, .github/workflows/, or tests/ file references the retired hcloud in-tree CA wiring', () => {
  it('zero matches anywhere (no exemptions besides this guard file)', () => {
    const srcFiles = walkFiles(SRC_ROOT);
    expect(srcFiles.length).toBeGreaterThan(50); // sanity: the walk actually found the tree

    const carbonK8sFiles = walkFiles(CARBON_K8S_ROOT);
    expect(carbonK8sFiles.length).toBeGreaterThan(0); // sanity: the walk found the k8s manifests

    const workflowFiles = walkFiles(WORKFLOWS_ROOT);
    expect(workflowFiles.length).toBeGreaterThan(0); // sanity: the walk found the workflows

    const testFiles = walkFiles(TESTS_ROOT).filter((f) => f !== GUARD_FILE);
    expect(testFiles.length).toBeGreaterThan(100); // sanity: the walk found the test tree

    const allFiles = [...srcFiles, ...carbonK8sFiles, ...workflowFiles, ...testFiles];

    const offenders: Array<{ file: string; match: string }> = [];
    for (const file of allFiles) {
      const content = readFileSync(file, 'utf-8');
      const match = content.match(RETIRED_PATTERN);
      if (match) {
        offenders.push({ file: file.replace(`${process.cwd()}${sep}`, ''), match: match[0] });
      }
    }

    expect(offenders).toEqual([]);
  });

  // Positive control: proves RETIRED_PATTERN actually catches every retired
  // token (not just some of them), and doesn't false-positive on the new
  // carbon-autoscaler architecture that replaced it — so a silently-broken
  // regex can't make the assertion above pass vacuously.
  it('pattern control: matches every retired token, ignores the new architecture', () => {
    expect(RETIRED_PATTERN.test('HCLOUD_CLUSTER_CONFIG.nodeConfigs.worker-pool.serverLabels')).toBe(
      true,
    );
    expect(RETIRED_PATTERN.test('kubectl apply Secret/hcloud-cluster-config')).toBe(true);
    expect(RETIRED_PATTERN.test('formatCaNodesSpec(minWorkers, maxWorkers, region)')).toBe(true);
    expect(RETIRED_PATTERN.test('updateCaNodesArgs(argList, spec)')).toBe(true);
    expect(RETIRED_PATTERN.test('renderCAClusterConfig(options)')).toBe(true);
    expect(RETIRED_PATTERN.test('"--nodes={{CA_NODES_SPEC}}"')).toBe(true);
    expect(RETIRED_PATTERN.test("'--cloud-provider=hetzner'")).toBe(true);
    // control: the new architecture doesn't false-positive
    expect(RETIRED_PATTERN.test('renderCarbonAutoscalerConfig(options)')).toBe(false);
    expect(RETIRED_PATTERN.test('applyCaBoundsToConfig(configJson, bounds)')).toBe(false);
    expect(RETIRED_PATTERN.test("'--cloud-provider=externalgrpc'")).toBe(false);
    expect(RETIRED_PATTERN.test('name: carbon-autoscaler-config')).toBe(false);
  });
});
