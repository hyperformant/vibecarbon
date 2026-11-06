/**
 * The cert-manager install is ONE rendered apply (carbon/scripts/
 * render-cert-manager.mjs): the controller flags and the control-plane pin
 * are kustomize patches rendered into the upstream manifest before the
 * apply, and nothing patches a cert-manager Deployment afterwards.
 *
 * Why (DO k8s-ha e2e, 2026-11): the controller pod restarted on every deploy,
 * warm redeploys included. The upstream args are a plain list, so the
 * client-side `kubectl apply -f <upstream>` replaced them wholesale and the
 * post-apply json patch appended the flags again: two rollouts per deploy. A
 * controller handoff can miss the restored Secret/vibecarbon-tls in its cache
 * ("Issuing certificate as Secret does not exist") and issue a new
 * certificate.
 *
 * The render runs through real kustomize (`kubectl kustomize`, as the
 * sibling k8s-ha-db-hostport-render test does) over the three upstream
 * Deployments, verbatim, in tests/fixtures.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CERT_MANAGER_CONTROLLER_FLAGS,
  CERT_MANAGER_DEPLOYMENTS,
  CERT_MANAGER_MIN_BACKOFF,
  CERT_MANAGER_URL,
  CERT_MANAGER_VERSION,
  renderCertManagerKustomization,
  writeCertManagerKustomization,
} from '../../../carbon/scripts/render-cert-manager.mjs';

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;

const FIXTURE = join(
  __dirname,
  `../../fixtures/cert-manager-${CERT_MANAGER_VERSION}-deployments.upstream.txt`,
);
const UPSTREAM_ARGS = [
  '--v=2',
  '--cluster-resource-namespace=$(POD_NAMESPACE)',
  '--leader-election-namespace=kube-system',
  `--acme-http01-solver-image=quay.io/jetstack/cert-manager-acmesolver:${CERT_MANAGER_VERSION}`,
  '--max-concurrent-challenges=60',
];
const ALL = ['--certificate-request-minimum-backoff-duration=5m'];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A kustomization dir over a local copy of `manifest` (kustomize refuses files outside its root). */
function renderDir(manifest = FIXTURE): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-cert-manager-'));
  dirs.push(dir);
  copyFileSync(manifest, join(dir, 'cert-manager.yaml'));
  writeCertManagerKustomization(dir, { resource: 'cert-manager.yaml' });
  return dir;
}

function kustomize(dir: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync('kubectl', ['kustomize', dir], { encoding: 'utf-8' });
}

function build(dir: string): Doc[] {
  const res = kustomize(dir);
  if (res.status !== 0) throw new Error(`kustomize build failed:\n${res.stderr}`);
  return (loadAll(res.stdout) as Doc[]).filter(Boolean);
}

const deployment = (docs: Doc[], name: string) =>
  docs.find((d) => d.kind === 'Deployment' && d.metadata.name === name);

const upstream = () => (loadAll(readFileSync(FIXTURE, 'utf-8')) as Doc[]).filter(Boolean);

describe('cert-manager controller flags', () => {
  it('is the 5 minute minimum backoff only', () => {
    expect([...CERT_MANAGER_CONTROLLER_FLAGS]).toEqual(ALL);
    expect(CERT_MANAGER_MIN_BACKOFF).toBe('5m');
  });

  it('applies the upstream release by default', () => {
    const k = JSON.parse(renderCertManagerKustomization());
    expect(k.resources).toEqual([CERT_MANAGER_URL]);
    expect(CERT_MANAGER_URL).toBe(
      `https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml`,
    );
  });
});

describe('the rendered cert-manager manifest', () => {
  it('carries the controller flags after upstream args, in order', () => {
    const docs = build(renderDir());
    const controller = deployment(docs, 'cert-manager').spec.template.spec.containers[0];
    expect(controller.name).toBe('cert-manager-controller');
    expect(controller.args).toEqual([...UPSTREAM_ARGS, ...ALL]);
  });

  it('pins all three Deployments to the control plane, keeping the upstream os selector', () => {
    const docs = build(renderDir());
    for (const name of CERT_MANAGER_DEPLOYMENTS) {
      const spec = deployment(docs, name).spec.template.spec;
      expect(spec.nodeSelector).toEqual({
        'kubernetes.io/os': 'linux',
        'node-role.kubernetes.io/control-plane': 'true',
      });
      expect(spec.tolerations).toEqual([
        { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' },
      ]);
    }
  });

  it('changes nothing else: only the patched fields differ from upstream', () => {
    const docs = build(renderDir());
    for (const before of upstream()) {
      const after = structuredClone(deployment(docs, before.metadata.name));
      const spec = after.spec.template.spec;
      spec.nodeSelector = { 'kubernetes.io/os': 'linux' };
      delete spec.tolerations;
      if (before.metadata.name === 'cert-manager') {
        spec.containers[0].args = spec.containers[0].args.slice(0, UPSTREAM_ARGS.length);
      }
      expect(after).toEqual(before);
    }
  });

  it('a re-render is byte-identical, kustomization and built manifest both', () => {
    expect(renderCertManagerKustomization()).toBe(renderCertManagerKustomization());
    const a = renderDir();
    const b = renderDir();
    expect(readFileSync(join(a, 'kustomization.yaml'), 'utf-8')).toBe(
      readFileSync(join(b, 'kustomization.yaml'), 'utf-8'),
    );
    expect(kustomize(a).stdout).toBe(kustomize(b).stdout);
  });

  it('equals the spec the retired post-apply patches produced, so an existing cluster does not roll', () => {
    // The old path: apply upstream, strategic-merge the pin onto each
    // Deployment, json-append the controller flags. The template that path
    // left live is exactly the rendered one, so the first apply after the
    // change finds nothing to roll.
    const docs = build(renderDir());
    for (const before of upstream()) {
      const legacy = structuredClone(before);
      const spec = legacy.spec.template.spec;
      spec.nodeSelector = { ...spec.nodeSelector, 'node-role.kubernetes.io/control-plane': 'true' };
      spec.tolerations = [
        { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' },
      ];
      if (before.metadata.name === 'cert-manager') spec.containers[0].args.push(...ALL);
      expect(deployment(docs, before.metadata.name).spec.template).toEqual(legacy.spec.template);
    }
  });

  it('refuses a manifest whose first container is not the controller', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-cert-manager-'));
    dirs.push(dir);
    const moved = readFileSync(FIXTURE, 'utf-8').replace(
      '- name: cert-manager-controller',
      '- name: something-else',
    );
    writeFileSync(join(dir, 'cert-manager.yaml'), moved);
    writeCertManagerKustomization(dir, { resource: 'cert-manager.yaml' });
    expect(kustomize(dir).status).not.toBe(0);
  });
});

describe('the script form (GitOps workflow)', () => {
  it('writes the same kustomization the CLI applies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-cert-manager-'));
    dirs.push(dir);
    const res = spawnSync(
      process.execPath,
      [join(__dirname, '../../../carbon/scripts/render-cert-manager.mjs'), join(dir, 'k')],
      { encoding: 'utf-8' },
    );
    expect(res.status).toBe(0);
    expect(readFileSync(join(dir, 'k', 'kustomization.yaml'), 'utf-8')).toBe(
      renderCertManagerKustomization(),
    );
  });

  it('refuses without a target directory', () => {
    const res = spawnSync(
      process.execPath,
      [join(__dirname, '../../../carbon/scripts/render-cert-manager.mjs')],
      { encoding: 'utf-8' },
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/usage/);
  });
});

describe('the kubectl floor (lib/runtime-floors.js)', () => {
  it('the k8s deploy preflight checks it right after the tool lookup', () => {
    const k3s = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const tools = k3s.indexOf("for (const tool of ['docker', 'ssh', 'kubectl'])");
    const floor = k3s.indexOf('kubectlFloorProblem(');
    const ok = k3s.indexOf("s.stop('Preflight OK')");
    expect(tools).toBeGreaterThan(-1);
    expect(floor).toBeGreaterThan(tools);
    expect(ok).toBeGreaterThan(floor);
  });
});
