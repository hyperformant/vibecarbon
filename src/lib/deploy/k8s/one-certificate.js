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
 * null when they can: the project's copy of the add-on (k8s/base/
 * observability, written by `vibecarbon add`) still issues grafana-tls, and
 * `vibecarbon upgrade` refreshes add-on files from the CLI's bundled copy.
 * Positive evidence only: the kustomization lists the Certificate's file,
 * or the IngressRoute names its secret.
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
  return 'Your observability add-on files are out of date. Run `vibecarbon upgrade`, then deploy again.';
}

/**
 * The IngressRoutes in a `get ingressroute -o json` that name the retired
 * secret. Throws when the output is not a list: an unread list is no proof
 * that no route names it, and deleting the Secret under such a route would
 * leave it naming nothing.
 */
function routesNamingRetiredSecret(listJson) {
  let items;
  try {
    items = JSON.parse(listJson)?.items;
  } catch {
    items = undefined;
  }
  if (!Array.isArray(items)) {
    throw new Error(
      `could not read the IngressRoutes in ${RETIRED_OBSERVABILITY_CERTIFICATE.namespace}, so the retired ${RETIRED_OBSERVABILITY_CERTIFICATE.name} was left in place`,
    );
  }
  return items
    .filter((r) => r?.spec?.tls?.secretName === RETIRED_OBSERVABILITY_CERTIFICATE.name)
    .map((r) => r?.metadata?.name)
    .filter(Boolean);
}

/**
 * Delete what the retired grafana-tls left in the observability namespace:
 * any IngressRoute that still names its secret (a stack whose add-on left
 * the project tree keeps the old route), the Certificate, and its Secret
 * (cert-manager leaves a Secret behind when its Certificate goes).
 * Idempotent: every delete passes `--ignore-not-found`. The Certificate goes
 * before its Secret, so cert-manager cannot re-create the Secret. The caller
 * has found the namespace.
 *
 * @param {{ env: Record<string, string|undefined>,
 *   kubectl: (argv: string[], opts?: object) => Promise<unknown> }} args
 */
export async function removeRetiredObservabilityCertificate({ env, kubectl }) {
  const { namespace, name } = RETIRED_OBSERVABILITY_CERTIFICATE;
  const routes = routesNamingRetiredSecret(
    String(
      (await kubectl(['-n', namespace, 'get', 'ingressroute', '-o', 'json'], {
        env,
        captureStdout: true,
        description: 'applyK3sManifests: list the observability IngressRoutes',
      })) ?? '',
    ),
  );
  for (const route of routes) {
    await kubectl(['-n', namespace, 'delete', 'ingressroute', route, '--ignore-not-found'], {
      env,
      description: `applyK3sManifests: remove ingressroute/${route}, which names ${name}`,
    });
  }
  for (const kind of ['certificate', 'secret']) {
    await kubectl(['-n', namespace, 'delete', kind, name, '--ignore-not-found'], {
      env,
      description: `applyK3sManifests: remove the retired ${kind}/${name}`,
    });
  }
}

/**
 * removeRetiredObservabilityCertificate wherever the observability namespace
 * exists, whatever the project tree holds: a primary whose project removed
 * the add-on, or an ex-standby promoted, still carries the stack. No-op
 * without the namespace.
 *
 * @param {{ env: Record<string, string|undefined>,
 *   kubectl: (argv: string[], opts?: object) => Promise<unknown> }} args
 * @returns {Promise<boolean>} true when the namespace was found
 */
export async function retireObservabilityCertificateIfPresent({ env, kubectl }) {
  const { namespace } = RETIRED_OBSERVABILITY_CERTIFICATE;
  const found = String(
    (await kubectl(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name'], {
      env,
      captureStdout: true,
      description: 'applyK3sManifests: look for the observability namespace',
    })) ?? '',
  ).trim();
  if (!found) return false;
  await removeRetiredObservabilityCertificate({ env, kubectl });
  return true;
}
