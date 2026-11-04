import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');

function kustomizeBuild(path: string): { ok: boolean; stdout: string; stderr: string } {
  // `kubectl kustomize` is pure client-side — it doesn't need a kubeconfig
  // or cluster connection. `kubectl apply --dry-run=client -k` would also
  // work conceptually but needs a kubeconfig pointing somewhere reachable.
  const result = spawnSync('kubectl', ['kustomize', path], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}

// Warm `kubectl` once before the timed tests. The FIRST `kubectl kustomize`
// invocation on a cold CI runner can take ~11s (loading the large Go binary
// into page cache), which blew the 5s default test timeout for whichever
// kustomizeBuild test ran first — locally it's ~0.04s and all pass; it only
// flaked on CI cold-start (PR #86). Paying that one-time cost in a hook with a
// generous timeout means every test below runs against a warm kubectl.
beforeAll(() => {
  spawnSync('kubectl', ['kustomize', 'carbon/k8s/infra/cert-manager-resources'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
}, 60_000);

describe('cert-manager-resources kustomization', () => {
  it('builds without error (catches yaml-syntax + bad-resource-list breakage cheaply)', () => {
    const result = kustomizeBuild('carbon/k8s/infra/cert-manager-resources');
    if (!result.ok) {
      throw new Error(`kustomize build failed:\n${result.stderr}\n${result.stdout}`);
    }
    expect(result.stdout).toBeTruthy();
  });

  it('emits the one HTTP-01 issuer pair, plus the standby self-signed issuer', () => {
    const { stdout } = kustomizeBuild('carbon/k8s/infra/cert-manager-resources');
    expect(stdout).toContain('name: letsencrypt-prod\n');
    expect(stdout).toContain('name: letsencrypt-staging\n');
    expect(stdout).toContain('name: vibecarbon-standby-selfsigned');
    expect(stdout).not.toContain('dns01:');
  });

  it('lists every cluster-issuer file in the kustomization (an unlisted file silently never applies)', () => {
    const dir = resolve(REPO_ROOT, 'carbon/k8s/infra/cert-manager-resources');
    const onDisk = readdirSync(dir)
      .filter((f) => f.startsWith('cluster-issuer') && f.endsWith('.yaml'))
      .sort();
    const kustomization = readFileSync(resolve(dir, 'kustomization.yaml'), 'utf-8');
    const listed = [...kustomization.matchAll(/^\s*-\s+(cluster-issuer[\w-]*\.yaml)\s*$/gm)]
      .map((m) => m[1])
      .sort();
    expect(listed).toEqual(onDisk);
  });
});

describe('k8s/base kustomization — backup NetworkPolicy under default-deny egress', () => {
  it('builds without error', () => {
    const result = kustomizeBuild('carbon/k8s/base');
    if (!result.ok) {
      throw new Error(`kustomize build failed:\n${result.stderr}\n${result.stdout}`);
    }
    expect(result.stdout).toBeTruthy();
  });

  it('gives the backup CronJob pod template a stable, policy-matching label', () => {
    // kubectl create job --from=cronjob/backup (src/backup.js triggerBackupJob)
    // copies this podTemplateSpec verbatim, so the manual backup-manual-<ts>
    // Job's pods inherit this same label and fall under backup-policy below
    // without a separate NetworkPolicy.
    const { stdout } = kustomizeBuild('carbon/k8s/base');
    const cronJob = stdout
      .split('---')
      .find((doc) => /kind: CronJob/.test(doc) && /\bname: backup\b/.test(doc));
    expect(cronJob).toBeTruthy();
    expect(cronJob).toContain('app: vibecarbon-backup');
  });

  it('gives backup pods apiserver egress on 6443 (post-NAT dial-anywhere), not just the 10.43.0.1 ClusterIP', () => {
    // LIVE RCA (e3 kept rig, 2026-07-07): the manual backup Job's kubectl
    // exec got `dial tcp 10.43.0.1:443: connect: connection refused`.
    // kube-proxy DNATs the kubernetes.default ClusterIP to the master
    // node's real (often public) IP at the OUTPUT chain BEFORE kube-router
    // evaluates NetworkPolicy egress, so a 10.43.0.1/32-only rule never
    // matches — the policy needs the 0.0.0.0/0:6443 dial-anywhere rule that
    // app-policy and traefik-policy already carry for the same reason.
    const { stdout } = kustomizeBuild('carbon/k8s/base');
    const backupPolicy = stdout
      .split('---')
      .find((doc) => /kind: NetworkPolicy/.test(doc) && /name: backup-policy/.test(doc));
    expect(backupPolicy).toBeTruthy();
    expect(backupPolicy).toContain('app: vibecarbon-backup');
    // Post-NAT dial-anywhere rule on port 6443, unscoped to 0.0.0.0/0.
    expect(backupPolicy).toMatch(/port: 6443[\s\S]*?cidr: 0\.0\.0\.0\/0/);
    // Pre-NAT ClusterIP rule is still present (harmless, matches sibling policies).
    expect(backupPolicy).toMatch(/port: 443[\s\S]*?cidr: 10\.43\.0\.1\/32/);
  });
});

describe('observability kustomization', () => {
  // M3 Task 4: the RAW dir carries a `{{K8S_STORAGE_CLASS}}` placeholder in
  // its PVCs (invalid YAML for kustomize BY DESIGN — a hand-apply of the
  // unrendered dir must fail loudly, since k8s would otherwise accept an
  // unresolved storageClassName and leave the PVC Pending forever). Deploy
  // builds a rendered temp copy via renderK8sStorageClassPlaceholder; this
  // suite mirrors that, exactly like applyK3sManifests does.
  let renderedDir = '';

  beforeAll(async () => {
    // @ts-expect-error — JS module without types
    const { renderK8sStorageClassPlaceholder } = await import('../../../src/lib/deploy/k8s/k3s.js');
    renderedDir = renderK8sStorageClassPlaceholder(
      resolve(REPO_ROOT, 'services/observability/k8s'),
      'hcloud-volumes',
    );
  }, 60_000);

  it('the RAW dir refuses to build (placeholder is a loud kustomize error, not a silent Pending PVC)', () => {
    const result = kustomizeBuild('services/observability/k8s');
    expect(result.ok).toBe(false);
  });

  it('the rendered dir builds without error (catches yaml-syntax + bad-resource-list breakage cheaply)', () => {
    const result = kustomizeBuild(renderedDir);
    if (!result.ok) {
      throw new Error(`kustomize build failed:\n${result.stderr}\n${result.stdout}`);
    }
    expect(result.stdout).toBeTruthy();
    expect(result.stdout).toContain('storageClassName: hcloud-volumes');
  });

  it('emits the Prometheus, Grafana, and Loki workloads', () => {
    const { stdout } = kustomizeBuild(renderedDir);
    expect(stdout).toContain('vibecarbon-prometheus');
    expect(stdout).toContain('vibecarbon-grafana');
    expect(stdout).toContain('name: loki-config');
  });

  it('keeps the Loki 3.x compactor config valid (delete_request_store set when retention is on)', () => {
    // retention_enabled: true without delete_request_store crash-loops Loki
    // with "CONFIG ERROR: invalid compactor config" (fixed in
    // services/observability/k8s/loki-configmap.yaml). Lock it in at build time.
    const { stdout } = kustomizeBuild(renderedDir);
    expect(stdout).toContain('retention_enabled: true');
    expect(stdout).toContain('delete_request_store: filesystem');
  });
});
