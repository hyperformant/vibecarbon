#!/usr/bin/env node
/**
 * The cert-manager install a k8s cluster runs with. ONE renderer for both
 * ways a cluster gets it:
 *
 * - the vibecarbon CLI imports this module when it applies a cluster
 *   (applyK3sManifests writes the kustomization into a temp dir and renders
 *   it here, then applies the result on the master);
 * - the GitOps deploy workflow (.github/workflows/deploy.yml) runs it as a
 *   script and applies the same directory.
 *
 * The upstream install manifest is the one resource; our settings are
 * kustomize patches rendered INTO it, so a single apply yields the final
 * Deployment specs. Nothing patches a cert-manager Deployment after the
 * apply: the upstream manifest's container args are a plain list, which a
 * client-side `kubectl apply` replaces wholesale, so a post-apply patch was
 * undone by every re-apply and re-done by the next patch. That rolled the
 * controller twice per deploy, warm redeploys included, and a controller
 * handoff can miss a restored Secret/vibecarbon-tls in its cache and issue a
 * brand-new certificate. Rendered in, an identical re-apply is a no-op.
 *
 * Script usage: `node scripts/render-cert-manager.mjs <dir>` writes
 * `<dir>/kustomization.yaml`; then `kubectl apply -k <dir>`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The cert-manager release. Re-cut the fixture
 * tests/fixtures/cert-manager-<version>-deployments.upstream.txt from the new
 * manifest when bumping, so the render test proves the patches still land.
 */
export const CERT_MANAGER_VERSION = 'v1.20.2';

export const CERT_MANAGER_URL = `https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml`;

/**
 * The oldest kubectl that can apply this render: 1.27, the first release
 * whose built-in kustomize is v5, which loads the release manifest's https
 * URL as a plain file resource. The CLI's k8s deploy preflight refuses an
 * older one (kubectlFloorProblem); the GitOps workflow pins a newer kubectl
 * itself (azure/setup-kubectl).
 */
export const KUBECTL_MIN_VERSION = Object.freeze({ major: 1, minor: 27 });

/**
 * Judge `kubectl version --client -o json`: a message when the client is
 * proven older than KUBECTL_MIN_VERSION, otherwise null. Output that cannot
 * be read proves nothing and is not refused.
 *
 * @param {string} versionJson
 * @returns {string|null}
 */
export function kubectlFloorProblem(versionJson) {
  let client;
  try {
    client = JSON.parse(versionJson)?.clientVersion;
  } catch {
    return null;
  }
  const major = Number.parseInt(client?.major ?? '', 10);
  const minor = Number.parseInt(client?.minor ?? '', 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  const { major: wantMajor, minor: wantMinor } = KUBECTL_MIN_VERSION;
  if (major > wantMajor || (major === wantMajor && minor >= wantMinor)) return null;
  const want = `${wantMajor}.${wantMinor}`;
  return (
    `kubectl ${major}.${minor} is older than ${want}, the oldest that can install cert-manager: ` +
    'its built-in kustomize must be v5 to load the release manifest from its URL. ' +
    `Install kubectl ${want} or newer, then run the deploy again.`
  );
}

/**
 * cert-manager's minimum backoff after a failed CertificateRequest (the
 * controller's `--certificate-request-minimum-backoff-duration`; its own
 * default is 1h). A first issuance that misses the deploy's first look is
 * retried within minutes, while the deploy has already finished with TLS
 * pending.
 */
export const CERT_MANAGER_MIN_BACKOFF = '5m';

/**
 * The flags the cert-manager controller runs with, appended to upstream's
 * args:
 *
 * - The minimum backoff after a failed CertificateRequest is
 *   CERT_MANAGER_MIN_BACKOFF instead of cert-manager's 1 hour.
 *
 * The order is the order the retired post-apply patch appended them in, so
 * a cluster that carries them from that patch sees an identical spec and
 * does not roll.
 */
export const CERT_MANAGER_CONTROLLER_FLAGS = Object.freeze([
  `--certificate-request-minimum-backoff-duration=${CERT_MANAGER_MIN_BACKOFF}`,
]);

/** The three Deployments of the upstream manifest, all pinned below. */
export const CERT_MANAGER_DEPLOYMENTS = Object.freeze([
  'cert-manager',
  'cert-manager-cainjector',
  'cert-manager-webhook',
]);

/**
 * Every cert-manager Deployment runs on the control-plane node. The
 * in-cluster `kubernetes` Endpoints advertises the master's PUBLIC IP (k3s
 * installs with --node-ip=<public>), and the cloud firewall admits public
 * :6443 from operator CIDRs only, so an apiserver-dependent pod scheduled
 * onto any other node times out on 10.43.0.1 forever (RCA 2026-07-17 e4 rig:
 * cainjector CrashLoopBackOff, webhook readiness 500). The toleration rides
 * along for distros that taint the control plane.
 */
const CONTROL_PLANE_PIN = Object.freeze({
  nodeSelector: { 'node-role.kubernetes.io/control-plane': 'true' },
  tolerations: [
    { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' },
  ],
});

/**
 * The kustomization, as JSON (which kustomize reads as YAML). Deterministic:
 * the same input renders the same bytes, so a warm deploy re-applies an
 * identical spec.
 *
 * The controller args are a JSON 6902 patch: `test` refuses a manifest whose
 * first container is not the controller (an upstream layout change fails the
 * build instead of flagging the wrong container), then one `add` per flag.
 * The pin is a strategic merge, which keeps upstream's
 * `kubernetes.io/os: linux` selector beside ours.
 *
 * @param {{ resource?: string }} [options] - the manifest to patch; the
 *   upstream release by default (tests pass a local fixture)
 * @returns {string}
 */
export function renderCertManagerKustomization({ resource = CERT_MANAGER_URL } = {}) {
  const container = '/spec/template/spec/containers/0';
  const controllerArgs = [
    { op: 'test', path: `${container}/name`, value: 'cert-manager-controller' },
    ...CERT_MANAGER_CONTROLLER_FLAGS.map((value) => ({
      op: 'add',
      path: `${container}/args/-`,
      value,
    })),
  ];
  const pin = (name) =>
    JSON.stringify({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: 'cert-manager' },
      spec: { template: { spec: CONTROL_PLANE_PIN } },
    });
  const kustomization = {
    apiVersion: 'kustomize.config.k8s.io/v1beta1',
    kind: 'Kustomization',
    resources: [resource],
    patches: [
      {
        target: {
          group: 'apps',
          version: 'v1',
          kind: 'Deployment',
          namespace: 'cert-manager',
          name: 'cert-manager',
        },
        patch: JSON.stringify(controllerArgs),
      },
      ...CERT_MANAGER_DEPLOYMENTS.map((name) => ({ patch: pin(name) })),
    ],
  };
  return `${JSON.stringify(kustomization, null, 2)}\n`;
}

/**
 * Write the kustomization into `dir` (created when absent).
 *
 * @param {string} dir
 * @param {{ resource?: string }} [options]
 * @returns {string} the kustomization path
 */
export function writeCertManagerKustomization(dir, options) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'kustomization.yaml');
  writeFileSync(path, renderCertManagerKustomization(options));
  return path;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('usage: node scripts/render-cert-manager.mjs <dir>\n');
    process.exit(1);
  }
  writeCertManagerKustomization(dir);
}
