/**
 * One certificate per name on k8s.
 *
 * `vibecarbon-tls` (carbon/k8s/base/traefik/certificate.yaml) is the only
 * certificate the cluster carries for the app's names. Traefik's certificate
 * store is global across namespaces and picks a certificate by SNI alone, so
 * a router in another namespace (the observability add-on's Grafana route)
 * declares `tls: {}` and is served `vibecarbon-tls`, which the app's own
 * IngressRoute loads into the store.
 *
 * The observability add-on used to issue a second certificate, `grafana-tls`,
 * for the bare app domain. With two certificates matching the same SNI,
 * Traefik served whichever it picked at start, and a correct restore of
 * `vibecarbon-tls` could still leave the domain serving the other serial
 * (DigitalOcean k8s-ha e2e, verify-restore `tls_reused`).
 * tests/unit/deploy/one-certificate-per-name-census.test.ts keeps every
 * shipped manifest to one certificate per name; this module removes what an
 * older deploy left behind.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The certificate the observability add-on no longer issues. */
export const RETIRED_OBSERVABILITY_CERTIFICATE = Object.freeze({
  namespace: 'vibecarbon-observability',
  name: 'grafana-tls',
});

const OBSERVABILITY_DIR = 'k8s/base/observability';

/** The text without its YAML comments, so a mention in a comment is no evidence. */
function withoutComments(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
}

function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Why this project's observability files cannot be deployed by this CLI, or
 * null when they can. `vibecarbon add` copied the add-on's k8s files into
 * the project, and `vibecarbon upgrade` does not refresh add-on files, so a
 * project that added observability before the change still asks for
 * grafana-tls. Deployed as-is it would issue that certificate again, now
 * with no deploy-time patch to give it real names. Positive evidence only:
 * the kustomization lists the Certificate's file, or the IngressRoute names
 * its secret.
 *
 * @param {string} projectDir
 * @returns {string|null}
 */
export function staleObservabilityTlsProblem(projectDir) {
  const dir = join(projectDir, OBSERVABILITY_DIR);
  if (!existsSync(join(dir, 'kustomization.yaml'))) return null;
  const kustomization = withoutComments(readOrEmpty(join(dir, 'kustomization.yaml')));
  const ingressRoute = withoutComments(readOrEmpty(join(dir, 'ingressroute.yaml')));
  const listsCertificate = /^\s*-\s*grafana-tls-certificate\.yaml\s*$/m.test(kustomization);
  const namesSecret = /^\s*secretName:\s*["']?grafana-tls["']?\s*$/m.test(ingressRoute);
  if (!listsCertificate && !namesSecret) return null;
  const edits = [];
  if (listsCertificate) {
    edits.push(
      `delete ${OBSERVABILITY_DIR}/grafana-tls-certificate.yaml and its line in ${OBSERVABILITY_DIR}/kustomization.yaml`,
    );
  }
  if (namesSecret) {
    edits.push(
      `in ${OBSERVABILITY_DIR}/ingressroute.yaml, replace the \`tls:\` block with \`tls: {}\``,
    );
  }
  return (
    'Your observability add-on still issues its own grafana-tls certificate for the app domain. ' +
    'A second certificate for the same name lets Traefik serve either one, so a restored certificate may not be the one your domain serves. ' +
    `Grafana now uses the app's certificate. To update the add-on files: ${edits.join('; then ')}. ` +
    'Then deploy again, and the deploy removes the old certificate from the cluster. Nothing was provisioned.'
  );
}

/**
 * Delete the retired grafana-tls Certificate and its Secret (cert-manager
 * leaves a Secret behind when its Certificate goes). Idempotent: both deletes
 * pass `--ignore-not-found`, so an env that never had them is unaffected.
 * The Certificate goes first, so cert-manager cannot re-create the Secret.
 *
 * @param {{ env: Record<string, string|undefined>,
 *   kubectl: (argv: string[], opts?: object) => Promise<unknown> }} args
 */
export async function removeRetiredObservabilityCertificate({ env, kubectl }) {
  const { namespace, name } = RETIRED_OBSERVABILITY_CERTIFICATE;
  for (const kind of ['certificate', 'secret']) {
    await kubectl(['-n', namespace, 'delete', kind, name, '--ignore-not-found'], {
      env,
      description: `applyK3sManifests: remove the retired ${kind}/${name}`,
    });
  }
}
