/**
 * k3s-on-Hetzner deploy backend.
 *
 * The Pulumi program is `hetzner-k8s.js`; cloud-init scripts are
 * `carbon/cloud-init/k3s/{master,db,worker}-init.sh`.
 *
 * End-to-end flow on a cold deploy:
 *   1. Preflight: docker, ssh, kubectl on PATH; server-type architecture.
 *   2. Start the app image build locally, in the background, before anything
 *      is provisioned (startAppImageBuild: `vibecarbon-local/<project>:<sha>
 *      [-dirty]-<ts>`, its k3s-build gate inputs read first).
 *   3. Generate (or reuse) the SSH keypair under projectDir/.vibecarbon/deploy_key_<env>.
 *   4. Pulumi up — cloud-init installs k3s + the provider's CCM/CSI on each node.
 *   5. Wait for SSH on master + `/tmp/k3s-ready` marker (onInfraReady fires:
 *      single k8s starts its DNS A record write here).
 *   6. scp `/etc/rancher/k3s/k3s.yaml` from master, patch server URL to public IP.
 *   7. Finish the build and retag it `<masterPrivateIp>:5000/<project>:<tag>`
 *      (deliverAppImage).
 *   8. applyK3sManifests: the image's layer delta into the master's
 *      containerd and the cluster autoscaler rollout start alongside the
 *      cert-manager chain; then applyKustomization a rendered copy of
 *      `k8s/base/` (db StatefulSet, traefik, app, the master's local
 *      registry); the image is pushed into that registry once it serves
 *      (deliverImage pushAfter), and every node pulls it from there.
 *   9. `kubectl rollout status statefulset/db`.
 *   10. `kubectl patch deploy/app` (image + Secret versions) + rollout-status.
 *
 * Warm path: skip what is unchanged (state-gated); a changed source rebuilds
 * (2, 7), changed manifests or a changed tag re-apply and re-deliver (8);
 * rollout (10).
 *
 * Target cold-deploy time: ≤ 3 min for single-master + database + 0 workers.
 * Spike on 2026-04-25 measured 82s for cluster bring-up alone.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { isIPv4 } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderBackupCronJob,
  renderBackupSettingsConfigMap,
  resolveBackupSettings,
} from '../../../../carbon/scripts/render-backup-settings.mjs';
import { writeCertManagerKustomization } from '../../../../carbon/scripts/render-cert-manager.mjs';
import { renderTlsCertificateManifest } from '../../../../carbon/scripts/render-tls-certificate.mjs';
import { backupStorageConfig } from '../../backups-bucket.js';
import { progressLog, spinner } from '../../cli/progress.js';
import { checkDependency, runCommandAsync } from '../../command.js';
import { parseDotenv } from '../../dotenv.js';
import { buildHostKeyOptsForPath, knownHostsPath, seedKnownHosts } from '../../host-keys.js';
import {
  carbonAutoscalerImageRef,
  clusterAutoscalerImageRef,
  csiSidecarSetImagePlan,
  currentImageSet,
  k3sVersion,
  manifestImageValues,
  renderManifestImages,
  resolveDbImage,
} from '../../images.js';
import {
  installOperatorKubeconfig,
  localKubeconfigPath,
  upgradeKubeconfig,
} from '../../kubeconfig.js';
import { readOperatorVar } from '../../operator-env.js';
import { assertOperatorIpUnchanged } from '../../operator-ip-guard.js';
import { perfAsync } from '../../perf.js';
import { providerFor, providerIdFor } from '../../providers/index.js';
import { hasSentinelLine } from '../../remote-sentinel.js';
import { runWithRetry } from '../../retry.js';
import {
  kubectlClientVersion,
  kubectlFloorProblem,
  unreadableMessage,
} from '../../runtime-floors.js';
import {
  declaredAddonNames,
  enabledK8sAddonNames,
  k8sStandbyZeroedWorkloads,
} from '../../services/standby-policy.js';
import { shEscape } from '../../shell.js';
import { scpWithRetry, sshKeyPathFor, sshKubectl, sshRun } from '../../ssh.js';
import { makeTempDir, removeTempDir } from '../../temp-dir.js';
import { pushBaseBackupAfterPromote } from '../../walg/post-promote-backup.js';
import {
  BACKUP_NAME_RE,
  DISCARD_PGDATA_PATH,
  LINEAGE_RE,
  PGDATA_PATH,
  PREVIOUS_PGDATA_PATH,
  PROVEN_WRITABLE_STATES,
  REMOVE_DISCARD_SH,
  RESTORE_ATTEMPT_RE,
  RESTORE_LAYOUT,
  RETIRE_PREVIOUS_SH,
  restoreMarkerStringData,
} from '../../walg/restore-layout.js';
import { assertRestoredPrimaryWritable } from '../../walg/restore-marker.js';
import { APP_RUNTIME_KEYS, appStorageCredential, buildAppRuntimeEnv } from '../app-runtime-env.js';
import { BOOT_MARK_LOG, queueBootTiming, readBootStage } from '../boot-timing.js';
import { collectComposeBuildArgs } from '../compose/build-args.js';
import {
  DB_CONTAINER,
  DB_POD,
  DB_POD_SELECTOR,
  DB_PVC,
  DB_STATEFULSET,
  POD_EXEC_PROBE_MS,
  POD_EXEC_QUERY_MS,
  standbyDbRebuildHint,
} from '../db-workload.js';
import { digestDir, digestPaths } from '../digest.js';
import { deliverImage } from '../layer-delta.js';
import { waitForRemoteMarker } from '../remote-marker.js';
import {
  READ_WRITE_PGOPTIONS,
  REPL_PORT,
  restoreRolloutTimeoutS,
  StaleVolumeAttachmentError,
  watchDbAttach,
} from '../replication.js';
import { RLS_AUDIT_SQL, rlsAuditFailureMessage } from '../rls-audit.js';
import { fingerprintSecret, secretHmac } from '../secret-fingerprint.js';
import { caSlug, tlsSnapshotS3Prefix } from '../tls-snapshot.js';
import {
  assertWalgBackupsWorking,
  k8sWalgAuditArgv,
  WALG_AUDIT_PROBE_TIMEOUT_MS,
} from '../walg-audit.js';
import {
  dbRoleConfigMapManifest,
  k8sWalgRoleIntentApplyArgv,
  readDbRoleRecord,
  setK8sWalgRole,
  WALG_ROLE_DIR,
} from '../walg-role.js';
import { awaitAcmeChallengesSettled, challengeWaitLine } from './acme-challenges.js';
import { STANDBY_SELFSIGNED_ISSUER } from './acme-issuer-policy.js';
import { DEPLOY_OWNED_CERTIFICATES } from './acme-order-recovery.js';
import {
  MANIFEST_DIGEST_SH,
  parseLocalRegistryRef,
  planImageDelivery,
  registryImageTag,
  standbyImageRef,
} from './image-delivery.js';
import { infraFloatingIp } from './ingress-ip.js';
import { MIRROR_PULL_EVENTS_ARGV, mirrorPullFailureHint } from './mirror-pull-diagnosis.js';
import {
  removeRetiredObservabilityCertificate,
  retireObservabilityCertificateIfPresent,
} from './one-certificate.js';
import {
  awaitAppAdminReady,
  awaitCertManagerAdmission,
  awaitCertManagerLeader,
  awaitControlPlaneServing,
  awaitDbPodReady,
  awaitPostgresAccepting,
  awaitPostgresPromoted,
  kubectlSkewNotice,
  watchAppMigrationFailure,
} from './readiness.js';
import { recordRetiredReservedIps } from './retired-reserved-ip.js';
import { tlsApplyTimingLines, tlsRestoreTimingLine } from './tls-reissue-watch.js';
import { k8sTlsRestoreLine, quietKubectl, restoreK8sTlsSecret } from './tls-restore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The vibecarbon CLI's OWN bundled k8s manifest tree (the `carbon/k8s/`
// shipped inside the installed package), as opposed to `projectDir/k8s` —
// the per-project copy `create` lays down. Both feed the `k3s-apply` step:
// the project copy via applyKustomization, this one via the conditional
// standalone manifests below (s3-egress-vpc, repl-gateway). Exported so the
// step-gate regression test can pin the path from outside.
export const BUNDLED_K8S_DIR = join(__dirname, '../../../../carbon/k8s');

// The S3-egress-VPC-allowance manifest (M3 Task 9c) — three additive
// NetworkPolicies (the app and db S3-purposed sibling policies).
// DO-only + conditional, so it lives OUTSIDE the base kustomization (mirrors
// carbon/k8s/base/repl-gateway/repl-gateway.yaml: read from the vibecarbon
// CLI's OWN bundled template — not projectDir — so a re-deploy with an
// updated CLI picks up this fix even against an environment whose
// `projectDir/k8s/base` predates this task, e.g. the DO kept rig). See
// applyK3sManifests's step 5a below for the render + conditional-apply.
const S3_EGRESS_VPC_MANIFEST = join(BUNDLED_K8S_DIR, 'base/s3-egress-vpc/s3-egress-vpc.yaml');

/**
 * The project files + directories the app image is actually built FROM.
 *
 * Mirrors the template Dockerfile's COPY sources (`carbon/Dockerfile`), plus
 * the two inputs the build consumes without ever naming them in a COPY:
 *
 *   - `Dockerfile` — `.dockerignore` excludes `Dockerfile*` from the build
 *     CONTEXT, but it is still the recipe `docker build` executes. A Node bump
 *     or a new build stage changes the image with every other input identical.
 *   - `.dockerignore` — shapes which files inside those COPY sources reach the
 *     daemon at all.
 *
 * Deliberately a hand-picked subset rather than "the whole project dir":
 * digesting `projectDir` wholesale would fold in `.vibecarbon/`, which this
 * very deploy rewrites on every step transition (gate busts every run), plus
 * `dist/` and the k8s manifest tree — and a manifest-only edit must re-APPLY
 * without also forcing a rebuild and a re-delivery of a byte-identical
 * image. `tests/unit/deploy/k3s-build-gate-inputs.test.ts` pins
 * this list against the shipped Dockerfile so a new COPY source can't be added
 * to the template without the gate learning about it.
 */
export const APP_BUILD_CONTEXT_PATHS = Object.freeze([
  '.dockerignore',
  'Dockerfile',
  'biome.json',
  'components.json',
  'content',
  // The app applies its migrations at startup, so they ship in the image: a
  // new migration must rebuild it.
  'db/migrations',
  'docker-entrypoint.sh',
  'package-lock.json',
  'package.json',
  'scripts',
  'src',
  'tsconfig.json',
  'tsconfig.server.json',
  'vite.config.ts',
]);

/** Sources we can't resolve to a literal path inside the build context. */
const UNRESOLVABLE_COPY_SOURCE = /[*?[\]$]|:\/\/|^\/|(^|\/)\.\.(\/|$)/;

/**
 * Extract the in-context source paths of a Dockerfile's COPY/ADD instructions.
 *
 * Why parse at all when APP_BUILD_CONTEXT_PATHS already lists the template's:
 * a customer who adds `COPY public/ ./public/` to THEIR Dockerfile gets
 * `public/` watched immediately, instead of waiting for a CLI release to teach
 * the baseline about it. The two are UNIONed (see digestAppSource), so a parse
 * that resolves nothing can never drop coverage below the baseline.
 *
 * Conservative by design — anything it can't resolve to a literal path inside
 * the context (globs, `$VAR` indirection, `--from=<stage>` copies, remote ADD
 * URLs, `..` escapes) is skipped rather than guessed at. The baseline still
 * covers the shipped template, so the cost of a skip is a customer-added path
 * going unwatched, never a wrong digest.
 *
 * @param {string} dockerfileText
 * @returns {string[]} Sorted, de-duplicated, root-relative paths.
 */
export function parseDockerfileContextPaths(dockerfileText) {
  const out = new Set();
  // Join line continuations first so a multi-line COPY parses as one argv.
  const joined = String(dockerfileText ?? '').replace(/\\[ \t]*\r?\n/g, ' ');
  for (const line of joined.split('\n')) {
    const m = /^\s*(?:COPY|ADD)\s+(.+)$/i.exec(line);
    if (!m) continue;
    const tokens = m[1].trim().split(/\s+/);
    // `--from=` sources come from another build stage or an external image —
    // not from the build context, so nothing on disk to digest.
    if (tokens.some((t) => /^--from=/i.test(t))) continue;
    // Drop flags (`--chown`, `--chmod`, …) and the destination (last token).
    const sources = tokens.filter((t) => !t.startsWith('--')).slice(0, -1);
    for (const raw of sources) {
      const src = raw.replace(/^["']|["']$/g, '');
      if (!src || UNRESOLVABLE_COPY_SOURCE.test(src)) continue;
      const normalized = src.replace(/^\.\//, '').replace(/\/+$/, '');
      if (normalized && normalized !== '.') out.add(normalized);
    }
  }
  return [...out].sort();
}

/**
 * Content digest of everything the app image build consumes from disk.
 *
 * @param {string} projectDir
 * @returns {string} Hex-encoded sha256.
 */
export function digestAppSource(projectDir) {
  const paths = new Set(APP_BUILD_CONTEXT_PATHS);
  try {
    for (const p of parseDockerfileContextPaths(
      readFileSync(join(projectDir, 'Dockerfile'), 'utf-8'),
    )) {
      paths.add(p);
    }
  } catch {
    // No readable Dockerfile — the baseline list still covers the template.
  }
  return digestPaths(projectDir, [...paths]);
}

/**
 * Build the `k3s-build` step's skip-gate inputs.
 *
 * The coarse inputs alone were blind to the app's SOURCE, and that is a
 * customer-visible bug, not a theoretical one: on a warm redeploy
 * projectName/domain/siteUrl/masterPrivateIp are all unchanged, so
 * `k3s-build` skipped, `imageTag` came back from the PRIOR step result,
 * the image delivery skipped on that same tag and `k3s-apply` saw an unchanged
 * image — an app-only edit NEVER reached the cluster and k8s push-to-deploy
 * silently kept serving the stale image. Compose never had the hole: its
 * `compose-setup-files` gate folds in `digestDir(bundlePath)` (prod bug
 * 2026-07-11), and the neighbouring `k3s-apply` gate got the same treatment for
 * its manifest trees (#202) and storage class (#234).
 *
 * The two content inputs cover the two halves of what `buildAppImage` feeds
 * `docker build`:
 *
 *   - `sourceDigest` — the build context + the Dockerfile itself
 *     (see APP_BUILD_CONTEXT_PATHS / digestAppSource).
 *   - `buildArgsDigest` — the `VITE_*` `--build-arg` values, which Vite INLINES
 *     into the browser bundle. They come from `.env.local`, which
 *     `.dockerignore` keeps out of the context entirely, so no source digest
 *     can see them: rotating a public key or flipping a feature flag changes
 *     the shipped bundle with the whole tree byte-identical. Digested rather
 *     than carried as values so a public-but-sensitive key never lands in
 *     `.vibecarbon/deploy-state-<env>.json` if the state format ever starts
 *     persisting inputs.
 *
 * The coarse inputs stay because neither digest can see them: `domain` /
 * `siteUrl` are baked into the bundle (a change to the URL DERIVATION
 * itself — e.g. the api.<domain> → apex single-origin migration — must bust the
 * gate on upgrade), and `masterPrivateIp` prefixes the built tag's registry ref
 * (M3 Task 2), so a resumed deploy against a different private IP must not
 * reuse a wrongly-prefixed tag.
 *
 * A rebuild mints a fresh tag (`generateLocalImageTag` carries a UTC
 * timestamp), and the downstream `k3s-apply` gate (which holds the image
 * delivery) keys off that tag via `buildK3sApplyInputs`, so one busted digest
 * cascades through the whole chain exactly as a cold deploy does.
 *
 * @param {{ projectName: string, domain?: string, masterPrivateIp: string, projectDir: string }} args
 * @returns {{ projectName: string, domain: string|undefined, siteUrl: string|undefined, masterPrivateIp: string, sourceDigest: string, buildArgsDigest: string }}
 */
export function buildK3sBuildInputs({ projectName, domain, masterPrivateIp, projectDir }) {
  const buildArgs = domain ? collectComposeBuildArgs(projectDir, { projectName, domain }) : {};
  return {
    projectName,
    domain,
    siteUrl: domain ? `https://${domain}` : undefined,
    masterPrivateIp,
    sourceDigest: digestAppSource(projectDir),
    buildArgsDigest: createHash('sha256')
      .update(JSON.stringify(Object.entries(buildArgs).sort()))
      .digest('hex'),
  };
}

/**
 * Build the `k3s-apply` step's skip-gate inputs.
 *
 * The coarse inputs (image tags + restore target) are blind to manifest
 * CONTENT, so both manifest trees the step applies are folded in as content
 * digests:
 *
 *   - `manifestDigest` — `projectDir/k8s`, the per-project copy applied with
 *     applyKustomization (added 2026-07-11 for the prod content-blind-gate bug).
 *   - `bundledManifestDigest` — `carbon/k8s` inside the installed CLI, applied
 *     directly by this module (s3-egress-vpc, repl-gateway) and the source the
 *     project copy is generated from. Without it, a CLI upgrade whose ONLY
 *     change is a bundled manifest edit leaves every gate input identical, so a
 *     warm/state-resumed redeploy SKIPS `k3s-apply` and the fix never reaches
 *     the cluster — exactly how the M3 cluster-autoscaler probe-budget fix
 *     stalled until the step was hand-cleared out of
 *     `.vibecarbon/deploy-state-<env>.json`.
 *
 * digestDir hashes sorted POSIX-normalized relative paths + bytes only (no
 * mtimes, no absolute paths), so both digests are stable across machines and
 * checkout locations — a re-deploy from a different clone of the same CLI
 * version does not false-bust the gate. `kubectl apply` is idempotent, so a
 * digest change only ever forces a (correct) re-apply.
 *
 * `storageClass` (`ProviderClass.K8S_STORAGE_CLASS`) is an input in its own
 * right because the step's most durability-critical render — the db
 * StatefulSet's PVC class — comes from a provider STATIC, not from either manifest
 * tree. Neither digest can see it, so without this key a warm/state-resumed
 * redeploy would happily skip `k3s-apply` and leave a cluster's database on
 * whatever class it originally bound (RCA: kept k8s-ha rig e4, 2026-08-05 —
 * node-local `local-path` under PGDATA). Adding the key also means the FIRST
 * redeploy after this CLI upgrade re-runs the step everywhere, which is exactly
 * how the fix reaches already-deployed environments.
 *
 * `role` (the k8s-ha pilot-light role) is an input because applyK3sManifests
 * renders a DIFFERENT cluster for each role: the standby zeroes the app tier and
 * the cluster-autoscaler, skips observability, points its Certificates at the
 * self-signed issuer and records the standby wal-g role intent for the db.
 * Each cluster keeps its own deploy-state file keyed by its STACK name, and a
 * failover swaps which stack holds which role without touching either file. So
 * without this key the post-failover reconverge redeploy found byte-identical
 * inputs on both stacks and SKIPPED the apply on both: the promoted cluster
 * never got its observability stack (no Grafana IngressRoute, the SPA answered
 * /admin/grafana; e4 run 2026-10-20) and the demoted one kept its primary-shaped
 * render. Normalized the same way as walgRole below, so single-cluster deploys
 * (role undefined) hash as 'primary'.
 *
 * `appStorageKeyDigest` folds in the app's own object-storage key (security
 * plan R9): a redeploy that mints a new one (its secret was missing here)
 * revokes the old key, so a skipped apply would leave the app Secret holding
 * a dead key. Only a digest of the access key id, never the key itself.
 *
 * `restore` is the resolved `deploy -restore` point: its backup and target
 * are an input, so a rerun that restores another base re-applies.
 *
 * `imageSetDigest` is the version set this deploy resolved. Its refs reach the
 * cluster through the render, and no manifest digest sees them: without it a
 * patched image on the channel would be skipped on a warm deploy. An unchanged
 * set hashes the same, so it costs nothing.
 *
 * `storageTargets` is where the app bucket and the backups bucket are, each
 * as `<bucket>@<region>@<endpoint>` (`s3Config` and `backupTarget`). Both are
 * rendered into the applied Secrets (the app Secret's S3_*, the infra
 * Secret's S3_BACKUP_BUCKET) and the db StatefulSet (wal-g's endpoint and
 * region), and no manifest digest sees them: without this key a deploy that
 * corrected an environment's uploads region (s3-setup finds the bucket where
 * it really is) skipped the apply, and the app Secret kept the wrong region.
 * Adding it re-applies every k8s environment once (unchanged content).
 *
 * @param {{ imageTag: string, dbImageTag: string, restore?: {backup: string, target: string}|null, projectDir: string, storageClass?: string, role?: 'primary'|'standby', appStorageAccessKey?: string, backupConfig?: {schedule?: string, retentionDays?: number}, s3Config?: {bucket?: string, region?: string, endpoint?: string}|null, backupTarget?: import('../../backups-bucket.js').BackupsTarget|null }} args
 * @returns {{ imageTag: string, dbImageTag: string, restore: string, storageClass: string, role: 'primary'|'standby', replicationHostPort: boolean, appStorageKeyDigest: string, storageTargets: string, imageSetDigest: string, manifestDigest: string, bundledManifestDigest: string }}
 */
export function buildK3sApplyInputs({
  imageTag,
  dbImageTag,
  restore,
  projectDir,
  storageClass,
  role,
  appStorageAccessKey,
  backupConfig,
  s3Config,
  backupTarget,
}) {
  const backup = resolveBackupSettings(backupConfig);
  return {
    imageTag,
    dbImageTag,
    // Written into the rendered manifests at apply (writeBackupConfigIntoTree):
    // no manifest digest sees them.
    backupSchedule: backup.schedule,
    backupRetentionDays: backup.retentionDays,
    restore: restore ? `${restore.backup} ${restore.target}` : '',
    storageClass: storageClass ?? '',
    role: role === 'standby' ? 'standby' : 'primary',
    // An HA cluster's db is rendered with the replication hostPort, a single
    // cluster's is not (renderK8sBase): a different db, so a different gate.
    replicationHostPort: rendersReplicationHostPort(role),
    appStorageKeyDigest: appStorageAccessKey ? fingerprintSecret(appStorageAccessKey) : '',
    storageTargets: [s3Config, backupTarget]
      .map((t) => `${t?.bucket ?? ''}@${t?.region ?? ''}@${t?.endpoint ?? ''}`)
      .join(' '),
    imageSetDigest: createHash('sha256').update(JSON.stringify(currentImageSet())).digest('hex'),
    manifestDigest: digestDir(join(projectDir, 'k8s')),
    bundledManifestDigest: digestDir(BUNDLED_K8S_DIR),
    envLocalDigest: digestEnvLocalSecrets(projectDir),
  };
}

/**
 * Digest of the `.env.local` values this step actually consumes.
 *
 * Fifth member of the #244 family (compose-setup-files 2026-07-11, k3s-apply's
 * manifest trees in #202, storageClass in #234, k3s-build's source+build-args
 * in #244): a gate input that does not cover something the step reads.
 *
 * `k3s-apply` loads `.env.local` and feeds it to applyVibecarbonSecrets (the
 * app and infra Secrets — every configure-managed OAuth/SMTP/billing
 * key plus REDIS_*) and to ACME_CA_SERVER. None of that was in the gate. `.env.local` sits in neither
 * digested manifest tree, and .dockerignore keeps it out of the build context
 * so no source digest sees it either.
 *
 * So: `vibecarbon configure` writes a Google OAuth secret or SMTP creds to
 * .env.local, `vibecarbon deploy` runs, nothing else changed — k3s-build skips
 * and returns the prior tag, every other apply input is byte-identical, and
 * k3s-apply SKIPS. The Secret is never re-applied and the values never
 * re-rendered. Both commands exit 0 and the setting silently never reaches the
 * cluster. Only VITE_* keys were covered, and only transitively (they ride
 * k3s-build's buildArgsDigest, and a rebuild mints a new tag that busts this
 * gate).
 *
 * Digests the VALUES, not the file: a comment edit or key reordering must not
 * force a redeploy, and the digest must not depend on unrelated keys. Missing
 * file hashes to a stable empty marker rather than throwing — a project may
 * legitimately have none (CI supplies the env).
 *
 * @param {string} projectDir
 * @returns {string}
 */
export function digestEnvLocalSecrets(projectDir) {
  // existsSync first: loadEnvLocal THROWS on a missing file (it is the deploy
  // path's hard precondition), but a gate input must never be the thing that
  // fails a deploy — and CI projects legitimately supply the env another way.
  const envPath = join(projectDir, '.env.local');
  if (!existsSync(envPath)) return 'no-env-local';
  const envLocal = loadEnvLocal(envPath);
  if (!envLocal) return 'no-env-local';
  // Keyed (HMAC under a machine-local key): the digest lands in the persisted
  // deploy state and must reveal nothing about the values.
  const hash = secretHmac();
  // Sorted so key ORDER in the file is not a change. ACME_CA_SERVER joins
  // SECRET_KEYS because the issuer pick reads it directly.
  const watched = [...new Set([...SECRET_KEYS, 'ACME_CA_SERVER'])].sort();
  for (const key of watched) {
    const value = envLocal[key];
    if (value === undefined) continue;
    hash.update(`${key}=${value}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

/** The db image is pre-published + multi-arch — pulled, never built or delivered. */
export function resolveDbImageTag() {
  return resolveDbImage().ref;
}

/**
 * Pattern of kube-apiserver transient signatures we've actually observed
 * mid-RPC during k3s control-plane warm-up. See runKubectlWithRetry —
 * exported so unit tests can exercise the regex without importing the
 * helper itself (and so a future caller adding a new signature has one
 * obvious place to do it).
 */
export const KUBECTL_TRANSIENT_PATTERN =
  // `connection timed out` covers cross-cluster API blips like
  // `read tcp <ip>:<port>->...:6443: read: connection timed out` — seen when a
  // kubectl exec (e.g. enable-WAL-archiving) hits a momentarily unreachable
  // standby control-plane in k8s-ha. Without it the call failed without
  // retrying, aborting the deploy. (RCA 2026-06-01: k8s-ha standby deploy.)
  //
  // `connection refused` (2026-08-07 family sweep): the canonical wording of
  // an apiserver mid-cycle, and this repo's own comments document it three
  // times over (registry-not-started at the local-registry ensure, the
  // traefik→apiserver refused loop, rolloutApp's refused loop) — every other
  // SSH-side classifier in the tree already carries it; kubectl was the lone
  // holdout.
  //
  // `broken pipe` (2026-08-23, DO k8s restore re-deploy, run 32659821814):
  // the apiserver's own transport to the ADMISSION-PROVEN cert-manager
  // webhook dropped mid-write (`write tcp 127.0.0.1:...->127.0.0.1:6443:
  // write: broken pipe`) and surfaced through kubectl as a server-side
  // InternalError. The ladder wrapped that apply and never engaged — no
  // pattern knew the spelling. Transport spelling only: a webhook that
  // ANSWERS with an error (500 / denied) stays fatal.
  /http2: client connection lost|connection reset by peer|context deadline exceeded|connection timed out|connection refused|EOF|i\/o timeout|TLS handshake|unexpected error when reading response body|broken pipe/i;

/**
 * The retry classifiers' haystack: message + stdout + stderr joined.
 * runCommandAsync ALWAYS assigns `error.stderr` (empty string when nothing
 * was written), so `err.stderr ?? err.message` NEVER falls through to the
 * message on `??` — an empty-stderr failure could never match any pattern
 * (2026-08-07 family sweep; walg-staleness.js solved the same bug the same
 * way: "where the output lands depends on the transport").
 */
export function kubectlErrorHaystack(err) {
  return [err?.message, err?.stdout, err?.stderr]
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map(String)
    .join('\n');
}

// The webhook-warm-up recognizer + ladder that lived here
// (KUBECTL_WEBHOOK_UNAVAILABLE_PATTERN / KUBECTL_WEBHOOK_RETRY_DELAYS_MS)
// are REMOVED (band-aid removal, 2026-08-16): awaitCertManagerAdmission
// proves the admission pipeline serves before anything traverses it, so the
// windows they absorbed (post-Available 502, 2026-08-07; caBundle lag,
// 2026-08-10) cannot occur without a real regression — which must fail
// loudly, not be retried into silence.

// The psql mid-lifecycle recognizer + ladder that lived here
// (PSQL_LIFECYCLE_TRANSIENT_PATTERN / PSQL_LIFECYCLE_RETRY_DELAYS_MS) are
// REMOVED (band-aid removal, 2026-08-16): awaitPostgresAccepting gates every
// psql-bearing step on pg_isready exit 0 — the CONDITION whose absence the
// ladder absorbed per call site (0fbb296f RCA). A lifecycle FATAL after a
// proven-accepting gate is a real regression and must fail the deploy.

/** A kubectl command run on the master: longer than any apply, short of a hang. */
const KUBECTL_ON_MASTER_TIMEOUT_MS = 300_000;

/**
 * Run a short-lived kubectl command with retry-on-transient-error.
 *
 * RCA from k8s-ha runs on 2026-04-29: a freshly-bootstrapped k3s control
 * plane drops one http2 connection mid-RPC, kubectl fails the call (the
 * error message itself ends with "Please retry. Original error: http2:
 * client connection lost"), and with no retry one transient kills the
 * entire HA deploy. Both `kubectl apply Secret/carbon-autoscaler-config`
 * and `kubectl patch deploy/cluster-autoscaler` crashed on consecutive
 * runs at different points in applyK3sManifests — so the fix lives at
 * the helper layer instead of being grafted onto each call site as it
 * surfaces.
 *
 * Three attempts with 2s/4s back-off (~6s ceiling, well under deploy
 * budget). Pattern matches against KUBECTL_TRANSIENT_PATTERN; non-
 * transient errors throw on the first attempt with stderr tail attached
 * for debuggability.
 *
 * `kubectl rollout status` / `kubectl wait` callers: fine, and since d4 run
 * 4 (2026-08-28) REQUIRED for deploy-gating waits — kubectl's own watch
 * retries only cover drops on an ESTABLISHED connection; a transient failure
 * on the initial connect (observed: `Unable to connect to the server:
 * net/http: TLS handshake timeout`, 13s into a 300s budget on a busy fresh
 * apiserver) exits kubectl immediately, and a bare runCommandAsync call
 * turns that blip into a failed deploy. The trade is buffered progress
 * (bytes land at completion instead of live) — the deploy log still gets
 * everything. Only `kubectl logs --follow` stays out (unbounded stream).
 *
 * `on` runs the command on a k3s server over ssh instead of on this machine
 * (see applyKustomization). Retries, classification and failure text are the
 * same either way: ssh hands back kubectl's exit code and stderr.
 *
 * @param {string[]} args kubectl argv
 * @param {{env?: NodeJS.ProcessEnv, input?: string, captureStdout?: boolean, description?: string, on?: {ip: string, sshKeyPath: string}}} options
 * @returns {Promise<string>} stdout (always returned; empty when nothing was emitted)
 */
export async function runKubectlWithRetry(
  args,
  {
    env,
    input,
    captureStdout = false,
    description,
    transientExtra,
    delaysMs,
    signal,
    on,
    timeout,
  } = {},
) {
  const RETRY_DELAYS_MS = delaysMs ?? [2000, 4000];
  const ATTEMPTS = RETRY_DELAYS_MS.length + 1;
  const desc = description ?? `kubectl ${args.slice(0, 4).join(' ')}`;
  try {
    return await runWithRetry(
      async () => {
        try {
          const out = await (on
            ? sshKubectl(on.ip, on.sshKeyPath, args, {
                input,
                timeout: timeout ?? KUBECTL_ON_MASTER_TIMEOUT_MS,
                ...(signal && { signal }),
              })
            : runCommandAsync(['kubectl', ...args], {
                env,
                input,
                silent: true,
                ...(timeout && { timeout }),
                ...(signal && { signal }),
              }));
          // Stream captured stdout through to the operator's terminal so the
          // success path looks identical to the legacy `stdio: 'inherit'` shape.
          // captureStdout suppresses stdout streaming because the caller wants
          // the bytes (e.g. `kubectl get -o jsonpath`).
          if (!captureStdout && out) process.stdout.write(out);
          return out;
        } catch (err) {
          if (!captureStdout && err.stdout) process.stdout.write(err.stdout);
          if (err.stderr) process.stderr.write(err.stderr);
          if (KUBECTL_TRANSIENT_PATTERN.test(kubectlErrorHaystack(err))) {
            await assertOperatorIpUnchanged();
          }
          throw err;
        }
      },
      {
        delaysMs: RETRY_DELAYS_MS,
        isTransient: (err) => {
          if (signal?.aborted) return false;
          const text = kubectlErrorHaystack(err);
          return KUBECTL_TRANSIENT_PATTERN.test(text) || (transientExtra?.test(text) ?? false);
        },
        onRetry: (_err, attempt) => {
          progressLog(
            `${desc} hit transient error on attempt ${attempt}/${ATTEMPTS}, retrying in ${RETRY_DELAYS_MS[attempt - 1]}ms`,
          );
        },
      },
    );
  } catch (err) {
    // status and stderr ride along so a caller can tell a remote script's own
    // failure line from an unreachable pod (setK8sWalgRole's write-failed).
    throw Object.assign(
      new Error(
        `${desc} failed with exit ${err.status ?? '?'}: ${(err.stderr ?? '').toString().trim().slice(-500)}`,
      ),
      { status: err.status, stderr: err.stderr },
    );
  }
}

/**
 * Apply a kustomization from the master, not from this machine.
 *
 * `kubectl apply` costs round trips per object on top of discovery, so a
 * chatty apply is mostly distance. On real k3s from a laptop 130 ms away
 * (Hetzner nbg1, 2026-11-05, median of 3), the laptop against the master:
 * base 27.1 s and 4.5 s, cert-manager 24.2 s and 12.9 s, Traefik CRDs 6.6 s and
 * 4.7 s. Run on the master, these steps take the same time wherever the
 * operator sits, so a provider's numbers describe its servers.
 *
 * The render stays here: the directory is usually a temp copy on this machine,
 * and it is why this needs only `kubectl kustomize` locally. Applying one or
 * two objects stays local (runKubectlWithRetry): an ssh handshake costs about
 * what they save.
 *
 * @param {string} dir  kustomization directory on this machine
 * @param {{env: NodeJS.ProcessEnv, master: {ip: string, sshKeyPath: string}, description: string, render?: (manifests: string) => string, signal?: AbortSignal}} options
 * @returns {Promise<string>} kubectl's stdout
 */
export async function applyKustomization(dir, { env, master, description, render, signal }) {
  const manifests = await runKubectlWithRetry(['kustomize', dir], {
    env,
    captureStdout: true,
    description: `${description} (render)`,
    ...(signal && { signal }),
  });
  return runKubectlWithRetry(['apply', '-f', '-'], {
    on: master,
    input: render ? render(manifests) : manifests,
    description,
    ...(signal && { signal }),
  });
}

// ---------------------------------------------------------------------------
// Deploy-time diagnostic capture
// ---------------------------------------------------------------------------
//
// WHY THESE RUN `silent: true` (this is the whole point of the helper):
//
// `withDeployLog` (src/lib/deploy-logger.js) tees the deploy log by
// monkey-patching `process.stdout.write` / `process.stderr.write` IN THIS
// PROCESS. A child spawned with `stdio: 'inherit'` (which is what
// `runCommandAsync` does whenever `silent` is falsy) writes straight to the
// inherited file descriptors and never passes through those patched writers —
// so its output reaches the terminal but NEVER reaches
// ~/.vibecarbon/logs/<env>-<ts>.log.
//
// That is exactly how the 2026-07-31 k8s e3 run produced a deploy log
// containing the line "[k3s] cluster-autoscaler rollout failed — capturing
// diagnostics:" followed by nothing at all: the capture ran, printed to a
// terminal nobody was watching, and left a bare header in the artifact we
// actually read afterwards. Second blind RCA in five days (the first was
// 2026-07-27).
//
// So: capture with `silent: true` (pipes), then re-emit through
// `process.stdout.write` so the tee sees every byte. Same shape
// `runKubectlWithRetry` already uses for its success path.

/** Lines kept from any single diagnostic capture (a log file, not a database). */
export const DIAGNOSTIC_TAIL_LINES = 50;

/** Hard ceiling on one diagnostic command — the failure path must not hang. */
export const DIAGNOSTIC_TIMEOUT_MS = 20_000;

/** Max not-ready pods we fan describe/logs out to. */
const DIAGNOSTIC_MAX_PODS = 5;

/** Max containers per pod we fan logs out to. */
const DIAGNOSTIC_MAX_CONTAINERS = 6;

/**
 * Write one labelled diagnostic section to stdout (and therefore to the
 * deploy log). Always emits the label, and says `(no output)` rather than
 * printing a bare header when the command produced nothing.
 *
 * @param {string} label
 * @param {string} text
 * @param {number} tailLines
 */
function emitDiagnosticSection(label, text, tailLines) {
  const trimmed = String(text ?? '').replace(/\s+$/, '');
  const lines = trimmed ? trimmed.split('\n') : [];
  const clipped = lines.length > tailLines ? lines.slice(-tailLines) : lines;
  const suffix = lines.length > tailLines ? ` (last ${tailLines} of ${lines.length} lines)` : '';
  const body = clipped.join('\n');
  process.stdout.write(
    `--- [k3s diag] ${label}${suffix} ---\n${body.trim() ? `${body}\n` : '(no output)\n'}`,
  );
}

/**
 * Run one best-effort diagnostic command and stream its (tail-bounded) output
 * into the deploy log.
 *
 * Best-effort but LOUD: a capture that fails prints a one-line reason naming
 * the label and the first line of stderr. It never throws — the caller is
 * already on a failure path — and it never swallows silently, because a
 * diagnostics step that fails without saying so is how you end up doing a
 * blind RCA off a bare header line.
 *
 * NOTE the runCommandAsync contract (src/lib/command.js): with
 * `silent: true` and `returnOutput` unset, a non-zero exit REJECTS (it does
 * NOT resolve(false) — that trap only applies to non-silent callers), so the
 * catch below is the real error path, not decoration.
 *
 * @param {string[]} argv
 * @param {{env?: NodeJS.ProcessEnv, label?: string, tailLines?: number}} [options]
 * @returns {Promise<boolean>} true when the command exited 0
 */
export async function runDeployDiagnostic(
  argv,
  { env, label, tailLines = DIAGNOSTIC_TAIL_LINES } = {},
) {
  const name = label ?? argv.join(' ');
  try {
    const out = await runCommandAsync(argv, {
      silent: true,
      env,
      timeout: DIAGNOSTIC_TIMEOUT_MS,
    });
    emitDiagnosticSection(name, typeof out === 'string' ? out : '', tailLines);
    return true;
  } catch (err) {
    logDiagnosticFailure(name, err);
    // Partial stdout is still worth having (kubectl often prints the useful
    // half before erroring), but only when there is something to show.
    const partial = typeof err?.stdout === 'string' ? err.stdout : '';
    if (partial.trim()) emitDiagnosticSection(`${name} (partial)`, partial, tailLines);
    return false;
  }
}

/**
 * One-line, single-line loud failure notice for a diagnostic that could not
 * be captured. console.error (not progressLog) on purpose: progressLog routes
 * into an active spinner's message line, which a diagnostics dump would
 * fight with and which reads as a transient frame in the log.
 *
 * @param {string} label
 * @param {unknown} err
 */
function logDiagnosticFailure(label, err) {
  const raw =
    (err && typeof err === 'object' && 'stderr' in err && String(err.stderr || '').trim()) ||
    (err instanceof Error ? err.message : String(err));
  const oneLine = raw.split('\n').find((l) => l.trim()) || 'unknown error';
  console.error(`[k3s] diagnostic capture FAILED: ${label}: ${oneLine.trim().slice(0, 300)}`);
}

/**
 * Reduce `kubectl get pods -o json` output to the pods worth dumping logs
 * for, with the container names to dump them from.
 *
 * "Not ready" is deliberately broader than "not Running": the 2026-07-31 CA
 * rollout timeout produced a pod that was Running with 1/2 containers ready
 * (the carbon-autoscaler sidecar never passed its readiness probe). A
 * phase-only filter would have skipped exactly the pod that mattered.
 *
 * Container names come from the spec (init containers first, so a stuck init
 * container's logs lead), falling back to the status when the spec is absent.
 *
 * @param {string} json raw kubectl stdout
 * @param {{maxPods?: number}} [options]
 * @returns {Array<{name: string, containers: string[]}>}
 */
export function selectNonReadyPods(json, { maxPods = DIAGNOSTIC_MAX_PODS } = {}) {
  let items;
  try {
    items = JSON.parse(String(json ?? ''))?.items;
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const pod of items) {
    const name = pod?.metadata?.name;
    if (!name) continue;
    const statuses = Array.isArray(pod?.status?.containerStatuses)
      ? pod.status.containerStatuses
      : [];
    const phase = pod?.status?.phase;
    const ready =
      (phase === 'Running' || phase === 'Succeeded') &&
      statuses.length > 0 &&
      statuses.every((s) => s?.ready === true);
    if (ready) continue;
    const names = [
      ...(pod?.spec?.initContainers ?? pod?.status?.initContainerStatuses ?? []),
      ...(pod?.spec?.containers ?? statuses),
    ]
      .map((c) => c?.name)
      .filter(Boolean);
    out.push({ name, containers: [...new Set(names)].slice(0, DIAGNOSTIC_MAX_CONTAINERS) });
    if (out.length >= maxPods) break;
  }
  return out;
}

/**
 * Ordered diagnostic command list for a failed cluster-autoscaler rollout.
 * Pure (no I/O) so the shape — namespaces covered, tail bounds, which pods
 * get logs — is unit-testable without a cluster.
 *
 * Everything is scoped to kube-system: that is where cluster-autoscaler and
 * its carbon-autoscaler sidecar run, and the app-namespace bundle the e2e
 * runner already collects says nothing about either.
 *
 * @param {Array<{name: string, containers: string[]}>} [nonReadyPods]
 * @returns {Array<{label: string, argv: string[]}>}
 */
export function clusterAutoscalerDiagnosticCommands(nonReadyPods = []) {
  const ns = ['-n', 'kube-system'];
  const cmds = [
    {
      label: 'kube-system: cluster-autoscaler pods',
      argv: ['kubectl', ...ns, 'get', 'pods', '-l', 'app=cluster-autoscaler', '-o', 'wide'],
    },
    {
      // Deployment-level Events cover the case where NO pod exists at all
      // (quota, admission webhook, unschedulable) — describe pods can't.
      label: 'kube-system: describe deployment/cluster-autoscaler',
      argv: ['kubectl', ...ns, 'describe', 'deployment/cluster-autoscaler'],
    },
    {
      // Pod Events carry the real reason: ImagePullBackOff with the failing
      // registry URL, probe failures, CreateContainerConfigError. Field-proven
      // 2026-07-27 — a deploy-only describe left a sidecar failure invisible.
      label: 'kube-system: describe pods -l app=cluster-autoscaler',
      argv: ['kubectl', ...ns, 'describe', 'pods', '-l', 'app=cluster-autoscaler'],
    },
    {
      label: 'kube-system: recent events',
      argv: ['kubectl', ...ns, 'get', 'events', '--sort-by=.lastTimestamp'],
    },
  ];
  for (const pod of nonReadyPods) {
    cmds.push({
      label: `kube-system: describe pod ${pod.name}`,
      argv: ['kubectl', ...ns, 'describe', 'pod', pod.name],
    });
    for (const container of pod.containers) {
      // --previous first: on a CrashLoopBackOff the dead instance holds the
      // reason; the current instance may not have gotten far enough to log.
      cmds.push({
        label: `kube-system: logs ${pod.name}/${container} (previous)`,
        argv: [
          'kubectl',
          ...ns,
          'logs',
          pod.name,
          '-c',
          container,
          '--previous',
          `--tail=${DIAGNOSTIC_TAIL_LINES}`,
        ],
      });
      cmds.push({
        label: `kube-system: logs ${pod.name}/${container} (current)`,
        argv: [
          'kubectl',
          ...ns,
          'logs',
          pod.name,
          '-c',
          container,
          `--tail=${DIAGNOSTIC_TAIL_LINES}`,
        ],
      });
    }
  }
  return cmds;
}

/**
 * Capture kube-system state after a cluster-autoscaler rollout failure.
 *
 * Never throws: the caller rethrows the original rollout error immediately
 * after, and a diagnostics bug must not mask the real failure.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 */
export async function captureClusterAutoscalerDiagnostics({ env } = {}) {
  console.error('[k3s] cluster-autoscaler rollout failed, capturing kube-system diagnostics');
  let nonReadyPods = [];
  try {
    const json = await runCommandAsync(
      ['kubectl', '-n', 'kube-system', 'get', 'pods', '-l', 'app=cluster-autoscaler', '-o', 'json'],
      { silent: true, env, timeout: DIAGNOSTIC_TIMEOUT_MS },
    );
    nonReadyPods = selectNonReadyPods(typeof json === 'string' ? json : '');
  } catch (err) {
    // Loud, then carry on: the label-wide captures below still work off the
    // apiserver and are the ones that matter most.
    logDiagnosticFailure('kube-system: list cluster-autoscaler pods', err);
  }
  for (const { label, argv } of clusterAutoscalerDiagnosticCommands(nonReadyPods)) {
    await runDeployDiagnostic(argv, { env, label });
  }
}

/**
 * Render the JSON config carbon-autoscaler (the externalgrpc sidecar) reads
 * from its mounted Secret. Validated on the read side by
 * `src/autoscaler/config.js`'s `loadConfig`/`validateConfig` — this
 * function's output MUST satisfy that validator; the config contract is
 * documented in the m2-carbon-autoscaler plan
 * ("carbon-autoscaler config contract").
 *
 * Writes the returned string into the `config.json` key of the
 * `kube-system/carbon-autoscaler-config` Secret, PLAIN (no base64
 * pre-encoding — that hack only existed for the old hcloud provider's
 * secretKeyRef→env path; the sidecar reads this as a mounted Secret FILE,
 * which decodes once). On each scale-up, `serverLabels` are attached to the
 * new server and `cloudInit` (plain UTF-8) becomes the provider's user-data.
 *
 * `serverLabels['cluster-autoscaler/node'] = 'worker-pool'` distinguishes
 * CA-spawned workers from static workers (which carry
 * `cluster-autoscaler/node: static` from the Pulumi program) — the destroy
 * sweep relies on this distinction. `serverLabels.cluster` scopes the
 * service's `listServers` calls to this cluster.
 *
 * `minSize` is always 0 and `maxSize` is the headroom above the
 * Pulumi-static floor: total cluster workers = minWorkers (Pulumi-managed)
 * + N CA-spawned, 0 ≤ N ≤ (maxWorkers - minWorkers). `caBoundsMin`
 * (pilot-light dormant-bounds trick) substitutes the PRIMARY's minWorkers
 * on a standby's render, so a failover only has to flip CA's replica count
 * 0→1, never re-render its config.
 *
 * CA-spawned workers join via the master's PRIVATE IP (default
 * `10.0.1.1`) — the in-network join path is firewalled to the
 * private-network range, so a public-IP join would be rejected and is
 * also unnecessary since the spawned servers attach to the same private
 * network.
 *
 * `nodeGroups['worker-pool'].image` is `ProviderClass.K8S_IMAGE` (M3 Task
 * 2) — MUST match the base image slug that provider's k8s Pulumi program
 * boots master/database/worker nodes with, or a CA-spawned worker would
 * come up on a different image than the rest of the cluster.
 *
 * `cloudInit` is rendered through `ProviderClass.getK8sWorkerUserData(vars)`
 * (M3 Task 3's provider-owned statics), NOT a hardcoded Hetzner template —
 * a CA-spawned worker must boot with the SAME provider-specific cloud-init
 * shape (metadata paths, registry-mirror IP, provider-id pre-seed) as that
 * provider's Pulumi-static workers, or the join fails on any non-Hetzner
 * provider (M3 Task 5b review Critical). Async because the statics are
 * (`getK8sWorkerUserData` dynamic-imports its render helper) — every
 * caller must await this function's result.
 *
 * @param {{
 *   k3sVersion: string,
 *   k3sToken: string,
 *   masterPrivateIp?: string,
 *   clusterName: string,
 *   environment: string,
 *   providerId: string,
 *   ProviderClass: typeof import('../../providers/base.js').BaseProvider,
 *   region: string,
 *   workerServerType: string,
 *   minWorkers: number,
 *   maxWorkers: number,
 *   caBoundsMin?: number,
 *   sshKeyName?: string,
 * }} args
 * @returns {Promise<string>} JSON-stringified carbon-autoscaler config
 */
export async function renderCarbonAutoscalerConfig({
  k3sVersion,
  k3sToken,
  masterPrivateIp = '10.0.1.1',
  clusterName,
  environment,
  providerId,
  ProviderClass,
  region,
  workerServerType,
  minWorkers,
  maxWorkers,
  caBoundsMin,
  sshKeyName,
}) {
  // Fail at render time, not as a post-deploy runtime CA failure: this config
  // is kubectl-applied straight into the Secret without passing the sidecar's
  // loadConfig validator, so an empty image would deploy "successfully" and
  // only break when carbon-autoscaler tries to create a node.
  if (!ProviderClass.K8S_IMAGE) {
    throw new Error(
      `renderCarbonAutoscalerConfig: ${ProviderClass.name} has no K8S_IMAGE — the provider's k8s program cannot be autoscaled without a node image slug`,
    );
  }
  const cloudInit = await ProviderClass.getK8sWorkerUserData({
    k3s_version: k3sVersion,
    k3s_token: k3sToken,
    master_ip: masterPrivateIp,
    cluster_name: clusterName,
  });
  const maxSize = Math.max(0, maxWorkers - (caBoundsMin ?? minWorkers));
  const config = {
    provider: providerId,
    providerIdPrefix: ProviderClass.PROVIDER_ID_PREFIX,
    clusterName,
    nodeGroups: {
      'worker-pool': {
        minSize: 0,
        maxSize,
        serverType: workerServerType,
        region,
        image: ProviderClass.K8S_IMAGE,
        cloudInit,
        serverLabels: {
          'cluster-autoscaler/node': 'worker-pool',
          'managed-by': 'vibecarbon',
          environment,
          cluster: clusterName,
        },
        nodeLabels: {},
        taints: [],
        podsPerNode: 110,
      },
    },
    // A k8s-ha cluster boots from the pair's shared key, so its caller names
    // that key; a single cluster owns `${clusterName}-${region}-key` (what its
    // program creates) and passes nothing.
    sshKeyName: sshKeyName ?? `${clusterName}-${region}-key`,
    firewallName: `${clusterName}-firewall`,
    networkName: `${clusterName}-network`,
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Map acmeServer → the ClusterIssuer name that `applyK3sManifests` renders
 * into `Certificate/vibecarbon-tls`. Both issuers solve HTTP-01 through the
 * Traefik ingress class (carbon/k8s/infra/cert-manager-resources/
 * cluster-issuers.yaml), for every DNS provider.
 *
 * @param {{acmeServer?: string|null}} args
 * @returns {'letsencrypt-prod'|'letsencrypt-staging'}
 */
export function pickIssuerName({ acmeServer }) {
  return (acmeServer || '').includes('staging') ? 'letsencrypt-staging' : 'letsencrypt-prod';
}

/**
 * Build the `dnsNames` list of the rendered `Certificate/vibecarbon-tls`.
 *
 * The apex alone: k8s routes every app and add-on by path on the apex, and
 * HTTP-01 cannot issue a wildcard.
 *
 * @param {string} domain - The apex deploy domain, e.g. `e1.carbonstack.dev`
 * @returns {string[]}
 */
export function certificateDnsNames(domain) {
  return [domain];
}

/**
 * The ClusterIssuer this project's deploy uses. `ACME_CA_SERVER` points at
 * staging for e2e tests (and any dev env that wants to avoid LE rate
 * limits): read from .env.local first (per-project), then from the
 * operator's environment, so the e2e harness can inject the staging URL
 * without writing it into the project. Anything else gets the prod issuer.
 *
 * @param {{ envLocal?: Record<string, string>|null }} args
 * @returns {string}
 */
export function k8sIssuerName({ envLocal }) {
  const acmeServer = envLocal?.ACME_CA_SERVER || readOperatorVar('ACME_CA_SERVER').value || '';
  return pickIssuerName({ acmeServer });
}

/**
 * The project's TLS identity as the k8s deploy renders it: the issuer, the
 * Certificate's names and the snapshot CA. Read from the project's
 * .env.local the same way applyK3sManifests does, for the code that runs
 * after the apply (the deploy's TLS phase).
 *
 * @param {{ projectDir: string, domain: string }} args
 * @returns {{ issuerName: string, dnsNames: string[], ca: 'prod'|'staging' }}
 */
export function k8sTlsIdentity({ projectDir, domain }) {
  const envPath = join(projectDir, '.env.local');
  const envLocal = existsSync(envPath) ? loadEnvLocal(envPath) : null;
  const issuerName = k8sIssuerName({ envLocal });
  return {
    issuerName,
    dnsNames: certificateDnsNames(domain),
    ca: caSlug(issuerName),
  };
}

/**
 * @typedef {Object} K3sDeployOptions
 * @property {string} projectName
 * @property {string} environment
 * @property {'primary'|'standby'} [role] Pilot-light HA role. Undefined ==
 *   single-cluster == primary behavior (Task 6 fans out primary/standby).
 * @property {string} provider
 * @property {string} region
 * @property {string} [secondaryRegion]
 * @property {string} masterServerType
 * @property {string} dbServerType
 * @property {string} workerServerType
 * @property {string} serverType
 * @property {number} minWorkers   Static floor (Pulumi-provisioned). Default 1.
 * @property {number} maxWorkers   CA upper bound (CA node-group maxSize = maxWorkers - minWorkers). Default 3.
 * @property {number} [caBoundsMin] Overrides minWorkers for the CA node-group maxSize only (Task 6:
 *   a pilot-light standby passes the primary's minWorkers here while its own minWorkers is 0).
 * @property {string} [domain]
 * @property {string} apiToken     Hetzner Cloud API token (CCM/CSI + cluster-autoscaler).
 * @property {Object} state
 * @property {Object} [tracker]
 * @property {boolean} [quietSuccess]
 * @property {string} [sharedSshKeyPath]
 * @property {string} [sharedSshPublicKey]
 * @property {string|number} [sharedSshKeyId]
 * @property {string} [sharedSshKeyName]
 * @property {Object} [s3Config]
 */

/**
 * Generate or reuse an SSH keypair for this environment.
 * Stored under projectDir/.vibecarbon/deploy_key_<env>{,.pub}.
 *
 * @param {string} projectDir
 * @param {string} environment
 * @returns {Promise<{privateKeyPath: string, publicKey: string}>}
 */
export async function ensureSshKey(projectDir, environment) {
  const dir = join(projectDir, '.vibecarbon');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const privateKeyPath = sshKeyPathFor(environment, projectDir);
  const publicKeyPath = `${privateKeyPath}.pub`;
  if (existsSync(privateKeyPath) && existsSync(publicKeyPath)) {
    return { privateKeyPath, publicKey: readFileSync(publicKeyPath, 'utf-8').trim() };
  }
  // ssh-keygen writes both halves: privateKeyPath in OpenSSH format, and
  // privateKeyPath.pub as the OpenSSH public key. -N "" = empty passphrase,
  // -q = quiet so we don't pollute the spinner output, -C tags the key with
  // a comment for operator-side identification. Async spawn (not
  // execFileSync) so this doesn't block the event loop on the deploy hot
  // path — matches the rest of this file's exec style.
  await runCommandAsync(
    [
      'ssh-keygen',
      '-t',
      'ed25519',
      '-N',
      '',
      '-f',
      privateKeyPath,
      '-C',
      `vibecarbon-${environment}`,
      '-q',
    ],
    { silent: true },
  );
  // ssh-keygen already creates the private key 0600, but defensively re-apply
  // in case it was regenerated atop a permission-loose existing file.
  chmodSync(privateKeyPath, 0o600);
  const publicKey = readFileSync(publicKeyPath, 'utf-8').trim();
  return { privateKeyPath, publicKey };
}

/**
 * Build the standard SSH host-key opts for k3s deploy SSH calls.
 *
 * Pinned per-env known_hosts file under `.vibecarbon/known_hosts_<env>` —
 * `accept-new` adds entries on first connect, then strict-checks on reuse.
 * `GlobalKnownHostsFile=/dev/null` ignores the system-wide file. Crucially we
 * also bypass the operator's `~/.ssh/known_hosts` — Hetzner recycles public
 * IPs, and a stale ECDSA entry from an unrelated server at the same IP would
 * otherwise reject the connection with "REMOTE HOST IDENTIFICATION HAS
 * CHANGED" (observed during early k3s real-infra testing).
 *
 * @param {string} khPath - absolute path to .vibecarbon/known_hosts_<env>
 * @returns {string[]} -o argv tokens for ssh/scp
 */
function sshHostKeyOpts(khPath) {
  // Shared builder also carries BatchMode=yes (key-auth failures abort
  // instead of hanging on a password prompt — critical for stdio:'inherit'
  // children) plus the ConnectTimeout/ServerAlive
  // keepalives from the banner-exchange-hang RCA (see host-keys.js).
  return buildHostKeyOptsForPath(khPath);
}

/**
 * Block until the cloud-init `/tmp/k3s-ready` marker appears via SSH.
 * Cloud-init writes this after `kubectl get nodes` shows the master Ready.
 *
 * Holds one SSH session that returns the moment the marker exists (see
 * remote-marker.js), reconnecting if it drops, so a ready node is noticed
 * within a fraction of a second.
 *
 * @param {string} masterIp
 * @param {string} sshKeyPath
 * @param {string} khPath - per-env known_hosts file path
 * @param {number} [maxWaitSec]
 * @param {{ onStage?: (label: string) => void }} [opts] - called with a plain
 *   description of what the server is doing, when it changes
 * @returns {Promise<void>}
 */
export async function waitForK3sReady(
  masterIp,
  sshKeyPath,
  khPath,
  maxWaitSec = 600,
  { onStage } = {},
) {
  // One held SSH session returns the moment /tmp/k3s-ready exists. The run
  // wrapper never throws (the helper's contract) and keeps the last SSH error
  // for the timeout message below.
  let lastErr;
  const run = async (script, { timeoutMs, onLine }) => {
    try {
      return await runCommandAsync(
        [
          'ssh',
          '-i',
          sshKeyPath,
          ...sshHostKeyOpts(khPath),
          '-o',
          'ConnectTimeout=5',
          '-o',
          'BatchMode=yes',
          `root@${masterIp}`,
          script,
        ],
        { silent: true, timeout: timeoutMs, onStdoutLine: onLine },
      );
    } catch (err) {
      lastErr = err;
      return null;
    }
  };
  const { ready } = await waitForRemoteMarker({
    run,
    markerPath: '/tmp/k3s-ready',
    logPath: BOOT_MARK_LOG,
    deadlineMs: Date.now() + maxWaitSec * 1000,
    ...(onStage && { onLine: readBootStage(onStage) }),
  });
  if (!ready) {
    const err = lastErr;
    // Capture cloud-init + syslog before throwing so the failure log says
    // WHY install timed out (apt slow? k3s download 5xx? script crashed?)
    // instead of just "300s passed and the marker isn't there." Best-effort —
    // if the box is unreachable, captureK3sInstallDiag returns an empty string
    // and we surface only the SSH probe error.
    const diag = await captureK3sInstallDiag(masterIp, sshKeyPath, khPath);
    throw new Error(
      `k3s did not become ready on ${masterIp} within ${maxWaitSec}s. ` +
        `Last SSH error: ${err instanceof Error ? err.message : 'unknown'}` +
        (diag ? `\n\n--- install diagnostics from ${masterIp} ---\n${diag}` : ''),
    );
  }
}

/**
 * scp the master's kubeconfig and install it as the operator's
 * (installOperatorKubeconfig, kubeconfig.js): its server URL points at the
 * public master IP (cloud-init writes `127.0.0.1:6443`, useless from the
 * operator's laptop) and every cluster entry carries
 * `disable-compression: true`. The copy lands in a 0600 temp beside the
 * kubeconfig and is renamed into place only once complete, so a reader never
 * sees a partial file and a failed copy leaves the old one as it was. The only
 * place the cluster's credentials leave the master
 * (kubectl-no-compression-census.test.ts).
 *
 * @param {string} masterIp
 * @param {string} sshKeyPath
 * @param {string} khPath - per-env known_hosts file path
 * @param {string} projectDir
 * @param {string} environment
 * @returns {Promise<string>} absolute path to the local kubeconfig
 */
export async function fetchKubeconfig(masterIp, sshKeyPath, khPath, projectDir, environment) {
  const localPath = localKubeconfigPath(projectDir, environment);
  await installOperatorKubeconfig(localPath, masterIp, (tmp) =>
    scpWithRetry([
      '-i',
      sshKeyPath,
      ...sshHostKeyOpts(khPath),
      `root@${masterIp}:/etc/rancher/k3s/k3s.yaml`,
      tmp,
    ]),
  );
  return localPath;
}

/**
 * The two images of the `cluster-autoscaler` pod (upstream CA + our
 * carbon-autoscaler sidecar), pre-pulled FIRST on every node.
 *
 * Incident 2026-07-31 (e3 k8s e2e): the CA rollout wait spent its whole 300s
 * budget on image pulls that 403'd — three attempts, BackOff x20 over 5m11s.
 * The image ref moved to a ghcr mirror (src/lib/images.js) to remove that
 * failure mode; pre-pulling is the independent second line of defense. Both
 * pulls start minutes before applyK3sManifests waits on the rollout, so a
 * slow or flaky registry costs overlap rather than the deploy.
 *
 * They lead the list because pulls run sequentially within a node: nothing
 * else in the pre-pull gates a rollout-status wait the way these two do. Only
 * the control-plane node actually schedules this pod (nodeSelector), but the
 * pre-pull ships one script to every node — a stray ~60MB layer set on the
 * others is far cheaper than teaching this path per-node image lists, and it
 * pre-warms whichever node a future failover promotes.
 *
 * @returns {string[]}
 */
export function clusterAutoscalerPodImages() {
  return [clusterAutoscalerImageRef(), carbonAutoscalerImageRef()];
}

/**
 * Assemble the pre-pull list: cluster-autoscaler pod first, then any extra
 * images (the db image on a deploy), duplicate-free and order-stable. Refs
 * end up inside a remote shell script, so anything outside a strict
 * character allowlist is dropped rather than quoted.
 *
 * @param {string[]} [extraImages]
 * @returns {string[]}
 */
export function buildPrePullImages(extraImages = []) {
  const safe = (ref) => typeof ref === 'string' && /^[A-Za-z0-9._/:@-]+$/.test(ref);
  return [...new Set([...clusterAutoscalerPodImages(), ...(extraImages ?? []).filter(safe)])];
}

/**
 * One-line pre-pull summary for the deploy log. Lives here rather than inline
 * at the call site so the fire-and-forget shape
 * (`prePullImages(...).then(...).catch(...)`) stays compact enough to read.
 *
 * @param {{images: number, nodes: number}} result
 * @param {number} elapsedMs
 * @returns {string}
 */
export function formatPrePullSummary(result, elapsedMs) {
  return `[prepull] ${result.images} images on ${result.nodes} node(s) in ${Math.round(elapsedMs / 1000)}s`;
}

/**
 * Opportunistic image pre-pull. Firing `ctr images pull` on every node right
 * after k3s is Ready moves the pulls 2-3 minutes earlier, overlapping the
 * build / manifest work, so kubelet finds the images already
 * present: the cluster-autoscaler pod's pair (see clusterAutoscalerPodImages)
 * and, on a deploy, the db image the db StatefulSet's inits and container all
 * run (pulled from ghcr; slow-pull regions measured over two minutes of a
 * cold db boot in image pulls alone).
 *
 * Fully fire-and-forget by contract: the caller must NOT await this into the
 * deploy's critical path, and every failure mode (SSH, a single pull)
 * degrades to the default behavior — kubelet pulls on demand. One SSH per
 * node (parallel across nodes); pulls run sequentially inside a node to bound
 * NIC + containerd churn. `|| true` per image keeps one bad ref from aborting
 * the rest.
 *
 * @param {{nodeIps: string[], sshKeyPath: string, khPath: string, extraImages?: string[]}} args
 * @returns {Promise<{images: number, nodes: number}>}
 */
export async function prePullImages({ nodeIps, sshKeyPath, khPath, extraImages = [] }) {
  const images = buildPrePullImages(extraImages);
  const targets = (nodeIps ?? []).filter(Boolean);
  if (images.length === 0 || targets.length === 0) {
    return { images: images.length, nodes: 0 };
  }
  const script = images
    .map((img) => `k3s ctr -n k8s.io images pull ${img} >/dev/null 2>&1 || true`)
    .join('\n');
  const sshOpts = ['-i', sshKeyPath, ...buildHostKeyOptsForPath(khPath)];
  await Promise.all(
    targets.map((ip) =>
      runCommandAsync(['ssh', ...sshOpts, `root@${ip}`, 'sh -s'], {
        silent: true,
        input: script,
        // Bounded: a wedged pull must not outlive the deploy by much. On
        // expiry the remaining images simply pull on demand.
        timeout: 300_000,
      }),
    ),
  );
  return { images: images.length, nodes: targets.length };
}

/**
 * Read a `.env.local` file into a plain object — the deploy path's hard
 * precondition, so a MISSING file throws (callers that merely want a
 * fingerprint existsSync first; see digestEnvLocalSecrets).
 *
 * Parsing is `parseDotenv` (src/lib/dotenv.js), the codebase's one dotenv
 * reader (Node's util.parseEnv).
 *
 * @param {string} envPath
 * @returns {Record<string, string>}
 */
function loadEnvLocal(envPath) {
  if (!existsSync(envPath)) {
    throw new Error(`loadEnvLocal: ${envPath} not found. Run 'vibecarbon create' to generate it.`);
  }
  return parseDotenv(readFileSync(envPath, 'utf-8'));
}

/**
 * Build the local container image and return its tag.
 *
 * Reuses the buildLocalImage primitive from src/lib/deploy/image.js, which
 * already handles git sha + dirty-state + timestamp. Tag scheme:
 * `vibecarbon-local/<projectName>:<sha>[-dirty]-<utcTimestamp>`, for no
 * particular cluster: the build starts before the cluster exists
 * (startAppImageBuild), so it cannot know the master's private IP, a real
 * Pulumi output on DigitalOcean. deliverAppImage then retags it
 * `<masterPrivateIp>:5000/<projectName>:<same tag>` (registryImageTag), the
 * ref used at every later step: applyK3sManifests delivers it once, by layer
 * delta, into the master's containerd and pushes it into the master's
 * registry pod (deliverImage, layer-delta.js), and every other node, static
 * or cluster-autoscaler-spawned, pulls it from the registry through
 * `registries.yaml`.
 *
 * A k8s-ha standby never calls this: it receives the primary's tag, copied
 * from the primary's registry into its own and re-prefixed with its own
 * master's private IP (see deliverAppImage).
 *
 * @param {string} projectDir
 * @param {string} projectName
 * @param {boolean} [rebuild]
 * @param {string} [domain]
 * @param {{quiet?: boolean}} [opts] - quiet: capture the build output (it
 *   overlaps the provisioning spinner); a failure carries its tail.
 * @returns {Promise<{tag: string, gitSha: string, isDirty: boolean}>}
 */
export async function buildAppImage(
  projectDir,
  projectName,
  rebuild = false,
  domain = undefined,
  { quiet = false, signal } = {},
) {
  const { buildLocalImage } = await import('../image.js');
  // App image: collect VITE_* build args (incl. VITE_PUBLIC_URL rewritten to
  // https://<domain> — single public origin) so the browser bundle ships with
  // real config instead of empty strings. buildLocalImage previously passed NO
  // build args, so the k8s SPA shipped empty client config — compose plumbs these via collectComposeBuildArgs, k8s did not. The backup
  // image build (no frontend) calls this without a domain → no VITE args.
  let buildArgs = {};
  if (domain) {
    const { collectComposeBuildArgs } = await import('../compose/build-args.js');
    buildArgs = collectComposeBuildArgs(projectDir, { projectName, domain });
  }
  return await buildLocalImage(projectDir, { projectName, rebuild, buildArgs, quiet, signal });
}

/** Give a locally built image its registry name (a local `docker tag`, no copy). */
async function tagLocalImage(source, target) {
  await runCommandAsync(['docker', 'tag', source, target], { silent: true });
}

/**
 * Best-effort capture of cloud-init + syslog tails to answer "why didn't
 * k3s install?" The caller has already exhausted its readiness budget;
 * this runs ONE quick SSH per command (5s connect, 15s exec) and returns
 * the joined output. Each command is wrapped in a short script so we get
 * partial output when the box is sluggish but not dead.
 *
 * Probe order is "answer the most-likely question first":
 *   1. cloud-init status — is user-data even done? (errored / running / done)
 *   2. install-attempt grep — did our script try? how many attempts?
 *   3. cloud-init-output.log (last 200) — install error or `exit 1` line
 *   4. k3s binary presence — install never wrote /usr/local/bin/k3s
 *   5. syslog tail — apt errors, kernel oopses
 *   6. systemctl status k3s — service registered yet?
 *   7. df -h — a full disk often masquerades as a hung install
 *
 * Without these, the 2026-04-27 morning-matrix k8s-ha primary failure
 * read as "Unit k3s.service could not be found" with no signal as to
 * whether the install script never started, errored mid-way, or hit
 * the 5-attempt curl retry limit. The new probes localize the failure
 * to one of: cloud-init didn't run, install script errored before line
 * N, install retries exhausted, k3s binary present but service unit
 * missing/disabled.
 *
 * Returns '' if even the first SSH fails (box unreachable / down).
 */
async function captureK3sInstallDiag(host, sshKeyPath, khPath) {
  const sshArgs = (cmd) => [
    '-i',
    sshKeyPath,
    ...sshHostKeyOpts(khPath),
    '-o',
    'ConnectTimeout=5',
    '-o',
    'BatchMode=yes',
    `root@${host}`,
    cmd,
  ];

  // Each probe returns at most `slice` chars from the END of its output
  // (so when the box dumps a wide cloud-init-output.log the tail — i.e. the
  // failure point — is what survives truncation, not the early ci-info
  // tables). Default is 4000; overridden per-probe where the relevant
  // signal lives in a longer tail.
  const probes = [
    {
      // `cloud-init status --long` reports `status: error|running|done` plus
      // (on error) the failing module name. This single line tells us
      // whether user-data even finished — the most useful signal of all.
      label: 'cloud-init status',
      cmd: 'cloud-init status --long 2>&1 | head -n 20 || echo "(cloud-init not installed)"',
    },
    {
      // Grep for our master-init.sh markers so a long log boils down to
      // "did install run, how many times, what was the result?" without
      // having to read the whole tail. Markers come from the script:
      //   "Installing k3s version: X"   → start of install section
      //   "k3s install attempt N failed" → curl|sh retry fired
      //   "k3s install failed after 5 attempts" → exhausted
      //   "k3s master installation complete!" → success line
      label: 'install attempts (cloud-init-output grep)',
      cmd: 'grep -E "Installing k3s|install attempt|installation complete|FATAL: k3s" /var/log/cloud-init-output.log 2>&1 | tail -n 30 || echo "(no log)"',
    },
    {
      // The output we *most* need to see in a failure: the lines right
      // before cloud-init bailed out. Wide ci-info tables at the start of
      // the file used to drown the failure tail under the 4k char cap;
      // we now keep the last 16k chars of `tail -n 400` so the actual
      // bash-level error survives truncation.
      label: 'cloud-init-output.log (last 400 lines)',
      cmd: 'echo "=== wc -l ===" && wc -l /var/log/cloud-init-output.log 2>&1; echo "=== tail ===" && tail -n 400 /var/log/cloud-init-output.log 2>&1 || echo "(not present)"',
      slice: 16_000,
    },
    {
      // The framework log (different file from cloud-init-output.log).
      // When cloud-init's own modules error before user-data runs, the
      // traceback lands here, not in -output.log. Critical when scripts_user
      // status says "error" but -output.log shows no command failure.
      label: 'cloud-init.log (errors + last 200 lines)',
      cmd: 'echo "=== ERROR / WARNING grep ===" && grep -nE "ERROR|WARNING|CRITICAL|Traceback" /var/log/cloud-init.log 2>&1 | tail -n 60; echo "=== last 200 lines ===" && tail -n 200 /var/log/cloud-init.log 2>&1 || echo "(not present)"',
      slice: 12_000,
    },
    {
      // Show what command in part-001 actually ran. cloud-init writes the
      // user-data script verbatim to /var/lib/cloud/instance/scripts/part-001,
      // so seeing its first/last lines plus an md5 lets us confirm the
      // generated script matches what we sent (no truncation in transit).
      label: 'part-001 user-data script',
      cmd: 'echo "=== md5 + size ===" && md5sum /var/lib/cloud/instance/scripts/*.sh /var/lib/cloud/instance/scripts/part-* 2>&1 | head -n 10; echo "=== head ===" && head -n 5 /var/lib/cloud/instance/scripts/part-* 2>/dev/null || echo "(not present)"; echo "=== tail ===" && tail -n 5 /var/lib/cloud/instance/scripts/part-* 2>/dev/null || echo "(not present)"',
    },
    {
      // Did the install at least produce a binary? Distinguishes "install
      // script never ran" (no binary) from "install ran but service unit
      // is borked" (binary present, unit missing).
      label: 'k3s binary',
      cmd: 'ls -la /usr/local/bin/k3s 2>&1; which k3s 2>&1 || echo "(not in PATH)"',
    },
    {
      // cloud-final is the systemd unit that runs scripts_user. Its
      // journal output captures any stderr that didn't make it into
      // cloud-init-output.log (e.g. when the script process is killed by
      // OOM or the box reboots mid-script).
      label: 'journalctl -u cloud-final',
      cmd: 'journalctl -u cloud-final --no-pager -n 100 2>&1 || echo "(no journal)"',
      slice: 8_000,
    },
    {
      label: 'syslog (last 50 lines)',
      cmd: 'tail -n 50 /var/log/syslog 2>&1 || journalctl -n 50 --no-pager 2>&1 || echo "(no log)"',
    },
    {
      label: 'systemctl status k3s',
      cmd: 'systemctl status k3s --no-pager 2>&1 | head -n 30 || echo "(no service)"',
    },
    { label: 'disk usage', cmd: 'df -h / 2>&1' },
  ];

  const out = [];
  for (const probe of probes) {
    const sliceLen = probe.slice ?? 4000;
    try {
      const result = await runCommandAsync(['ssh', ...sshArgs(probe.cmd)], {
        silent: true,
        timeout: 20_000,
      });
      // Keep the END of the output (failure tail), not the start. ci-info
      // tables at the head of cloud-init-output.log used to push the
      // failing line off the end; `slice(-sliceLen)` flips that.
      const trimmed = result.trim();
      const kept =
        trimmed.length > sliceLen
          ? `…(truncated; kept last ${sliceLen} chars)…\n${trimmed.slice(-sliceLen)}`
          : trimmed;
      out.push(`### ${probe.label}\n${kept}`);
    } catch (err) {
      // First probe fails -> box is dead, no point trying the others.
      if (out.length === 0) return '';
      out.push(
        `### ${probe.label}\n(probe failed: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'})`,
      );
    }
  }
  return out.join('\n\n');
}

/**
 * Generated infra passwords that land in Secret `vibecarbon-infra-secrets`,
 * never in the app's Secret. Each is read by key (secretKeyRef), only by the
 * pod that uses it: DB_PASSWORD (the db superuser; the db StatefulSet and the
 * app pod's migrate init container, never the app container), REPL_PASSWORD
 * (no pod reads it: setupReplication takes it from .env.local and the reseed
 * reads it back from this Secret over SSH) and the add-on roles' own database passwords
 * (generated by `vibecarbon add`, healed by `upgrade`; read by the metabase
 * and n8n Deployments, present only when the add-on is installed).
 *
 * These are generated at deploy time (not user-configured), so they stay
 * local here rather than in the config-registry.
 */
export const INFRA_SECRET_KEYS = [
  'DB_PASSWORD',
  'REPL_PASSWORD',
  'METABASE_DB_PASSWORD',
  'N8N_DB_PASSWORD',
  'N8N_ENCRYPTION_KEY',
];

/**
 * Every `.env.local` key that reaches either cluster Secret: the infra
 * passwords above plus the app's runtime keys (APP_RUNTIME_KEYS, which folds
 * in every configure-managed billing/OAuth/SMTP key from the config-registry).
 * The k3s-apply gate digests these values. Client-side VITE_* keys are
 * excluded except the Plausible pair the app server also reads at runtime.
 */
export const SECRET_KEYS = [...new Set([...INFRA_SECRET_KEYS, ...APP_RUNTIME_KEYS])];

/**
 * The single Secret the app and infra keys shared before they were split.
 * applyK3sManifests deletes it once the rollout has moved every pod off it.
 */
export const LEGACY_VIBECARBON_SECRET = 'vibecarbon-secrets';

/** The Redis add-on's password, when the add-on is on. */
function redisPassword(envLocal) {
  return envLocal.REDIS_ENABLED === 'true' && envLocal.REDIS_PASSWORD
    ? envLocal.REDIS_PASSWORD
    : null;
}

/**
 * The `stringData` of Secret `vibecarbon-app-secrets`, which the app
 * Deployment reads whole through envFrom: the app's runtime keys
 * (buildAppRuntimeEnv), its object-storage keys from the appStorageCredential
 * hand-off, and the Redis add-on's REDIS_URL (`redis` is the add-on's
 * ClusterIP Service; compose's equivalent lives in
 * services/redis/compose/docker-compose.yml). No infra password, cloud or DNS
 * token ever lands here. Pure, so the contents are testable without a cluster.
 *
 * No VC_ENV: compose's WAL-G prefix reads it, but k8s renders WALG_S3_PREFIX_BASE
 * from s3Config.walgPrefix (buildDbManifestValues) and nothing in carbon/k8s
 * reads it; in k8s-ha the stack env (prod-primary) is not even the env's name.
 *
 * @param {{envLocal: Record<string,string>, s3Config?: {accessKey: string, secretKey: string, bucket: string, endpoint: string, region: string}}} args
 * @returns {Record<string,string>}
 */
export function buildAppSecretData({ envLocal, s3Config }) {
  /** @type {Record<string,string>} */
  const extras = appStorageCredential({ s3Config });
  const redis = redisPassword(envLocal);
  if (redis) extras.REDIS_URL = `redis://:${redis}@redis:6379`;
  return buildAppRuntimeEnv(envLocal, extras);
}

/**
 * The `stringData` of Secret `vibecarbon-infra-secrets`: the infra passwords
 * (INFRA_SECRET_KEYS), the Redis add-on's REDIS_PASSWORD (the redis
 * Deployment's required secretKeyRef), WAL-G's credentials file and the
 * backup bucket name. Every consumer reads it by key, never whole, and the
 * app container reads none of it (only the migrate init container reads
 * DB_PASSWORD, to run the migrations as the owner). Also the Secret that
 * carries the restore marker (RESTORE_MARKER_KEYS, src/lib/walg/restore-marker.js):
 * `vibecarbon restore` patches it in, and `deploy -restore` passes its
 * resolved `restore` point so the marker lands with the rest, before the db
 * StatefulSet applies. Without one no marker key is written, so an apply
 * leaves a restore's patched keys alone. Clearing is the restore's own patch
 * once the restored database is proven, never this. Pure.
 *
 * @param {{envLocal: Record<string,string>, s3Config?: {accessKey: string, secretKey: string, bucket: string, endpoint: string, region: string}, backupTarget?: import('../../backups-bucket.js').BackupsTarget|null, restore?: {backup: string, target: string, recoveryConf: string}|null}} args
 * @returns {Record<string,string>}
 */
export function buildInfraSecretData({ envLocal, s3Config, backupTarget, restore }) {
  /** @type {Record<string,string>} */
  const stringData = {};
  for (const key of INFRA_SECRET_KEYS) {
    if (envLocal[key]) stringData[key] = envLocal[key];
  }
  const redis = redisPassword(envLocal);
  if (redis) stringData.REDIS_PASSWORD = redis;
  if (s3Config) {
    // AWS-SDK-format credentials file for wal-g in the db pod, mounted as a
    // file (AWS_SHARED_CREDENTIALS_FILE) rather than env so a rotated key
    // reaches wal-g without a pod-template change. See the walg-s3-creds
    // volume in k8s/base/db/statefulset.yaml.
    stringData.S3_CREDENTIALS_INI = `[default]\naws_access_key_id=${s3Config.accessKey}\naws_secret_access_key=${s3Config.secretKey}\n`;
  }
  if (backupTarget?.bucket) {
    stringData.S3_BACKUP_BUCKET = backupTarget.bucket;
  }
  if (restore) Object.assign(stringData, restoreMarkerStringData({ ...restore, origin: 'deploy' }));
  return stringData;
}

/** The app pod-template annotation that records the Secrets' resourceVersions. */
export const APP_SECRETS_SHA_ANNOTATION = 'vibecarbon.dev/app-secrets-sha';

/**
 * The resourceVersions of the two Secrets the app pod reads: the app Secret
 * (envFrom on the app container, APP_DB_PASSWORD on migrate) and the infra
 * Secret (the owner DB_PASSWORD the migrate init container reads). Stamped on
 * the pod template, so a changed Secret rolls the pods and reruns migrate.
 * Without it nothing rolled: envFrom is read at container start and `set
 * image` to the same tag is a no-op, so a re-minted storage key never reached
 * the pods before the old one was revoked, and an APP_DB_PASSWORD rotation
 * never took effect. Nothing is derived from a Secret value: `kubectl apply`
 * of unchanged data leaves resourceVersion alone (an unchanged deploy stays a
 * no-op roll) and any real change bumps it. Must run after the Secrets are
 * applied. An unreadable version throws: a silently skipped roll would leave
 * the old credential live under the pods.
 *
 * @param {{env: NodeJS.ProcessEnv}} args
 * @returns {Promise<string>} e.g. "app:1234,infra:1235"
 */
export async function readAppSecretVersions({ env }) {
  const versions = [];
  for (const [label, name] of [
    ['app', 'vibecarbon-app-secrets'],
    ['infra', 'vibecarbon-infra-secrets'],
  ]) {
    const out = await runKubectlWithRetry(
      ['-n', 'vibecarbon', 'get', 'secret', name, '-o', 'jsonpath={.metadata.resourceVersion}'],
      {
        env,
        captureStdout: true,
        description: `applyK3sManifests: read Secret/${name} resourceVersion`,
      },
    );
    const rv = String(out ?? '').trim();
    if (!/^\d+$/.test(rv)) {
      throw new Error(
        `Could not read the resourceVersion of Secret/${name}; refusing to deploy without knowing whether the app must roll.`,
      );
    }
    versions.push(`${label}:${rv}`);
  }
  return versions.join(',');
}

/** A Secret manifest for `kubectl apply -f -`, values JSON-quoted, never on argv. */
function secretManifest(name, stringData) {
  return [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${name}`,
    '  namespace: vibecarbon',
    'type: Opaque',
    'stringData:',
    ...Object.entries(stringData).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
  ].join('\n');
}

/**
 * Apply the two in-cluster Secrets, `vibecarbon-app-secrets` and
 * `vibecarbon-infra-secrets`, from the project's `.env.local`. Idempotent:
 * each is rendered as a Secret manifest and piped to `kubectl apply -f -`
 * so re-runs upsert cleanly.
 *
 * Must run BEFORE the base/ kustomization apply, because the app Deployment
 * (envFrom) and the db StatefulSet (secretKeyRef) reference them.
 *
 * `backupTarget` is the dedicated backups bucket (separate from the storage
 * bucket in s3Config.bucket), with its region and endpoint; without it,
 * backup.sh falls back to the storage bucket and uploads dumps next to user
 * files (observed 2026-04-27 k8s-ha matrix #6 — restore couldn't find
 * backups).
 *
 * `restore` (a resolved `deploy -restore` point) writes the restore marker
 * into the infra Secret, see buildInfraSecretData.
 *
 * `walgRole` is recorded after the Secrets as the db's wal-g role intent, the
 * CLI-owned ConfigMap vibecarbon-db-role (src/lib/deploy/walg-role.js). The db
 * container reads it as VC_WALG_ROLE_INTENT and db-guard.sh writes it to the
 * role file on every start, so it has to exist before base/ creates the pod.
 * `kubectl apply`, so a cluster that predates it gets it created.
 *
 * @param {{kubeconfig: string, envLocal: Record<string,string>, s3Config?: {accessKey: string, secretKey: string, bucket: string, endpoint: string, region: string}, backupTarget?: import('../../backups-bucket.js').BackupsTarget|null, restore?: {backup: string, target: string, recoveryConf: string}|null, walgRole: 'primary'|'standby'}} args
 */
export async function applyVibecarbonSecrets({
  kubeconfig,
  envLocal,
  s3Config,
  backupTarget,
  restore,
  walgRole,
}) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  // Ensure the namespace exists before we try to land a Secret in it.
  // base/ kustomization creates it too, but we run before base/.
  // Two-step (render → apply) instead of `bash -c '… | kubectl apply -f -'`
  // so each kubectl call goes through runKubectlWithRetry — apiserver
  // transients during k3s warm-up otherwise kill the deploy here too.
  const namespaceYaml = await runKubectlWithRetry(
    ['create', 'namespace', 'vibecarbon', '--dry-run=client', '-o', 'yaml'],
    { env, captureStdout: true, description: 'applyVibecarbonSecrets: render namespace yaml' },
  );
  await runKubectlWithRetry(['apply', '-f', '-'], {
    env,
    input: namespaceYaml,
    description: 'applyVibecarbonSecrets: kubectl apply namespace/vibecarbon',
  });
  const secrets = {
    'vibecarbon-app-secrets': buildAppSecretData({ envLocal, s3Config }),
    'vibecarbon-infra-secrets': buildInfraSecretData({
      envLocal,
      s3Config,
      backupTarget,
      restore,
    }),
  };
  for (const [name, stringData] of Object.entries(secrets)) {
    await runKubectlWithRetry(['apply', '-f', '-'], {
      env,
      input: secretManifest(name, stringData),
      description: `applyVibecarbonSecrets: kubectl apply Secret/${name}`,
    });
  }
  // The intent must exist before the base apply creates the db pod, which
  // reads it at container start. deployK3s sets it on every deploy
  // (writeDeployWalgRole, through setK8sWalgRole), including one whose apply
  // is skipped; this first apply is what a brand-new pod starts with. An
  // unchanged intent stays as it is: applying it clears the live record, which
  // would cost this warm deploy the exec the record exists to avoid.
  const { intent } = await readDbRoleRecord({ kubectl: localWalgRoleKubectl(kubeconfig) });
  if (intent !== walgRole) {
    await runKubectlWithRetry(k8sWalgRoleIntentApplyArgv(), {
      env,
      input: dbRoleConfigMapManifest(walgRole),
      description: 'applyVibecarbonSecrets: kubectl apply ConfigMap/vibecarbon-db-role',
    });
  }
}

/**
 * Provision the SCOPED secret + config the isolated Grafana needs in the
 * `vibecarbon-observability` namespace (H-9). Secrets/ConfigMaps are
 * namespace-scoped, so Grafana's `grafana-secrets`/`grafana-config` refs would
 * resolve to nothing after the namespace move.
 *
 * SECURITY: this deliberately ships ONLY the three keys Grafana reads —
 * ADMIN_EMAIL + ADMIN_PASSWORD (its login) and SITE_URL (root URL) — NOT the
 * whole vibecarbon-app-secrets bundle. No DB / service-role / JWT material crosses
 * into the observability namespace, so a Grafana/observability compromise can't
 * read app credentials. Values are piped via stdin (never argv), same as
 * applyVibecarbonSecrets.
 *
 * Must run BEFORE the observability apply so the Grafana
 * Deployment finds its secret/config on first schedule.
 *
 * @param {{kubeconfig: string, envLocal: Record<string,string>, domain: string}} args
 */
export async function applyObservabilitySecrets({ kubeconfig, envLocal, domain }) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  const ns = 'vibecarbon-observability';
  // Ensure the namespace exists before landing the Secret/ConfigMap. The
  // observability kustomization also creates it (idempotent), but that apply
  // runs after this so Grafana starts clean.
  const namespaceYaml = await runKubectlWithRetry(
    ['create', 'namespace', ns, '--dry-run=client', '-o', 'yaml'],
    { env, captureStdout: true, description: 'applyObservabilitySecrets: render namespace yaml' },
  );
  await runKubectlWithRetry(['apply', '-f', '-'], {
    env,
    input: namespaceYaml,
    description: `applyObservabilitySecrets: kubectl apply namespace/${ns}`,
  });
  const secretYaml = [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    '  name: grafana-secrets',
    `  namespace: ${ns}`,
    'type: Opaque',
    'stringData:',
    `  ADMIN_EMAIL: ${JSON.stringify(envLocal.ADMIN_EMAIL || '')}`,
    `  ADMIN_PASSWORD: ${JSON.stringify(envLocal.ADMIN_PASSWORD || '')}`,
  ].join('\n');
  await runKubectlWithRetry(['apply', '-f', '-'], {
    env,
    input: secretYaml,
    description: 'applyObservabilitySecrets: kubectl apply Secret/grafana-secrets',
  });
  const configYaml = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: grafana-config',
    `  namespace: ${ns}`,
    'data:',
    `  SITE_URL: ${JSON.stringify(`https://${domain}`)}`,
  ].join('\n');
  await runKubectlWithRetry(['apply', '-f', '-'], {
    env,
    input: configYaml,
    description: 'applyObservabilitySecrets: kubectl apply ConfigMap/grafana-config',
  });
}

/**
 * Pre-flight the two ways the database can end up on node-local storage, and
 * fail LOUD instead of proceeding. Runs before `k8s/base` (and with it the db
 * StatefulSet) is applied.
 *
 * WHY (kept k8s-ha rig e4, 2026-08-05): a PVC created with NO class gets
 * whichever class the DefaultStorageClass admission plugin picks at that
 * instant, and that is a race: k3s ships `local-path` annotated default and
 * hetznercloud/csi-driver's `hcloud-volumes` is annotated the same way, and
 * with two defaults the plugin picks the NEWEST. A state-resumed deploy lost
 * the race and put PGDATA on node-local disk — no detachable volume, so
 * replication, failover and wal-g restore all silently lost their footing.
 * The StatefulSet's volumeClaimTemplate therefore pins
 * `ProviderClass.K8S_STORAGE_CLASS` (rendered by renderK8sBase), and this
 * checks the two cases the pin alone cannot fix:
 *
 * 1. The provider's StorageClass is absent from the cluster. cloud-init installs
 *    the CSI driver on a best-effort 3-try loop whose failure is never checked
 *    (`carbon/cloud-init/k3s/master-init.sh`), and `/tmp/k3s-ready` is touched
 *    regardless — so a cluster genuinely can come up with only `local-path`.
 *    The db PVC would then sit Pending and the db rollout wait would burn its
 *    whole budget; this turns that into an instant, named failure.
 * 2. The PGDATA claim (DB_PVC) already exists on a DIFFERENT class.
 *    `spec.storageClassName` is immutable, so it cannot be repaired in place.
 *
 * Probe failures are NOT fatal: a transient apiserver blip must not fail a
 * deploy, and the pinned class still prevents a silent wrong-class bind (the
 * PVC would stay Pending and the rollout wait would fail loudly). An EMPTY
 * StorageClass listing is treated as "could not verify" rather than "none
 * exist" — every real k3s cluster has at least `local-path`, so an empty list
 * means the probe, not the cluster, came up short.
 *
 * @param {{storageClass: string, namespace?: string, env: NodeJS.ProcessEnv}} args
 *   `env` must already carry KUBECONFIG.
 */
export async function assertDbStorageClass({ storageClass, namespace = 'vibecarbon', env }) {
  if (!storageClass) {
    throw new Error(
      'assertDbStorageClass: no storageClass, ProviderClass.K8S_STORAGE_CLASS is empty. ' +
        'Refusing to create the database without a pinned StorageClass: the PVC would ' +
        "fall back to the cluster's default class, which can be k3s' node-local " +
        'local-path and silently breaks replication/failover/restore.',
    );
  }
  /** @param {string[]} args */
  const probe = async (args, description) => {
    try {
      return await runKubectlWithRetry(args, { env, captureStdout: true, description });
    } catch (err) {
      console.error(
        `[storage-class] probe skipped (${(err?.message || String(err)).slice(0, 160)}), ` +
          'the pinned class still prevents a silent wrong-class bind',
      );
      return null;
    }
  };

  const pvcOut = await probe(
    [
      'get',
      'pvc',
      '-n',
      namespace,
      '-o',
      'jsonpath={range .items[*]}{.metadata.name}{"="}{.spec.storageClassName}{"\\n"}{end}',
    ],
    'assertDbStorageClass: kubectl get pvc',
  );
  for (const line of (pvcOut ?? '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const observed = line.slice(idx + 1).trim();
    if (name !== DB_PVC || observed === storageClass) continue;
    throw new Error(
      `assertDbStorageClass: the database PVC is on the WRONG StorageClass; expected ${storageClass}:\n` +
        `  - ${name}: ${observed || '(no class)'}\n` +
        "A PVC's spec.storageClassName is immutable, so this cannot be repaired in place. " +
        'A node-local volume is not detachable: replication, failover and wal-g ' +
        'restore do not work against it.\n' +
        'Remediation (DESTRUCTIVE; the local copy of this data is deleted):\n' +
        `  kubectl -n ${namespace} scale statefulset ${DB_STATEFULSET} --replicas=0\n` +
        `  kubectl -n ${namespace} delete pvc ${name}\n` +
        '  then re-run deploy. If this cluster holds the only copy of the data, take a ' +
        'wal-g backup first and bring it back with `vibecarbon restore` afterwards.',
    );
  }

  const scOut = await probe(
    ['get', 'storageclass', '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}'],
    'assertDbStorageClass: kubectl get storageclass',
  );
  const classes = (scOut ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (classes.length > 0 && !classes.includes(storageClass)) {
    throw new Error(
      `assertDbStorageClass: StorageClass '${storageClass}' does not exist in this cluster ` +
        `(found: ${classes.join(', ')}). The provider's CSI driver did not install — ` +
        'cloud-init applies it on a best-effort retry loop whose failure is not checked. ' +
        'Refusing to create the database: without it the PVC would fall back to ' +
        "the cluster's default class (k3s' node-local local-path). Check the master's " +
        '/var/log/cloud-init-output.log, re-apply the CSI driver, then re-run deploy.',
    );
  }
}

/**
 * The `kubectl get pods` argv behind the db-rollout failure explanation,
 * scoped to the db pod's own label (the namespace also carries the app and
 * any add-ons, and the wait was not on those). PHASE and the READY condition
 * are both read because `rollout status` gates on READY, not on phase — a
 * Running-but-not-Ready pod times the wait out exactly like a Pending one.
 *
 * @returns {string[]}
 */
export function dbPodListArgs() {
  return [
    'kubectl',
    '-n',
    'vibecarbon',
    'get',
    'pods',
    '-l',
    DB_POD_SELECTOR,
    '-o',
    'custom-columns=NAME:.metadata.name,PHASE:.status.phase,READY:.status.conditions[?(@.type=="Ready")].status',
    '--no-headers',
  ];
}

/**
 * Turn `dbPodListArgs`' output into the one-line truth about what the db
 * rollout wait left behind. The "never became Ready" wording is load-bearing:
 * tests/e2e/utils/classify-failure.ts pairs it with summarizeNotReadyNodes'
 * clause to tell a dead host from our own bug.
 *
 * @param {string} raw - `kubectl get pods … --no-headers` stdout
 * @returns {string}
 */
export function summarizeDbPods(raw) {
  const pods = String(raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // custom-columns pads with spaces and writes `<none>` for a condition
      // that does not exist yet (an unscheduled pod has no Ready condition).
      const [name, phase = 'Unknown', ready = '<none>'] = line.split(/\s+/);
      return { name, phase, ready: ready === 'True' };
    });

  if (pods.length === 0) {
    return `No db pod exists in the namespace; the ${DB_STATEFULSET} StatefulSet never created one.`;
  }

  const notReady = pods.filter((p) => !p.ready);
  if (notReady.length === 0) {
    return (
      `The db pod is Ready, the rollout wait failed for a reason other than pod ` +
      `readiness (its own timeout racing the pod to Ready, or the apiserver); ` +
      `see its output above.`
    );
  }

  const named = notReady.map((p) => `${p.name} (${p.phase})`);
  return `The db pod never became Ready: ${named.join(', ')}.`;
}

/**
 * `kubectl get nodes` shaped like `dbPodListArgs` — name + the Ready
 * condition. Read alongside the pod when the db rollout wait fails: a pod
 * stuck Pending/Init means one thing on a healthy cluster and something
 * entirely different when its HOST is gone.
 *
 * @returns {string[]}
 */
export function clusterNodeListArgs() {
  return [
    'kubectl',
    'get',
    'nodes',
    '-o',
    'custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status',
    '--no-headers',
  ];
}

/**
 * One clause naming any NotReady nodes, or '' when every node is Ready.
 *
 * WHY (RCA 2026-09-01, k8s-ha standby, PG17 cert run): the database node went
 * dark mid-deploy — kubelet stopped answering, SSH timed out, Hetzner's API
 * still said "running". The db pod froze in Init, the wait expired, and the
 * step classified [unknown] because the error only described the POD. Naming
 * the dead node makes the failure classifiable as infrastructure (see
 * classify-failure.ts) so the flake retry can re-roll the deploy instead of
 * hard-failing the run.
 *
 * @param {string} raw - `kubectl get nodes … --no-headers` stdout
 * @returns {string}
 */
export function summarizeNotReadyNodes(raw) {
  const notReady = String(raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ready = '<none>'] = line.split(/\s+/);
      return { name, ready };
    })
    .filter((n) => n.ready !== 'True');
  if (notReady.length === 0) return '';
  const named = notReady.map((n) => `${n.name} (Ready=${n.ready})`).join(', ');
  return (
    ` Node(s) NotReady: ${named} — the pod may be stuck because its HOST ` +
    `died or lost its kubelet, not because of the workload.`
  );
}

/**
 * Read the db pod so the rollout-failure error can say what actually
 * happened instead of asserting a state it never checked.
 *
 * Never throws: this runs INSIDE the construction of another error, and a
 * failure to list pods must not replace the failure it was trying to
 * explain. It also must not fall back to the zero-pod wording — claiming
 * "no pod" because kubectl was unreachable is the same lie in a new place.
 *
 * @param {NodeJS.ProcessEnv} env - carries KUBECONFIG
 * @returns {Promise<string>}
 */
async function describeDbPods(env) {
  try {
    const raw = await runCommandAsync(dbPodListArgs(), { env, silent: true });
    const podSummary = summarizeDbPods(raw);
    // Node readiness rides along, best-effort: a stuck pod on a dead node
    // is an infrastructure event, and only the node line makes it read as
    // one (see summarizeNotReadyNodes). A failure to list nodes never
    // replaces the pod summary we already have.
    let nodeSummary = '';
    try {
      const nodesRaw = await runCommandAsync(clusterNodeListArgs(), { env, silent: true });
      nodeSummary = summarizeNotReadyNodes(nodesRaw);
    } catch {
      // pod summary alone is still the truth we came for
    }
    return `${podSummary}${nodeSummary}`;
  } catch (err) {
    const detail = String(err?.message ?? err)
      .trim()
      .slice(0, 160);
    return (
      `Could not list the db pod to report what state it is in (${detail}) — ` +
      `check it by hand with \`kubectl -n vibecarbon get pods -l ${DB_POD_SELECTOR}\`.`
    );
  }
}

/**
 * Budget for the db StatefulSet to become Ready after `k8s/base` is applied.
 * A cold first boot pays the CSI volume provision + attach, the db image pull
 * (when the pre-pull has not finished) and initdb. 15 minutes is the budget
 * the chart install had for the same work.
 *
 * Deliberately longer than DB_STS_BOOT_TIMEOUT_S (600s, src/lib/deploy/
 * replication.js), the shared budget for re-booting an EXISTING db pod (the
 * reseed standby boot): that wait pays a CSI
 * re-attach, this one also pays the first provision, the image pull and
 * initdb. Must never drop below that floor:
 * tests/unit/deploy/db-sts-boot-timeout-census.test.ts pins it.
 */
export const DB_ROLLOUT_TIMEOUT_S = 900;

/**
 * A StatefulSet the retired Postgres Helm chart left behind: `<release>-<chart>-db`.
 * Ours is plainly `db`, so any other `*-db` is not one this CLI made.
 */
const RETIRED_CHART_DB = /^statefulset(\.apps)?\/.+-db$/;
/** Helm's release record: a Secret `sh.helm.release.v1.<release>.v<n>`. */
const HELM_RELEASE_RECORD = /sh\.helm\.release\.v1\.(.+)\.v\d+$/;

/**
 * Refuse to deploy onto a cluster that still runs the retired chart's
 * database.
 *
 * WHY: the db now lives on a new StatefulSet and a new volume (`data-db-0`).
 * Applied beside a running chart release it would start an EMPTY database
 * and the app (DB_HOST=db) would switch to it, so every row would look gone;
 * on k8s-ha the new pod could not even schedule, because the chart pod
 * already holds the node's replication hostPort (5433), and the rollout
 * would burn its whole budget. Nothing moves the data across automatically,
 * so the operator has to choose how, and this says how.
 *
 * Recognized by shape, not by name: this CLI installs no Helm release, so a
 * release record in the app namespace, or a database StatefulSet other than
 * `db`, is not ours. A customer's own chart in this namespace is refused too,
 * and that is the safe way round: a wrong refusal explains itself, a wrong
 * pass empties the site.
 *
 * A single read of the live cluster, not a retry: it runs after
 * awaitControlPlaneServing proved the apiserver answers, so a failing read
 * is a real failure and is reported as one rather than guessed at.
 *
 * @param {{env: NodeJS.ProcessEnv, namespace?: string, exec?: typeof runCommandAsync}} args
 */
export async function assertNoRetiredChartDb({
  env,
  namespace = 'vibecarbon',
  exec = runCommandAsync,
}) {
  let statefulsets;
  let releases;
  try {
    statefulsets = await exec(['kubectl', '-n', namespace, 'get', 'statefulset', '-o', 'name'], {
      env,
      silent: true,
    });
    releases = await exec(
      ['kubectl', '-n', namespace, 'get', 'secret', '-l', 'owner=helm', '-o', 'name'],
      { env, silent: true },
    );
  } catch (err) {
    throw new Error(
      'assertNoRetiredChartDb: could not read the cluster to check for the retired database ' +
        `chart (${String(err?.message ?? err).slice(0, 200)}). Refusing to create the db ` +
        'StatefulSet without knowing whether an older database is still running here.',
    );
  }
  const lines = (out) =>
    String(out ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  const records = lines(releases);
  const found = [...lines(statefulsets).filter((l) => RETIRED_CHART_DB.test(l)), ...records];
  if (found.length === 0) return;
  const release = records[0]?.match(HELM_RELEASE_RECORD)?.[1];
  const uninstall = release
    ? `\`helm uninstall ${release} -n ${namespace}\``
    : `\`helm uninstall\` the release \`helm list -n ${namespace}\` names`;
  const kustomization = release ? `\`vibecarbon-${release}\`` : "the chart's";
  throw new Error(
    `This cluster still runs the database from the retired Helm chart (${found.join(', ')} in ` +
      `namespace ${namespace}). This version runs Postgres as its own StatefulSet on a NEW ` +
      'volume, and existing data does not carry over automatically: deploying now would point ' +
      'the app at an empty database.\n' +
      'Pick one:\n' +
      '  - Start clean: `vibecarbon destroy <env>`, then `vibecarbon deploy <env>`.\n' +
      `  - Keep the data: ${uninstall}, then ` +
      '`vibecarbon deploy <env> -restore latest`. The restore reads the same wal-g prefix ' +
      'the chart database archived to (unchanged), so it replays every segment archived ' +
      'before the uninstall. On k8s-ha do this on both clusters.\n' +
      'GitOps clusters (`vibecarbon configure cicd`): first set `prune: false` on ' +
      `${kustomization} Flux Kustomization in flux-system and then delete it; deleting it ` +
      'with prune on garbage-collects the HelmRelease, which uninstalls the chart and deletes ' +
      'its database volume before you chose to.',
  );
}

/**
 * Wait for `statefulset/db` to roll out (its pod Ready: the real server
 * accepting TCP, see the readinessProbe in k8s/base/db/statefulset.yaml).
 * Throws with the db pod's state, and any NotReady node, when it does not.
 *
 * Rides runKubectlWithRetry like every deploy-gating rollout wait: a
 * transient failure on kubectl's initial connect (a TLS handshake timeout
 * seconds into the budget) would otherwise fail the deploy outright, and its
 * output goes through the deploy-log tee. Async (spawn-based): the wait can
 * last many minutes, and in HA the standby cluster's deploy runs in parallel
 * with the primary's.
 *
 * Fails EARLY on a stale volume attachment (watchDbAttach): the wait runs
 * while the current db pod's events are read every `staleAttachPollMs`, and
 * once the mkfs-on-a-missing-device signature has held it stops and names
 * that state. It repairs nothing and retries nothing.
 *
 * A k8s-ha standby's deploy passes `hint` (standbyDbRebuildHint): its db
 * holds only a replica, so a db that never becomes Ready there has a manual
 * way back, which a timeout names.
 *
 * @param {{env: NodeJS.ProcessEnv, timeoutS?: number, staleAttachPollMs?: number, waitRollout?: typeof runKubectlWithRetry, kubectl?: (argv: string[], opts: {signal: AbortSignal, timeout: number}) => Promise<string>, hint?: string}} args
 */
export async function awaitDbRollout({
  env,
  hint = '',
  timeoutS = DB_ROLLOUT_TIMEOUT_S,
  staleAttachPollMs = 15_000,
  waitRollout = runKubectlWithRetry,
  kubectl = localKubectlReader(env),
}) {
  const started = Date.now();
  try {
    await watchDbAttach(
      (signal) =>
        waitRollout(
          [
            '-n',
            'vibecarbon',
            'rollout',
            'status',
            `statefulset/${DB_STATEFULSET}`,
            `--timeout=${timeoutS}s`,
          ],
          {
            env,
            description: `awaitDbRollout: rollout status statefulset/${DB_STATEFULSET}`,
            signal,
          },
        ),
      { kubectl, pollMs: staleAttachPollMs },
    );
  } catch (err) {
    if (err instanceof StaleVolumeAttachmentError) {
      throw new Error(`awaitDbRollout: ${err.message} ${await describeDbPods(env)}`);
    }
    throw new Error(
      `awaitDbRollout: statefulset/${DB_STATEFULSET} did not become Ready within ${timeoutS}s ` +
        `(${(err?.message || String(err)).slice(0, 300)}). ${await describeDbPods(env)}` +
        (hint ? ` ${hint}` : ''),
    );
  }
  console.error(
    `[db] statefulset/${DB_STATEFULSET} Ready after ${Math.round((Date.now() - started) / 1000)}s`,
  );
}

/**
 * `kubectl <argv>` against the deploy's own kubeconfig, returning stdout: the
 * reader watchDbAttach polls the db pod's events with during awaitDbRollout.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {(argv: string[], opts?: {signal?: AbortSignal, timeout?: number}) => Promise<string>}
 */
function localKubectlReader(env) {
  return (argv, opts) => runCommandAsync(['kubectl', ...argv], { env, silent: true, ...opts });
}

/**
 * The deploy-time values for the db StatefulSet's `{{PLACEHOLDER}}` tokens
 * (k8s/base/db/statefulset.yaml), one per token. Pure.
 *
 * @param {object} o
 * @param {string} o.dbImageTag - full db image ref, `<repo>:<tag>`
 * @param {{bucket?: string, walgPrefix?: string, endpoint?: string, region?: string}} [o.s3Config]
 * @param {import('../../backups-bucket.js').BackupsTarget|null} [o.backupTarget] - the
 *   backups bucket with its region and endpoint (null: the legacy path, wal-g
 *   archives into the storage bucket)
 * @param {string} o.storageClass - `ProviderClass.K8S_STORAGE_CLASS`
 * @param {string} o.walArchiveSha - sha of k8s/base/backup/configmap-walg.yaml
 * @returns {Record<string, string>}
 */
export function buildDbManifestValues({
  dbImageTag,
  s3Config,
  backupTarget,
  storageClass,
  walArchiveSha,
}) {
  if (!dbImageTag) {
    throw new Error(
      'buildDbManifestValues: dbImageTag is required (the pre-published wal-g db image, pulled from ghcr).',
    );
  }
  if (!storageClass) {
    throw new Error(
      'buildDbManifestValues: no storageClass, ProviderClass.K8S_STORAGE_CLASS is empty.',
    );
  }
  // Split on the LAST colon so the registry host (and any port colon) stays
  // in the repository.
  const lastColon = dbImageTag.lastIndexOf(':');
  // WAL-G S3 prefix — dedicated backup bucket if provided, else the storage
  // bucket (mirrors compose's S3_BACKUP_BUCKET:-S3_BUCKET fallback). Never
  // s3:/// (wal-g would error): empty when there is no bucket at all. This is
  // the BASE: walg-env.sh (sourced by every wal-g caller in the db pod)
  // appends the database lineage's folder, its system identifier.
  //
  // SINGLE canonical prefix (NO role segment). Reads (backup-fetch/restore/
  // reseed) and writes (backup-push/wal-push) must all agree on ONE prefix — a
  // role-segmented prefix made the standby read an empty `…/walg/standby` and
  // fail restore/reseed with "No backups found" (caught by compose-ha scale
  // e2e). Anti-collision (a standby / bring-up-phase independent primary must
  // never WRITE here) is enforced by the wal-g role WRITE-GUARD: the role file
  // (walg-role.js), which wal-archive.sh and the backup CronJob read through
  // walg-env.sh. Neither archives unless it says primary.
  //
  // wal-g talks to the bucket it archives into at THAT bucket's endpoint and
  // region (the statefulset's S3_ENDPOINT / S3_REGION tokens): the backups
  // target's own when there is one, which an environment an older CLI put in
  // another region's bucket keeps; else the storage bucket's.
  const walgStore = backupTarget?.bucket ? backupTarget : s3Config;
  const walgBucket = walgStore?.bucket || '';
  // The path inside the bucket is resolveEnvStorage's per-environment
  // `backups/<project>/<env>/walg`. Without it two environments would archive
  // into one stream, so a bucket with no prefix is an error, not a default.
  const walgPrefix = s3Config?.walgPrefix;
  if (walgBucket && !walgPrefix) {
    throw new Error(
      'buildDbManifestValues: s3Config.walgPrefix is required with a bucket (resolveEnvStorage supplies it)',
    );
  }
  return {
    DB_IMAGE: dbImageTag.slice(0, lastColon),
    DB_IMAGE_TAG: dbImageTag.slice(lastColon + 1),
    WALG_S3_PREFIX_BASE: walgBucket ? `s3://${walgBucket}/${walgPrefix}` : '',
    S3_ENDPOINT: walgStore?.endpoint ?? '',
    S3_REGION: walgStore?.region ?? '',
    K8S_STORAGE_CLASS: storageClass,
    WAL_ARCHIVE_SHA: walArchiveSha || 'none',
  };
}

/**
 * The sha the db pod template records for the wal-archive ConfigMap
 * (`vibecarbon.dev/wal-archive-sha`). The hash covers the WHOLE ConfigMap
 * file rather than just the script body: it needs no YAML parsing, cannot
 * drift from how the file is applied, and the only cost of the extra breadth
 * is one db roll if someone edits a comment in that file.
 *
 * @param {string} projectDir
 * @returns {string} 16 hex chars, or '' when the file is absent
 */
export function walArchiveConfigSha(projectDir) {
  const cmPath = join(projectDir, 'k8s/base/backup/configmap-walg.yaml');
  if (!existsSync(cmPath)) return '';
  return createHash('sha256').update(readFileSync(cmPath)).digest('hex').slice(0, 16);
}

/**
 * Ground-truth RLS audit for the k8s path (see src/lib/deploy/rls-audit.js),
 * against the live catalog once the app has migrated it: the app applies
 * db/migrations itself at startup (carbon/src/server/db/migrate.ts), and
 * awaitAppAdminReady waits for `migrationStatus: 'applied'` before this
 * runs. THROWS (failing the deploy) when any public table lacks RLS.
 *
 * @param {{kubeconfig: string}} args
 */
export async function auditRls({ kubeconfig }) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  // Ground-truth RLS audit (see src/lib/deploy/rls-audit.js): query the live
  // catalog and refuse to proceed if any public table reached the schema
  // without row-level security — RLS is what scopes every query the app runs
  // on a user's behalf, so an un-RLS'd table hands every signed-in user every
  // row regardless of how it was created (migration, hand edit, dependency).
  const auditOut = await runCommandAsync(
    [
      'kubectl',
      '-n',
      'vibecarbon',
      'exec',
      '-i',
      DB_POD,
      '-c',
      DB_CONTAINER,
      '--',
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-tAc',
      RLS_AUDIT_SQL,
    ],
    { env, silent: true, timeout: POD_EXEC_QUERY_MS },
  );
  // runCommandAsync(silent) resolves the stdout string directly.
  const unprotected = String(auditOut ?? '').trim();
  if (unprotected) {
    throw new Error(`auditRls: ${rlsAuditFailureMessage(unprotected)}`);
  }
}

/**
 * The deploy's live wal-g role write: the intent (vibecarbon-db-role) and the
 * role file in the running db container, through setK8sWalgRole. deployK3s
 * runs it on every deploy, outside the k3s-apply skip gate and once the db is
 * up, so a redeploy that did not restart the db
 * (or skipped the apply altogether) still converges the file. A deploy whose
 * role vibecarbon-db-role already proves does not exec at all (recordLive; the
 * header of walg-role.js says why that is sound). Throws when the
 * file does not read back the role, which fails the deploy: a db whose role
 * file is wrong would hold or drop WAL behind a green deploy. The errors are
 * the deploy's own: a missing role mount after the rollout is a template that
 * did not land, never a hint to run a deploy; the other reasons keep
 * setK8sWalgRole's detail.
 *
 * @param {object} o
 * @param {(ip: string, argv: string[], opts?: {input?: string, timeout?: number}) => Promise<string>} o.kubectl
 * @param {'primary'|'standby'} o.role
 * @param {string} [o.envName] the environment as the operator names it
 * @returns {Promise<{intent: true, live: boolean}>}
 */
export async function writeDeployWalgRole({ kubectl, role, envName }) {
  const result = await setK8sWalgRole({
    ip: undefined,
    kubectl,
    role,
    envName,
    recordLive: true,
  });
  if (result.live) return result;
  // setK8sWalgRole's own no-role-mount hint says to run a deploy; this IS the
  // deploy, after a rollout of the template that carries the mount, so the
  // missing mount means the rollout did not land on db-0.
  if (result.reason === 'no-role-mount') {
    throw new Error(
      `the db rollout did not give ${DB_POD} the wal-g role mount (${WALG_ROLE_DIR}); ` +
        `check the db StatefulSet template and \`kubectl -n vibecarbon get pod ${DB_POD} -o yaml\``,
    );
  }
  const detail = result.error ? `: ${result.error.message}` : '';
  throw new Error(
    `could not set the wal-g role to ${role} on ${DB_POD} (${result.reason})${detail}`,
  );
}

/**
 * writeDeployWalgRole's kubectl seam for the operator's own kubectl: the
 * `(ip, argv, {input, timeout})` shape setK8sWalgRole takes, over
 * runKubectlWithRetry with stdout captured. The ip is unused (the kubeconfig
 * names the cluster); the timeout bounds the call through an abort signal.
 *
 * @param {string} kubeconfig
 * @returns {(ip: string, argv: string[], opts?: {input?: string, timeout?: number}) => Promise<string>}
 */
function localWalgRoleKubectl(kubeconfig) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  return (_ip, argv, { input, timeout } = {}) =>
    runKubectlWithRetry(argv, {
      env,
      input,
      captureStdout: true,
      description: `deploy: kubectl ${argv.slice(2, 5).join(' ')} (wal-g role)`,
      ...(timeout && { signal: AbortSignal.timeout(timeout) }),
    });
}

/**
 * Ground-truth BACKUP audit for the k8s path — the kubectl-exec twin of the
 * `docker compose exec` probe compose/index.js runs inside runDatabaseAudits.
 * Same probe string, same pure evaluator, same failure message; only the exec
 * seam differs. See src/lib/deploy/walg-audit.js for why its in-container listing
 * is the load-bearing signal and why a standby / unconfigured node skips.
 *
 * THROWS (failing the deploy) when wal-g cannot reach the configured storage.
 * `runCommandAsync(silent)` rejects on a non-zero exit, which the audit's own
 * retry budget absorbs and then reports as a probe-exec failure — so a db pod
 * that can't be exec'd into is loud rather than silently skipped.
 *
 * @param {{kubeconfig: string, dbPod?: string}} args
 */
export async function verifyWalgBackups({ kubeconfig, dbPod = DB_POD }) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  await assertWalgBackupsWorking({
    path: 'k8s',
    probe: async () => {
      const out = await runCommandAsync(['kubectl', ...k8sWalgAuditArgv(dbPod)], {
        env,
        silent: true,
        // Bound the exec the same way the compose probe is bounded. Without it
        // a wedged `kubectl exec` (unreachable apiserver, a pod stuck
        // Terminating) hangs the deploy indefinitely instead of failing into
        // the audit's own retry budget. The probe itself is one S3 LIST plus a
        // catalog read — seconds, not minutes.
        timeout: WALG_AUDIT_PROBE_TIMEOUT_MS,
      });
      return typeof out === 'string' ? out : '';
    },
  });
}

/**
 * Resolve every `{{K8S_STORAGE_CLASS}}` placeholder a kustomize directory's
 * manifests ship (observability's loki/grafana/prometheus PVCs today; any
 * future PVC-bearing addon that adopts the same placeholder) into a FRESH
 * TEMP COPY of that directory, leaving the project's own checked-in files
 * on disk untouched.
 *
 * Why a temp copy and not an in-place rewrite (M3 Task 4): a PVC's
 * `spec.storageClassName` is immutable once the object is created — the API
 * server rejects any later patch — so the placeholder MUST be resolved
 * BEFORE `kubectl apply` ever creates the object, unlike the mutable-field
 * placeholders below (cert-manager domain, carbon-autoscaler image) that
 * get `kubectl patch`ed AFTER apply. And it must not overwrite the
 * project's own tracked files (a redeploy would otherwise leave the
 * operator's git working tree permanently dirty). renderK8sBase applies the
 * same rule to `k8s/base` and the db StatefulSet.
 *
 * RECURSIVE since 2026-08-06. It was flat, and its own note said "a future
 * addon that needs one would need this extended" — which had already happened
 * without anyone noticing: `add redis` / `add n8n` copy their PVCs into
 * `k8s/base/<addon>/`, a SUBDIRECTORY of the tree applied by
 * the k8s/base apply, and that apply never went through this
 * renderer at all. The literal `{{K8S_STORAGE_CLASS}}` therefore reached the
 * API server, which accepts it (storageClassName is a free-form reference,
 * never DNS-1123-validated) and leaves the PVC Pending forever.
 *
 * @param {string} dir - Source kustomize directory (e.g.
 *   `${projectDir}/k8s/base/observability`)
 * @param {string} storageClass - `ProviderClass.K8S_STORAGE_CLASS`
 * @returns {string} Path to the rendered temp copy — pass this to
 *   applyKustomization instead of `dir`.
 */
export function renderK8sStorageClassPlaceholder(dir, storageClass) {
  // Fail loudly up front: k8s gives NO natural error for a bad value here.
  // A leftover `{{K8S_STORAGE_CLASS}}` is accepted by kubectl (free-form
  // reference, never DNS-1123-validated) and the PVC sits Pending forever;
  // an EMPTY value silently binds the cluster's default StorageClass —
  // a semantic change, not an error. This render is the only safety net
  // (T4 review).
  if (!storageClass) {
    throw new Error(
      'renderK8sStorageClassPlaceholder: unresolved placeholder target; ProviderClass.K8S_STORAGE_CLASS is empty',
    );
  }
  return renderK8sPlaceholders(dir, { K8S_STORAGE_CLASS: storageClass }, 'storageclass');
}

/**
 * Copy a kustomize directory tree into a fresh temp dir, replacing every
 * `{{KEY}}` for each KEY in `values` (recursively, every file). The source
 * tree is never modified. Keys not in `values` are left as they are.
 *
 * @param {string} dir
 * @param {Record<string, string>} values
 * @param {string} label - lands in the temp dir's name, for logs
 * @returns {string} the rendered temp copy
 */
function renderK8sPlaceholders(dir, values, label) {
  // Prefix carries the source dir's basename (e.g. `observability`) so the
  // rendered path stays recognizable in `kubectl` error output/logs, and so
  // any argv/log matching on the addon name (e.g. tests asserting the
  // observability apply ran) still finds it after the path swap.
  const tmpDir = makeTempDir(`vibecarbon-k8s-${label}-${basename(dir)}-`);
  const entries = Object.entries(values);
  const copyInto = (srcDir, destDir) => {
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        copyInto(srcPath, destPath);
        continue;
      }
      let content = readFileSync(srcPath, 'utf-8');
      for (const [key, value] of entries) {
        const token = `{{${key}}}`;
        if (content.includes(token)) content = content.replaceAll(token, value);
      }
      writeFileSync(destPath, content);
    }
  };
  try {
    copyInto(dir, tmpDir);
  } catch (err) {
    removeTempDir(tmpDir);
    throw err;
  }
  return tmpDir;
}

/**
 * Copy `k8s/infra/traefik-crds` with its Traefik tag filled in.
 *
 * @param {string} dir
 * @returns {string} the rendered temp copy to pass to applyKustomization
 */
export function renderTraefikCrds(dir) {
  return renderK8sPlaceholders(dir, manifestImageValues(), 'crds');
}

/** The in-cluster registry manifest, relative to `k8s/base`. */
const REGISTRY_MANIFEST = 'registry/local-registry.yaml';
/** The Traefik Deployment, relative to `k8s/base`. */
const TRAEFIK_MANIFEST = 'traefik/deployment.yaml';

/** The vibecarbon-tls Certificate, relative to `k8s/base`. */
const CERTIFICATE_MANIFEST = 'traefik/certificate.yaml';

/**
 * Strategic-merge patch that binds a k8s-ha cluster's postgres to
 * `127.0.0.1:REPL_PORT` (hostPort + hostIP) -> containerPort 5432 on its
 * database node. The primary repl-gateway (hostNetwork socat) relays tunnel
 * traffic to `127.0.0.1:REPL_PORT`; this hostPort IS that local listener, and
 * its only consumer. `hostIP: '127.0.0.1'` is what makes "localhost-only"
 * true: a hostPort with no hostIP is published on EVERY node address (public
 * and private), leaving the cloud firewall (which admits only WG udp/51821)
 * as the sole barrier. One db pod per node (StatefulSet), so the node's
 * :REPL_PORT is uncontended. Enforced by
 * tests/unit/deploy/hostport-binding-census.test.ts.
 *
 * Kept out of k8s/base/db/statefulset.yaml itself: only an HA cluster needs
 * the node port, and a single cluster's db stays cluster-internal. Keyed by
 * container `name` + port `containerPort`/`protocol`, so it updates the
 * existing port entry in place (adds hostPort + hostIP) rather than appending
 * a duplicate.
 * @returns {object}
 */
export function buildDbHostPortPatch() {
  return {
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: DB_CONTAINER,
              // `protocol` is part of kustomize's merge key for ports: a
              // patch entry without it matches nothing and is DROPPED
              // silently (kubectl kustomize v5.7), so the db would render
              // with no hostPort at all.
              ports: [
                { containerPort: 5432, protocol: 'TCP', hostPort: REPL_PORT, hostIP: '127.0.0.1' },
              ],
            },
          ],
        },
      },
    },
  };
}

/**
 * Whether this cluster's db StatefulSet is rendered with the replication
 * hostPort: every k8s-ha cluster, primary AND standby; never a single
 * cluster (role undefined).
 *
 * WHY at render time, on both roles (DO e2e 2026-11-01, d4): the hostPort
 * used to be `kubectl patch`ed into the primary's running StatefulSet by
 * configurePrimaryForReplication, about a minute after the db's first volume
 * attach. The patch recreated db-0, so the volume detached and re-attached on
 * the same node within seconds, which is the churn that trips the DO CSI
 * stale-attachment state (docs/mitigations.yml
 * `do-csi-stale-volumeattachment`): kubelet looped mkfs on a device that never
 * appeared and the primary db never came back. Rendered here, the
 * StatefulSet is created once with it. The standby gets it too, so a
 * failover's promoted cluster is already a complete primary and no redeploy
 * ever restarts a serving database to add it. On the standby it is unused
 * and binds only the node's loopback.
 *
 * @param {'primary'|'standby'|undefined} role
 * @returns {boolean}
 */
export function rendersReplicationHostPort(role) {
  return role === 'primary' || role === 'standby';
}

/** The rendered db/ kustomize patch file carrying buildDbHostPortPatch. */
const DB_HOSTPORT_PATCH_FILE = 'replication-hostport.patch.json';

/**
 * Add buildDbHostPortPatch to a RENDERED k8s/base copy as a kustomize patch
 * of `db/`, so applyKustomization creates the StatefulSet with it. Refuses a
 * db/kustomization.yaml that already declares patches rather than guess how
 * to merge into an operator's own list.
 *
 * @param {string} rendered - renderK8sPlaceholders' temp copy of k8s/base
 */
function addDbReplicationHostPort(rendered) {
  const kustomization = join(rendered, 'db', 'kustomization.yaml');
  if (!existsSync(kustomization)) {
    throw new Error(
      'renderK8sBase: k8s/base/db/kustomization.yaml is missing, so the k8s-ha replication ' +
        'hostPort cannot be added to the db StatefulSet. Run `vibecarbon upgrade` to restore it.',
    );
  }
  const text = readFileSync(kustomization, 'utf-8');
  if (/^(patches|patchesStrategicMerge|patchesJson6902):/m.test(text)) {
    throw new Error(
      'renderK8sBase: k8s/base/db/kustomization.yaml already declares patches, so the ' +
        'k8s-ha replication hostPort cannot be added to the db StatefulSet. Move those ' +
        'patches elsewhere, or run `vibecarbon upgrade` to restore the shipped file.',
    );
  }
  const patch = {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: DB_STATEFULSET },
    ...buildDbHostPortPatch(),
  };
  writeFileSync(
    join(rendered, 'db', DB_HOSTPORT_PATCH_FILE),
    `${JSON.stringify(patch, null, 2)}\n`,
  );
  writeFileSync(
    kustomization,
    `${text.replace(/\n*$/, '\n')}\n# k8s-ha: the replication hostPort, added at render time (renderK8sBase).\npatches:\n  - path: ${DB_HOSTPORT_PATCH_FILE}\n`,
  );
}

/**
 * Render `k8s/base` for apply: every db StatefulSet placeholder
 * (buildDbManifestValues) plus `{{K8S_STORAGE_CLASS}}`, which the db's
 * volumeClaimTemplate and the add-on PVCs `add redis` / `add n8n` copy into
 * `k8s/base/<addon>/` share, and the registry's `{{MASTER_PRIVATE_IP}}`
 * (the one address its hostPort binds), into a temp copy of the tree.
 *
 * Always a temp copy, never an in-place rewrite: the placeholders must be
 * resolved BEFORE `kubectl apply` creates the objects (a StatefulSet's
 * volumeClaimTemplates and a PVC's storageClassName are immutable), and a
 * redeploy must not leave the operator's git working tree dirty.
 *
 * Refuses the result when `db/statefulset.yaml` still carries ANY
 * `{{PLACEHOLDER}}`: the API server accepts a literal image or StorageClass
 * name and fails much later and much less clearly (InvalidImageName, a PVC
 * Pending forever) — and the volumeClaimTemplate cannot be fixed afterwards.
 * A project whose base predates the db StatefulSet (no `db/` at all) is
 * refused too: without it nothing would ever create the database.
 *
 * The vibecarbon-tls Certificate is rendered too (renderTlsCertificateManifest),
 * so cert-manager never sees the `app.example.com` placeholder: a rendered
 * Certificate that still names it is refused, and a missing `tls` throws.
 *
 * On a k8s-ha cluster (`replicationHostPort`), the db StatefulSet also gets
 * its replication hostPort (buildDbHostPortPatch) as a kustomize patch in the
 * rendered `db/`, so the StatefulSet is CREATED with it and never has to be
 * restarted to gain it (see rendersReplicationHostPort).
 *
 * @param {string} dir - the project's `k8s/base`
 * @param {Record<string, string>} values - buildDbManifestValues' output
 * @param {{schedule?: string, retentionDays?: number}} [backupConfig]
 * @param {{ dnsNames: string[], issuerName: string, effectiveIssuer: string }} tls
 * @param {{ replicationHostPort?: boolean }} [opts]
 * @returns {string} the rendered temp copy to pass to applyKustomization
 */
export function renderK8sBase(
  dir,
  values,
  backupConfig,
  tls,
  { replicationHostPort = false } = {},
) {
  if (!tls?.dnsNames?.length || !tls.issuerName || !tls.effectiveIssuer) {
    throw new Error(
      'renderK8sBase: no TLS certificate to render (dnsNames, issuerName, effectiveIssuer)',
    );
  }
  if (!values?.K8S_STORAGE_CLASS) {
    throw new Error('renderK8sBase: K8S_STORAGE_CLASS is empty, refusing to render the db PVC');
  }
  const sourceSts = join(dir, 'db', 'statefulset.yaml');
  if (!existsSync(sourceSts)) {
    throw new Error(
      `renderK8sBase: ${sourceSts} is missing. This project's k8s/base predates the db ` +
        'StatefulSet; run `vibecarbon upgrade` to bring the k8s manifests up to date.',
    );
  }
  // The registry's hostPort binds only this address (hostIP). A missing
  // value would render the literal `undefined`, and a hostIP that is not an
  // address of the master leaves every node's image pull with nothing to dial.
  const hasRegistry = existsSync(join(dir, REGISTRY_MANIFEST));
  if (hasRegistry && !isIPv4(values.MASTER_PRIVATE_IP ?? '')) {
    throw new Error(
      `renderK8sBase: MASTER_PRIVATE_IP is not an IPv4 address (got ${JSON.stringify(values.MASTER_PRIVATE_IP ?? null)}), so the registry hostPort has no address to bind`,
    );
  }
  // The image tokens are the deploy's version set (images.js), never the
  // caller's: there is one set per deploy.
  const rendered = renderK8sPlaceholders(dir, { ...values, ...manifestImageValues() }, 'base');
  try {
    completeK8sBase(rendered, { backupConfig, tls, replicationHostPort, hasRegistry });
  } catch (err) {
    removeTempDir(rendered);
    throw err;
  }
  return rendered;
}

/**
 * renderK8sBase's work on its fresh copy: the backup schedule, the replication
 * hostPort, the TLS Certificate, then the leftover-placeholder checks. Throws
 * on a placeholder it would otherwise apply; renderK8sBase removes the copy.
 *
 * @param {string} rendered
 * @param {{ backupConfig?: object, tls: object, replicationHostPort: boolean, hasRegistry: boolean }} opts
 */
function completeK8sBase(rendered, { backupConfig, tls, replicationHostPort, hasRegistry }) {
  // The backup CronJob's schedule is per environment (deploy-owned, Flux does
  // not build it): filled in by the renderer deploy.yml also runs.
  const cronjob = join(rendered, 'backup', 'cronjob.yaml');
  if (existsSync(cronjob)) {
    writeFileSync(
      cronjob,
      renderBackupCronJob(readFileSync(cronjob, 'utf-8'), resolveBackupSettings(backupConfig)),
    );
  }
  if (replicationHostPort) addDbReplicationHostPort(rendered);
  // The TLS Certificate is deploy-owned (Flux does not build it): rendered
  // with this deploy's names and issuer, so cert-manager never sees the
  // base's app.example.com placeholder, and a Secret restored before this
  // apply already matches it.
  mkdirSync(join(rendered, 'traefik'), { recursive: true });
  writeFileSync(join(rendered, CERTIFICATE_MANIFEST), renderTlsCertificateManifest(tls));
  const checks = [
    ...(existsSync(cronjob)
      ? [['backup/cronjob.yaml', 'a backup CronJob with an unresolved schedule or image']]
      : []),
    ['db/statefulset.yaml', 'a database with an unresolved image, prefix or StorageClass'],
    ...(hasRegistry
      ? [[REGISTRY_MANIFEST, 'a registry with an unresolved image or bind address']]
      : []),
    ...(existsSync(join(rendered, TRAEFIK_MANIFEST))
      ? [[TRAEFIK_MANIFEST, 'a Traefik with an unresolved image']]
      : []),
    [CERTIFICATE_MANIFEST, 'a placeholder TLS Certificate', /app\.example\.com/g],
  ];
  for (const [file, what, pattern = /\{\{[A-Z0-9_]+\}\}/g] of checks) {
    const leftover = readFileSync(join(rendered, file), 'utf-8').match(pattern);
    if (leftover) {
      throw new Error(
        `renderK8sBase: ${file} still carries ${[...new Set(leftover)].join(', ')} after rendering; ` +
          `refusing to apply ${what}.`,
      );
    }
  }
}

/**
 * Render the S3-egress-VPC-allowance manifest (M3 Task 9c —
 * `carbon/k8s/base/s3-egress-vpc/s3-egress-vpc.yaml`): substitute every
 * `__VPC_CIDR__` placeholder with the given CIDR. Mirrors
 * `renderReplGatewayManifest`'s (deploy/k8s/ha/index.js) placeholder-
 * substitution shape — resolved at apply time, never left for runtime.
 *
 * The template supports exactly ONE extra CIDR today (one `__VPC_CIDR__`
 * token per policy) — DigitalOceanProvider.getS3EgressExtraCidrs only ever
 * returns a single-element array (DO has one VPC per cluster). Throws
 * loudly rather than silently dropping entries if a future provider's
 * getS3EgressExtraCidrs ever returns more than one — extend the template
 * (repeat the `- ipBlock:` entry per policy) before wiring in a provider
 * that needs it.
 *
 * @param {string} template - the raw s3-egress-vpc.yaml
 * @param {string[]} vpcCidrs - non-empty; from
 *   `ProviderClass.getS3EgressExtraCidrs(vpcCidr)`
 * @returns {string}
 */
export function renderS3EgressVpcManifest(template, vpcCidrs) {
  if (!Array.isArray(vpcCidrs) || vpcCidrs.length === 0) {
    throw new Error('renderS3EgressVpcManifest: vpcCidrs must be a non-empty array');
  }
  if (vpcCidrs.length > 1) {
    throw new Error(
      `renderS3EgressVpcManifest: got ${vpcCidrs.length} extra CIDRs but s3-egress-vpc.yaml ` +
        'supports exactly one __VPC_CIDR__ per policy, extend the template first',
    );
  }
  return template.replaceAll('__VPC_CIDR__', vpcCidrs[0]);
}

// The isolated observability stack's namespace (services/observability/k8s).
const OBSERVABILITY_NAMESPACE = 'vibecarbon-observability';

/**
 * Pilot-light standby: hold every declared add-on workload at zero. Each
 * `{kind, name, namespace}` (from `k8sStandbyZeroedWorkloads`) that exists is
 * scaled to 0 with `kubectl scale`, never a patch (the HA ruling: a patch or
 * set image would roll pods); one that does not exist (an add-on namespace
 * never applied on this cluster) is skipped. The pod templates stay as
 * applied, so a promotion only scales them back up.
 *
 * @param {{ env: Record<string, string|undefined>, workloads: Array<{kind: string, name: string, namespace: string}>, kubectl?: typeof runKubectlWithRetry }} args
 * @returns {Promise<string[]>} the workload names it zeroed
 */
export async function zeroWorkloadsOnStandby({ env, workloads, kubectl = runKubectlWithRetry }) {
  const zeroed = [];
  for (const { kind, name, namespace } of workloads) {
    const type = kind.toLowerCase();
    const found = String(
      (await kubectl(['-n', namespace, 'get', type, name, '--ignore-not-found', '-o', 'name'], {
        env,
        captureStdout: true,
        description: `applyK3sManifests: look for ${namespace}/${name} (pilot standby)`,
      })) ?? '',
    ).trim();
    if (!found) continue;
    await kubectl(['-n', namespace, 'scale', type, name, '--replicas=0'], {
      env,
      description: `applyK3sManifests: zero ${namespace}/${name} (pilot standby)`,
    });
    zeroed.push(name);
  }
  if (zeroed.length > 0) console.error(`[pilot-standby] zeroed ${zeroed.join(', ')}`);
  return zeroed;
}

/**
 * Pilot-light standby: settle an observability stack left from this
 * cluster's primary life. The stack's Deployments are zeroed by
 * zeroWorkloadsOnStandby from the declaration when the add-on is in the
 * project tree; `leftoverWorkloads` are the namespace's declared Deployments
 * that list did not cover (the add-on left the tree but its stack is still on
 * the cluster), zeroed here once the namespace is found. The retired
 * grafana-tls Certificate and Secret go too (one certificate per name, see
 * ./one-certificate.js). No-op when the namespace is absent, which is every
 * freshly deployed standby.
 *
 * @param {{ env: Record<string, string|undefined>, leftoverWorkloads?: Array<{kind: string, name: string, namespace: string}>, kubectl?: typeof runKubectlWithRetry }} args
 * @returns {Promise<boolean>} true when a leftover stack's namespace was found
 */
export async function settleObservabilityOnStandby({
  env,
  leftoverWorkloads = [],
  kubectl = runKubectlWithRetry,
}) {
  const ns = String(
    (await kubectl(
      ['get', 'namespace', OBSERVABILITY_NAMESPACE, '--ignore-not-found', '-o', 'name'],
      {
        env,
        captureStdout: true,
        description: 'applyK3sManifests: look for a leftover observability namespace (standby)',
      },
    )) ?? '',
  ).trim();
  if (!ns) return false;
  await zeroWorkloadsOnStandby({ env, workloads: leftoverWorkloads, kubectl });
  await removeRetiredObservabilityCertificate({ env, kubectl });
  return true;
}

/**
 * Refuse an incomplete `deploy -restore` point before deployK3s does anything
 * (C5): the orchestrator resolves it (resolveDeployRestorePoint) and passes
 * the object; a raw flag value or a partial object means a caller skipped
 * that resolution. Null (no restore) passes.
 *
 * @param {{ restore: unknown }} args
 */
export function assertDeployRestorePoint({ restore }) {
  if (restore === null || restore === undefined) return;
  const ok =
    typeof restore === 'object' &&
    BACKUP_NAME_RE.test(String(restore.backup ?? '')) &&
    typeof restore.target === 'string' &&
    restore.target !== '' &&
    typeof restore.recoveryConf === 'string' &&
    restore.recoveryConf !== '' &&
    Number.isFinite(restore.sizeBytes) &&
    RESTORE_ATTEMPT_RE.test(String(restore.attempt ?? '')) &&
    LINEAGE_RE.test(String(restore.lineage ?? ''));
  if (!ok) {
    throw new Error(
      'deployK3s: incomplete restore point. Expected { backup, target, recoveryConf, sizeBytes, attempt, lineage } ' +
        'resolved from the backup bucket (resolveDeployRestorePoint) before the deploy starts',
    );
  }
}

/** The kubectl patch that clears the k8s restore marker, for operator messages. */
function clearMarkerCommand() {
  return `kubectl -n vibecarbon patch secret vibecarbon-infra-secrets --type=merge -p '${JSON.stringify({ stringData: restoreMarkerStringData(null) })}'`;
}

/** The restore marker on vibecarbon-infra-secrets, decoded; {} when unset or absent. */
async function readRestoreMarker(env) {
  const out = await runKubectlWithRetry(
    [
      '-n',
      'vibecarbon',
      'get',
      'secret',
      'vibecarbon-infra-secrets',
      '--ignore-not-found',
      '-o',
      'jsonpath={.data}',
    ],
    { env, captureStdout: true, description: 'assertRestoreMarkerState: read the restore marker' },
  );
  const text = String(out ?? '').trim();
  const data = text ? JSON.parse(text) : {};
  const get = (k) => (data[k] ? Buffer.from(data[k], 'base64').toString('utf8') : '');
  return {
    backup: get('RESTORE_BACKUP'),
    target: get('RESTORE_TARGET'),
    attempt: get('RESTORE_ATTEMPT'),
    origin: get('RESTORE_ORIGIN'),
    lineage: get('RESTORE_LINEAGE'),
  };
}

/**
 * Whether a pending restore has already swapped its copy into PGDATA, read
 * from the db pod: 'swapped' (the attempt record names it, or the database
 * from before sits in .vc-prev), 'not-swapped', or 'unknown' (the pod could
 * not be exec'd, e.g. it is stuck in its init). `previous` says whether
 * .vc-prev exists.
 */
async function readRestoreSwapState(env, marker) {
  const record = `${PGDATA_PATH}/${RESTORE_LAYOUT.restoredFrom}`;
  // VC_OK last: a probe cut short (no sentinel) proves nothing and reads as
  // unknown, never as "nothing swapped in".
  const probe =
    `if [ -d ${PREVIOUS_PGDATA_PATH} ]; then echo prev; fi; ` +
    `if [ -d ${DISCARD_PGDATA_PATH} ]; then echo discard; fi; ` +
    `if [ -e ${PGDATA_PATH}/${RESTORE_LAYOUT.inProgress} ]; then echo swapping; fi; ` +
    `if [ -f ${record} ]; then printf 'record %s\\n' "$(cat ${record})"; fi; ` +
    'echo VC_OK';
  let out;
  try {
    out = await runCommandAsync(
      ['kubectl', '-n', 'vibecarbon', 'exec', DB_POD, '-c', DB_CONTAINER, '--', 'sh', '-c', probe],
      { env, silent: true, timeout: POD_EXEC_PROBE_MS },
    );
  } catch {
    return { state: 'unknown', previous: false };
  }
  const lines = String(out ?? '')
    .split('\n')
    .map((l) => l.trim());
  if (!hasSentinelLine(out, 'VC_OK')) return { state: 'unknown', previous: false };
  const previous = lines.includes('prev');
  const recorded =
    Boolean(marker.attempt) && lines.includes(`record ${marker.backup} ${marker.attempt}`);
  // This attempt swapped in, .vc-prev is gone and .vc-discard holds it, with
  // no swap in progress: the CLI proved the copy writable and retired the
  // database from before (RETIRE_PREVIOUS_SH), then stopped before the
  // marker clear (finishDeployRestore, or runK8sRestore).
  if (recorded && !previous && lines.includes('discard') && !lines.includes('swapping')) {
    return { state: 'retired', previous: false };
  }
  return { state: previous || recorded ? 'swapped' : 'not-swapped', previous };
}

/**
 * What the cluster's restore marker (vibecarbon-infra-secrets) lets this
 * deploy do. Read-only; runs in deployK3s once the cluster answers, outside
 * every step gate.
 *
 * - A plain deploy refuses while a restore is pending (I1): the walg-restore
 *   init restores on every db pod start while the marker is set, so leaving
 *   it would hand the restore to the next drain or OOM, unproven, and an
 *   apply could drop the key and abandon it silently. It names the command
 *   that finishes THAT attempt (deploy -restore for one deploy set,
 *   vibecarbon restore for one vibecarbon restore set; the base for 'latest',
 *   else the target). It offers the abandon command only when nothing was
 *   swapped in yet: once a copy is in, clearing the marker would boot it
 *   unproven, with the database from before in .vc-prev (N2 ruling).
 * - `deploy -restore` seeds a NEW database: on a cluster whose db StatefulSet
 *   already runs, nothing reboots the pod, so the deploy would report a
 *   restore that never happened. It refuses, unless the marker is this same
 *   restore (base and target), a rerun finishing it.
 *
 * @param {{ env: NodeJS.ProcessEnv, restore: { backup: string, target: string } | null, operatorEnv: string }} args
 */
export async function assertRestoreMarkerState({ env, restore, operatorEnv }) {
  const marker = await readRestoreMarker(env);
  if (!restore) {
    if (!marker.backup) return;
    const point = marker.target && marker.target !== 'latest' ? marker.target : marker.backup;
    // The lineage folder the attempt reads, so the rerun reads the same one.
    const lineage = marker.lineage ? ` -lineage ${marker.lineage}` : '';
    const finish =
      marker.origin === 'deploy'
        ? [`  vibecarbon deploy ${operatorEnv} -restore ${point}${lineage}`]
        : marker.origin === 'restore'
          ? [`  vibecarbon restore ${operatorEnv} -source ${point}${lineage}`]
          : [
              `  vibecarbon restore ${operatorEnv} -source ${point}${lineage}`,
              `(or, on an environment deploy -restore was bringing up: vibecarbon deploy ${operatorEnv} -restore ${point}${lineage})`,
            ];
    const { state, previous } = await readRestoreSwapState(env, marker);
    const before = previous
      ? `the database from before is kept in ${PREVIOUS_PGDATA_PATH}`
      : 'there was no database before it';
    const head = [
      `a restore of ${marker.backup} (target ${marker.target || 'latest'}) is pending on this cluster (the marker on vibecarbon-infra-secrets).`,
      state === 'retired'
        ? 'A plain deploy stops here until the marker is cleared.'
        : 'A plain deploy would leave it to the next db pod start, unproven, so it stops here.',
    ];
    const lines =
      state === 'not-swapped'
        ? [
            ...head,
            'Finish the restore:',
            ...finish,
            'or, since nothing was swapped in yet, abandon it (the database keeps what it holds now):',
            `  ${clearMarkerCommand()}`,
          ]
        : state === 'retired'
          ? [
              ...head,
              'The restored copy was proven writable and the database from before it was retired; ' +
                'only clearing the marker did not finish. Clear it, then remove the retired copy:',
              `  ${clearMarkerCommand()}`,
              `  kubectl -n vibecarbon exec ${DB_POD} -c ${DB_CONTAINER} -- sh -c '${REMOVE_DISCARD_SH}'`,
            ]
          : state === 'swapped'
            ? [
                ...head,
                `The restored copy is already swapped in, unproven, and ${before}.`,
                'Clearing the marker would boot the restored copy as if it were proven, so finish the restore:',
                ...finish,
              ]
            : [
                ...head,
                'Could not read the db pod to tell whether the restored copy was swapped in. Finish the restore:',
                ...finish,
                'If nothing was swapped in yet, it can be abandoned instead:',
                `  ${clearMarkerCommand()}`,
                `If it was, clearing the marker boots the restored copy unproven, and the database from before (if any) is in ${PREVIOUS_PGDATA_PATH}.`,
              ];
    throw new Error(lines.join('\n'));
  }
  const sts = await runKubectlWithRetry(
    ['-n', 'vibecarbon', 'get', 'statefulset', DB_STATEFULSET, '--ignore-not-found', '-o', 'name'],
    { env, captureStdout: true, description: 'assertRestoreMarkerState: get the db StatefulSet' },
  );
  if (!String(sts ?? '').trim()) return;
  if (marker.backup === restore.backup && marker.target === restore.target) return;
  throw new Error(
    [
      `deploy -restore seeds a new database, and this cluster already runs one (statefulset/${DB_STATEFULSET}).`,
      'Restore into the running environment:',
      `  vibecarbon restore ${operatorEnv} -source ${restore.target !== 'latest' ? restore.target : restore.backup}${restore.lineage ? ` -lineage ${restore.lineage}` : ''}`,
      'or destroy it first and run deploy -restore again.',
    ].join('\n'),
  );
}

/** psql in the db pod as postgres, through the deploy's kubeconfig. */
function dbPsql(env) {
  return async (sql, { readWrite = false } = {}) =>
    String(
      (await runCommandAsync(
        [
          'kubectl',
          '-n',
          'vibecarbon',
          'exec',
          DB_POD,
          '-c',
          DB_CONTAINER,
          '--',
          ...(readWrite ? ['env', `PGOPTIONS=${READ_WRITE_PGOPTIONS}`] : []),
          'psql',
          '-U',
          'postgres',
          '-tAc',
          sql,
        ],
        { env, silent: true, timeout: POD_EXEC_QUERY_MS },
      )) ?? '',
    );
}

/**
 * Finish a `deploy -restore` once the db rollout is Ready: the restored
 * primary must have left recovery and prove writable (only 'writable' or
 * 'lifted' is a proof). Then, as `vibecarbon restore` does: rename the
 * previous cluster out of `.vc-prev` (a fresh cluster has none: the swap
 * leaves no empty one), clear the marker so a later pod restart boots
 * normally, and remove the discard.
 *
 * On an unproven write fence the marker stays set and the error names the
 * commands that finish by hand.
 *
 * @param {{ env: NodeJS.ProcessEnv, restore: { backup: string }, environment?: string }} args
 */
export async function finishDeployRestore({ env, restore, environment, operatorEnv }) {
  await awaitPostgresPromoted({ env, dbPod: DB_POD, dbContainer: DB_CONTAINER });
  // The orchestrator already refused an HA deploy with a failover in flight.
  const proof = await assertRestoredPrimaryWritable({
    environment,
    envConfig: undefined,
    exec: dbPsql(env),
  });
  const inDb = `kubectl -n vibecarbon exec ${DB_POD} -c ${DB_CONTAINER} --`;
  if (!PROVEN_WRITABLE_STATES.includes(proof)) {
    throw new Error(
      [
        `could not prove the restored database writable (write fence ${proof ?? 'unread'}), so the`,
        'restore marker stays set and the app has not rolled. Check it (expect off):',
        `  ${inDb} psql -U postgres -At -c 'SHOW default_transaction_read_only'`,
        'Then finish, one command at a time:',
        `  ${inDb} sh -c '${RETIRE_PREVIOUS_SH}'`,
        `  ${clearMarkerCommand()}`,
        `  ${inDb} sh -c '${REMOVE_DISCARD_SH}'`,
        `  vibecarbon deploy ${operatorEnv ?? environment}`,
      ].join('\n'),
    );
  }
  // The bounds `vibecarbon restore` gives the same two scripts: a rename, and
  // an `rm -rf` of a whole cluster.
  const execInDb = (script, description, timeout) =>
    runKubectlWithRetry(
      ['-n', 'vibecarbon', 'exec', DB_POD, '-c', DB_CONTAINER, '--', 'sh', '-c', script],
      { env, description, timeout },
    );
  await execInDb(RETIRE_PREVIOUS_SH, 'finishDeployRestore: retire the previous cluster', 60_000);
  try {
    await runKubectlWithRetry(
      [
        '-n',
        'vibecarbon',
        'patch',
        'secret',
        'vibecarbon-infra-secrets',
        '--type=merge',
        '-p',
        JSON.stringify({ stringData: restoreMarkerStringData(null) }),
      ],
      { env, description: 'finishDeployRestore: clear the restore marker' },
    );
  } catch (err) {
    // Past the proof and the retire: the restored copy serves the volume and
    // the database from before is under .vc-discard. Only the marker (and the
    // discard after it) are left; a pod start meanwhile boots normally (the
    // attempt record matches the marker).
    throw new Error(
      [
        `the restored database is proven writable and the database from before it was retired, but ` +
          `clearing the restore marker failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)}). ` +
          'The app has not rolled. Finish, one command at a time:',
        `  ${clearMarkerCommand()}`,
        `  ${inDb} sh -c '${REMOVE_DISCARD_SH}'`,
        `  vibecarbon deploy ${operatorEnv ?? environment}`,
      ].join('\n'),
    );
  }
  await execInDb(REMOVE_DISCARD_SH, 'finishDeployRestore: remove the discarded cluster', 300_000);
  progressLog(`[db] restored ${restore.backup}: promoted, writable, restore marker cleared`);
}

/**
 * Apply cert-manager + the app and infra Secrets + the project's k8s/infra +
 * k8s/base kustomizations (the db StatefulSet included, rendered), wait for
 * the db, deliver the app image into the master's registry (primary only),
 * patch the app deployment to that image, and wait for rollout.
 *
 * Local-first by default — no Flux on the deploy path; Flux is opt-in
 * via `vibecarbon configure cicd`.
 *
 * @param {{kubeconfig: string, projectDir: string, projectName: string, imageTag: string, dbImageTag: string, envLocal: Record<string,string>, domain: string, s3Config?: {accessKey: string, secretKey: string, bucket: string, endpoint: string, region: string}, backupTarget?: import('../../backups-bucket.js').BackupsTarget|null, backupConfig?: {schedule?: string, retentionDays?: number}, restore?: {backup: string, target: string, recoveryConf: string, sizeBytes: number}|null, apiToken?: string, providerId?: string, ProviderClass?: typeof import('../../providers/base.js').BaseProvider, region?: string, environment?: string, minWorkers?: number, maxWorkers?: number, caBoundsMin?: number, sshKeyName?: string, workerServerType?: string, k3sToken?: string, masterIp?: string, sshKeyPath?: string, basePull?: Promise<unknown>, onNamespaceReady?: () => void, masterPrivateIp?: string, vpcCidr?: string, role?: 'primary'|'standby'}} args
 *   `restore` is the resolved `deploy -restore` point (resolveDeployRestorePoint,
 *   src/lib/walg/restore-base.js). With it the restore marker goes into the
 *   infra Secret before the db StatefulSet applies, so the db pod's
 *   walg-restore init fetches that backup on its first boot; the db wait is
 *   sized from the backup, and the restored primary must promote and prove
 *   writable (finishDeployRestore) before the marker is cleared and the app
 *   rolls. The app's migrate init container then applies what the backup
 *   lacks.
 * @returns {Promise<{ tlsRestoredAt: string|null }>} when this apply's TLS
 *   restore wrote Secret/vibecarbon-tls (null when it wrote nothing), for the
 *   TLS phase's re-issue check (tls-reissue-watch.js)
 */
export async function applyK3sManifests({
  kubeconfig,
  projectDir,
  projectName,
  imageTag,
  dbImageTag,
  envLocal,
  domain,
  s3Config,
  backupTarget,
  backupConfig,
  // Phase 5: cluster-autoscaler wiring. `apiToken` is the compute provider's
  // API token (CCM/CSI/CA).
  apiToken,
  // Task 8: the compute provider id string + class, threaded from the SAME
  // source deployK3s already resolves (`providerIdFor(options)` /
  // `providerFor(options)`) — renderCarbonAutoscalerConfig needs both: the
  // id for the config's `provider` field, the class for
  // `ProviderClass.PROVIDER_ID_PREFIX`.
  providerId,
  ProviderClass,
  region,
  environment,
  minWorkers,
  maxWorkers,
  // Task 6: overrides `minWorkers` for the carbon-autoscaler node-group's
  // maxSize ONLY (renderCarbonAutoscalerConfig below). A pilot-light
  // standby deploys with minWorkers: 0 (no Pulumi-provisioned worker
  // nodes) but its CA is rendered against the PRIMARY's static floor so a
  // failover only has to flip CA's replica count 0→1, never re-render its
  // config. Defaults to `minWorkers` so single-cluster deploys (and
  // primary) are unaffected.
  caBoundsMin,
  // The SSH key name carbon-autoscaler gives the provider for new nodes; set
  // on k8s-ha (shared key), undefined on single-cluster k8s.
  sshKeyName: caSshKeyName,
  workerServerType,
  k3sToken,
  // The app image delivery's ssh coordinates: operator → master only. The
  // delta lands in the master's containerd and is pushed into its registry
  // pod from there (deliverImage), so no other node is ever reached.
  masterIp,
  sshKeyPath,
  // The in-flight pull of the runtime base on the master (deployK3s starts
  // it at infra-ready, ruling R3), or undefined for a Dockerfile without
  // the RUNTIME_IMAGE ARG. deliverImage awaits it and owns its failure.
  basePull,
  // Called once the `vibecarbon` namespace exists (applyVibecarbonSecrets
  // creates it). The k8s-ha fan-out starts the replication transport on it.
  onNamespaceReady,
  // perfPrefix tags internal sub-stage perf timings — see deployK3s.
  perfPrefix = 'k3s',
  // The master's private-network IP (deterministic on Hetzner — static
  // 10.0.1.1 — but a real Pulumi output on DO, which can't pin VPC IPs).
  // deployK3s threads it through from infraOutputs. Passed to
  // renderCarbonAutoscalerConfig (CA-spawned worker join target) and the
  // registry hostPort render (renderK8sBase). Undefined here falls through to
  // the callee's own '10.0.1.1' default — old callers that never pass this
  // keep producing byte-identical Hetzner output.
  masterPrivateIp,
  // M3 Task 9c: this deploy's cluster VPC CIDR (DO real Pulumi output, or
  // its resume-compat fallback — see deployK3s). Passed to
  // `ProviderClass.getS3EgressExtraCidrs(vpcCidr)` to decide whether/how to
  // render the S3-egress-VPC-allowance manifest below. undefined on
  // Hetzner (its program doesn't return this key) — harmless, since
  // HetznerProvider.getS3EgressExtraCidrs ignores its argument entirely.
  vpcCidr,
  // Pilot-light: 'primary' | 'standby' | undefined (single-cluster ==
  // primary behavior). Drives walgRole below (the db's wal-g role intent)
  // and zeroes the app tier on a standby.
  role,
  // `deploy -restore`: { backup, target, recoveryConf, sizeBytes }, or null.
  restore = null,
  // The environment as the operator names it (HA clusters deploy under their
  // stack names), for the commands an error prints.
  operatorEnv,
  // Where this registers what it runs alongside its main chain (the CA
  // rollout), so deployK3s can stop and settle it when the deploy fails.
  inFlight = {},
}) {
  if (!masterIp) throw new Error('applyK3sManifests: masterIp required');
  if (!sshKeyPath) throw new Error('applyK3sManifests: sshKeyPath required');
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  const master = { ip: masterIp, sshKeyPath };
  // The schedule and retention this environment runs backups with, validated
  // before anything is created; rendered into the CronJob (renderK8sBase) and
  // the vibecarbon-backup-settings ConfigMap applied below.
  const backupSettings = resolveBackupSettings(backupConfig);
  // Pilot-light: on the standby cluster nothing app-tier runs until a
  // failover promotes it — no app pods, no CA-spawned workers. Everything
  // below gated on this const either declaratively zeroes a Deployment
  // (same patch-at-deploy pattern as the cert/configmap placeholder patches)
  // or skips a step that would otherwise exec against a pod that doesn't
  // exist yet. Registry wait+push, cert-manager, traefik, and the cert/config
  // patches are NOT gated — failover needs the registry (CA-spawned workers
  // pull the app image from it) and the serving master.
  const pilotStandby = role === 'standby';
  // The add-on workloads a pilot standby holds at zero: every add-on deployed
  // into the project's k8s tree, both policies (the app tier is zeroed).
  const standbyAddonWorkloads = pilotStandby
    ? k8sStandbyZeroedWorkloads(enabledK8sAddonNames(projectDir))
    : [];
  // PRECONDITION: the control plane SERVES (/readyz plus a server-side
  // dry-run apply, both in one passing iteration). deployK3s, the only
  // caller, proves it with awaitControlPlaneServing right before this, at its
  // `controlPlane.gate`, and nothing in between touches k3s. This apply used
  // to probe again here, the gate it carried before deployK3s grew its own
  // for the restore marker (#237): two more kubectl round trips per cluster
  // (0.6 s on the primary, 26 s on the DO tor1 standby on an evening path)
  // proving what was proven seconds earlier. The probe exists so nothing
  // races a cold apiserver (mitigation-audit cluster 4); the per-call
  // ladders stay as tripwires.
  // 0a. Move the provider's CSI sidecars off registry.k8s.io and onto our ghcr
  //     mirrors, BEFORE anything that needs a PersistentVolume.
  //
  //     RCA 2026-08-05, fresh k8s-ha rig: kubelet on ONE node of three 403'd
  //     `registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.11.1` and
  //     `sig-storage/livenessprobe:v2.13.1`. That node's hcloud-csi-node pod
  //     never came up, so it never registered the driver, so its CSINode had no
  //     topology key — and the db PVC failed to provision with "no topology key
  //     found on CSINode". The db install's 15m wait then sat until its
  //     timeout and the deploy died. The other two nodes pulled
  //     the identical images without trouble: registry.k8s.io routes by client
  //     IP, so the 403 is per-node roulette (full write-up: src/lib/images.js).
  //     (Those two tags are the INCIDENT's — csi-driver v2.9.0's. The Hetzner
  //     driver has moved on since; the plan below always carries
  //     whatever tags CSI_SIDECAR_MIRRORS was last re-derived from.)
  //
  //     WHY HERE AND NOT IN THE MANIFEST — we do not own these manifests.
  //     cloud-init applies upstream's YAML verbatim from a URL, so there is no
  //     template placeholder to render and no overlay to patch. `set image` is
  //     the same seam cloud-init itself uses one line later (`kubectl set env
  //     deployment/hcloud-csi-controller HCLOUD_VOLUME_EXTRA_LABELS=...`), and
  //     the same one step 5a'' below uses for the cluster-autoscaler pod.
  //
  //     WHY IT IS SAFE TO ASSUME THE WORKLOADS EXIST — both master-init.sh and
  //     do-master-init.sh write /tmp/k3s-ready only AFTER their CCM+CSI applies
  //     have returned, and deployK3s blocks on that marker (waitForK3sReady)
  //     before it ever fetches a kubeconfig. So there is no race to poll around.
  //
  //     WHY FIRST — the re-pin triggers a DaemonSet rollout, and the node plugin
  //     has to re-register on every node before a PVC can bind anywhere. That
  //     wants to overlap with the minutes of cert-manager + traefik + registry
  //     work below, not queue behind it. Unknown provider ⇒ empty plan ⇒ no-op.
  await perfAsync(`deploy.${perfPrefix}.csiSidecars`, async () => {
    for (const { workload, setImageArgs } of csiSidecarSetImagePlan(providerId)) {
      await runKubectlWithRetry(['-n', 'kube-system', 'set', 'image', workload, ...setImageArgs], {
        env,
        description: `applyK3sManifests: kubectl set image ${workload} (CSI sidecars → ghcr mirrors)`,
      });
    }
  });
  // 0b. Deliver the app image, once, into the master's registry: a layer
  //     delta into the master's containerd (only the layers the base pull
  //     did not already put there), checked against the image's diffIDs,
  //     then `ctr images push` into the local registry pod. Every other node,
  //     static or CA-spawned, pulls the same
  //     `<masterPrivateIp>:5000/<project>:<tag>` from it (registries.yaml),
  //     so nothing goes to a node per node. The transfer and import need only
  //     ssh and the base pull, so they start HERE, alongside the cert-manager
  //     chain and the base apply (DO e2e 2026-10-31: 12 s); only the push
  //     waits (pushAfter) for the registry rollout, step 5b', because a
  //     registry pod still Pending refuses `ctr images push` on :5000. It is
  //     awaited right before step 6 points deployment/app at the tag, the
  //     first time any pod references it.
  //     A k8s-ha standby delivers nothing: the primary's image is copied
  //     into this registry over wg0 (planImageDelivery); the registry wait
  //     stays and only the delivery is skipped.
  let markRegistryServing;
  const registryServing = {
    promise: new Promise((resolve, reject) => {
      markRegistryServing = { resolve, reject };
    }),
    resolve: () => markRegistryServing.resolve(),
    reject: (err) => markRegistryServing.reject(err),
  };
  // A registry that never serves fails the deploy at its own wait; this only
  // keeps the rejected signal from being an unhandledRejection.
  registryServing.promise.catch(() => {});
  const { deliver } = planImageDelivery({ role });
  let deliveryPromise = null;
  if (deliver) {
    // `deploy.<prefix>.image.deliver` now spans the transfer AND the wait for
    // the registry before the push, so it is not comparable with the pre-
    // pushAfter figure (12 s on DO, 2026-10-31). `deploy.image.delta` covers
    // everything up to the target's import, with a mark for each stage.
    deliveryPromise = perfAsync(`deploy.${perfPrefix}.image.deliver`, () =>
      deliverImage({
        tag: imageTag,
        sshTarget: `root@${masterIp}`,
        sshKey: sshKeyPath,
        runtime: 'k3s',
        registryRef: imageTag,
        basePull,
        pushAfter: registryServing.promise,
      }),
    );
    // A delivery that fails while the work below is still running must not
    // surface as an unhandledRejection: the await before step 6 re-throws it
    // and fails the deploy.
    deliveryPromise.catch(() => {});
  }
  if (!apiToken) {
    throw new Error(
      'applyK3sManifests: apiToken (provider API token) required for carbon-autoscaler Secret/carbon-autoscaler-config',
    );
  }
  if (!k3sToken) {
    throw new Error('applyK3sManifests: k3sToken required to render carbon-autoscaler config.json');
  }
  // The cluster autoscaler, applied and rolled out ALONGSIDE the cert-manager
  // chain below rather than after k8s/base (DO e2e 2026-10-31: its rollout
  // was 15.6 s of the 127 s apply, in series). Nothing it needs comes from
  // either: it runs in kube-system on the master's host network, from its own
  // kustomization (k8s/base/cluster-autoscaler, applied standalone) and its
  // own carbon-autoscaler-config Secret; no cert-manager resource, no
  // vibecarbon-namespace object, no NetworkPolicy (hostNetwork) is involved.
  // The order inside is unchanged: Secret, apply, set image, then the zero
  // (pilot standby) or the rollout wait. The app is still patched only after
  // this settles (awaited with the image delivery before step 6), so the CA
  // is up before any app pod can ask it for a node, exactly as before, and a
  // failed rollout fails the deploy there with its diagnostics.
  // Stopped (its kubectl children killed) when the main chain below fails,
  // so it settles before applyK3sManifests rethrows: no CA diagnostics print
  // after the deploy's own failure and no kubectl outlives it.
  const caStop = new AbortController();
  const rollOutClusterAutoscaler = async () => {
    // One span for the Secret, the apply, the image pin and (pilot standby)
    // the zero; the rollout wait has its own. The whole chain runs alongside
    // the rest of the apply, so it is off the critical path unless it outlasts
    // the app rollout.
    await perfAsync(`deploy.${perfPrefix}.clusterAutoscaler.apply`, async () => {
      // 4b. Create the kube-system/carbon-autoscaler-config Secret the
      //     carbon-autoscaler sidecar reads on startup (and on every
      //     mtime-changed Refresh — see ConfigWatcher). Two keys:
      //     - `token`: the provider API token, exposed to the sidecar via
      //       secretKeyRef→PROVIDER_API_TOKEN in deployment.yaml.
      //     - `config.json`: the rendered node-group config from
      //       renderCarbonAutoscalerConfig, PLAIN JSON — no base64
      //       pre-encoding. That hack only existed for the old hcloud
      //       cloudprovider's secretKeyRef→env path (Kubernetes auto-decodes
      //       Secret data to plaintext once, and that binary wanted a SECOND,
      //       still-encoded layer on top). The sidecar mounts this Secret as a
      //       FILE (`CARBON_AUTOSCALER_CONFIG=/config-ca/config.json`), which
      //       only ever goes through the one automatic decode — plain JSON is
      //       exactly what it expects.
      //     Stdin pipe keeps the token + JSON off argv (mirrors the dnsSecret
      //     pattern at step 2b).
      const clusterName = `${projectName}-${environment}`;
      const carbonAutoscalerConfigJson = await renderCarbonAutoscalerConfig({
        k3sVersion: k3sVersion(),
        k3sToken,
        // M3 Task 2: output-driven master private IP (Hetzner's own default
        // stays '10.0.1.1' when this is undefined — see renderCarbonAutoscalerConfig).
        masterPrivateIp,
        clusterName,
        environment,
        providerId,
        ProviderClass,
        region,
        workerServerType,
        minWorkers,
        maxWorkers,
        caBoundsMin,
        sshKeyName: caSshKeyName,
      });
      {
        const caSecretYaml = [
          'apiVersion: v1',
          'kind: Secret',
          'metadata:',
          '  name: carbon-autoscaler-config',
          '  namespace: kube-system',
          'type: Opaque',
          'stringData:',
          `  token: ${JSON.stringify(apiToken)}`,
          `  config.json: ${JSON.stringify(carbonAutoscalerConfigJson)}`,
          '',
        ].join('\n');
        await runKubectlWithRetry(['apply', '-f', '-'], {
          env,
          signal: caStop.signal,
          input: caSecretYaml,
          description: 'applyK3sManifests: kubectl apply Secret/carbon-autoscaler-config',
        });
      }
      // 5a'. Apply cluster-autoscaler manifests SEPARATELY. CA lives in
      //      kube-system but base/'s parent kustomization sets
      //      `namespace: vibecarbon`, whose namespace transformer would
      //      override our kube-system metadata. Mirrors the CCM/CSI
      //      separate-install pattern (those are commented in
      //      base/kustomization.yaml and applied via cloud-init). The
      //      child kustomization at carbon/k8s/base/cluster-autoscaler/
      //      sets `namespace: kube-system` explicitly, which only takes
      //      effect when applied standalone like this.
      await applyKustomization(join(projectDir, 'k8s/base/cluster-autoscaler'), {
        env,
        master,
        signal: caStop.signal,
        description: 'applyK3sManifests: apply cluster-autoscaler',
        // The sidecar's image goes in here, not after: a client-side apply pushes
        // every field the manifest names, so an image patched in afterwards is
        // reset by the next deploy, and on `strategy: Recreate` that killed a
        // healthy autoscaler to roll out a pod that could not start.
        render: (manifests) =>
          renderManifestImages(manifests).replaceAll(
            '{{CARBON_AUTOSCALER_IMAGE}}',
            carbonAutoscalerImageRef(),
          ),
      });
      // 5a''. The manifest's token already carries this ref, so this is
      //       belt-and-braces, but load-bearing belt-and-braces: the apply above
      //       reads the PROJECT's checked-in copy of this manifest, and a project
      //       generated before the mirror landed still pins registry.k8s.io
      //       there, i.e. still walks into the 403 that cost a deploy on
      //       2026-07-31 (src/lib/images.js). Re-pinning here keeps the version
      //       set authoritative at deploy time no matter how old the project's
      //       k8s/ tree is. On a current project it changes nothing, so nothing
      //       rolls.
      await runKubectlWithRetry(
        [
          '-n',
          'kube-system',
          'set',
          'image',
          'deployment/cluster-autoscaler',
          `cluster-autoscaler=${clusterAutoscalerImageRef()}`,
        ],
        {
          env,
          signal: caStop.signal,
          description: 'applyK3sManifests: kubectl set image deployment/cluster-autoscaler',
        },
      );
      if (pilotStandby) {
        // Pilot-light: CA has nothing to scale for until a failover promotes
        // this cluster, so zero it the same way as the app Deployment (step 5).
        // Its node-group bounds are already pre-rendered into the
        // carbon-autoscaler-config Secret (step 4b) using the PRIMARY's
        // caBoundsMin/maxWorkers — the standby's maxSize reflects the same
        // headroom the primary would scale into — so a failover only has to
        // flip replicas 0→1, never re-render the config.
        await runKubectlWithRetry(
          [
            '-n',
            'kube-system',
            'patch',
            'deployment',
            'cluster-autoscaler',
            '--type=merge',
            '-p',
            JSON.stringify({ spec: { replicas: 0 } }),
          ],
          {
            env,
            signal: caStop.signal,
            description: 'applyK3sManifests: zero cluster-autoscaler deployment (pilot standby)',
          },
        );
      }
    });
    // 5e. Wait for the rollout the the cluster-autoscaler apply + `set image`
    //     steps above triggered (on `strategy: Recreate`, either one changing
    //     the pod template rolls the pod). The status-wait is the clean
    //     failure mode: a misconfigured sidecar (e.g. an unreachable image tag)
    //     surfaces here instead of as a downstream "no nodes scaled" mystery.
    if (pilotStandby) {
      // The steps above just rolled a Deployment we then zeroed — there's
      // no rollout to wait on (0 replicas converges immediately).
      console.error(
        '[pilot-standby] skipping cluster-autoscaler rollout wait, app tier is zeroed until failover',
      );
    } else {
      await perfAsync(`deploy.${perfPrefix}.clusterAutoscaler.rollout`, async () => {
        // rollout-status has its own --timeout and benefits from live progress;
        // runs via runCommandAsync (kubectl rollout status). Internal
        // apiserver-watch retries cover transient drops within the budget.
        //
        // 300s: ONE Recreate cycle (old pod terminate + new pod start) plus a
        // cold pull of both container images from ghcr.io. The former THREE
        // back-to-back rolls (now collapsed into the single 5d patch) were what
        // pushed this past 180s on the standby (k8s-ha 2026-04-29 run); one
        // cycle sits comfortably under 300s, and the node has been pre-pulling
        // both images since k3s came up (clusterAutoscalerPodImages()). Capture
        // pod state on failure so a timeout surfaces root cause instead of just
        // "rollout status timed out" — that is how the 2026-07-31 registry.k8s.io
        // 403 was finally identified.
        try {
          // Through the retry wrapper, NOT bare runCommandAsync (d4 run 4,
          // 2026-08-28): kubectl's internal watch retries only survive drops on
          // an established connection — a transient `TLS handshake timeout` on
          // the INITIAL connect exited kubectl 13s into the 300s budget and
          // failed the deploy while the pod went Ready seconds later. The
          // classifier already knew the spelling; this call was the last
          // rollout-status holdout outside the wrapper.
          await runKubectlWithRetry(
            [
              '-n',
              'kube-system',
              'rollout',
              'status',
              'deploy/cluster-autoscaler',
              '--timeout=300s',
            ],
            {
              env,
              signal: caStop.signal,
              description: 'applyK3sManifests: cluster-autoscaler rollout status',
            },
          );
        } catch (err) {
          // Capture runs through runDeployDiagnostic (silent:true + re-emit) so
          // every byte lands in ~/.vibecarbon/logs/<env>-<ts>.log. The previous
          // `silent: false` version wrote to inherited fds, which the deploy-log
          // tee cannot see — on the 2026-07-31 e3 run it left a bare header and
          // cost a blind RCA. See the "Deploy-time diagnostic capture" block.
          // Stopped because the deploy already failed: no diagnostics after
          // that failure (applyK3sManifests).
          if (caStop.signal.aborted) throw err;
          await captureClusterAutoscalerDiagnostics({ env });
          throw err;
        }
      });
    }
  };
  const clusterAutoscalerReady = rollOutClusterAutoscaler();
  // The app does not wait for this. The autoscaler serves pending pods whenever
  // it comes up, and holding the app for it cost about 20 s after the image had
  // landed (DO e2e 2026-11-05: 94 s rollout). The deploy still awaits it, last.
  // Only a failure settles clusterAutoscalerFailed, so the app's path can stop
  // on one at once without waiting for a healthy rollout.
  const clusterAutoscalerFailed = clusterAutoscalerReady.then(() => new Promise(() => {}));
  // These only keep a failed rollout from being an unhandledRejection.
  clusterAutoscalerReady.catch(() => {});
  clusterAutoscalerFailed.catch(() => {});
  inFlight.stopClusterAutoscaler = async () => {
    caStop.abort();
    await clusterAutoscalerReady.catch(() => {});
  };
  // 1. Install cert-manager: ONE apply of the upstream manifest with our
  //    settings rendered in as kustomize patches
  //    (carbon/scripts/render-cert-manager.mjs, shared with the GitOps
  //    workflow): the controller flag (a 5 minute minimum backoff) and the
  //    control-plane pin of all three Deployments.
  //
  //    Nothing patches a cert-manager Deployment after this apply
  //    (tests/unit/deploy/cert-manager-no-post-apply-patch-census.test.ts).
  //    The upstream args are a plain list, so this client-side apply used to
  //    replace them and a json patch then appended the flags again: the
  //    controller rolled twice on every deploy, warm redeploys included, and
  //    a controller handoff can miss the restored Secret/vibecarbon-tls and
  //    issue a new certificate. Rendered in, a warm re-apply is a no-op.
  //
  //    The pin: the in-cluster `kubernetes` Endpoints advertises the master's
  //    PUBLIC IP (k3s installs with --node-ip=<public>), and the firewall
  //    admits public :6443 from operator CIDRs only, so an apiserver-dependent
  //    pod scheduled onto any other node times out on 10.43.0.1 forever (RCA
  //    2026-07-17 e4 rig: cainjector CrashLoopBackOff, webhook readiness 500).
  const certManagerDir = makeTempDir('vibecarbon-cert-manager-');
  try {
    writeCertManagerKustomization(certManagerDir);
    await perfAsync(`deploy.${perfPrefix}.certManager.install`, () =>
      applyKustomization(certManagerDir, {
        env,
        master,
        description: 'applyK3sManifests: apply cert-manager',
      }),
    );
  } finally {
    removeTempDir(certManagerDir);
  }
  // 2. Wait for cert-manager to be ready before applying ClusterIssuers.
  // Fan out the three deploys in parallel: kubectl wait blocks per-arg
  // sequentially, and the cainjector + webhook usually become Available
  // ~10-30s after the core deploy, so the serial form pays the longest
  // arrival time three times in a row.
  //
  // Each deploy POLLS to Available within a generous total budget rather than
  // one or two fixed `kubectl wait` calls. On a fresh worker, cold image pulls
  // can push cainjector/webhook readiness past a tight envelope even though the
  // pod ultimately comes up healthy (observed 2026-06-01: k8s e2e failed
  // `kubectl wait deploy/cert-manager-cainjector exited 1` while the pod was
  // 1/1 Running moments later — the old 90s→120s=210s envelope just gave up
  // first). Re-attempting `kubectl wait` in chunks until the budget also
  // self-heals the fast-fail race where `wait` runs before the just-applied
  // Deployment object has propagated (NotFound → exit 1 immediately). A
  // genuinely stuck deploy still fails once the budget is exhausted.
  const certManagerDeploys = [
    'deploy/cert-manager',
    'deploy/cert-manager-webhook',
    'deploy/cert-manager-cainjector',
  ];
  // 8-min budget: on a freshly provisioned cluster under load, cert-manager
  // pods have been observed not even getting created until ~5 min after apply
  // (control-plane/scheduler lag, not image pull), overrunning a tighter
  // envelope even though the pods then come up healthy. This margin covers that
  // cold-start tail; the poll below re-attempts within it rather than giving up.
  const CERT_MANAGER_READY_BUDGET_MS = 480_000;
  const waitDeployAvailableOnce = (deploy, timeoutSec) =>
    new Promise((resolveFn, reject) => {
      const child = spawn(
        'kubectl',
        [
          '-n',
          'cert-manager',
          'wait',
          '--for=condition=Available',
          `--timeout=${timeoutSec}s`,
          deploy,
        ],
        { stdio: 'inherit', env },
      );
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolveFn() : reject(new Error(`kubectl wait ${deploy} exited ${code}`)),
      );
    });
  const waitDeployAvailable = async (deploy) => {
    const deadline = Date.now() + CERT_MANAGER_READY_BUDGET_MS;
    let lastErr;
    while (Date.now() < deadline) {
      const remainingSec = Math.max(5, Math.ceil((deadline - Date.now()) / 1000));
      try {
        await waitDeployAvailableOnce(deploy, Math.min(60, remainingSec));
        return;
      } catch (err) {
        lastErr = err;
        if (Date.now() >= deadline) break;
        // Brief backoff so a fast-failing wait (e.g. the Deployment object not
        // yet propagated → immediate NotFound) doesn't busy-spin the budget.
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    throw (
      lastErr ??
      new Error(
        `kubectl wait ${deploy} never became Available within ${CERT_MANAGER_READY_BUDGET_MS / 1000}s`,
      )
    );
  };
  await perfAsync(`deploy.${perfPrefix}.certManager.wait`, () =>
    Promise.all(certManagerDeploys.map((deploy) => waitDeployAvailable(deploy))),
  );
  // 2a-bis. Available is not SERVING. Prove the admission pipeline round-trips
  // — apiserver -> ValidatingWebhookConfiguration -> caBundle -> webhook pod —
  // with one server-side dry-run of a real cert-manager resource, before
  // ANYTHING below creates cert-manager resources. This one probe covers both
  // windows the downstream ladders separately absorbed: the post-Available 502
  // (2026-08-07) and the caBundle lag (2026-08-10). Those ladders remain as
  // tripwires per the mitigation policy.
  await perfAsync(`deploy.${perfPrefix}.certManager.admission`, () =>
    awaitCertManagerAdmission({ env }),
  );
  // 3. Apply infra (cert-manager-resources/cluster-issuers + traefik-crds).
  // ClusterIssuers traverse cert-manager's validating webhook. The webhook
  // warm-up retry that used to guard this apply is GONE (band-aid removal,
  // 2026-08-16): awaitCertManagerAdmission above has already PROVEN the
  // admission pipeline round-trips, so a webhook failure here is a real
  // regression and must fail the deploy loudly, not be absorbed.
  await perfAsync(`deploy.${perfPrefix}.certManager.resources`, () =>
    applyKustomization(join(projectDir, 'k8s/infra/cert-manager-resources'), {
      env,
      master,
      description: 'applyK3sManifests: apply cert-manager-resources',
    }),
  );
  // The CRD URL carries the Traefik tag this deploy resolved, so it is filled
  // in BEFORE `kubectl kustomize` fetches it, on a temp copy: a redeploy must
  // not leave the operator's git tree dirty.
  const traefikCrdsDir = renderTraefikCrds(join(projectDir, 'k8s/infra/traefik-crds'));
  try {
    await perfAsync(`deploy.${perfPrefix}.traefikCrds`, () =>
      applyKustomization(traefikCrdsDir, {
        env,
        master,
        description: 'applyK3sManifests: apply traefik-crds',
      }),
    );
  } finally {
    removeTempDir(traefikCrdsDir);
  }
  // 4. Create the app and infra Secrets BEFORE base/ — base/'s Deployment
  //    and StatefulSet reference them; without them kubelet fails container
  //    creation with `secret "vibecarbon-app-secrets" not found`.
  //    With `deploy -restore` the infra Secret also carries the restore
  //    marker, so the db pod's first boot restores that backup.
  //    The db's wal-g role intent (vibecarbon-db-role) lands here too, so
  //    the db pod base/ creates starts with it.
  //
  // Derive the wal-g WRITE-GUARD role (NOT a path segment) from the explicit
  // `role` option — the k8s-ha fan-out passes role: 'primary' / 'standby';
  // single-cluster deploys leave role undefined → 'primary'. Recorded as the
  // db's role intent (vibecarbon-db-role), which db-guard.sh writes to the
  // role file wal-archive.sh + the backup CronJob read, so both no-op on the
  // standby. The S3 prefix itself stays canonical.
  const walgRole = role === 'standby' ? 'standby' : 'primary';
  await perfAsync(`deploy.${perfPrefix}.secrets`, () =>
    applyVibecarbonSecrets({ kubeconfig, envLocal, s3Config, backupTarget, restore, walgRole }),
  );
  onNamespaceReady?.();
  // 5. Apply base (namespace, network-policies, db, app, backup, traefik,
  //    config), always from a rendered temp copy (renderK8sBase): the db
  //    StatefulSet carries deploy-time placeholders (image, wal-g prefix,
  //    S3 endpoint, StorageClass), and so do the PVCs
  //    `add redis` / `add n8n` copy into k8s/base/<addon>/. kubectl accepts a
  //    literal storageClassName and the PVC sits Pending forever, and neither
  //    a PVC's class nor a StatefulSet's volumeClaimTemplates can be changed
  //    once the object exists, so the substitution has to happen before this
  //    apply.
  const storageClass = ProviderClass?.K8S_STORAGE_CLASS;
  // A chart-era cluster keeps its database on the chart's StatefulSet; a new
  // one beside it would be empty. Refuse before anything is created.
  await perfAsync(`deploy.${perfPrefix}.db.preflight`, async () => {
    await assertNoRetiredChartDb({ env });
    await assertDbStorageClass({ storageClass, env });
  });
  // Issuer choice (k8sIssuerName): ACME_CA_SERVER from .env.local or the
  // operator's environment picks staging or prod, both HTTP-01 (see
  // pickIssuerName). Computed before the base
  // is rendered: the backup settings below (the TLS snapshot folder is per
  // CA), the rendered Certificate and the Secret restore all need it.
  const issuerName = k8sIssuerName({ envLocal });
  // The apex alone: k8s routes by path on the apex, and HTTP-01 has no wildcard.
  const dnsNames = certificateDnsNames(domain);
  // Single-ACME-issuer policy (d4 2026-08-28, acme-issuer-policy.js): a
  // pilot-standby's Certificate references the local self-signed issuer so
  // only the cluster DNS points at solves ACME (HTTP-01 can pass on no other)
  // and two issuers never order the same names at once. The REAL issuer name
  // rides along in the promote annotation on BOTH roles: the failover promote step (and every
  // reconverge redeploy, via this same branch under the swapped role)
  // re-points issuerRef from it.
  const effectiveIssuer = pilotStandby ? STANDBY_SELFSIGNED_ISSUER : issuerName;
  if (pilotStandby) {
    console.error(
      `[pilot-standby] certificate issuerRef -> ${STANDBY_SELFSIGNED_ISSUER} ` +
        `(single-ACME-issuer policy; promote annotation carries ${issuerName})`,
    );
  }
  // Where the backup CronJob saves the vibecarbon-tls Secret: the env backup
  // bucket (none: no snapshot) under backups/<project>/<env>/tls/<ca>.
  const tlsSnapshotPrefix = backupTarget?.bucket
    ? tlsSnapshotS3Prefix({
        backupBucket: backupTarget.bucket,
        projectName,
        envName: operatorEnv,
        ca: caSlug(issuerName),
      })
    : '';
  const baseDir = renderK8sBase(
    join(projectDir, 'k8s/base'),
    {
      ...buildDbManifestValues({
        dbImageTag,
        s3Config,
        backupTarget,
        storageClass,
        walArchiveSha: walArchiveConfigSha(projectDir),
      }),
      // The registry hostPort's bind address (hostIP). No default: renderK8sBase
      // refuses a missing one rather than assume Hetzner's 10.0.1.1.
      MASTER_PRIVATE_IP: masterPrivateIp,
    },
    backupConfig,
    { dnsNames, issuerName, effectiveIssuer },
    // k8s-ha: the db StatefulSet is created with its replication hostPort,
    // never patched (and so restarted) to gain it later.
    { replicationHostPort: rendersReplicationHostPort(role) },
  );
  // When this deploy's restore wrote Secret/vibecarbon-tls (operator clock),
  // returned so the TLS phase can tell a re-issue after it.
  let tlsRestoredAt = null;
  // Its reads are records, never gates: a short bound each.
  const timingKubectl = quietKubectl(env, { timeoutMs: 10_000 });
  // From here the rendered copy is removed whatever happens (finally below).
  try {
    // The cert-manager controller is SETTLED before the restored Secret and the
    // Certificate land: its rollout complete and the leader lease held by a pod
    // of the current ReplicaSet. A handoff in that window can miss the Secret in
    // the new leader's cache and issue a new certificate. On a warm deploy the
    // controller did not roll (step 1), so this returns on its first read; on a
    // cold one it waits out the first leader election. One bounded wait.
    await perfAsync(`deploy.${perfPrefix}.certManager.leader`, () =>
      awaitCertManagerLeader({ env }),
    );
    // The last issued certificate goes back into Secret/vibecarbon-tls before
    // this apply creates the Certificate, so cert-manager finds a Secret that
    // matches it and does not issue (tls-restore.js holds the overwrite rule).
    // The issuing cluster only: a pilot standby serves its self-signed
    // certificate until a failover promotes it. Never fails the deploy.
    // Read from the backups bucket at its own region and endpoint.
    if (!pilotStandby) {
      const tlsRestore = await perfAsync(`deploy.${perfPrefix}.tlsRestore`, () =>
        restoreK8sTlsSecret({
          s3Config: backupStorageConfig(s3Config, backupTarget),
          projectName,
          envName: operatorEnv,
          ca: caSlug(issuerName),
          issuerName,
          dnsNames,
          runKubectl: quietKubectl(env),
        }),
      );
      progressLog(`[k3s] ${k8sTlsRestoreLine(tlsRestore)}`);
      // Timing records for a re-issue of a restored certificate
      // (tls-reissue-watch.js): when the write landed, then when the
      // Certificate was created and which controller held the lease.
      if (tlsRestore.restored) {
        tlsRestoredAt = new Date().toISOString();
        progressLog(`[k3s] ${await tlsRestoreTimingLine(timingKubectl, tlsRestoredAt)}`);
      }
    }
    await perfAsync(`deploy.${perfPrefix}.applyBase`, () =>
      applyKustomization(baseDir, {
        env,
        master,
        description: 'applyK3sManifests: apply k8s/base',
      }),
    );
    if (!pilotStandby) {
      for (const line of await tlsApplyTimingLines(timingKubectl)) {
        progressLog(`[k3s] ${line}`);
      }
    }
  } finally {
    // The rendered copy carries the bucket + endpoint wiring; it served its
    // one apply.
    removeTempDir(baseDir);
  }
  // The per-environment retention the backup CronJob reads (in no manifest
  // tree, so no Flux reconcile can touch it).
  await runKubectlWithRetry(['-n', 'vibecarbon', 'apply', '-f', '-'], {
    env,
    input: renderBackupSettingsConfigMap({ ...backupSettings, tlsSnapshotPrefix }),
    description: 'applyK3sManifests: kubectl apply ConfigMap/vibecarbon-backup-settings',
  });
  if (pilotStandby) {
    // Pilot-light: nothing app-tier runs on the 2-node standby. Declarative
    // zero via the same patch-at-deploy pattern as the placeholder patches
    // below (TYPE and NAME as separate argv tokens, matching kubectl's own
    // `patch TYPE NAME` form). Step 6 below still patches the image of this
    // Deployment so its pod template is failover-ready the moment CA (or
    // an operator) scales it back to 1.
    await runKubectlWithRetry(
      [
        '-n',
        'vibecarbon',
        'patch',
        'deployment',
        'app',
        '--type=merge',
        '-p',
        JSON.stringify({ spec: { replicas: 0 } }),
      ],
      { env, description: 'applyK3sManifests: zero app deployment (pilot standby)' },
    );
    // Every declared add-on follows (primary-only ones write to the primary's
    // database; with-app-tier ones follow the zeroed app tier), in the same
    // window after the apply as the app. Failover scales the app-namespace
    // ones back up from ha.scaleUpList.
    await zeroWorkloadsOnStandby({ env, workloads: standbyAddonWorkloads });

    // Reap stale worker Node OBJECTS. A pilot standby has minWorkers:0, so
    // ANY '-worker-' node here is stale by definition — after a failover,
    // the reconverge deploy demotes the old primary to standby and Pulumi
    // deletes its worker VMs, but nothing deletes the Kubernetes Node
    // records those VMs left behind. Run 32620564611 caught
    // `...-primary-worker-1` still registered on the new standby while the
    // provider account held zero servers; whether the CCM eventually reaps
    // it is a race this deploy must not depend on (conditions, not timers).
    // Fresh standbys list no workers and this is a no-op.
    const nodesOut = await runKubectlWithRetry(['get', 'nodes', '-o', 'name'], {
      env,
      silent: true,
      description: 'applyK3sManifests: list nodes for stale-worker reap (pilot standby)',
    });
    const staleWorkers = String(nodesOut ?? '')
      .split('\n')
      .map((l) => l.trim().replace(/^node\//, ''))
      .filter((n) => n.includes('-worker-'));
    for (const node of staleWorkers) {
      await runKubectlWithRetry(['delete', 'node', node, '--ignore-not-found'], {
        env,
        description: `applyK3sManifests: reap stale worker Node object ${node} (pilot standby)`,
      });
    }
  }
  // 5a. M3 Task 9c: provider-conditional S3-egress VPC CIDR allowance.
  //     MUST run before the registry-pod readiness wait (5b' below) — on
  //     DO the registry pod's readinessProbe fails (storagedriver health
  //     check can't reach S3) until this lands, so the wait would time out
  //     without it. getS3EgressExtraCidrs is called via optional chaining
  //     so a hand-rolled test-double ProviderClass that predates this
  //     method (e.g. existing k3s-apply-manifests-ordering.test.ts fixtures)
  //     still resolves to "no extra CIDRs" — Hetzner's real render path
  //     stays byte-identical (this whole block is skipped, no new kubectl
  //     call, k8s/base's OTHER manifests untouched either way).
  const s3EgressExtraCidrs = ProviderClass?.getS3EgressExtraCidrs?.(vpcCidr) ?? [];
  if (s3EgressExtraCidrs.length > 0) {
    const s3EgressVpcTemplate = readFileSync(S3_EGRESS_VPC_MANIFEST, 'utf-8');
    const renderedS3EgressVpc = renderS3EgressVpcManifest(s3EgressVpcTemplate, s3EgressExtraCidrs);
    await runKubectlWithRetry(['apply', '-f', '-'], {
      env,
      input: renderedS3EgressVpc,
      description: 'applyK3sManifests: kubectl apply -f - s3-egress-vpc (S3-egress VPC allowance)',
    });
  }
  // 5b'. Wait for the local registry's rollout (Phase 1) before the delivery
  //      pushes into it. The registry is part of base/, so it just landed.
  //      A rollout, not a pod Ready wait: the Deployment uses Recreate, and
  //      after an image ref change the old pod is still Ready while it
  //      terminates, so a pod wait could hand the delivery a registry that is
  //      going away. A pod still Pending refuses `ctr images push` on :5000.
  //      120s mirrors other base-pod readiness budgets. On a timeout, the
  //      events say whether a mirror package nobody can pull is the cause.
  try {
    await perfAsync(`deploy.${perfPrefix}.localRegistry.wait`, async () => {
      try {
        await runKubectlWithRetry(
          ['-n', 'vibecarbon', 'rollout', 'status', 'deployment/local-registry', '--timeout=120s'],
          {
            env,
            description: 'applyK3sManifests: kubectl rollout status deployment/local-registry',
          },
        );
      } catch (err) {
        const events = await runCommandAsync(MIRROR_PULL_EVENTS_ARGV, {
          silent: true,
          env,
          timeout: 30_000,
          ignoreError: true,
        });
        const hint = mirrorPullFailureHint(typeof events === 'string' ? events : '');
        throw new Error(`local-registry rollout did not complete: ${hint ?? err.message}`, {
          cause: err,
        });
      }
    });
    registryServing.resolve();
  } catch (err) {
    registryServing.reject(err);
    throw err;
  }
  // 5b. Patch the vibecarbon-config SITE_URL that the base/ kustomization
  //     ships with its `app.example.com` placeholder. (The vibecarbon-tls
  //     Certificate is no longer patched here: renderK8sBase renders it with
  //     this deploy's names and issuer before the apply, so cert-manager
  //     never acts on the placeholder.)
  await runKubectlWithRetry(
    [
      '-n',
      'vibecarbon',
      'patch',
      'configmap',
      'vibecarbon-config',
      '--type=merge',
      '-p',
      JSON.stringify({ data: { SITE_URL: `https://${domain}` } }),
    ],
    { env, description: 'applyK3sManifests: kubectl patch configmap/vibecarbon-config' },
  );
  // 5c'. Isolated observability stack (H-9). Applied SEPARATELY from k8s/base for
  //      the SAME reason as cluster-autoscaler above: base/'s parent kustomization
  //      sets `namespace: vibecarbon`, whose namespace transformer would override
  //      the observability namespace and pull the stack back into vibecarbon —
  //      defeating the isolation. The child kustomization
  //      (k8s/base/observability) sets `namespace: vibecarbon-observability`,
  //      which only holds when applied standalone like this. Gated on the dir
  //      existing (present only after `vibecarbon add observability`).
  //
  //      NOTE: the gitops/Flux deploy path (flux/clusters/*/vibecarbon.yaml) still
  //      reconciles only k8s/base, so it does NOT yet apply this — tracked as a
  //      follow-up. Removing observability from base/ (add.js) means gitops loses
  //      the stack until that Flux Kustomization lands.
  const observabilityDir = join(projectDir, 'k8s/base/observability');
  // Apply the isolated stack separately ONLY when base does NOT already aggregate
  // it. `add observability` never wires `- observability/` into base (H-9 uniform
  // isolation), so this is normally always true — but the guard is harmless
  // belt-and-suspenders: if base were hand-edited to include observability, it
  // keeps the separate isolated apply and the base aggregation mutually exclusive
  // (no double-apply into both the vibecarbon and vibecarbon-observability
  // namespaces).
  const baseKustPath = join(projectDir, 'k8s/base/kustomization.yaml');
  const baseAggregatesObservability =
    existsSync(baseKustPath) && readFileSync(baseKustPath, 'utf-8').includes('observability/');
  if (pilotStandby) {
    // Spec: add-ons follow the app tier — zeroed on the pilot-light standby.
    // Skip the observability apply entirely; the reconverge/failover redeploy
    // installs it when this cluster becomes primary (the apply above is
    // idempotent across redeploys, so nothing is lost).
    console.error('[pilot-standby] skipping observability, app tier is zeroed until failover');
    // A cluster demoted by the post-failover reconverge was a full primary
    // and still runs the stack it was given then. zeroWorkloadsOnStandby
    // above already scaled its Deployments to zero from the declaration (no
    // scrape or Grafana spend, no second Prometheus watching a zeroed app
    // tier; scale, not delete, so the PVCs keep their history); the apply
    // restores `replicas: 1` the day this cluster is promoted again. A fresh
    // standby has no such namespace and this is a no-op.
    await settleObservabilityOnStandby({
      env,
      // A stack left on the cluster after its add-on left the project tree:
      // nothing above zeroed it, so the namespace check does.
      leftoverWorkloads: k8sStandbyZeroedWorkloads(declaredAddonNames()).filter(
        (w) =>
          w.namespace === OBSERVABILITY_NAMESPACE &&
          !standbyAddonWorkloads.some((z) => z.namespace === w.namespace && z.name === w.name),
      ),
    });
  } else if (
    existsSync(join(observabilityDir, 'kustomization.yaml')) &&
    !baseAggregatesObservability
  ) {
    // Scoped secret/config into the new namespace FIRST (Grafana refs them).
    await applyObservabilitySecrets({ kubeconfig, envLocal, domain });
    // M3 Task 4: loki/grafana/prometheus-pvc.yaml ship a
    // `{{K8S_STORAGE_CLASS}}` placeholder instead of hardcoding Hetzner's
    // `hcloud-volumes` — resolve it into a temp copy of the dir (see
    // renderK8sStorageClassPlaceholder's doc for why a temp copy, not an
    // in-place rewrite or a post-apply patch) and apply THAT instead of the
    // project's own observabilityDir.
    const renderedObservabilityDir = renderK8sStorageClassPlaceholder(
      observabilityDir,
      ProviderClass.K8S_STORAGE_CLASS,
    );
    try {
      await perfAsync(`deploy.${perfPrefix}.applyObservability`, () =>
        applyKustomization(renderedObservabilityDir, {
          env,
          master,
          description: 'applyK3sManifests: apply k8s/base/observability',
        }),
      );
    } finally {
      // Same cleanup contract as the rendered k8s/base copy — deploys must
      // not leak a temp dir per run (T4 review).
      removeTempDir(renderedObservabilityDir);
    }
  }
  // One certificate per name: Grafana's IngressRoute takes vibecarbon-tls
  // from Traefik's global store (`tls: {}`). An env deployed before that
  // still holds the grafana-tls Certificate and Secret (and, where the
  // add-on has since left the project tree, the old route naming them),
  // which no apply manages any more. Removed wherever the observability
  // namespace exists, whatever the project tree holds, and after the apply
  // above so the Grafana route never names a Secret that is gone. A pilot
  // standby does it in settleObservabilityOnStandby.
  if (!pilotStandby) {
    await retireObservabilityCertificateIfPresent({ env, kubectl: runKubectlWithRetry });
  }
  // (Considered: setting HCLOUD_NETWORK on the Hetzner CCM so it populates
  // each Node's InternalIP from the Hetzner private network. Reverted —
  // because k3s installs with `--node-ip=<public>` per master-init.sh,
  // the kubelet TLS cert SAN includes only the public IP. CCM then
  // overwriting InternalIP with 10.0.1.x makes kubectl logs/exec fail with
  // "tls: failed to verify certificate: x509: certificate is valid for
  // 127.0.0.1, <public>, not 10.0.1.x", which silently breaks every
  // diagnostic the lifecycle relies on. The actual fix for the
  // traefik→apiserver "connection refused" loop turned out to be the
  // NetworkPolicy egress widening in
  // carbon/k8s/base/{traefik,app}/network-policy.yaml plus the explicit
  // traefik rollout-restart below — kube-router's iptables can ship up
  // stale on first apply, and forcing traefik to re-establish its watch
  // after policies are in place clears it.)
  // The db wait: Ready (its readinessProbe: the real server accepting TCP),
  // then the condition itself, not the proxy: the pod being Ready is its
  // readiness probe's verdict at one instant, and awaitPostgresAccepting
  // re-proves the REAL server accepts TCP right now (mitigation-audit cluster
  // 5 root fix; the d4 run-2 RCA in awaitPostgresAccepting). WAL archiving is
  // on from the first boot (startup flags, see k8s/base/db/statefulset.yaml),
  // so there is no archiving setup or restart after it. A changed
  // wal-archive.sh rolls the pod through its template's sha annotation,
  // inside this same wait. A restore's first boot also fetches the backup, so
  // its budget scales with the backup's size (C13), never below the cold
  // deploy's.
  const dbRolloutTimeoutS = restore
    ? Math.max(DB_ROLLOUT_TIMEOUT_S, restoreRolloutTimeoutS(restore.sizeBytes))
    : DB_ROLLOUT_TIMEOUT_S;
  // The live wal-g role file is not written here: deployK3s writes it on
  // every deploy, outside the k3s-apply skip gate (writeDeployWalgRole).
  const awaitDb = async () => {
    await perfAsync(`deploy.${perfPrefix}.awaitDb`, () =>
      awaitDbRollout({
        env,
        timeoutS: dbRolloutTimeoutS,
        // A pilot standby's db holds only a replica: name the rebuild.
        hint: role === 'standby' ? standbyDbRebuildHint(operatorEnv ?? environment) : '',
      }),
    );
    await awaitPostgresAccepting({ env, dbPod: DB_POD });
  };
  // 5b. `deploy -restore`: the restored database must have promoted and
  //     proved writable BEFORE the app rolls. The app pods' migrate init
  //     container reads a database still in recovery as a standby and applies
  //     nothing (carbon/src/server/db/migrate.ts), so pods started during the
  //     restore would skip the migrations the backup lacks. The marker stays
  //     set on any failure here, so a rerun restores again.
  if (restore) {
    await awaitDb();
    await perfAsync(`deploy.${perfPrefix}.restore.finish`, () =>
      finishDeployRestore({ env, restore, environment, operatorEnv }),
    );
  }
  // 6. Patch the app deployment to the delivered image BEFORE waiting on
  //    the db (after it on a restore, see 5b). base/ ships
  //    image=ghcr.io/<owner>/<repo>:main — no pull secret in local-first mode,
  //    so leaving it pointed at GHCR triggers an ImagePullBackOff for the
  //    whole db wait. Switching now means the app pods come up on the
  //    delivered image immediately (their readiness stays 503 until the db
  //    answers); we still wait for their rollout below. The delivery (5b'')
  //    is the barrier: this patch is the first reference to the tag, so the
  //    registry holds it before any kubelet asks.
  //    One patch also stamps the resourceVersions of the Secrets the pod reads
  //    (readAppSecretVersions), so a re-minted storage key or a rotated password
  //    rolls the pods even when the image tag is unchanged; one template
  //    change, one roll. Both containers: the app and its migrate init
  //    container run one image.
  if (deliveryPromise) await deliveryPromise;
  // An autoscaler that has already failed stops the deploy before the app is
  // touched. One still coming up does not hold it.
  await Promise.race([clusterAutoscalerFailed, Promise.resolve()]);
  const appTemplatePatch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            [APP_SECRETS_SHA_ANNOTATION]: await readAppSecretVersions({ env }),
          },
        },
        spec: {
          containers: [{ name: 'app', image: imageTag }],
          initContainers: [{ name: 'migrate', image: imageTag }],
        },
      },
    },
  };
  await runKubectlWithRetry(
    [
      '-n',
      'vibecarbon',
      'patch',
      'deployment/app',
      '--type=strategic',
      '-p',
      JSON.stringify(appTemplatePatch),
    ],
    {
      env,
      description: 'applyK3sManifests: kubectl patch deployment/app (image, secret versions)',
    },
  );
  // 7. Wait for the db StatefulSet (applied with base in step 5), gating the
  //    psql-bearing steps after this (the RLS audit, the wal-g audit, the HA
  //    primary configuration). A restore already waited in 5b.
  if (!restore) await awaitDb();
  // NOTE: the wal-g backup audit deliberately does NOT live here. It is the one
  // check whose subject can rot with ZERO in-cluster change (keys revoked at the
  // provider, bucket deleted), so it must not sit behind the persisted
  // `k3s-apply` skip gate — see deployK3s, which runs it unconditionally.
  // 8. No separate migration step here: each app pod's `migrate` init
  //    container applies db/migrations as the owner (under an advisory lock,
  //    so replicas take turns) and sets up app_service before the app
  //    container starts, and the readiness probe stays 503 until the ledger
  //    is current. A restored database carries its ledger, so they apply only
  //    what the backup lacks; the one restore special case is the ordering in
  //    5b (the app rolls only once the restored database has promoted).
  // 9. Wait for app rollout. The deployment template already has
  //    imagePullPolicy: IfNotPresent, so the master's kubelet uses the
  //    delivered image without pulling and every other node pulls it once
  //    from the master's registry. 300s wasn't enough on a cold deploy where
  //    the app pods stay unready until the database converges, hence 10m.
  //
  //    Retry on apiserver-warm-up transients. iter-postpush + iter-validate2
  //    both saw `kubectl rollout status` fast-fail in ~10s on the k8s-ha
  //    restore re-deploy with "Unable to connect to the server: net/http:
  //    TLS handshake timeout" — the apiserver was still cycling certs after
  //    the cluster came up. Pods rolled out fine within 2 minutes; kubectl
  //    just bailed on the first connect. We can't use runKubectlWithRetry
  //    here because rollout-status genuinely needs live stdout (operator
  //    sees per-replica progress over a 10min window). Hand-rolled retry
  //    keeps inherited stdout, captures stderr through a pipe so the
  //    transient-error pattern can fire, and short-circuits non-transient
  //    failures (real rollout failures or the deployment not existing
  //    surface immediately, not after 3×retry).
  if (pilotStandby) {
    // Step 5 already patched this Deployment to replicas:0 — there's no
    // rollout to wait on.
    console.error('[pilot-standby] skipping rolloutApp, app tier is zeroed until failover');
  } else {
    // The rollout waits on readiness, which stays 503 until the app's
    // startup migrations are applied. A FAILED migration never becomes ready,
    // so a watcher polls the app's own health probe alongside the rollout and
    // fails the deploy at once on MIGRATIONS_FAILED (with the app log tail)
    // instead of at the rollout's 600 s timeout. Whichever settles first wins;
    // the other is stopped (the rollout child is killed through the signal).
    const rolloutAbort = new AbortController();
    const rollout = perfAsync(`deploy.${perfPrefix}.rolloutApp`, async () => {
      const rolloutArgs = [
        '-n',
        'vibecarbon',
        'rollout',
        'status',
        'deployment/app',
        '--timeout=600s',
      ];
      const ROLLOUT_RETRY_DELAYS_MS = [2000, 4000];
      const ATTEMPTS = ROLLOUT_RETRY_DELAYS_MS.length + 1;
      // Async (spawn-based) — `kubectl rollout status --timeout=600s` can wait
      // up to 10 minutes for pods to roll. spawnSync would block Node's event
      // loop the whole time; in HA the parallel standby branch's perf substep
      // numbers would all be inflated by primary's rollout-wait. Stream stdout
      // to operator (inherit), pipe stderr so the transient-error classifier
      // can fire (KUBECTL_TRANSIENT_PATTERN check below).
      const runRollout = () =>
        new Promise((resolve, reject) => {
          const child = spawn('kubectl', rolloutArgs, {
            env,
            stdio: ['ignore', 'inherit', 'pipe'],
            signal: rolloutAbort.signal,
          });
          let stderrBuf = '';
          child.stderr?.on('data', (chunk) => {
            const s = chunk.toString();
            stderrBuf += s;
            process.stderr.write(s);
          });
          child.on('error', reject);
          child.on('exit', (code) => resolve({ status: code, stderr: stderrBuf }));
        });
      await runWithRetry(
        async () => {
          const result = await runRollout();
          if (result.status !== 0) {
            const err = new Error(
              `kubectl rollout status failed with exit ${result.status ?? '?'}: ${result.stderr.trim().slice(-500)}`,
            );
            err.stderr = result.stderr;
            err.status = result.status;
            throw err;
          }
        },
        {
          delaysMs: ROLLOUT_RETRY_DELAYS_MS,
          isTransient: (err) => KUBECTL_TRANSIENT_PATTERN.test(kubectlErrorHaystack(err)),
          onRetry: (_err, attempt) => {
            progressLog(
              `kubectl rollout status hit transient error on attempt ${attempt}/${ATTEMPTS}, retrying in ${ROLLOUT_RETRY_DELAYS_MS[attempt - 1]}ms`,
            );
          },
        },
      );
    });
    const migrationWatch = watchAppMigrationFailure({ env, signal: rolloutAbort.signal });
    try {
      await Promise.race([rollout, migrationWatch, clusterAutoscalerFailed]);
    } finally {
      rolloutAbort.abort();
      // The loser settles after the abort; its outcome no longer matters.
      rollout.catch(() => {});
      migrationWatch.catch(() => {});
    }
  }
  // 9a. Delete the pre-split `vibecarbon-secrets` Secret. The app, the db and
  //     the add-ons now read vibecarbon-app-secrets and
  //     vibecarbon-infra-secrets, and this deploy's rollout replaced every pod
  //     that referenced the old Secret, so nothing uses it any more. Leaving
  //     it would keep a copy of every infra password in a Secret no one owns.
  //     A no-op once it is gone.
  await runKubectlWithRetry(
    ['-n', 'vibecarbon', 'delete', 'secret', LEGACY_VIBECARBON_SECRET, '--ignore-not-found'],
    { env, description: `applyK3sManifests: delete Secret/${LEGACY_VIBECARBON_SECRET}` },
  );
  // 9b. Wait for the app to report its migrations applied and its super
  //     admin ready (one probe). The app migrates, then creates the admin
  //     at startup from ADMIN_EMAIL / ADMIN_PASSWORD (delivered through the
  //     vibecarbon-app-secrets envFrom, see buildAppSecretData) once the database
  //     answers; the deploy is not done until the operator can sign in.
  //     Runs on restore too (a backup predating the admin still gets one).
  //     SKIPPED on a pilot standby: its app tier is zeroed until failover,
  //     and the admin row arrives with the replicated database.
  if (pilotStandby) {
    console.error('[pilot-standby] skipping awaitAppAdminReady, app tier is zeroed until failover');
  } else {
    await perfAsync(`deploy.${perfPrefix}.awaitAdminReady`, () => awaitAppAdminReady({ env }));
    // 9c. The app has migrated the database (awaitAppAdminReady waits for
    //     migrationStatus 'applied'): audit the live catalog for RLS.
    await perfAsync(`deploy.${perfPrefix}.auditRls`, () => auditRls({ kubeconfig }));
  }
  // 10. Force-restart traefik so it starts AFTER kube-router has installed
  //     iptables rules for the NetworkPolicies. RCA from k8s-hetzner
  //     2026-04-28 deploy run (1di log): when traefik starts during
  //     kustomize apply, kube-router's NetworkPolicy controller may not yet
  //     have reconciled the new policies. traefik's first connection to
  //     10.43.0.1:443 races the rule install — it gets stuck in a retry
  //     loop on `connect: connection refused`, never loads IngressRoutes,
  //     and serves its default 404 on every external request. Bouncing
  //     traefik live fixed every observed instance (k8s-ha verify-1df-1dg
  //     and k8s-hetzner restore probe). Forcing a clean rollout-restart
  //     here closes the race deterministically — by the time we restart
  //     traefik, all NetworkPolicies + ClusterIssuers + IngressRoutes have
  //     landed and kube-router has had time to reconcile.
  //     ignoreError=true is intentional: traefik uses hostPort 80/443 with
  //     RollingUpdate, so the new pod can't start until the old one
  //     terminates. We force-delete the existing pod (graceful would block
  //     on the hostPort race), then wait briefly for the replacement to
  //     stabilize. If anything in this block fails, the deploy still
  //     succeeds — the public probe will catch a real issue.
  // 10a. Never while an ACME challenge is live. Traefik serves the HTTP-01
  //     token Let's Encrypt fetches, and the Certificate was created by the
  //     base apply (step 5), so issuance can be mid-validation right now; a
  //     force-deleted Traefik leaves port 80 closed until its replacement
  //     starts, and a validation that lands in that gap fails the order. So
  //     the restart first waits, bounded, until no Challenge of a
  //     deploy-owned Certificate is live (acme-challenges.js has the bound and
  //     why it is enough). Usually that is one read: issuance finished while
  //     the app rolled. Past the bound the restart goes ahead, since the race
  //     above leaves the domain dead for good while a failed order is
  //     repaired by the ACME watchdog. A pilot standby skips the wait: its
  //     Certificate uses the self-signed issuer, so it has no challenge.
  if (!pilotStandby) {
    await perfAsync(`deploy.${perfPrefix}.traefik.challengeWait`, async () => {
      const settled = await awaitAcmeChallengesSettled({
        runKubectl: quietKubectl(env, { timeoutMs: 10_000 }),
        namespaces: [...new Set(DEPLOY_OWNED_CERTIFICATES.map((key) => key.split('/')[0]))],
      });
      const line = challengeWaitLine(settled);
      if (line) progressLog(`[k3s] ${line}`);
    });
  }
  try {
    await perfAsync(`deploy.${perfPrefix}.traefik.restart`, async () => {
      await runKubectlWithRetry(
        [
          '-n',
          'vibecarbon',
          'delete',
          'pod',
          '-l',
          'app=vibecarbon-traefik',
          '--force',
          '--grace-period=0',
        ],
        { env, description: 'applyK3sManifests: kubectl delete pod traefik' },
      );
      // ignoreError: true means this resolves null/false on failure instead
      // of throwing — check explicitly and warn so the non-fatal-failure
      // signal isn't silently dropped (the outer catch below only fires on
      // a THROWN error, e.g. from the delete-pod call above).
      const ok = await runCommandAsync(
        [
          'kubectl',
          '-n',
          'vibecarbon',
          'rollout',
          'status',
          'deployment/traefik',
          '--timeout=120s',
        ],
        { silent: false, ignoreError: true, env },
      );
      if (ok === null || ok === false) {
        progressLog(
          '[k3s] traefik post-apply restart warning: kubectl rollout status deployment/traefik did not complete within 120s',
        );
      }
    });
  } catch (err) {
    progressLog(`[k3s] traefik post-apply restart warning: ${err.message?.split('\n')[0] || err}`);
  }
  await clusterAutoscalerReady;
  return { tlsRestoredAt };
}

/**
 * Start building the app image before the cluster is provisioned, so the build
 * runs while Pulumi creates the servers instead of after k3s is Ready (DO e2e
 * 2026-10-31: the up took 78 s, more than a cold build). The build needs
 * nothing from the cluster: its tag names no registry until deliverAppImage
 * retags it with the master's private IP.
 *
 * The `k3s-build` gate inputs (source and build-arg digests) are read HERE,
 * before `docker build` reads the source, and handed to deliverAppImage with
 * the build. The gate then records what the image was built from: an edit
 * made while the cluster provisions is not recorded against the older image,
 * so the next deploy rebuilds it. Only the master's private IP, unknown
 * until provisioning, is filled in later; it names the registry, not the
 * image's content.
 *
 * Returns null for a k8s-ha standby (it copies the primary's image).
 * Otherwise `{ build, inputs }`, where `build` is null for a rerun whose
 * `k3s-build` gate will skip (judged with the master IP the last
 * provisioning recorded), so an unchanged redeploy builds nothing and leaves
 * no stray local tag, and deliverAppImage reuses `inputs` instead of hashing
 * the source again. A failure is not reported here: deliverAppImage awaits
 * the build and fails the deploy with it, at the point a serial build would
 * have.
 *
 * @returns {{build: Promise<{tag: string, gitSha: string, isDirty: boolean}>|null, inputs: object, abort?: () => void}|null}
 */
export function startAppImageBuild({
  role,
  state,
  projectDir,
  projectName,
  domain,
  priorMasterPrivateIp,
  perfPrefix = 'k3s',
  deps = {},
}) {
  const d = { buildAppImage, buildK3sBuildInputs, ...deps };
  if (!planImageDelivery({ role }).build) return null;
  const inputs = d.buildK3sBuildInputs({
    projectName,
    domain,
    masterPrivateIp: priorMasterPrivateIp ?? null,
    projectDir,
  });
  if (priorMasterPrivateIp && state.shouldSkip('k3s-build', inputs)) {
    return { build: null, inputs };
  }
  // abort(): a deploy that fails while this runs reaps the docker build
  // (deployK3s), instead of leaving it running after the error.
  const reap = new AbortController();
  const build = perfAsync(`deploy.${perfPrefix}.image.localBuild`, () =>
    d.buildAppImage(projectDir, projectName, false, domain, { quiet: true, signal: reap.signal }),
  );
  // Awaited (and its failure thrown) by deliverAppImage; this only keeps a
  // build that fails while Pulumi is still running from being an
  // unhandledRejection before then.
  build.catch(() => {});
  return { build, inputs, abort: () => reap.abort() };
}

/**
 * Build the app image this cluster will run, and return its tag.
 *
 * Single-cluster k8s and a k8s-ha primary build the image locally (the
 * `k3s-build` gate), usually by taking the build startAppImageBuild began
 * before provisioning (`early`, with the gate inputs it read), then name it for this cluster's
 * registry (registryImageTag); applyK3sManifests then delivers it once into
 * the master's registry, which every node pulls from. A k8s-ha standby builds
 * nothing: it awaits the primary's built ref (`peerImageRef`), which is
 * copied into its own registry, and re-prefixes it for its own master
 * (`standbyImageRef`). `onImageBuilt` reports the built tag whether the build
 * gate ran or skipped, so a warm rerun still hands the standby a ref.
 *
 * `deps` exists for tests: deployK3s can't be unit-driven and same-module
 * calls can't be mocked. The call stays spelled `d.buildAppImage(` so the
 * call-site census sees it.
 *
 * @returns {Promise<string>} the image tag deployment/app runs
 */
export async function deliverAppImage({
  role,
  peerImageRef,
  onImageBuilt,
  state,
  projectDir,
  projectName,
  domain,
  masterPrivateIp,
  early = null,
  spinner,
  deps = {},
}) {
  const d = { buildAppImage, buildK3sBuildInputs, tagImage: tagLocalImage, ...deps };
  const plan = planImageDelivery({ role });
  if (plan.awaitPeerImage) {
    if (!peerImageRef) throw new Error('deployK3s: role standby requires peerImageRef');
    return standbyImageRef({
      primaryRef: await peerImageRef,
      standbyMasterPrivateIp: masterPrivateIp,
    });
  }
  let imageTag;
  if (plan.build) {
    // The build gate folds the CONTENT of the build context (app source +
    // Dockerfile) and of the VITE_* build args into its inputs — see
    // buildK3sBuildInputs for why each one is load-bearing, and for the
    // stale-image bug the coarse inputs alone shipped. Computed here, not in
    // deployK3s, so a standby (which builds nothing) never hashes the source.
    // With an early start, the inputs it read before `docker build` (plus the
    // master IP, now known): the gate records what the image was built from.
    const readInputs = () =>
      d.buildK3sBuildInputs({ projectName, domain, masterPrivateIp, projectDir });
    let buildInputs = early ? { ...early.inputs, masterPrivateIp } : readInputs();
    // A predicted skip that missed (the master IP moved) builds now, so it
    // gates on the source as it is now.
    if (early && !early.build && !state.shouldSkip('k3s-build', buildInputs)) {
      buildInputs = readInputs();
    }
    if (!state.shouldSkip('k3s-build', buildInputs)) {
      state.startStep('k3s-build', buildInputs);
      spinner.start(`Building app image (${masterPrivateIp}:5000/...)`);
      let built;
      try {
        built = await (early?.build ?? d.buildAppImage(projectDir, projectName, false, domain));
      } catch (err) {
        spinner.stop('App image build failed', 1);
        throw err;
      }
      const tag = registryImageTag(built.tag, masterPrivateIp);
      await d.tagImage(built.tag, tag);
      state.completeStep('k3s-build', {
        tag,
        gitSha: built.gitSha,
        isDirty: built.isDirty,
      });
      spinner.stop(`Image built: ${tag}`);
    }
    ({ tag: imageTag } = state.getStepResult('k3s-build'));
    onImageBuilt?.(imageTag);
  }
  return imageTag;
}

/**
 * Pull the app's runtime base into the master's k8s.io containerd namespace,
 * where the layer delta (deliverImage, runtime k3s) finds its layers and so
 * sends only the app's own. Inspect first: the ref is immutable (a pinned
 * tag, a digest once published), so a master that already holds it, which is
 * every warm redeploy, asks no registry and a GHCR blip cannot fail it.
 *
 * Rejects with ctr's own one-line cause (deliverImage adds the GHCR hint).
 * No retry (Brandon, 2026-11-09): a download the network cut off says so and
 * that running the deploy again finishes it. On 2026-11-08 a linode/k8s
 * deploy lost its base this way (`connection reset by peer`) while kubelet
 * pulled about 15 images in the same minute; the cause is still open.
 *
 * @param {object} o
 * @param {string} o.masterIp
 * @param {string} o.sshKeyPath
 * @param {string} o.baseRef - the Dockerfile's `ARG RUNTIME_IMAGE=` default
 * @param {(script: string) => Promise<string>} [o.run] - test seam
 * @returns {Promise<void>}
 */
export async function pullK3sRuntimeBase({ masterIp, sshKeyPath, baseRef, run }) {
  const ref = shEscape(baseRef);
  const script = [
    'set -eu',
    `if k3s ctr -n k8s.io images ls -q name==${ref} | grep -q .; then exit 0; fi`,
    `k3s ctr -n k8s.io images pull ${ref} >/dev/null`,
    '',
  ].join('\n');
  const exec =
    run ?? ((sc) => sshRun(masterIp, sshKeyPath, ['sh', '-s'], { input: sc, timeout: 600_000 }));
  try {
    await exec(script);
  } catch (err) {
    const cause = String(err?.stderr ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('Warning:'));
    const line = cause || String(err?.message ?? err).split('\n')[0];
    // Only ctr's own line: ctr ran, so the master is up and only the
    // download failed. An ssh that never connected is not told this.
    const dropped = line.startsWith('ctr: ') && NETWORK_DROP.test(line);
    throw new Error(dropped ? `${line}. ${BASE_PULL_DROPPED}` : line, { cause: err });
  }
}

/** How ctr words a download the network cut off, as opposed to one refused. */
const NETWORK_DROP = /reset by peer|i\/o timeout|unexpected EOF|TLS handshake timeout|broken pipe/i;

/** What a deploy whose base download was cut off tells the operator. */
export const BASE_PULL_DROPPED =
  'The connection to the registry dropped partway through the download. ' +
  'That is the network, not your project, so run the deploy again to finish it.';

/**
 * Does the primary's own registry still hold the app image tag? One ssh round
 * trip to the master: a manifest HEAD against the registry the image was
 * pushed to (by `ctr images push` at the end of deliverImage: one docker v2
 * manifest, which MANIFEST_ACCEPT names; ruling R8). The k3s-apply gate
 * hashes manifests and tags, none of which see a registry that lost its
 * contents (a rebuilt master disk), so the gate asks here. `false` only when
 * the registry answered with no such tag.
 *
 * @param {object} o
 * @param {string} o.masterIp
 * @param {string} o.sshKeyPath
 * @param {string} o.imageTag - `<masterPrivateIp>:5000/<repo>:<tag>`
 * @param {(script: string) => Promise<string>} [o.run] - test seam
 * @returns {Promise<boolean>}
 */
export async function primaryRegistryHasImage({ masterIp, sshKeyPath, imageTag, run }) {
  const { host, repo, repoTag } = parseLocalRegistryRef(imageTag);
  if (
    !/^[A-Za-z0-9.-]+:[0-9]+$/.test(host) ||
    !/^[a-z0-9._/-]+$/.test(repo) ||
    !/^[A-Za-z0-9._-]+$/.test(repoTag.slice(repo.length + 1))
  ) {
    throw new Error(`primaryRegistryHasImage: unsafe image ref ${imageTag}`);
  }
  const script = `set -eu\n${MANIFEST_DIGEST_SH}\ndigest ${host} ${repo} ${repoTag.slice(repo.length + 1)}\n`;
  const exec =
    run ?? ((s) => sshRun(masterIp, sshKeyPath, ['sh', '-s'], { input: s, timeout: 60_000 }));
  return (await exec(script)).trim() !== '';
}

/**
 * The k3s-apply skip decision. A role that delivers into its own registry
 * (planImageDelivery.deliver) only skips when that registry still holds the
 * image: the delivery lives inside the gated apply, so a warm deploy against a
 * registry that lost the tag must re-run it, or no node can pull it and the
 * standby copy has nothing to read. A probe that throws keeps the hash
 * decision (state.shouldSkipWithVerify); a standby delivers nothing and skips
 * on the hash.
 *
 * @returns {Promise<boolean>}
 */
export async function shouldSkipK3sApply({ state, applyInputs, role, imageInRegistry }) {
  if (!planImageDelivery({ role }).deliver) return state.shouldSkip('k3s-apply', applyInputs);
  return state.shouldSkipWithVerify('k3s-apply', applyInputs, imageInRegistry);
}

/**
 * Probe an existing Pulumi stack for its k3s token so a re-deploy replays it.
 *
 * Returns the stack's stored `k3sToken`, or undefined when the stack is
 * fresh/unreadable — the program then mints one exactly as before (cold
 * deploy path). Errors degrade the same way: an unreachable backend falls
 * back to cold behavior on a stack that, being unreachable, upStack will fail
 * on anyway with its own clearer error. So undefined does NOT mean the
 * cluster is new: a live stack whose read fails or whose outputs lack the
 * token gets a minted one too. See the call-site comment in deployK3s's
 * k3s-infra block for why replay is load-bearing (a minted token on a live
 * stack leaves new nodes unable to join).
 *
 * Three errors propagate, rethrown by classifyK3sTokenProbe: a passphrase
 * failure, a StateMigrationError (the one-time legacy migration stopped) and
 * a StackHeldError (another run holds the stack). Unlike an unreachable
 * backend, each can clear by the time the up that follows opens the stack
 * again (the migration re-encrypts it on first open, the child may have
 * finished before it exited non-zero, the other run ends), so a token minted
 * here would reach a live cluster.
 *
 * @param {any} Provider  provider class (getK8sProgram static)
 * @param {Record<string, unknown>} programConfig  same config the real program uses
 * @param {{provider?: string, providerToken?: string, s3Config?: object, log?: (msg: string) => void}} [opts]
 *   `provider` is required whenever `providerToken` is set — buildEnv throws
 *   otherwise (see its JSDoc / the DO k8s 401 RCA).
 * @returns {Promise<string|undefined>}
 */
export async function resolveStackK3sToken(Provider, programConfig, opts = {}) {
  const log = opts.log ?? console.error;
  const { getStackOutputs, classifyK3sTokenProbe } = await import('../../iac/index.js');
  let probe;
  try {
    const probeProgram = await Provider.getK8sProgram(programConfig);
    const outputs = await getStackOutputs(programConfig.environment, probeProgram, {
      provider: opts.provider,
      providerToken: opts.providerToken,
      s3Config: opts.s3Config,
      projectName: opts.projectName,
    });
    probe = classifyK3sTokenProbe({ outputs });
  } catch (err) {
    // Rethrows the three failures above instead of classifying them.
    probe = classifyK3sTokenProbe({ error: err instanceof Error ? err : new Error(String(err)) });
  }
  if (probe.status !== 'recovered') {
    log(
      `[k3s-infra] k3s token probe: ${probe.status} (${probe.reason}), minting a fresh token (fresh-stack path)`,
    );
  }
  return probe.priorK3sToken;
}

/**
 * Stop what a failed deploy started in the background, before its error is
 * rethrown. `early` is whatever startAppImageBuild returned: null, a skipped
 * build with no abort, or a running build.
 * @param {{early?: {abort?: () => void}|null, stopClusterAutoscaler?: () => Promise<void>}} inFlight
 */
export async function reapInFlight(inFlight) {
  inFlight.early?.abort?.();
  await inFlight.stopClusterAutoscaler?.();
}

/**
 * Deploy one k3s cluster on any provider: infra (Pulumi), k3s install and
 * kubeconfig, the app image built locally and delivered once into the
 * master's registry by layer delta (every node pulls it from there), then the
 * manifests, cert-manager and the app rollout. A k8s-ha standby delivers
 * nothing of its own: the primary's image is copied into its registry.
 * `onInfraReady` fires once the nodes answer and `onNamespaceReady` once the
 * `vibecarbon` namespace exists, so the HA fan-out can start on signals.
 *
 * @param {K3sDeployOptions} options
 * @returns {Promise<{masterIp: string, floatingIp?: string, dbIp: string, dbPrivateIp: string, masterPrivateIp: string, workerIps: string[], networkId: string|number, kubeconfig: string, sshKeyPath: string, imageTag: string}>}
 *   `floatingIp` only on a provider with K8S_FLOATING_IP: the domain's
 *   address is clusterIngressIp of this result (k8s/ingress-ip.js).
 */
export async function deployK3s(options) {
  // What deployK3sSteps started in the background and must not outlive a
  // failed deploy: the early app image build, and applyK3sManifests' cluster
  // autoscaler rollout. Both are stopped, and the rollout settled, before the
  // failure is rethrown: no CA diagnostics print after it, no child outlives it.
  const inFlight = {};
  try {
    return await deployK3sSteps(options, inFlight);
  } catch (err) {
    await reapInFlight(inFlight);
    throw err;
  }
}

async function deployK3sSteps(options, inFlight) {
  // A `deploy -restore` point arrives resolved (C5); refuse a partial one
  // before anything is provisioned or applied.
  assertDeployRestorePoint({ restore: options.restore });
  const { state } = options;
  // When a tracker is supplied (the orchestrator + HA fan-out always pass one),
  // use its spinner factory (timing + per-step log file). Otherwise fall back to
  // the spinner-safe `spinner()` from cli/progress.js — it registers itself as
  // the active spinner so any progressLog() chatter routes through its message
  // line instead of corrupting it.
  const spin = options.tracker ? options.tracker.spinner.bind(options.tracker) : spinner;
  const s = spin();
  const projectDir = process.cwd();
  // perfPrefix tags all internal sub-stage perf timings. Default 'k3s' for
  // single-cluster (`deploy.k3s.iac.upStack` etc); HA passes 'k3s.primary' /
  // 'k3s.standby' so the perf_substep table can attribute primary/standby
  // deploy time per sub-stage. Without this, both HA clusters' timings
  // collide on identical sub-stage names and we can't tell which dominated.
  const perfPrefix = options.perfPrefix ?? 'k3s';
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(options);

  // 1. Preflight
  s.start('Preflight (docker + ssh + kubectl)');
  for (const tool of ['docker', 'ssh', 'kubectl']) {
    // checkDependency does a pure in-process PATH lookup (no child process),
    // so there's nothing to make async here — matches the same preflight
    // idiom used in deploy.js / github.js / ci-setup.js.
    if (!checkDependency(tool)) {
      throw new Error(`Required tool '${tool}' not found on PATH`);
    }
  }
  // The floor and why it is what it is: kubectl-patch-subresource in
  // lib/runtime-floors.js.
  const kubectlVersion = await runCommandAsync(['kubectl', 'version', '--client', '-o', 'json'], {
    silent: true,
  }).catch(() => '');
  const kubectlVersionText = String(kubectlVersion ?? '');
  const kubectlTooOld = kubectlFloorProblem(kubectlVersionText);
  if (kubectlTooOld) throw new Error(kubectlTooOld);
  s.stop('Preflight OK');
  if (!kubectlClientVersion(kubectlVersionText)) {
    progressLog(unreadableMessage({ tool: 'kubectl', raw: kubectlVersionText }));
  }

  // 1b. The app image build, started now so it runs while Pulumi provisions
  //     the cluster (startAppImageBuild); deliverAppImage takes it below. The
  //     master IP the last provisioning recorded lets an unchanged rerun skip
  //     it, as its build gate will.
  const early = startAppImageBuild({
    role: options.role,
    state,
    projectDir,
    projectName: options.projectName,
    domain: options.domain,
    priorMasterPrivateIp: state.getStepResult('k3s-infra')?.masterPrivateIp,
    perfPrefix,
  });
  inFlight.early = early;

  // 2. SSH key
  const { privateKeyPath, publicKey } = options.sharedSshKeyPath
    ? {
        privateKeyPath: options.sharedSshKeyPath,
        publicKey: options.sharedSshPublicKey ?? '',
      }
    : await ensureSshKey(projectDir, options.environment);

  // Per-env known_hosts file. host-keys.js: <projectDir>/.vibecarbon/known_hosts_<env>.
  // Used by every SSH/SCP call below so we never read or pollute the
  // operator's ~/.ssh/known_hosts (which would otherwise reject reconnects
  // when Hetzner recycles a public IP).
  const khPath = knownHostsPath(options.environment, projectDir);

  // 3. Pulumi up — provisions network, firewall, master, database, workers,
  //    floating IP. Cloud-init runs k3s install + hcloud-ccm/csi on each node.
  // Phase 5: Pulumi sees `minWorkers` (static floor) only; `maxWorkers`
  // is consumed by the cluster-autoscaler patch in applyK3sManifests
  // and intentionally NOT passed to Pulumi. Defaults match the JSDoc on
  // K8sStackConfig (1 / 3) — the orchestrator (Phase 8) populates from
  // CLI flags + envConfig.
  const minWorkers = options.minWorkers ?? 1;
  const maxWorkers = options.maxWorkers ?? 3;
  const infraInputs = {
    region: options.region,
    masterType: options.masterServerType,
    dbType: options.dbServerType,
    workerType: options.workerServerType,
    minWorkers,
    maxWorkers,
    k3sVersion: k3sVersion(),
  };
  if (!state.shouldSkip('k3s-infra', infraInputs)) {
    state.startStep('k3s-infra', infraInputs);
    const { upStack } = await import('../../iac/index.js');

    const allowedCidrs = (options.operatorCidrs ?? []).map((e) => e.cidr);
    // CD2 — lazy dispatch through the provider class (no named
    // buildHetznerK8sProgram import) so Phase B providers slot in without
    // editing this file.
    const programConfig = {
      projectName: options.projectName,
      environment: options.environment,
      sshPublicKey: publicKey,
      existingSshKeyId: options.sharedSshKeyId ? String(options.sharedSshKeyId) : undefined,
      location: options.region,
      masterServerType:
        options.masterServerType || options.serverType || Provider.DEFAULT_K8S_NODE_TYPE,
      dbServerType: options.dbServerType || options.serverType || Provider.DEFAULT_K8S_NODE_TYPE,
      workerServerType:
        options.workerServerType || options.serverType || Provider.DEFAULT_K8S_NODE_TYPE,
      minWorkers,
      maxWorkers,
      k3sVersion: k3sVersion(),
      apiToken: options.apiToken,
      labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
      allowedSshIps: allowedCidrs,
      allowedK8sApiIps: allowedCidrs,
    };
    // Replay the stack's existing k3s token before building the real
    // program. The token is interpolated into every node's cloud-init user
    // data, which every server ignores once it exists (serverResourceOptions /
    // workerResourceOptions, lib/iac/create-timeout.js): a live master keeps
    // the token it booted with whatever the program says. A freshly minted
    // token would reach only what is created from now on (a new static
    // worker, every autoscaler-spawned worker through the carbon-autoscaler
    // config, the stack's k3sToken output), and none of those could join.
    // The role reconciler makes re-running this block on an EXISTING stack
    // routine (primary↔standby shapes hash differently after a failover
    // swap), so the token must come from the stack; only a genuinely fresh
    // stack mints one. History: before servers ignored their user data, a
    // fresh token REPLACED every server (RCA 2026-07-17 e4 rig: the
    // post-failover reconverge deploy replaced all servers of both clusters).
    // Same probe-and-replay contract as scale's converge seam.
    const priorK3sToken = await resolveStackK3sToken(Provider, programConfig, {
      provider: providerIdFor(options),
      providerToken: options.apiToken,
      s3Config: options.s3Config,
      projectName: options.projectName,
    });
    const program = await Provider.getK8sProgram({
      ...programConfig,
      ...(priorK3sToken ? { k3sToken: priorK3sToken } : {}),
    });

    s.start('Provisioning k3s cluster (Pulumi up)');
    const requiredOutputs =
      Provider.K8S_FLOATING_IP === false ? ['masterIp'] : ['masterIp', 'floatingIp'];
    const { outputs } = await perfAsync(`deploy.${perfPrefix}.iac.upStack`, () =>
      upStack(options.environment, program, {
        perfStem: `deploy.${perfPrefix}.iac.upStack`,
        provider: providerIdFor(options),
        providerToken: options.apiToken,
        s3Config: options.s3Config,
        projectName: options.projectName,
        // A DigitalOcean cluster made before 2026-11: the reserved IP the up
        // takes out of this stack goes onto the environment's record, where
        // the release and destroy find it (k8s/retired-reserved-ip.js).
        recordRetiredAddresses: (addresses) =>
          recordRetiredReservedIps({
            environment: options.operatorEnv ?? options.environment,
            stackName: options.environment,
            addresses,
          }),
        // Recover stale-EMPTY outputs reads in place (read-only poll inside
        // upStack) — the hard gate below stays the loud last resort. Same
        // family member as the compose provision sites (bc94b18): this gate
        // was validation-without-recovery, the exact pre-fix shape that
        // failed e1's restore re-deploy twice on 2026-08-06/07. A provider
        // without a floating IP (K8S_FLOATING_IP false) outputs none.
        requiredOutputs,
      }),
    );
    const missing = requiredOutputs.filter((key) => !outputs[key]);
    if (missing.length > 0) {
      throw new Error(`Pulumi outputs missing ${missing.join(' and ')}`);
    }
    state.completeStep('k3s-infra', outputs);
    s.stop(
      `Cluster provisioned: master=${outputs.masterIp}` +
        (outputs.floatingIp ? ` floating=${outputs.floatingIp}` : ''),
    );
  }
  const infraOutputs = state.getStepResult('k3s-infra');
  const {
    masterIp,
    // Output-driven — Hetzner's program exports the same static
    // '10.0.1.1' it always has (fixture-pinned byte-identical); DO cannot
    // pin VPC IPs so its program returns the real Pulumi-assigned address.
    // NO fallback defaults: a missing value means the k3s-infra step result
    // predates these outputs (or the program regressed) — assuming a
    // Hetzner-shaped address silently breaks every other provider, so the
    // guard below fails the deploy instead. Re-run the infra step
    // (redeploy) to refresh the persisted outputs.
    masterPrivateIp,
    dbIp,
    dbPrivateIp,
    workerIps,
    networkId,
    // DO-only real Pulumi output (the Vpc's actual ipRange). Fallback
    // default (Provider.DEFAULT_VPC_CIDR — empty string on Hetzner,
    // '10.10.0.0/20' on DO) covers state.json step results persisted
    // before this field existed, same reasoning as
    // masterPrivateIp/dbPrivateIp above. HetznerProvider.
    // getS3EgressExtraCidrs ignores this value entirely, so an unused ''
    // fallback there is harmless.
    vpcCidr = Provider.DEFAULT_VPC_CIDR,
  } = infraOutputs;
  // The cluster's floating IP, only on a provider whose clusters have one. A
  // DigitalOcean cluster made before 2026-11 saved its reserved IP here; a
  // skipped step hands that result back, and it must not become the
  // domain's address again (infraFloatingIp, ./ingress-ip.js).
  const floatingIp = infraFloatingIp(infraOutputs, Provider);
  if (!masterPrivateIp || !dbPrivateIp) {
    throw new Error(
      'k3s-infra step result is missing masterPrivateIp/dbPrivateIp — the IaC ' +
        'program outputs both; a stale persisted step result predates them. ' +
        'Re-run the infra step (redeploy) to refresh the outputs.',
    );
  }

  // 4. Wait for cloud-init to finish + k3s to be Ready
  // Set when this run waited for the master, i.e. on a fresh (re)provision:
  // the nodes' first-boot timing is read back once the host keys are pinned.
  let bootTimingDue = false;
  if (!state.shouldSkip('k3s-ready', { masterIp })) {
    state.startStep('k3s-ready', { masterIp });
    s.start('Waiting for k3s on master (cloud-init + Ready)');
    // 1200s (20 min) covers cold-init + k3s-download + k3s-up.
    // Earlier 600s budget tripped on 2026-04-27 morning matrix when apt was
    // mid-install at the timeout (cloud-init-output.log diagnostics
    // confirmed). The diagnostic capture inside waitForK3sReady means a
    // genuine bug surfaces with cloud-init log content, so a longer budget
    // costs us nothing — we still get the same actionable signal on real
    // failures, just don't false-positive on slow apt mornings.
    await perfAsync(`deploy.${perfPrefix}.waitForReady`, () =>
      waitForK3sReady(masterIp, privateKeyPath, khPath, 1200, {
        onStage: (label) => s.message(`Waiting for k3s on master: ${label}`),
      }),
    );
    bootTimingDue = true;
    state.completeStep('k3s-ready');
    s.stop('k3s reachable');
  }

  // Trusted host-key seed. The SSH opts above pin per-env with accept-new
  // (TOFU on first connect); seeding the known_hosts from a real ssh-keyscan
  // now — on (re)provision, once SSH is reachable — turns accept-new into a
  // strict pin for the rest of this deploy AND every later command, and
  // re-pins a Hetzner-recycled IP cleanly (seedKnownHosts drops the stale
  // per-IP line). Best-effort: if ssh-keyscan can't reach a node we fall back
  // to accept-new TOFU. See host-keys.js seedKnownHosts for the full security
  // rationale (why only provisioning re-seeds). Every node is scanned at once,
  // so the cluster pays for its slowest node rather than the sum (13 s for the
  // two DO tor1 standby nodes on an evening path); concurrent seeds of one
  // file are safe, each merge runs after its own scan with no await inside.
  await perfAsync(`deploy.${perfPrefix}.hostKeys`, () =>
    Promise.all(
      [masterIp, dbIp, ...(workerIps ?? [])]
        .filter(Boolean)
        .map((ip) => seedKnownHosts(khPath, ip)),
    ),
  );

  // First-boot timing (`[perf] deploy.<perfPrefix>.<node>.boot.*`, VIBECARBON_PERF only):
  // queued now, read once the command is over (lib/deploy/boot-timing.js).
  if (bootTimingDue) {
    queueBootTiming(
      [
        { ip: masterIp, prefix: `deploy.${perfPrefix}.master` },
        { ip: dbIp, prefix: `deploy.${perfPrefix}.db` },
        ...(workerIps ?? []).map((ip, i) => ({
          ip,
          prefix: `deploy.${perfPrefix}.worker${i + 1}`,
        })),
      ],
      privateKeyPath,
    );
  }

  // HA fan-out hook: surface this cluster's infra identity the moment the
  // nodes exist, k3s answers, and host keys are pinned — the HA deploy uses
  // it to start replication transport prep (WireGuard + gateways) while this
  // cluster's manifests/helm are still installing. Fire-and-forget: the
  // callback is not awaited and must never fail this deploy.
  if (typeof options.onInfraReady === 'function') {
    try {
      options.onInfraReady({ masterIp, floatingIp, dbIp, dbPrivateIp });
    } catch {
      // opportunistic hook — a listener bug must not break the deploy
    }
  }

  // HA fan-out hook: the `vibecarbon` namespace exists, so the replication
  // gateways can be applied into it. Fired from applyK3sManifests right after
  // applyVibecarbonSecrets creates it, or below when the apply is skipped.
  // Same contract as onInfraReady: never awaited, never fails this deploy.
  const signalNamespaceReady = () => {
    try {
      options.onNamespaceReady?.();
    } catch {
      // opportunistic hook — a listener bug must not break the deploy
    }
  };

  // The app's runtime base, pulled onto the master now so the layer delta in
  // applyK3sManifests, minutes later, sends only the app's own layers (ruling
  // R3). Only an operator-built image has one (a standby copies the primary's
  // image), and a Dockerfile without the RUNTIME_IMAGE ARG has none: the delta
  // then sends every layer, the same algorithm. Not awaited here: deliverImage
  // awaits it and owns its failure; the catch only keeps a pull that fails
  // before then from surfacing as an unhandledRejection.
  const { readRuntimeBaseRef } = await import('../image.js');
  const baseRef = planImageDelivery({ role: options.role }).deliver
    ? readRuntimeBaseRef(projectDir)
    : null;
  const basePull = baseRef
    ? perfAsync(`deploy.${perfPrefix}.image.basePull`, () =>
        pullK3sRuntimeBase({ masterIp, sshKeyPath: privateKeyPath, baseRef }),
      )
    : undefined;
  basePull?.catch(() => {});

  // The wal-g-equipped db image is a pre-published image pulled from ghcr —
  // no per-deploy build or delivery. The db StatefulSet's container and both
  // its walg-restore init reference it (see buildDbManifestValues).
  const dbImageTag = resolveDbImageTag();

  // Opportunistic image pre-pull on every node — deliberately NOT awaited: it
  // overlaps the build/manifest work below so kubelet finds the
  // images already present when the db StatefulSet starts (its image pull
  // is a cold boot's first cost) and when the cluster-autoscaler rollout wait
  // starts (a 403'd CA pull ate the full 300s budget on 2026-07-31). Any
  // failure just means kubelet pulls on demand.
  const prePullStart = Date.now();
  prePullImages({
    nodeIps: [masterIp, dbIp, ...(workerIps ?? [])],
    sshKeyPath: privateKeyPath,
    khPath,
    extraImages: [dbImageTag],
  })
    .then((r) => console.error(formatPrePullSummary(r, Date.now() - prePullStart)))
    .catch((err) =>
      console.error(
        `[prepull] skipped (${(err?.message || String(err)).slice(0, 120)}), kubelet pulls on demand`,
      ),
    );

  // 5. Fetch + patch kubeconfig
  let kubeconfig;
  if (!state.shouldSkip('k3s-kubeconfig', { masterIp })) {
    state.startStep('k3s-kubeconfig', { masterIp });
    s.start('Retrieving kubeconfig');
    kubeconfig = await perfAsync(`deploy.${perfPrefix}.kubeconfig`, () =>
      fetchKubeconfig(masterIp, privateKeyPath, khPath, projectDir, options.environment),
    );
    state.completeStep('k3s-kubeconfig', { kubeconfig });
    s.stop('Kubeconfig saved');
  } else {
    // A resumed deploy reuses the kubeconfig its last run fetched, which an
    // older CLI may have written without disable-compression. The deploy is
    // that file's writer, so it may bring it up to date; readers never do.
    kubeconfig = await upgradeKubeconfig(state.getStepResult('k3s-kubeconfig').kubeconfig);
  }

  // 5b. The cluster's restore marker decides what this deploy may do (a
  //     pending restore stops a plain deploy; a running database stops
  //     `deploy -restore`). Outside every step gate on purpose: a skipped
  //     k3s-apply must not skip it. Before the image is recorded or
  //     delivered, so a refusal changes nothing on the cluster.
  //     The control-plane gate is the deploy's only one: it proves the
  //     apiserver serves (discovery and admission) for the marker read and
  //     for everything applyK3sManifests does next, since nothing between
  //     here and that apply touches k3s (the image wait is local or over the
  //     peer; the apply gate's registry probe is ssh).
  {
    const kubeEnv = { ...process.env, KUBECONFIG: kubeconfig };
    // Beside the gate, which makes the same kind of call to the same apiserver,
    // so a warning costs the deploy no extra wait.
    const skewNotice = kubectlSkewNotice({ env: kubeEnv });
    await perfAsync(`deploy.${perfPrefix}.controlPlane.gate`, () =>
      awaitControlPlaneServing({ env: kubeEnv }),
    );
    const skew = await skewNotice;
    if (skew) progressLog(skew);
    await perfAsync(`deploy.${perfPrefix}.restoreMarker`, () =>
      assertRestoreMarkerState({
        env: kubeEnv,
        restore: options.restore ?? null,
        operatorEnv: options.operatorEnv ?? options.environment,
      }),
    );
  }

  // 6-7. The app image: finish the build started before provisioning (or
  // build it now), or, on a k8s-ha standby, take the primary's ref
  // (deliverAppImage). applyK3sManifests delivers a built one to the master's
  // registry.
  // The span is the wait for it: the early build's own time is
  // `image.localBuild`.
  const imageTag = await perfAsync(`deploy.${perfPrefix}.image.ready`, () =>
    deliverAppImage({
      early,
      role: options.role,
      peerImageRef: options.peerImageRef,
      onImageBuilt: options.onImageBuilt,
      state,
      projectDir,
      projectName: options.projectName,
      domain: options.domain,
      masterPrivateIp,
      spinner: s,
    }),
  );

  // 8. Apply manifests (the db StatefulSet included) + roll out the app.
  // The gate folds the CONTENT of BOTH applied manifest trees (the project
  // copy and the CLI's own bundled `carbon/k8s`) into its inputs — see
  // buildK3sApplyInputs for why each one is load-bearing.
  const applyInputs = buildK3sApplyInputs({
    imageTag,
    dbImageTag,
    restore: options.restore,
    projectDir,
    // The db StatefulSet's PVC class is rendered from this provider static,
    // and no manifest digest can see it — see buildK3sApplyInputs.
    storageClass: Provider.K8S_STORAGE_CLASS,
    // The pilot-light role: a failover swaps it between stacks, and each
    // role renders a different cluster — see buildK3sApplyInputs.
    role: options.role,
    // A re-minted app storage key must reach the app Secret.
    appStorageAccessKey: options.s3Config?.appCredential?.accessKey,
    // The schedule and retention rendered into the backup CronJob/ConfigMap.
    backupConfig: options.backupConfig,
    // Where the app bucket and the backups bucket are, rendered into the
    // Secrets and the db StatefulSet.
    s3Config: options.s3Config,
    backupTarget: options.backupTarget,
  });
  const skipApply = await shouldSkipK3sApply({
    state,
    applyInputs,
    role: options.role,
    imageInRegistry: () =>
      primaryRegistryHasImage({ masterIp, sshKeyPath: privateKeyPath, imageTag }),
  });
  // When the apply's restore wrote Secret/vibecarbon-tls; null when it did
  // not (or the apply was skipped). The TLS phase reads it.
  let tlsRestoredAt = null;
  if (!skipApply) {
    state.startStep('k3s-apply', applyInputs);
    s.start('Applying k8s manifests + starting the database + rolling out app');
    const envLocal = loadEnvLocal(join(projectDir, '.env.local'));
    const applied = await perfAsync(`deploy.${perfPrefix}.applyManifests`, () =>
      applyK3sManifests({
        inFlight,
        perfPrefix,
        kubeconfig,
        projectDir,
        projectName: options.projectName,
        imageTag,
        dbImageTag,
        envLocal,
        domain: options.domain || 'localhost',
        s3Config: options.s3Config,
        backupTarget: options.backupTarget,
        backupConfig: options.backupConfig,
        restore: options.restore,
        operatorEnv: options.operatorEnv ?? options.environment,
        // Phase 5: cluster-autoscaler wiring. apiToken (the Hetzner Cloud
        // token CCM/CSI/Pulumi already use) flows in here under its own
        // name to make the CA Secret apply unambiguous; the k3sToken
        // came back from Pulumi outputs in `k3s-infra` step.
        apiToken: options.apiToken,
        // Task 8: same resolution deployK3s already did above (`Provider =
        // providerFor(options)`) — threaded through so
        // renderCarbonAutoscalerConfig can set the config's `provider` id
        // and `providerIdPrefix` without re-deriving either.
        providerId: providerIdFor(options),
        ProviderClass: Provider,
        sshKeyName: options.sharedSshKeyName,
        region: options.region,
        environment: options.environment,
        // Pilot-light: 'primary' | 'standby' | undefined — drives walgRole
        // and the zeroed standby app tier. The k8s-ha fan-out
        // (Task 6) passes this; single-cluster deploys leave it undefined
        // (== primary behavior).
        role: options.role,
        minWorkers,
        maxWorkers,
        // Task 6: dormant CA bounds — undefined on single-cluster/primary
        // (applyK3sManifests defaults caBoundsMin to minWorkers itself).
        caBoundsMin: options.caBoundsMin,
        workerServerType:
          options.workerServerType || options.serverType || Provider.DEFAULT_K8S_NODE_TYPE,
        k3sToken: infraOutputs.k3sToken,
        // The image delivery's target (the master only) and the base pull
        // started at infra-ready, which deliverImage awaits.
        masterIp,
        sshKeyPath: privateKeyPath,
        basePull,
        onNamespaceReady: signalNamespaceReady,
        // M3 Task 2: the master's own private IP — renderCarbonAutoscalerConfig
        // (CA-spawned worker join target) and the registry hostPort render.
        // Already in scope from infraOutputs (returned below).
        masterPrivateIp,
        // M3 Task 9c: this cluster's VPC CIDR — drives the provider-
        // conditional S3-egress-VPC-allowance manifest. Already in scope
        // from infraOutputs (destructured above with its resume-compat
        // fallback).
        vpcCidr,
      }),
    );
    tlsRestoredAt = applied?.tlsRestoredAt ?? null;
    state.completeStep('k3s-apply');
    s.stop('App rolled out');
  } else {
    // Skipped apply: a prior one created the namespace.
    signalNamespaceReady();
  }

  // 8a. The live wal-g role, on EVERY deploy — outside the `k3s-apply` gate
  //     for the same reason as the audit below: db-guard.sh applies the intent
  //     only at container start, so a db this deploy did not restart (or a
  //     deploy whose apply was skipped) keeps whatever role file it had. The
  //     intent and the file are set to this deploy's role and read back
  //     before the audit, so the audit reads the role this deploy set; a role
  //     vibecarbon-db-role already proves needs no exec. A skipped apply
  //     waited for no db and rolled none, so it waits on the pod's Ready from
  //     the API: the write never races a starting pod, and a deploy with
  //     nothing to do does not exec only to ask if the db is up.
  if (skipApply) {
    await awaitDbPodReady({ env: { ...process.env, KUBECONFIG: kubeconfig } });
  }
  await perfAsync(`deploy.${perfPrefix}.walgRole`, () =>
    writeDeployWalgRole({
      kubectl: localWalgRoleKubectl(kubeconfig),
      role: options.role === 'standby' ? 'standby' : 'primary',
      envName: options.operatorEnv ?? options.environment,
    }),
  );

  // 8b. Ground-truth BACKUP audit — OUTSIDE the `k3s-apply` gate on purpose.
  //     Every other post-apply check verifies something this deploy just did,
  //     so gating them on "did anything change" is sound. Backups are the
  //     exception: their subject is EXTERNAL and rots with zero in-cluster
  //     change — keys revoked or rotated at the provider, a bucket deleted or
  //     lifecycle-expired, egress newly firewalled. `buildK3sApplyInputs`
  //     hashes image tags + restore + manifest digests, all of which are
  //     identical on exactly the redeploy most likely to be carrying rotted
  //     credentials, so from inside the gate this audit would never run again
  //     until something unrelated forced an image change — green gate, dead
  //     backups. Compose runs its audit on every deploy; this keeps k8s honest
  //     with it. Cost is one S3 LIST.
  //     Gated on S3 being configured at all (mirrors the archiving-enable
  //     block); the probe independently re-checks that from inside the
  //     container. Not on a standby: the probe only reads the role file and
  //     skips, and the step above just proved that file reads standby, so the
  //     exec could learn nothing.
  //     THROWS on failure — see src/lib/deploy/walg-audit.js.
  if (options.s3Config?.accessKey && options.role !== 'standby') {
    await perfAsync(`deploy.${perfPrefix}.verifyWalgBackups`, () =>
      verifyWalgBackups({ kubeconfig }),
    );
  }

  // 8c. `deploy -restore`: the first base backup on the restored timeline
  //     (post-promote-backup.js), once the app is up and archiving is proven.
  //     finishDeployRestore retired .vc-prev and removed the discard, so the
  //     base holds the restored cluster only. Outside the `k3s-apply` gate: a
  //     rerun after a failed push skips the apply, never the push. A failure
  //     fails the deploy with the one message.
  if (options.restore) {
    s.start('Pushing the first base backup on the restored timeline');
    const { name } = await perfAsync(`deploy.${perfPrefix}.restore.basePush`, () =>
      pushBaseBackupAfterPromote({
        tier: 'k8s',
        ip: masterIp,
        sshKeyPath: privateKeyPath,
        envName: options.operatorEnv ?? options.environment,
      }),
    );
    s.stop(`Base backup ${name} pushed on the restored timeline`);
  }

  // 9. Cluster details
  return {
    masterIp,
    floatingIp,
    dbIp,
    // The database node's Hetzner private-network IP (deterministic in the IaC
    // program, but threaded through the output rather than hardcoded at the use
    // site). setupReplication renders it into the repl-gateway egress
    // NetworkPolicy + socat bind for this cluster.
    dbPrivateIp,
    // The master's private IP: the registry hostPort bind the standby image
    // copy's relay targets (withRegistryRelay).
    masterPrivateIp,
    workerIps,
    networkId,
    kubeconfig,
    sshKeyPath: privateKeyPath,
    imageTag,
    tlsRestoredAt,
  };
}
