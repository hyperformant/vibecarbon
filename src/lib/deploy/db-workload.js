/**
 * The names of the Kubernetes database workload, in one place.
 *
 * Postgres runs as our own StatefulSet (carbon/k8s/base/db/statefulset.yaml).
 * Every `kubectl exec`, `rollout`, `scale` and PVC lookup the CLI performs
 * against it uses these constants, so a rename is one edit here plus the
 * manifest, and a unit test (k8s-db-statefulset.test.ts) pins the two
 * together.
 *
 * A free leaf module on purpose: the backup, restore, replication and status
 * code outside src/lib/deploy/k8s/ needs the same names, and the paid-boundary
 * guard (src/lib/licensing/paid-surface.js) keeps that code from importing
 * engine internals.
 */

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
