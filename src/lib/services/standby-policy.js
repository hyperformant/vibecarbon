/**
 * Add-on HA standby policy. Each add-on declares in services/<name>/manifest.json
 * how it behaves on a standby (`standby`): `primary-only` add-ons write to the
 * primary database so they stay off the standby until promotion, while
 * `with-app-tier` add-ons follow the app tier. Consumers (compose-ha scaling,
 * failover start list, k8s pilot-light zeroing) read this module instead of
 * keeping hand lists; the declaration census keeps manifests honest.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'services');
const POLICIES = ['primary-only', 'with-app-tier'];
const FAILOVER_NAMESPACE = 'vibecarbon';

const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * @param {string} name add-on name (a directory under services/)
 * @returns {{ name: string, policy: 'primary-only'|'with-app-tier', composeServices: string[], composeSetup: string[], k8s: Array<{kind: 'Deployment', name: string, namespace: string}> }}
 */
export function loadAddonStandby(name) {
  const manifestPath = join(SERVICES_DIR, name, 'manifest.json');
  if (!existsSync(manifestPath))
    throw new Error(`add-on "${name}" has no manifest at ${manifestPath}`);
  const standby = readJson(manifestPath).standby;
  const bad = (why) => new Error(`add-on "${name}" has an invalid standby declaration: ${why}`);
  if (!standby || typeof standby !== 'object') throw bad('missing `standby`');
  if (!POLICIES.includes(standby.policy)) throw bad(`policy must be one of ${POLICIES.join(', ')}`);
  const composeServices = standby.compose?.services;
  const composeSetup = standby.compose?.setup;
  if (!isStringList(composeServices)) throw bad('compose.services must be a list of names');
  if (!isStringList(composeSetup)) throw bad('compose.setup must be a list of names');
  const k8s = standby.k8s;
  if (
    !Array.isArray(k8s) ||
    !k8s.every(
      (w) =>
        w?.kind === 'Deployment' && typeof w.name === 'string' && typeof w.namespace === 'string',
    )
  ) {
    throw bad('k8s must be a list of {kind: "Deployment", name, namespace}');
  }
  return { name, policy: standby.policy, composeServices, composeSetup, k8s };
}

/** Every add-on name, in `services/index.json` order (installed or not). */
export function declaredAddonNames() {
  return readJson(join(SERVICES_DIR, 'index.json')).map((s) => s.name);
}

/** The add-ons an env config turns on, as `envConfig[name]` or `envConfig.services[name]`. */
export function enabledAddonNames(envConfig) {
  return declaredAddonNames().filter((name) =>
    Boolean(envConfig?.[name] || envConfig?.services?.[name]),
  );
}

/** The add-ons deployed into a project's k8s tree (`k8s/base/<name>/kustomization.yaml`). */
export function enabledK8sAddonNames(projectDir) {
  return declaredAddonNames().filter((name) =>
    existsSync(join(projectDir, 'k8s', 'base', name, 'kustomization.yaml')),
  );
}

const primaryOnly = (names) =>
  names.map(loadAddonStandby).filter((s) => s.policy === 'primary-only');

/** Compose services (and their one-shot setups) scaled to zero on a standby. */
export function composeStandbyScaledServices(names) {
  return primaryOnly(names).flatMap((s) => [...s.composeServices, ...s.composeSetup]);
}

/** Compose services started on promotion (the one-shot setups are not). */
export function composePromotionServices(names) {
  return primaryOnly(names).flatMap((s) => s.composeServices);
}

/** k8s workloads zeroed on a pilot-light standby: every add-on, both policies, since the app tier is zeroed. */
export function k8sStandbyZeroedWorkloads(names) {
  return names.flatMap((n) => loadAddonStandby(n).k8s);
}

/** k8s add-on workloads in the app namespace, the ones a failover restores. */
export function k8sFailoverAddonWorkloads(names) {
  return k8sStandbyZeroedWorkloads(names).filter((w) => w.namespace === FAILOVER_NAMESPACE);
}

/** k8s workloads of the primary-only add-ons: a failover starts them only once the old primary's writers are stopped. */
export function k8sPrimaryOnlyWorkloads(names) {
  return primaryOnly(names).flatMap((s) => s.k8s);
}

/** Compose services that write to the database: the app plus the promoted primary-only add-ons. */
export function composeWriterServices(names) {
  return ['app', ...composePromotionServices(names)];
}
