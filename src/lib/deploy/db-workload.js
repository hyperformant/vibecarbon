/**
 * The names of the Kubernetes database workload, in one place.
 *
 * Postgres runs as our own StatefulSet (carbon/k8s/base/db/statefulset.yaml).
 * Every `kubectl exec`, `rollout`, `scale` and PVC lookup the CLI performs
 * against it uses these constants, so a rename is one edit here plus the
 * manifest, and a unit test (k8s-db-statefulset.test.ts) pins the two
 * together.
 *
 * A leaf module on purpose: the backup, restore, replication and status
 * code outside src/lib/deploy/k8s/ needs the same names without importing
 * engine internals.
 */

/**
 * What one kubectl call into a pod may take. `exec` and `logs` go apiserver to
 * kubelet to the container, a path that has hung on a healthy db until the
 * call's own bound killed it (30 s on a role write, 120 s on a backup audit)
 * with the cause unknown, so a hang has to cost seconds and never the deploy's
 * whole wait. A long operation (a reseed stage, `rm -rf` of an old cluster, ANALYZE)
 * names its own bound beside its call. Every pod call names one
 * (tests/unit/deploy/pod-exec-bound-census.test.ts): sshRun's default is 120 s
 * and runCommandAsync has none.
 *
 * Slowest real runs (perf_substep, k8s modes on DigitalOcean and Hetzner,
 * 2026-08 to 2026-11): auditRls 1.5 s, the whole app health wait 1.8 s, the
 * replication setup 4.9 s, the pg_hba write 1.2 s. pg_isready has no timing of
 * its own here; its connect timeout caps it at 3 s.
 */
/** pg_isready (its own connect timeout is 3 s), a stat, a read of a small file, df. */
export const POD_EXEC_PROBE_MS = 10_000;

/** One psql statement, or the app's health probe (4 s http plus node starting). */
export const POD_EXEC_QUERY_MS = 15_000;

/** A short write with no loop around it: replication setup, pg_hba, a slot, a promote. */
export const POD_EXEC_WRITE_MS = 30_000;

/** The StatefulSet (`statefulset/db`). */
export const DB_STATEFULSET = 'db';

/** Its only pod: StatefulSet pods are `<name>-<ordinal>`. */
export const DB_POD = `${DB_STATEFULSET}-0`;

/** The postgres container inside the pod (its one init is walg-restore). */
export const DB_CONTAINER = 'db';

/** The volumeClaimTemplate name; its claim is `<template>-<pod>`. */
export const DB_VOLUME_CLAIM_TEMPLATE = 'data';

/** The PGDATA claim (`data-db-0`): the one PVC whose StorageClass decides the database's durability. */
export const DB_PVC = `${DB_VOLUME_CLAIM_TEMPLATE}-${DB_POD}`;

/** The pod label every selector uses (NetworkPolicies, Services, the admin Infrastructure page). */
export const DB_APP_LABEL = 'vibecarbon-db';

/** `kubectl -l` selector for the db pod. */
export const DB_POD_SELECTOR = `app=${DB_APP_LABEL}`;

/**
 * Line 2 of db-guard.sh (both copies): the reseed protocol it speaks. The
 * live-pod guard greps it in the mounted wrapper (replication.js), and the
 * scaffold lockstep preflight requires it in the template's ConfigMap key.
 */
export const DB_GUARD_PROTOCOL_MARKER = '# vc-reseed-protocol: 1';

/** The db container's command when it runs the wrapper (statefulset.yaml). */
export const DB_GUARD_COMMAND = Object.freeze(['sh', '/usr/local/bin/db-guard.sh']);

/** The docs/technical.md section that walks the rebuild below. */
export const STANDBY_DB_REBUILD_DOC =
  'docs/technical.md, "Rebuilding a k8s-ha standby whose db cannot start"';

/**
 * What a cold deploy says when the k8s-ha STANDBY's db cannot run: the one
 * manual way back (a CLI command for it is a tracked follow-up). On the
 * standby cluster, its db pod and volume go, the StatefulSet makes a fresh
 * volume (initdb, its own system identifier), and the next deploy's cold
 * reseed seeds it in place from the primary, the same path a brand-new
 * standby cluster takes. Never for the primary: its volume is the data.
 *
 * @param {string} [envName]
 * @returns {string}
 */
export function standbyDbRebuildHint(envName) {
  const env = envName || '<env>';
  const k = (args) => `\`kubectl ${args} -n vibecarbon\``;
  return (
    "If the standby's postgres cannot start at all (a crash loop, a damaged data directory), " +
    'rebuild its db on the STANDBY cluster (never the primary) with ' +
    `${k(`scale statefulset/${DB_STATEFULSET} --replicas=0`)} then ` +
    `${k(`wait --for=delete pod/${DB_POD} --timeout=600s`)} then ` +
    `${k(`delete pvc ${DB_PVC}`)} then ` +
    `${k(`scale statefulset/${DB_STATEFULSET} --replicas=1`)} and then ` +
    `\`vibecarbon deploy ${env}\` seeds it from the primary (${STANDBY_DB_REBUILD_DOC})`
  );
}
