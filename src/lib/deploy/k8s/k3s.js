/**
 * k3s-on-Hetzner deploy backend.
 *
 * The Pulumi program is `hetzner-k8s.js`; cloud-init scripts are
 * `carbon/cloud-init/k3s/{master,db,worker}-init.sh`.
 *
 * End-to-end flow on a cold deploy:
 *   1. Preflight: docker, ssh, kubectl, helm on PATH; server-type architecture.
 *   2. Generate (or reuse) the SSH keypair under projectDir/.vibecarbon/ssh-<env>.
 *   3. Pulumi up — cloud-init installs k3s + hcloud-ccm/csi on each node.
 *   4. Wait for SSH on master + `/tmp/k3s-ready` marker.
 *   5. scp `/etc/rancher/k3s/k3s.yaml` from master, patch server URL to public IP.
 *   6. Build app image locally (10.0.1.1:5000/<project>:<sha>[-dirty]-<ts>).
 *   7. Sideload via `docker save TAG | ssh node 'k3s ctr images import -'` per node.
 *   8. `kubectl apply -k` a rendered copy of `k8s/base/` (db StatefulSet,
 *      traefik, app; cert-manager via infra/).
 *   9. `kubectl rollout status statefulset/db`.
 *   10. `kubectl set image deploy/app app=<tag>` + rollout-status.
 *
 * Warm path: skip 1-5; rebuild image (6); sideload (7) skipping unchanged tag;
 * apply changed manifests (8); rollout (10).
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
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { progressLog, spinner } from '../../cli/progress.js';
import { checkDependency, runCommandAsync } from '../../command.js';
import { DNS01_PROVIDERS } from '../../dns-provider.js';
import { parseDotenv } from '../../dotenv.js';
import { buildHostKeyOptsForPath, knownHostsPath, seedKnownHosts } from '../../host-keys.js';
import {
  carbonAutoscalerImageRef,
  clusterAutoscalerImageRef,
  csiSidecarSetImagePlan,
  resolveDbImage,
} from '../../images.js';
import { readOperatorVar } from '../../operator-env.js';
import { perfAsync } from '../../perf.js';
import { providerFor, providerIdFor } from '../../providers/index.js';
import { pollUntil, runWithRetry } from '../../retry.js';
import { shEscape } from '../../shell.js';
import { scpWithRetry } from '../../ssh.js';
import { APP_RUNTIME_KEYS, appStorageCredential, buildAppRuntimeEnv } from '../app-runtime-env.js';
import { collectComposeBuildArgs } from '../compose/build-args.js';
import { DB_CONTAINER, DB_POD, DB_POD_SELECTOR, DB_PVC, DB_STATEFULSET } from '../db-workload.js';
import { digestDir, digestPaths } from '../digest.js';
import { pushImageOverSshTunnel } from '../registry-push.js';
import { buildStandbySeedInitScript } from '../replication.js';
import { RLS_AUDIT_SQL, rlsAuditFailureMessage } from '../rls-audit.js';
import {
  assertWalgBackupsWorking,
  k8sWalgAuditArgv,
  WALG_AUDIT_PROBE_TIMEOUT_MS,
} from '../walg-audit.js';
import { REPL_GATEWAY_PORT } from '../wireguard.js';
import { PROMOTE_ISSUER_ANNOTATION, STANDBY_SELFSIGNED_ISSUER } from './acme-issuer-policy.js';
import {
  awaitAppAdminReady,
  awaitCertManagerAdmission,
  awaitControlPlaneServing,
  awaitPostgresAccepting,
  watchAppMigrationFailure,
} from './readiness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const K3S_VERSION = 'v1.31.5+k3s1';

// The vibecarbon CLI's OWN bundled k8s manifest tree (the `carbon/k8s/`
// shipped inside the installed package), as opposed to `projectDir/k8s` —
// the per-project copy `create` lays down. Both feed the `k3s-apply` step:
// the project copy via `kubectl apply -k`, this one via the conditional
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
 * without also forcing a rebuild and a 5-10 minute re-sideload of a
 * byte-identical image. `tests/unit/deploy/k3s-build-gate-inputs.test.ts` pins
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
 * `k3s-sideload` skipped on that same tag and `k3s-apply` saw an unchanged
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
 * timestamp), and both downstream gates key off that tag — `k3s-sideload` via
 * `sideloadInputs.imageTag` and `k3s-apply` via `buildK3sApplyInputs` — so one
 * busted digest cascades through the whole chain exactly as a cold deploy does.
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
 *     `kubectl apply -k` (added 2026-07-11 for the prod content-blind-gate bug).
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
 * self-signed issuer and renders WALG_ROLE=standby into the db StatefulSet.
 * Each cluster keeps its own deploy-state file keyed by its STACK name, and a
 * failover swaps which stack holds which role without touching either file. So
 * without this key the post-failover reconverge redeploy found byte-identical
 * inputs on both stacks and SKIPPED the apply on both: the promoted cluster
 * never got its observability stack (no Grafana IngressRoute, the SPA answered
 * /admin/grafana; e4 run 2026-10-20) and the demoted one kept its primary-shaped
 * render. Normalized the same way as walgRole below, so single-cluster deploys
 * (role undefined) hash as 'primary'.
 *
 * @param {{ imageTag: string, dbImageTag: string, restore?: string, projectDir: string, storageClass?: string, role?: 'primary'|'standby' }} args
 * @returns {{ imageTag: string, dbImageTag: string, restore: string, storageClass: string, role: 'primary'|'standby', manifestDigest: string, bundledManifestDigest: string }}
 */
export function buildK3sApplyInputs({
  imageTag,
  dbImageTag,
  restore,
  projectDir,
  storageClass,
  role,
}) {
  return {
    imageTag,
    dbImageTag,
    restore: restore ?? '',
    storageClass: storageClass ?? '',
    role: role === 'standby' ? 'standby' : 'primary',
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
  const hash = createHash('sha256');
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

/** The db image is pre-published + multi-arch — pulled, never built/sideloaded. */
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
 * @param {string[]} args kubectl argv
 * @param {{env: NodeJS.ProcessEnv, input?: string, captureStdout?: boolean, description?: string}} options
 * @returns {Promise<string>} stdout (always returned; empty when nothing was emitted)
 */
export async function runKubectlWithRetry(
  args,
  { env, input, captureStdout = false, description, transientExtra, delaysMs } = {},
) {
  const RETRY_DELAYS_MS = delaysMs ?? [2000, 4000];
  const ATTEMPTS = RETRY_DELAYS_MS.length + 1;
  const desc = description ?? `kubectl ${args.slice(0, 4).join(' ')}`;
  try {
    return await runWithRetry(
      async () => {
        try {
          const out = await runCommandAsync(['kubectl', ...args], { env, input, silent: true });
          // Stream captured stdout through to the operator's terminal so the
          // success path looks identical to the legacy `stdio: 'inherit'` shape.
          // captureStdout suppresses stdout streaming because the caller wants
          // the bytes (e.g. `kubectl get -o jsonpath`).
          if (!captureStdout && out) process.stdout.write(out);
          return out;
        } catch (err) {
          if (!captureStdout && err.stdout) process.stdout.write(err.stdout);
          if (err.stderr) process.stderr.write(err.stderr);
          throw err;
        }
      },
      {
        delaysMs: RETRY_DELAYS_MS,
        isTransient: (err) => {
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
    throw new Error(
      `${desc} failed with exit ${err.status ?? '?'}: ${(err.stderr ?? '').toString().trim().slice(-500)}`,
    );
  }
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
    sshKeyName: `${clusterName}-${region}-key`,
    firewallName: `${clusterName}-firewall`,
    networkName: `${clusterName}-network`,
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Matches a ClusterIssuer name ending in a DNS01_PROVIDERS key (e.g.
 * `letsencrypt-prod-hetzner`) — generated once from the table's own keys so
 * `certificateDnsNames` can't drift from `pickIssuerName`'s provider suffixes.
 */
const DNS01_ISSUER_SUFFIX_PATTERN = new RegExp(`-(${Object.keys(DNS01_PROVIDERS).join('|')})$`);

/**
 * Map (dnsProvider, acmeServer) → ClusterIssuer name that
 * `applyK3sManifests` patches into `Certificate/vibecarbon-tls`.
 *
 * - cloudflare/hetzner: DNS-01 solver — works behind reverse proxies and
 *   has no port-80 dependency. Requires per-provider Secret + (for
 *   hetzner) the cert-manager-webhook-hetzner deployment.
 * - manual (default): HTTP-01 solver — needs port 80 reachable from
 *   Let's Encrypt. Used when no programmable DNS provider is wired up.
 *
 * Unknown providers fall back to `manual` so a future enum addition
 * never deploys a Certificate that references a non-existent issuer.
 *
 * @param {{dnsProvider?: string|null, acmeServer?: string|null}} args
 * @returns {string}
 */
export function pickIssuerName({ dnsProvider, acmeServer }) {
  const stage = (acmeServer || '').includes('staging') ? 'staging' : 'prod';
  const providerSuffix = DNS01_PROVIDERS[dnsProvider] ? dnsProvider : 'manual';
  return `letsencrypt-${stage}-${providerSuffix}`;
}

/**
 * Build the `dnsNames` list for the `Certificate/vibecarbon-tls` patch.
 *
 * DNS-01 issuers (cloudflare, hetzner) support wildcard SANs — cert-manager
 * can obtain `*.${domain}` in a single ACME order, covering every subdomain
 * (api, dashboard, grafana, n8n …) without separate per-subdomain
 * certificates. One wildcard cert = no per-router cert-resolver needed =
 * no per-domain ACME rate-limit risk.
 *
 * Manual issuers use HTTP-01 which cannot issue wildcards, so fall back to
 * the apex domain only (the IngressRoutes already work; only non-apex
 * subdomains are uncovered, but those are admin-only tools the operator
 * configures manually for manual-DNS deploys).
 *
 * @param {string} domain - The apex deploy domain, e.g. `e1.carbonstack.dev`
 * @param {string} issuerName - The ClusterIssuer name, e.g.
 *   `letsencrypt-prod-hetzner`, produced by `pickIssuerName`
 * @returns {string[]}
 */
export function certificateDnsNames(domain, issuerName) {
  // Only the known DNS-01 providers (DNS01_PROVIDERS keys — cloudflare,
  // hetzner) support wildcard SANs. `manual` and any future/unknown issuer
  // name falls back to apex-only so an unrecognised issuer never attempts a
  // wildcard via HTTP-01 (which LE rejects). Generated from the same table
  // pickIssuerName/buildDnsProviderSecret read, so a row is one place that
  // grants wildcard capability instead of a separately-maintained regex.
  const isDns01 = DNS01_ISSUER_SUFFIX_PATTERN.test(issuerName);
  if (!isDns01) return [domain];
  // DNS-01 issuers (cloudflare, hetzner — prod or staging): issue one wildcard.
  return [domain, `*.${domain}`];
}

/**
 * Build the `dnsNames` list for the observability add-on's `grafana-tls`
 * Certificate — apex only, ALWAYS, never the wildcard.
 *
 * Grafana is routed by `PathPrefix('/admin/grafana')` with no `Host()` clause
 * (services/observability/k8s/ingressroute.yaml), so it is only ever served
 * on the apex domain and the wildcard SAN buys it nothing.
 *
 * It costs plenty, though. This Certificate lives in
 * vibecarbon-observability because Traefik cannot read a TLS Secret across
 * namespaces, so the cluster necessarily holds TWO Certificates for the same
 * site against the SAME ClusterIssuer — i.e. the same ACME account. When
 * both ask for the IDENTICAL identifier set, Boulder hands them the SAME
 * ACME order, because it "may return a previously created Order when a given
 * Account submits a new Order that is identical to a previously submitted
 * Order that is in the 'pending' or 'ready' state"
 * (letsencrypt/boulder docs/acme-implementation_details.md). Both Order
 * controllers then validate and both call finalize; the loser gets
 *   403 orderNotReady :: Order was already processing
 * and cert-manager marks that Order Errored — terminally, because
 * finalizeOrder only recovers from a 403 when the re-fetched ACME order is
 * "valid", not "processing" (cert-manager#8960, PR#8968, unfixed as of the
 * v1.20.2 we pin). That is what took down the 2026-08-11 e2e hetzner/k8s
 * restore: challenges valid, order errored, cert never issued.
 *
 * Requesting `[domain]` here while the app cert requests
 * `[domain, *.domain]` keeps the two identifier sets DISTINCT, so Boulder
 * issues two independent orders and the shared-order race cannot arise.
 * It also stops the two certs from sharing one Let's Encrypt
 * duplicate-certificate bucket (5 identical FQDN sets per week), which two
 * identical requests per deploy would otherwise exhaust in three deploys.
 *
 * NOTE the residue: under a `manual` (HTTP-01) issuer the app cert is also
 * apex-only, so both sets are `[domain]` again and the race is still
 * reachable. HTTP-01 cannot validate a SAN that does not already resolve, so
 * there is no identifier we could add to separate them. That path is covered
 * at runtime by the watchdog in ./acme-order-recovery.js.
 *
 * @param {string} domain - The apex deploy domain, e.g. `e1.carbonstack.dev`
 * @returns {string[]}
 */
export function observabilityCertificateDnsNames(domain) {
  return [domain];
}

/**
 * Render the per-DNS-provider Secret YAML that cert-manager's DNS-01
 * solvers read for API auth, or null when the provider doesn't need a
 * Secret (`manual` uses HTTP-01).
 *
 * - cloudflare: `cloudflare-api-token` / key `api-token` — referenced by
 *   `letsencrypt-{prod,staging}-cloudflare`.
 * - hetzner: `hetzner` / key `token` — referenced by
 *   `letsencrypt-{prod,staging}-hetzner` AND by the official
 *   `cert-manager-webhook-hetzner` chart (matches the chart's expected
 *   `tokenSecretKeyRef` shape). The token here is the SAME Cloud API
 *   token used elsewhere — Hetzner shut down the separate DNS Console
 *   API in May 2026 and folded zone management into the main Cloud
 *   Console + api.hetzner.cloud/v1/zones.
 * - digitalocean: `digitalocean-dns` / key `access-token` — the shape
 *   cert-manager's own docs specify for its native
 *   `dns01.digitalocean.tokenSecretRef` solver; referenced by
 *   `letsencrypt-{prod,staging}-digitalocean`.
 *
 * `dnsToken` is the single credential for whichever provider is selected —
 * the caller resolves it, this function only decides where it lands.
 *
 * Throws when a token is required but missing — the early throw makes
 * "Order pinned Pending forever" failures show up at deploy-start with
 * an actionable error message instead.
 *
 * @param {{dnsProvider?: string|null, dnsToken?: string|null}} args
 * @returns {{name: string, yaml: string}|null}
 */
export function buildDnsProviderSecret({ dnsProvider, dnsToken }) {
  const row = DNS01_PROVIDERS[dnsProvider];
  if (!row) return null;
  if (!dnsToken) {
    throw new Error(row.missingTokenError);
  }
  return {
    name: row.secretName,
    yaml: [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      `  name: ${row.secretName}`,
      '  namespace: cert-manager',
      'type: Opaque',
      'stringData:',
      `  ${row.secretKey}: ${JSON.stringify(dnsToken)}`,
    ].join('\n'),
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
 * @property {Object} [s3Config]
 */

/**
 * Generate or reuse an SSH keypair for this environment.
 * Stored under projectDir/.vibecarbon/ssh-<env>{,.pub}.
 *
 * @param {string} projectDir
 * @param {string} environment
 * @returns {Promise<{privateKeyPath: string, publicKey: string}>}
 */
export async function ensureSshKey(projectDir, environment) {
  const dir = join(projectDir, '.vibecarbon');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const privateKeyPath = join(dir, `ssh-${environment}`);
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
  // pipelines like sideloadK3s) plus the ConnectTimeout/ServerAlive
  // keepalives from the banner-exchange-hang RCA (see host-keys.js).
  return buildHostKeyOptsForPath(khPath);
}

/**
 * Block until the cloud-init `/tmp/k3s-ready` marker appears via SSH.
 * Cloud-init writes this after `kubectl get nodes` shows the master Ready.
 *
 * Exponential backoff (2s → 4s → 8s, capped at 15s) so early-ready nodes
 * (~80s on the spike) aren't held back. Long tails still back off so we
 * don't hammer SSH during slow boots.
 *
 * @param {string} masterIp
 * @param {string} sshKeyPath
 * @param {string} khPath - per-env known_hosts file path
 * @param {number} [maxWaitSec]
 * @returns {Promise<void>}
 */
export async function waitForK3sReady(masterIp, sshKeyPath, khPath, maxWaitSec = 600) {
  try {
    await pollUntil(
      async () => {
        await runCommandAsync(
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
            'test -f /tmp/k3s-ready',
          ],
          { silent: true },
        );
        return true;
      },
      {
        budgetMs: maxWaitSec * 1000,
        // Tight tail (default is 15s): a cold node flips /tmp/k3s-ready in one
        // step, so a 15s backoff would add up to ~15s of dead time past the
        // actual-ready moment. 5s caps that at ~5s; the extra SSH probes are
        // ~1s ConnectTimeout=5 round-trips, cheap against the saved tail.
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        description: 'k3s ready flag',
      },
    );
  } catch (err) {
    // Capture cloud-init + syslog before throwing so the failure log says
    // WHY install timed out (apt slow? k3s download 5xx? script crashed?)
    // instead of just "300s passed and the marker isn't there." Best-effort —
    // if the box is unreachable, captureK3sInstallDiag returns an empty string
    // and we surface only the SSH probe error.
    const lastErr = err.cause ?? err;
    const diag = await captureK3sInstallDiag(masterIp, sshKeyPath, khPath);
    throw new Error(
      `k3s did not become ready on ${masterIp} within ${maxWaitSec}s. ` +
        `Last SSH error: ${lastErr instanceof Error ? lastErr.message : 'unknown'}` +
        (diag ? `\n\n--- install diagnostics from ${masterIp} ---\n${diag}` : ''),
    );
  }
}

/**
 * scp the master's kubeconfig and patch its server URL to point at the
 * public master IP (cloud-init writes `127.0.0.1:6443`, useless from
 * the operator's laptop).
 *
 * @param {string} masterIp
 * @param {string} sshKeyPath
 * @param {string} khPath - per-env known_hosts file path
 * @param {string} projectDir
 * @param {string} environment
 * @returns {Promise<string>} absolute path to the local kubeconfig
 */
export async function fetchKubeconfig(masterIp, sshKeyPath, khPath, projectDir, environment) {
  const localPath = join(projectDir, '.vibecarbon', `kubeconfig-${environment}`);
  await scpWithRetry([
    '-i',
    sshKeyPath,
    ...sshHostKeyOpts(khPath),
    `root@${masterIp}:/etc/rancher/k3s/k3s.yaml`,
    localPath,
  ]);
  const kc = readFileSync(localPath, 'utf-8');
  const patched = kc.replace(
    /server: https:\/\/127\.0\.0\.1:6443/g,
    `server: https://${masterIp}:6443`,
  );
  writeFileSync(localPath, patched);
  // Tighten perms — kubeconfig embeds a cluster-admin client cert + key.
  // scp inherits the operator's umask, so without this the file lands at
  // 0644 and helm/kubectl warn "Kubernetes configuration file is
  // world-readable" on every invocation.
  chmodSync(localPath, 0o600);
  return localPath;
}

const CERT_MANAGER_VERSION = 'v1.20.2';
const CERT_MANAGER_URL = `https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml`;
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
 * build / sideload / manifest work, so kubelet finds the images already
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

// cert-manager-webhook-hetzner (third-party chart for the Hetzner DNS-01
// solver): repo/chart/version/release-name now live on
// DNS01_PROVIDERS.hetzner.webhook in src/lib/dns-provider.js — see that
// row's comment for the pinning rationale.

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
 * `<masterPrivateIp>:5000/<projectName>:<sha>[-dirty]-<utcTimestamp>`.
 *
 * The `<masterPrivateIp>:5000/` prefix points at the master's local OCI
 * registry pod (Phase 1's `registries.yaml` configures kubelet on every
 * node to resolve `<masterPrivateIp>:5000` → that pod). `masterPrivateIp`
 * defaults to Hetzner's static `10.0.1.1` (see hetzner-k8s.js) so every
 * pre-M3 caller keeps producing byte-identical tags; deployK3s threads the
 * real value from `infraOutputs.masterPrivateIp` (M3 — DO can't pin VPC
 * IPs the way Hetzner's program does). The same tag is used at every step
 * (build → sideload → push → Deployment), so:
 *   - static workers get the image via `sideloadK3s` (containerd cache
 *     hit, kubelet `imagePullPolicy: IfNotPresent` finds it),
 *   - CA-spawned workers (which don't exist at sideload time) pull the
 *     same tag from master's registry pod via `registries.yaml`.
 *
 * @param {string} projectDir
 * @param {string} projectName
 * @param {boolean} [rebuild]
 * @param {string} [domain]
 * @param {string} [masterPrivateIp]
 * @returns {Promise<{tag: string, gitSha: string, isDirty: boolean}>}
 */
export async function buildAppImage(
  projectDir,
  projectName,
  rebuild = false,
  domain = undefined,
  masterPrivateIp = '10.0.1.1',
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
  return await buildLocalImage(projectDir, {
    projectName,
    rebuild,
    tagPrefix: `${masterPrivateIp}:5000`,
    buildArgs,
  });
}

/**
 * Wait until the `k3s` binary is installed and on PATH on a given node.
 *
 * waitForK3sReady only polls the master's /tmp/k3s-ready marker. Workers
 * and the database node run their own k3s install asynchronously
 * (worker-init.sh / db-init.sh) which can take 1-3 min after the
 * master is ready (apt update, dpkg locks, k3s install script). If
 * sideload runs in that window, the remote `k3s ctr images import -`
 * exits 127 ("command not found") and one node's import fails,
 * cancelling the entire batch (observed 2026-04-26 e2e run #2 —
 * worker @ 204.168.185.124 returned 127).
 *
 * We poll up to maxWaitSec for `command -v k3s` to succeed. Cheap (~10ms
 * SSH per probe), idempotent, and resolves the race without changing
 * cloud-init.
 *
 * @param {string} target - SSH target (e.g. root@1.2.3.4)
 * @param {string} sshKeyPath
 * @param {string} khPath - per-env known_hosts file
 * @param {number} [maxWaitSec=300]
 * @returns {Promise<void>}
 */
export async function waitForK3sBinary(target, sshKeyPath, khPath, maxWaitSec = 300) {
  try {
    await pollUntil(
      async () => {
        await runCommandAsync(
          [
            'ssh',
            '-i',
            sshKeyPath,
            ...sshHostKeyOpts(khPath),
            '-o',
            'ConnectTimeout=5',
            '-o',
            'BatchMode=yes',
            target,
            'command -v k3s >/dev/null',
          ],
          { silent: true },
        );
        return true;
      },
      {
        budgetMs: maxWaitSec * 1000,
        // Tight tail — same rationale as waitForK3sReady: don't pay a 15s
        // backoff past the moment `command -v k3s` first succeeds.
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        description: 'k3s binary on PATH',
      },
    );
  } catch (err) {
    // Same diagnostic capture as waitForK3sReady — see that function for why.
    // `target` here is `root@<ip>` form; strip the user@ prefix for the host.
    const lastErr = err.cause ?? err;
    const ip = String(target).includes('@') ? String(target).split('@').pop() : String(target);
    const diag = await captureK3sInstallDiag(ip, sshKeyPath, khPath);
    throw new Error(
      `k3s binary did not appear on ${target} within ${maxWaitSec}s. ` +
        `Last SSH error: ${lastErr instanceof Error ? lastErr.message : 'unknown'}` +
        (diag ? `\n\n--- install diagnostics from ${ip} ---\n${diag}` : ''),
    );
  }
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
 * Sideload an image to every node in a k3s cluster via parallel SSH.
 *
 * Per node: `docker save TAG | ssh -i KEY -o ... TARGET 'k3s ctr images import -'`.
 * Pipeline streams the tarball over SSH; no temp files on either end, no registry.
 * Parallel via Promise.all + spawn — wall-clock dominated by the slowest node.
 *
 * Before each `docker save | ssh` we wait for `command -v k3s` on the target
 * (workers and the database node finish their k3s install asynchronously after the master
 * marker — see waitForK3sBinary). 5-min cap per node; total budget bounded
 * by the deploy step's lifecycle timeout.
 *
 * @param {{tag: string, sshTargets: string[], sshKey: string, khPath: string}} args
 * @returns {Promise<void>}
 */
export async function sideloadK3s({ tag, sshTargets, sshKey, khPath }) {
  if (!sshTargets || sshTargets.length === 0) {
    throw new Error('sideloadK3s: at least one SSH target is required');
  }
  if (!khPath) {
    throw new Error('sideloadK3s: khPath is required');
  }
  const { spawn } = await import('node:child_process');
  // We're going through `bash -c` because of the `docker save | ssh` pipe, so
  // khPath/sshKey/target are interpolated into the shell. shEscape the file
  // paths so spaces in cwd don't break the command (and so a hostile env
  // name — already validated upstream — couldn't smuggle metacharacters).
  const q = shEscape;
  // BatchMode=yes mirrors sshHostKeyOpts() — without it, a missing key on
  // the target falls back to interactive password prompt and the docker
  // save | gzip | ssh pipeline hangs (stdio:'inherit' surfaces the prompt
  // on the operator's terminal).
  const sshOptsStr = `-o UserKnownHostsFile=${q(khPath)} -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
  await Promise.all(
    sshTargets.map(async (target) => {
      // Pre-flight: ensure k3s is on PATH before piping the tarball.
      // Docker save streams ~600MB; if we ssh into a node that doesn't
      // have k3s yet, the import errors mid-stream and we waste the
      // bandwidth + cancel parallel imports on other healthy nodes.
      // 600s mirrors waitForK3sReady — same cold-init story, same
      // remedy as the comment there.
      await waitForK3sBinary(target, sshKey, khPath, 600);

      // Retry the docker-save | ssh pipe on transient failures.
      // Observed in iter-wave1a (2026-05-01): standby k3s sideload failed
      // with `kex_exchange_identification: read: Connection timed out`
      // 21min into a successful deploy — cluster healthy, just an SSH
      // socket flake. Retrying the pipe is the cheapest fix; the cost on
      // the genuine-failure path is one extra ~5-10 min attempt, vs the
      // current cost of throwing away an entire 21-min HA deploy.
      const SIDELOAD_DELAYS_MS = [5_000, 15_000];
      const runOnce = () =>
        new Promise((resolve, reject) => {
          // gzip on the wire: Node app images compress 3-5x (most layers
          // are JS source + node_modules text). Without gzip, sideloading
          // ~600MB to 6 nodes (HA) saturated the laptop's upload at ~25
          // Mbps each, taking 23-29 min wall-clock (e2e run #1+#2).
          // With gzip, the same payload is ~150-200MB → expected 5-10 min.
          // We could reach for `pigz` for parallel compression, but plain
          // `gzip -1` is universally present and dominant cost is network,
          // not CPU. `gunzip` is available on Ubuntu 24.04 cloud-init by
          // default (part of base image). pipefail propagates either side
          // of the pipeline failing.
          const cmd =
            `set -o pipefail && docker save ${q(tag)} | gzip -1 | ` +
            `ssh -i ${q(sshKey)} ${sshOptsStr} ${q(target)} ` +
            `'gunzip | k3s ctr images import -'`;
          const child = spawn('bash', ['-c', cmd], { stdio: 'inherit' });
          child.on('error', (err) =>
            reject(new Error(`sideloadK3s spawn failed for ${target}: ${err.message}`)),
          );
          child.on('exit', (code) => {
            if (code === 0) resolve(undefined);
            else reject(new Error(`sideloadK3s failed on ${target} with exit code ${code}`));
          });
        });

      await runWithRetry(runOnce, {
        delaysMs: SIDELOAD_DELAYS_MS,
        onRetry: (err, attempt) => {
          progressLog(
            `[sideloadK3s] ${target} attempt ${attempt} failed (${err.message}); retrying in ${SIDELOAD_DELAYS_MS[attempt - 1] / 1000}s`,
          );
        },
      });
    }),
  );
}

// PUSH_PERMANENT_PATTERN / isPermanentPushError now live in registry-push.js
// (shared by the compose tier's push too). Re-exported here for API
// stability — no external importers exist today, but the symbols were
// public and free to keep.
export { isPermanentPushError, PUSH_PERMANENT_PATTERN } from '../registry-push.js';

/**
 * Push a locally-built image to the master's local OCI registry.
 *
 * Thin delegate over the shared `pushImageOverSshTunnel` (registry-push.js —
 * settle-on-exit tunnel, bind-race port walk, idempotent teardown, BatchMode /
 * known-hosts opts, transient/permanent push classification, and the settle
 * ladder itself); the k8s registry pod listens on the master's private
 * `<masterPrivateIp>:5000` (Phase 1's `registries.yaml` maps that hostname to
 * the registry pod). `masterPrivateIp` MUST match the value `buildAppImage`
 * used to build `tag` (both default to Hetzner's static `10.0.1.1`) or the
 * shared helper's prefix check throws.
 *
 * Nothing about the push mechanics lives in this file any more — including
 * `-o BatchMode=yes` / `buildHostKeyOptsForPath`, which the shared helper
 * applies to its own tunnel rather than going through this file's
 * `sshHostKeyOpts`. Fix push behavior in registry-push.js, not here; note it
 * is shared with the compose tier, which passes its own shorter
 * `settleDelaysMs` (see `COMPOSE_PUSH_SETTLE_DELAYS_MS`).
 *
 * `masterIp` is validated here (rather than inside the shared helper, which
 * only knows a generic `serverIp`) so this function's own error message
 * stays pinned for existing callers/tests.
 *
 * @param {{
 *   tag: string,
 *   masterIp: string,
 *   sshKey: string,
 *   khPath: string,
 *   settleDelaysMs?: number[],
 *   localTunnelPort?: number,
 *   masterPrivateIp?: string,
 * }} args
 * @returns {Promise<void>}
 */
export async function pushImageToLocalRegistry({
  tag,
  masterIp,
  sshKey,
  khPath,
  settleDelaysMs,
  localTunnelPort = 5000,
  masterPrivateIp = '10.0.1.1',
}) {
  // async (not a plain function returning the delegate's promise) so this
  // synchronous check rejects rather than throwing to the caller directly —
  // callers pass the call expression straight into expect(...).rejects.
  if (!masterIp) throw new Error('pushImageToLocalRegistry: masterIp is required');
  return pushImageOverSshTunnel({
    tag,
    remotePrefix: `${masterPrivateIp}:5000/`,
    serverIp: masterIp,
    sshKey,
    khPath,
    settleDelaysMs,
    localTunnelPort,
  });
}

/**
 * Generated infra passwords that land in Secret `vibecarbon-infra-secrets`,
 * never in the app's Secret. Each is read by key (secretKeyRef), only by the
 * pod that uses it: DB_PASSWORD (the db superuser; the db StatefulSet, and the
 * app's explicit DB_PASSWORD env until it gets its own role), REPL_PASSWORD
 * (the standby's seed init) and the add-on roles' own database passwords
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
 * No VC_ENV: compose's WAL-G prefix reads it, but k8s renders WALG_S3_PREFIX
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
 * app pod mounts none of it except its explicit DB_PASSWORD. Also the Secret
 * `vibecarbon restore` sets RESTORE_TARGET on. Pure.
 *
 * @param {{envLocal: Record<string,string>, s3Config?: {accessKey: string, secretKey: string, bucket: string, endpoint: string, region: string}, backupBucketName?: string|null}} args
 * @returns {Record<string,string>}
 */
export function buildInfraSecretData({ envLocal, s3Config, backupBucketName }) {
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
  if (backupBucketName) {
    stringData.S3_BACKUP_BUCKET = backupBucketName;
  }
  return stringData;
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
 * `backupBucketName` is the dedicated backup bucket (separate from the
 * storage bucket in s3Config.bucket); without it, backup.sh falls back to
 * the storage bucket and uploads dumps next to user files (observed
 * 2026-04-27 k8s-ha matrix #6 — restore couldn't find backups).
 *
 * @param {{kubeconfig: string, envLocal: Record<string,string>, s3Config?: {accessKey: string, secretKey: string, bucket: string, endpoint: string, region: string}, backupBucketName?: string|null}} args
 */
export async function applyVibecarbonSecrets({ kubeconfig, envLocal, s3Config, backupBucketName }) {
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
    'vibecarbon-infra-secrets': buildInfraSecretData({ envLocal, s3Config, backupBucketName }),
  };
  for (const [name, stringData] of Object.entries(secrets)) {
    await runKubectlWithRetry(['apply', '-f', '-'], {
      env,
      input: secretManifest(name, stringData),
      description: `applyVibecarbonSecrets: kubectl apply Secret/${name}`,
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
 * Must run BEFORE `kubectl apply -k k8s/base/observability` so the Grafana
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
 * (when the pre-pull has not finished) and initdb; a standby's first boot adds
 * the seed-standby init's pg_basebackup (up to ~6 minutes of retries before it
 * gives up and lets the serial reseed take over). 15 minutes is the budget the
 * chart install had for the same work.
 *
 * Deliberately longer than DB_STS_BOOT_TIMEOUT_S (600s, src/lib/deploy/
 * replication.js), the shared budget for re-booting an EXISTING db pod (the
 * HA hostPort recreate, the reseed standby boot): those waits pay a CSI
 * re-attach, this one also pays the first provision, the image pull and
 * initdb. Must never drop below that floor:
 * tests/unit/deploy/db-sts-boot-timeout-census.test.ts pins it.
 */
export const DB_ROLLOUT_TIMEOUT_S = 900;

/**
 * The workloads the retired Postgres Helm chart left in a cluster: its db
 * StatefulSet (`<release>-<chart>-db`; the release and the chart shared one
 * name) and Helm's release record (a `sh.helm.release.v1.<release>.v<n>`
 * Secret labelled owner=helm,name=<release>), plus the GitOps Kustomization
 * `vibecarbon-<release>` that installed it. Named here, and only here, so
 * the deploy can recognize a chart-era cluster and refuse to build a second
 * database beside it. The release name is the one line the terminology
 * census exempts (tests/unit/lib/terminology-census.test.ts).
 */
export const RETIRED_CHART_RELEASE = 'supabase'; // terminology-census: retired chart name
export const RETIRED_CHART_DB_STATEFULSET = `${RETIRED_CHART_RELEASE}-${RETIRED_CHART_RELEASE}-db`;
export const RETIRED_CHART_KUSTOMIZATION = `vibecarbon-${RETIRED_CHART_RELEASE}`;

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
  let sts;
  let release;
  try {
    sts = await exec(
      [
        'kubectl',
        '-n',
        namespace,
        'get',
        'statefulset',
        RETIRED_CHART_DB_STATEFULSET,
        '--ignore-not-found',
        '-o',
        'name',
      ],
      { env, silent: true },
    );
    release = await exec(
      [
        'kubectl',
        '-n',
        namespace,
        'get',
        'secret',
        '-l',
        `owner=helm,name=${RETIRED_CHART_RELEASE}`,
        '-o',
        'name',
      ],
      { env, silent: true },
    );
  } catch (err) {
    throw new Error(
      'assertNoRetiredChartDb: could not read the cluster to check for the retired database ' +
        `chart (${String(err?.message ?? err).slice(0, 200)}). Refusing to create the db ` +
        'StatefulSet without knowing whether an older database is still running here.',
    );
  }
  const found = [String(sts ?? '').trim(), String(release ?? '').trim()].filter(Boolean);
  if (found.length === 0) return;
  throw new Error(
    `This cluster still runs the database from the retired Helm chart (${found.join(', ')} in ` +
      `namespace ${namespace}). This version runs Postgres as its own StatefulSet on a NEW ` +
      'volume, and existing data does not carry over automatically: deploying now would point ' +
      'the app at an empty database.\n' +
      'Pick one:\n' +
      '  - Start clean: `vibecarbon destroy <env>`, then `vibecarbon deploy <env>`.\n' +
      `  - Keep the data: \`helm uninstall ${RETIRED_CHART_RELEASE} -n ${namespace}\`, then ` +
      '`vibecarbon deploy <env> -restore latest`. The restore reads the same wal-g prefix ' +
      'the chart database archived to (unchanged), so it replays every segment archived ' +
      'before the uninstall. On k8s-ha do this on both clusters.\n' +
      'GitOps clusters (`vibecarbon configure cicd`): first set `prune: false` on the ' +
      `\`${RETIRED_CHART_KUSTOMIZATION}\` Flux Kustomization in flux-system and then delete it; deleting it ` +
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
 * @param {{env: NodeJS.ProcessEnv, timeoutS?: number}} args
 */
export async function awaitDbRollout({ env, timeoutS = DB_ROLLOUT_TIMEOUT_S }) {
  const started = Date.now();
  try {
    await runKubectlWithRetry(
      [
        '-n',
        'vibecarbon',
        'rollout',
        'status',
        `statefulset/${DB_STATEFULSET}`,
        `--timeout=${timeoutS}s`,
      ],
      { env, description: `awaitDbRollout: rollout status statefulset/${DB_STATEFULSET}` },
    );
  } catch (err) {
    throw new Error(
      `awaitDbRollout: statefulset/${DB_STATEFULSET} did not become Ready within ${timeoutS}s ` +
        `(${(err?.message || String(err)).slice(0, 300)}). ${await describeDbPods(env)}`,
    );
  }
  console.error(
    `[db] statefulset/${DB_STATEFULSET} Ready after ${Math.round((Date.now() - started) / 1000)}s`,
  );
}

/**
 * Apply the `vibecarbon-seed-standby` ConfigMap the db pod's seed-standby
 * init mounts. Rendered fresh every deploy from the shared builder (one
 * source of truth with the failover/restore reseeds) and applied BEFORE
 * `k8s/base`, so the init can mount it on the pod's first boot. Secret-free by
 * contract: REPL_PASSWORD reaches the script via env only.
 *
 * Best-effort: the ConfigMap's ABSENCE is already fully handled — the init's
 * volume is optional and its command guards on the mounted file being present
 * — so losing this apply just means a standby's first-boot seed self-skips and
 * the serial reseed path covers replication later. Logged loudly, not thrown.
 *
 * @param {{env: NodeJS.ProcessEnv}} args
 */
export async function applyDbSeedConfigMap({ env }) {
  const seedScript = buildStandbySeedInitScript();
  const seedConfigMap = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: vibecarbon-seed-standby',
    '  namespace: vibecarbon',
    'data:',
    '  seed-standby.sh: |',
    ...seedScript.split('\n').map((l) => `    ${l}`),
    '',
  ].join('\n');
  await runCommandAsync(['kubectl', 'apply', '-f', '-'], {
    silent: true,
    env,
    input: seedConfigMap,
  }).catch((err) => {
    console.error(
      `[seed-standby] ConfigMap apply failed (${err?.message || err}), seed init will self-skip; serial reseed covers replication`,
    );
  });
}

/**
 * The deploy-time values for the db StatefulSet's `{{PLACEHOLDER}}` tokens
 * (k8s/base/db/statefulset.yaml), one per token. Pure.
 *
 * @param {object} o
 * @param {string} o.dbImageTag - full db image ref, `<repo>:<tag>`
 * @param {{bucket?: string, walgPrefix?: string, endpoint?: string, region?: string}} [o.s3Config]
 * @param {string|null} [o.backupBucketName]
 * @param {'primary'|'standby'} [o.walgRole]
 * @param {string} o.dbPrivateIp - this cluster's database node private IP
 * @param {string} o.storageClass - `ProviderClass.K8S_STORAGE_CLASS`
 * @param {string} o.walArchiveSha - sha of k8s/base/backup/configmap-walg.yaml
 * @returns {Record<string, string>}
 */
export function buildDbManifestValues({
  dbImageTag,
  s3Config,
  backupBucketName,
  walgRole = 'primary',
  dbPrivateIp,
  storageClass,
  walArchiveSha,
}) {
  if (!dbImageTag) {
    throw new Error(
      'buildDbManifestValues: dbImageTag is required (the pre-published wal-g db image, pulled from ghcr).',
    );
  }
  if (!dbPrivateIp) {
    // Rendered into {{REPL_RELAY_HOST}}. A real IaC output on every provider
    // (Hetzner pins 10.0.1.2 statically; DO exports the Pulumi-assigned VPC
    // address) — never assume a Hetzner-shaped address: a standby's seed init
    // would dial a relay that exists on no node.
    throw new Error(
      'buildDbManifestValues: dbPrivateIp is required — the IaC program outputs it; ' +
        'a missing value means the infra step result is incomplete',
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
  // s3:/// (wal-g would error): empty when there is no bucket at all.
  //
  // SINGLE canonical prefix (NO role segment). Reads (backup-fetch/restore/
  // reseed) and writes (backup-push/wal-push) must all agree on ONE prefix — a
  // role-segmented prefix made the standby read an empty `…/walg/standby` and
  // fail restore/reseed with "No backups found" (caught by compose-ha scale
  // e2e). Anti-collision (a standby / bring-up-phase independent primary must
  // never WRITE here) is enforced by the WALG_ROLE WRITE-GUARD: wal-archive.sh
  // and the backup CronJob both no-op when WALG_ROLE=standby.
  const walgBucket = backupBucketName || s3Config?.bucket || '';
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
    WALG_S3_PREFIX: walgBucket ? `s3://${walgBucket}/${walgPrefix}` : '',
    WALG_ROLE: walgRole,
    S3_ENDPOINT: s3Config?.endpoint ?? '',
    S3_REGION: s3Config?.region ?? '',
    // Repl-gateway relay endpoint for the standby seed init: the cluster's
    // OWN database-node private IP + the relay port. Rendered on every tier;
    // only a standby's first boot ever dials it.
    REPL_RELAY_HOST: dbPrivateIp,
    REPL_RELAY_PORT: String(REPL_GATEWAY_PORT),
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
    { env, silent: true },
  );
  // runCommandAsync(silent) resolves the stdout string directly.
  const unprotected = String(auditOut ?? '').trim();
  if (unprotected) {
    throw new Error(`auditRls: ${rlsAuditFailureMessage(unprotected)}`);
  }
}

/**
 * Ground-truth BACKUP audit for the k8s path — the kubectl-exec twin of the
 * `docker compose exec` probe compose/index.js runs inside runDatabaseAudits.
 * Same probe string, same pure evaluator, same failure message; only the exec
 * seam differs. See src/lib/deploy/walg-audit.js for why `wal-g backup-list`
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
 * `kubectl apply -k k8s/base`, and that apply never went through this
 * renderer at all. The literal `{{K8S_STORAGE_CLASS}}` therefore reached the
 * API server, which accepts it (storageClassName is a free-form reference,
 * never DNS-1123-validated) and leaves the PVC Pending forever.
 *
 * @param {string} dir - Source kustomize directory (e.g.
 *   `${projectDir}/k8s/base/observability`)
 * @param {string} storageClass - `ProviderClass.K8S_STORAGE_CLASS`
 * @returns {string} Path to the rendered temp copy — pass this to
 *   `kubectl apply -k` instead of `dir`.
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
  const tmpDir = mkdtempSync(join(tmpdir(), `vibecarbon-k8s-${label}-${basename(dir)}-`));
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
  copyInto(dir, tmpDir);
  return tmpDir;
}

/**
 * Render `k8s/base` for apply: every db StatefulSet placeholder
 * (buildDbManifestValues) plus `{{K8S_STORAGE_CLASS}}`, which the db's
 * volumeClaimTemplate and the add-on PVCs `add redis` / `add n8n` copy into
 * `k8s/base/<addon>/` share, into a temp copy of the tree.
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
 * @param {string} dir - the project's `k8s/base`
 * @param {Record<string, string>} values - buildDbManifestValues' output
 * @returns {string} the rendered temp copy to pass to `kubectl apply -k`
 */
export function renderK8sBase(dir, values) {
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
  const rendered = renderK8sPlaceholders(dir, values, 'base');
  const leftover = readFileSync(join(rendered, 'db', 'statefulset.yaml'), 'utf-8').match(
    /\{\{[A-Z0-9_]+\}\}/g,
  );
  if (leftover) {
    rmSync(rendered, { recursive: true, force: true });
    throw new Error(
      `renderK8sBase: db/statefulset.yaml still carries ${[...new Set(leftover)].join(', ')} after rendering; ` +
        'refusing to apply a database with an unresolved image, prefix or StorageClass.',
    );
  }
  return rendered;
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
 * Pilot-light standby: scale down an observability stack this cluster still
 * carries from its life as a primary, and point its grafana-tls Certificate at
 * the standby's self-signed issuer (the real issuer rides the promote
 * annotation, as on vibecarbon-tls). No-op when the namespace is absent, which
 * is every freshly deployed standby.
 *
 * @param {{ env: Record<string, string|undefined>, issuerName: string }} args
 * @returns {Promise<boolean>} true when a leftover stack was demoted
 */
export async function demoteObservabilityOnStandby({ env, issuerName }) {
  const ns = String(
    (await runKubectlWithRetry(
      ['get', 'namespace', OBSERVABILITY_NAMESPACE, '--ignore-not-found', '-o', 'name'],
      {
        env,
        captureStdout: true,
        description: 'applyK3sManifests: look for a leftover observability namespace (standby)',
      },
    )) ?? '',
  ).trim();
  if (!ns) return false;
  console.error(
    `[pilot-standby] demoting the observability stack left from this cluster's primary life`,
  );
  await runKubectlWithRetry(
    ['-n', OBSERVABILITY_NAMESPACE, 'scale', 'deployment', '--all', '--replicas=0'],
    { env, description: 'applyK3sManifests: zero observability deployments (pilot standby)' },
  );
  const cert = String(
    (await runKubectlWithRetry(
      [
        '-n',
        OBSERVABILITY_NAMESPACE,
        'get',
        'certificate',
        'grafana-tls',
        '--ignore-not-found',
        '-o',
        'name',
      ],
      {
        env,
        captureStdout: true,
        description: 'applyK3sManifests: look for grafana-tls (pilot standby)',
      },
    )) ?? '',
  ).trim();
  if (cert) {
    await runKubectlWithRetry(
      [
        '-n',
        OBSERVABILITY_NAMESPACE,
        'patch',
        'certificate',
        'grafana-tls',
        '--type=merge',
        '-p',
        JSON.stringify({
          metadata: { annotations: { [PROMOTE_ISSUER_ANNOTATION]: issuerName } },
          spec: { issuerRef: { name: STANDBY_SELFSIGNED_ISSUER, kind: 'ClusterIssuer' } },
        }),
      ],
      {
        env,
        description: 'applyK3sManifests: grafana-tls -> standby self-signed issuer (pilot standby)',
      },
    );
  }
  return true;
}

/**
 * Apply cert-manager + the app and infra Secrets + the project's k8s/infra +
 * k8s/base kustomizations (the db StatefulSet included, rendered), wait for
 * the db, patch the app deployment to use the locally-sideloaded image, and
 * wait for rollout.
 *
 * Local-first by default — no Flux on the deploy path; Flux is opt-in
 * via `vibecarbon configure cicd`.
 *
 * @param {{kubeconfig: string, projectDir: string, projectName: string, imageTag: string, dbImageTag: string, envLocal: Record<string,string>, domain: string, s3Config?: {accessKey: string, secretKey: string, bucket: string, endpoint: string, region: string}, backupBucketName?: string|null, restore?: string|null, dnsProvider?: string|null, dnsToken?: string|null, apiToken?: string, providerId?: string, ProviderClass?: typeof import('../../providers/base.js').BaseProvider, region?: string, environment?: string, minWorkers?: number, maxWorkers?: number, caBoundsMin?: number, workerServerType?: string, k3sToken?: string, masterIp?: string, sshKeyPath?: string, khPath?: string, dbPrivateIp?: string, masterPrivateIp?: string, vpcCidr?: string, role?: 'primary'|'standby'}} args
 *   `restore` is accepted for the caller's input hash and ignored here: the
 *   wal-g-restored DB carries its migration ledger, so the app's startup
 *   migrations apply only what the backup lacks (no restore special case).
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
  backupBucketName,
  dnsProvider,
  // The ONE DNS-01 credential, already resolved for whichever `dnsProvider`
  // is selected (see DNS01_PROVIDERS). Never five per-provider token args:
  // the deploy drives exactly one DNS API.
  dnsToken,
  // Phase 5: cluster-autoscaler wiring. `apiToken` is the compute provider's
  // API token (CCM/CSI/CA), distinct from `dnsToken` which only names the
  // cert-manager DNS-01 token. On Hetzner-compute + Hetzner-DNS the two
  // carry the same VALUE (Hetzner consolidated APIs in May 2026), but they
  // stay separate args so the wiring is explicit and cross-provider deploys
  // (e.g. DO compute + Cloudflare DNS) need no special case.
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
  workerServerType,
  k3sToken,
  // Phase 6: registry-push wiring. masterIp/sshKeyPath/khPath are the
  // SSH coordinates needed to open a local-port-forward to master:5000
  // for `docker push` (mirrors what sideloadK3s already received via a
  // different shape — this set is operator → master only).
  masterIp,
  sshKeyPath,
  khPath,
  // HA runs primary+standby deploys in parallel; both call this
  // function from the same operator host. Without distinct ports, the
  // second `ssh -L 5000:localhost:5000` loses the bind race and
  // ExitOnForwardFailure=yes aborts the deploy. Default 5000 is the
  // single-cluster path; HA passes 5000 (primary) and 5001 (standby).
  localTunnelPort = 5000,
  // perfPrefix tags internal sub-stage perf timings — see deployK3s.
  perfPrefix = 'k3s',
  // The database node's Hetzner private-network IP (deterministic in the IaC
  // program; deployK3s threads it through from infraOutputs). Rendered into
  // the db StatefulSet's seed-standby init as SEED_PRIMARY_HOST
  // ({{REPL_RELAY_HOST}}, see buildDbManifestValues).
  dbPrivateIp,
  // The master's private-network IP (deterministic on Hetzner — static
  // 10.0.1.1 — but a real Pulumi output on DO, which can't pin VPC IPs).
  // deployK3s threads it through from infraOutputs. Passed to
  // renderCarbonAutoscalerConfig (CA-spawned worker join target) and
  // pushImageToLocalRegistry (registry-ref host, must match buildAppImage's
  // own masterPrivateIp). Undefined here falls through to each callee's own
  // '10.0.1.1' default — old callers that never pass this keep producing
  // byte-identical Hetzner output.
  masterPrivateIp,
  // M3 Task 9c: this deploy's cluster VPC CIDR (DO real Pulumi output, or
  // its resume-compat fallback — see deployK3s). Passed to
  // `ProviderClass.getS3EgressExtraCidrs(vpcCidr)` to decide whether/how to
  // render the S3-egress-VPC-allowance manifest below. undefined on
  // Hetzner (its program doesn't return this key) — harmless, since
  // HetznerProvider.getS3EgressExtraCidrs ignores its argument entirely.
  vpcCidr,
  // Pilot-light: 'primary' | 'standby' | undefined (single-cluster ==
  // primary behavior). Drives walgRole below (rendered into the db
  // StatefulSet) and zeroes the app tier on a standby.
  role,
}) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  // Pilot-light: on the standby cluster nothing app-tier runs until a
  // failover promotes it — no app pods, no CA-spawned workers. Everything
  // below gated on this const either declaratively zeroes a Deployment
  // (same patch-at-deploy pattern as the cert/configmap placeholder patches)
  // or skips a step that would otherwise exec against a pod that doesn't
  // exist yet. Registry wait+push, cert-manager, traefik, and the cert/config
  // patches are NOT gated — failover needs the registry (CA-spawned workers
  // pull the app image from it) and the serving master.
  const pilotStandby = role === 'standby';
  // 0. Validate DNS-01 prerequisites BEFORE any apply so the failure
  //    surfaces at deploy-start, not 20 min in when an Order pins Pending.
  //    Throws on missing token for any DNS01_PROVIDERS row; manual returns null.
  const dnsSecret = buildDnsProviderSecret({ dnsProvider, dnsToken });
  // Gate everything below on the control plane actually SERVING — /readyz plus
  // a server-side dry-run apply, both in one passing iteration — instead of
  // racing a cold apiserver and absorbing the fallout in per-call retry
  // ladders (mitigation-audit cluster 4: "we race cold clusters by
  // construction"). Runs AFTER the DNS-01 prerequisite validation above so a
  // missing token still aborts before we touch (or wait on) the cluster; the
  // per-call ladders stay as tripwires and should no longer fire on a
  // proven-serving control plane.
  await perfAsync(`deploy.${perfPrefix}.controlPlane.serving`, () =>
    awaitControlPlaneServing({ env }),
  );
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
  //     driver has since been bumped to v2.18.1; the plan below always carries
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
  for (const { workload, setImageArgs } of csiSidecarSetImagePlan(providerId)) {
    await runKubectlWithRetry(['-n', 'kube-system', 'set', 'image', workload, ...setImageArgs], {
      env,
      description: `applyK3sManifests: kubectl set image ${workload} (CSI sidecars → ghcr mirrors)`,
    });
  }
  // 1. Install cert-manager (raw YAML; not a kustomize base).
  await perfAsync(`deploy.${perfPrefix}.certManager.install`, () =>
    runKubectlWithRetry(['apply', '-f', CERT_MANAGER_URL], {
      env,
      description: 'applyK3sManifests: kubectl apply cert-manager',
    }),
  );
  // 1b. Pin all three cert-manager Deployments to the control-plane node —
  //     the same idiom the cluster-autoscaler manifest uses. The in-cluster
  //     `kubernetes` Endpoints advertises the master's PUBLIC IP (k3s
  //     installs with --node-ip=<public>, see the CCM note near the
  //     traefik restart), and the Hetzner firewall admits public :6443
  //     from operator CIDRs only — so an apiserver-dependent pod scheduled
  //     onto any OTHER node times out on 10.43.0.1 forever. RCA 2026-07-17
  //     e4 rig: whenever the scheduler picked a worker, cainjector went
  //     CrashLoopBackOff ("dial tcp 10.43.0.1:443: i/o timeout") and the
  //     webhook's readiness probe returned 500 until the 8-min budget
  //     died; on the (worker-less) pilot-light standby the same pods
  //     landed on the master and were Ready in seconds. The 2026-06-01
  //     "cold image pulls push cainjector past the envelope" observation
  //     below was this same lockout wearing a latency costume — the pin
  //     removes the scheduling coin-flip on every cluster shape.
  const certManagerPin = JSON.stringify({
    spec: {
      template: {
        spec: {
          nodeSelector: { 'node-role.kubernetes.io/control-plane': 'true' },
          tolerations: [
            {
              key: 'node-role.kubernetes.io/control-plane',
              operator: 'Exists',
              effect: 'NoSchedule',
            },
          ],
        },
      },
    },
  });
  for (const certDeploy of ['cert-manager', 'cert-manager-cainjector', 'cert-manager-webhook']) {
    await runKubectlWithRetry(
      [
        '-n',
        'cert-manager',
        'patch',
        'deployment',
        certDeploy,
        '--type=strategic',
        '-p',
        certManagerPin,
      ],
      { env, description: `applyK3sManifests: pin ${certDeploy} to control-plane` },
    );
  }
  // 1c. Point the DNS-01 SELF-CHECK at public recursive resolvers instead of
  //     the zone's authoritative servers. cert-manager's default self-check
  //     dials the authoritative NS directly from the pod; both Hetzner DNS
  //     and DigitalOcean DNS are served through ANYCAST fleets, and the POP
  //     a given region's egress lands on can lag a freshly-written record by
  //     many minutes (d4 run 3, 2026-08-28: the TXT was visible from every
  //     external vantage and via the cluster's own CoreDNS, while the sfo3
  //     pod's direct query to the same anycast IP returned empty — the
  //     issuance sat "not yet propagated" indefinitely). Let's Encrypt
  //     validates from ITS OWN vantage, not ours, so gating issuance on the
  //     one stale POP we happen to egress through is strictly worse than
  //     gating on a public recursive answer. Idempotent test-and-set: args
  //     are only appended when absent, so warm re-deploys never duplicate.
  await perfAsync(`deploy.${perfPrefix}.certManager.recursiveNameservers`, async () => {
    const dnsFlags = [
      '--dns01-recursive-nameservers=1.1.1.1:53,8.8.8.8:53',
      '--dns01-recursive-nameservers-only',
    ];
    const raw = await runKubectlWithRetry(
      ['-n', 'cert-manager', 'get', 'deployment', 'cert-manager', '-o', 'json'],
      { env, captureStdout: true, description: 'applyK3sManifests: read cert-manager args' },
    );
    let dep;
    try {
      dep = JSON.parse(raw?.toString() ?? '{}');
    } catch {
      // Unreadable deployment JSON — skip the patch rather than fail the
      // deploy: without the flags cert-manager falls back to its default
      // (authoritative-direct) self-check, which is the pre-fix behavior,
      // not an outage. The next deploy retries.
      progressLog('[k3s] cert-manager args unreadable, skipping recursive-nameserver patch.');
      return;
    }
    const containers = dep?.spec?.template?.spec?.containers ?? [];
    const idx = containers.findIndex((c) => c?.name === 'cert-manager-controller');
    const controllerIdx = idx >= 0 ? idx : 0;
    const existing = containers[controllerIdx]?.args ?? [];
    const missing = dnsFlags.filter((f) => !existing.includes(f));
    if (missing.length === 0) {
      progressLog('[k3s] cert-manager recursive-nameserver flags already present.');
      return;
    }
    const ops = missing.map((value) => ({
      op: 'add',
      path: `/spec/template/spec/containers/${controllerIdx}/args/-`,
      value,
    }));
    await runKubectlWithRetry(
      [
        '-n',
        'cert-manager',
        'patch',
        'deployment',
        'cert-manager',
        '--type=json',
        '-p',
        JSON.stringify(ops),
      ],
      { env, description: 'applyK3sManifests: cert-manager recursive-nameserver self-check' },
    );
  });
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
  // 2b. Land the per-DNS-provider Secret in the cert-manager namespace
  //     BEFORE the kustomization that defines the issuers, so when the
  //     ClusterIssuer is created the controller can immediately resolve
  //     `apiTokenSecretRef`. Stdin pipe keeps the token out of argv.
  if (dnsSecret) {
    await runKubectlWithRetry(['apply', '-f', '-'], {
      env,
      input: dnsSecret.yaml,
      description: `applyK3sManifests: kubectl apply Secret/${dnsSecret.name}`,
    });
  }
  // 2c. Some DNS-01 providers (currently: hetzner) need a third-party
  //     cert-manager webhook deployment because cert-manager core has no
  //     native solver for them — the webhook registers an APIService that
  //     cert-manager calls into for dns01.webhook(groupName=...). It must be
  //     Available BEFORE any Certificate referencing the issuer is
  //     reconciled, otherwise Orders fail with "no provider for solver".
  //     `row.webhook` is null for
  //     providers whose solver ships in cert-manager core (e.g. cloudflare)
  //     and DNS01_PROVIDERS has no entry at all for manual/unknown
  //     providers, so both skip this block exactly as the old
  //     `dnsProvider === 'hetzner'` gate did.
  const dns01Row = DNS01_PROVIDERS[dnsProvider];
  if (dns01Row?.webhook) {
    const { repoName, repoUrl, chart, version, releaseName } = dns01Row.webhook;
    // helm repo add fails if the repo already exists; `helm repo update`
    // below refreshes either way, hence ignoreError.
    await runCommandAsync(['helm', 'repo', 'add', repoName, repoUrl], {
      silent: true,
      ignoreError: true,
      env,
    });
    await runCommandAsync(['helm', 'repo', 'update', repoName], {
      silent: true,
      env,
    });
    try {
      // Chart 0.7.0 reads zero Helm values that bind the issuer's
      // `hetzner` Secret — that linkage lives entirely in the
      // ClusterIssuer's `config.tokenSecretKeyRef` (name `hetzner`,
      // key `token`; created above by buildDnsProviderSecret). The
      // chart's `groupName` default `acme.hetzner.com` matches the
      // ClusterIssuer's groupName, so we don't override it either.
      // Async helm + kubectl wait — both can block for minutes; sync would
      // block Node's event loop and inflate parallel-branch perf timings.
      // (RCA iter-validate6: a blocking wait on the primary made the standby's
      // certManager.wait report 21min when the actual was seconds).
      //
      // The webhook warm-up retry that used to wrap this install is GONE
      // (band-aid removal, 2026-08-16): the third-party chart's own Issuer +
      // Certificate traverse cert-manager's admission pipeline, and
      // awaitCertManagerAdmission has already proven that pipeline serves —
      // including the caBundle window this helper's ladder absorbed
      // (2026-08-10 e3). A webhook failure here is a regression: fail loudly.
      try {
        await runCommandAsync(
          [
            'helm',
            'upgrade',
            '--install',
            releaseName,
            chart,
            '--namespace',
            'cert-manager',
            '--version',
            version,
            // Same control-plane pin as the core cert-manager deploys above —
            // this webhook is the APIService backend cert-manager dials for
            // dns01.webhook() and needs the apiserver itself; off-master it
            // hits the same public-6443 firewall lockout. Standard chart
            // values; if a future chart version drops them they are ignored
            // harmlessly and the helm --wait below still gates readiness.
            '--set-json',
            'nodeSelector={"node-role.kubernetes.io/control-plane":"true"}',
            '--set-json',
            'tolerations=[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"}]',
            '--wait',
            '--timeout',
            '5m',
          ],
          {
            env,
            silent: true,
            description:
              `cert-manager webhook: helm upgrade --install ${chart} --version ${version} ` +
              `(release ${releaseName}), DNS-01 certificate issuance cannot work without it`,
          },
        );
      } catch (err) {
        // Keep the actionable framing the old helper's terminal throw carried:
        // name the component and the consequence, then the raw helm error.
        throw new Error(
          `cert-manager webhook: helm upgrade --install ${chart} --version ${version} ` +
            `(release ${releaseName}) failed — DNS-01 certificate issuance cannot work ` +
            `without it. ${err.message}`,
        );
      }
      const waitOk = await runCommandAsync(
        [
          'kubectl',
          '-n',
          'cert-manager',
          'wait',
          '--for=condition=Available',
          '--timeout=180s',
          `deploy/${releaseName}`,
        ],
        { silent: false, env },
      );
      if (waitOk !== true) {
        throw new Error(
          `cert-manager webhook: deploy/${releaseName} never became Available ` +
            `(180s). DNS-01 certificate issuance cannot work without it.`,
        );
      }
    } catch (err) {
      // Surface webhook pod logs on failure — chart install rarely
      // tells the operator anything useful when the actual cause is
      // a CrashLoopBackOff or a missing dependency. Best-effort but LOUD,
      // and captured (not inherited) so it reaches the deploy log file.
      await runDeployDiagnostic(
        ['kubectl', '-n', 'cert-manager', 'logs', `deploy/${releaseName}`, '--tail=200'],
        { env, label: `cert-manager: logs deploy/${releaseName}`, tailLines: 200 },
      );
      throw err;
    }
  }
  // 3. Apply infra (cert-manager-resources/cluster-issuers + traefik-crds).
  // ClusterIssuers traverse cert-manager's validating webhook. The webhook
  // warm-up retry that used to guard this apply is GONE (band-aid removal,
  // 2026-08-16): awaitCertManagerAdmission above has already PROVEN the
  // admission pipeline round-trips, so a webhook failure here is a real
  // regression and must fail the deploy loudly, not be absorbed.
  await runKubectlWithRetry(['apply', '-k', join(projectDir, 'k8s/infra/cert-manager-resources')], {
    env,
    description: 'applyK3sManifests: kubectl apply -k cert-manager-resources',
  });
  await runKubectlWithRetry(['apply', '-k', join(projectDir, 'k8s/infra/traefik-crds')], {
    env,
    description: 'applyK3sManifests: kubectl apply -k traefik-crds',
  });
  // 4. Create the app and infra Secrets BEFORE base/ — base/'s Deployment
  //    and StatefulSet reference them; without them kubelet fails container
  //    creation with `secret "vibecarbon-app-secrets" not found`.
  await applyVibecarbonSecrets({ kubeconfig, envLocal, s3Config, backupBucketName });
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
  if (!apiToken) {
    throw new Error(
      'applyK3sManifests: apiToken (provider API token) required for carbon-autoscaler Secret/carbon-autoscaler-config',
    );
  }
  if (!k3sToken) {
    throw new Error('applyK3sManifests: k3sToken required to render carbon-autoscaler config.json');
  }
  const clusterName = `${projectName}-${environment}`;
  const carbonAutoscalerConfigJson = await renderCarbonAutoscalerConfig({
    k3sVersion: K3S_VERSION,
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
      input: caSecretYaml,
      description: 'applyK3sManifests: kubectl apply Secret/carbon-autoscaler-config',
    });
  }
  // 4c. The db pod's seed-standby init mounts this ConfigMap on its FIRST
  //     boot, so it lands before base creates the StatefulSet.
  await applyDbSeedConfigMap({ env });
  // 5. Apply base (namespace, network-policies, db, app, backup, traefik,
  //    config), always from a rendered temp copy (renderK8sBase): the db
  //    StatefulSet carries deploy-time placeholders (image, wal-g prefix and
  //    role, S3 endpoint, relay address, StorageClass), and so do the PVCs
  //    `add redis` / `add n8n` copy into k8s/base/<addon>/. kubectl accepts a
  //    literal storageClassName and the PVC sits Pending forever, and neither
  //    a PVC's class nor a StatefulSet's volumeClaimTemplates can be changed
  //    once the object exists, so the substitution has to happen before this
  //    apply.
  //
  // Derive the wal-g WRITE-GUARD role (NOT a path segment) from the explicit
  // `role` option — the k8s-ha fan-out passes role: 'primary' / 'standby';
  // single-cluster deploys leave role undefined → 'primary'. Rendered into the
  // db container env as WALG_ROLE so wal-archive.sh + the backup CronJob
  // no-op on the standby. The S3 prefix itself stays canonical.
  const walgRole = role === 'standby' ? 'standby' : 'primary';
  const storageClass = ProviderClass?.K8S_STORAGE_CLASS;
  // A chart-era cluster keeps its database on the chart's StatefulSet; a new
  // one beside it would be empty. Refuse before anything is created.
  await assertNoRetiredChartDb({ env });
  await assertDbStorageClass({ storageClass, env });
  const baseDir = renderK8sBase(
    join(projectDir, 'k8s/base'),
    buildDbManifestValues({
      dbImageTag,
      s3Config,
      backupBucketName,
      walgRole,
      dbPrivateIp,
      storageClass,
      walArchiveSha: walArchiveConfigSha(projectDir),
    }),
  );
  try {
    await perfAsync(`deploy.${perfPrefix}.applyBase`, () =>
      runKubectlWithRetry(['apply', '-k', baseDir], {
        env,
        description: 'applyK3sManifests: kubectl apply -k k8s/base',
      }),
    );
  } finally {
    // The rendered copy carries the bucket + endpoint wiring; it served its
    // one apply.
    rmSync(baseDir, { recursive: true, force: true });
  }
  if (pilotStandby) {
    // Pilot-light: nothing app-tier runs on the 2-node standby. Declarative
    // zero via the same patch-at-deploy pattern as the placeholder patches
    // below (TYPE and NAME as separate argv tokens, matching kubectl's own
    // `patch TYPE NAME` form). Step 6 below still `set image`s this
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
  // 5b'. Wait for the local registry pod (Phase 1) to be Ready before
  //      pushing images. The pod is part of base/, so it just landed.
  //      Without this wait, the SSH-tunnel push race-targets a Pending
  //      pod (registry container not started → connection refused on
  //      :5000). 120s mirrors other base-pod readiness budgets.
  await perfAsync(`deploy.${perfPrefix}.localRegistry.wait`, async () => {
    const ok = await runCommandAsync(
      [
        'kubectl',
        '-n',
        'vibecarbon',
        'wait',
        '--for=condition=Ready',
        'pod',
        '-l',
        'app=local-registry',
        '--timeout=120s',
      ],
      { silent: false, env },
    );
    if (ok === false) throw new Error('local-registry pod not Ready');
  });
  // 5b''. Push the app image to the local registry on master so
  //       CA-spawned workers (which don't exist at sideload time) can
  //       pull on first schedule. Sideload remains primary distribution
  //       for static workers — this is additive. Both paths use the
  //       same `10.0.1.1:5000/<project>:<tag>` reference (Phase 1's
  //       registries.yaml maps that hostname to the registry pod).
  if (!masterIp) {
    throw new Error('applyK3sManifests: masterIp required for registry push (Phase 6)');
  }
  if (!sshKeyPath) {
    throw new Error('applyK3sManifests: sshKeyPath required for registry push (Phase 6)');
  }
  if (!khPath) {
    throw new Error('applyK3sManifests: khPath required for registry push (Phase 6)');
  }
  // Push the app image to the in-cluster registry so CA-spawned workers
  // (which don't exist at sideload time) can pull it on first schedule.
  // The db image is NOT pushed here: it's pulled from ghcr by the database
  // node (pinned there, see k8s/base/db/statefulset.yaml) — CA workers never
  // run postgres.
  const appPushPort = localTunnelPort;
  // Kick off the registry push CONCURRENTLY — do NOT await it here. It exists
  // only so future cluster-autoscaler-spawned workers can pull the app image;
  // the app pods themselves run the SIDELOADED image (step 6 sets
  // deployment/app to imageTag with imagePullPolicy: IfNotPresent), and NOTHING
  // between here and the end of this function reads the in-cluster registry. So
  // this ~90-140s S3-blob upload overlaps the CA rollout + db rollout +
  // migrations + app rollout instead of serializing onto the critical path. It
  // is still AWAITED at the end of applyK3sManifests (see the await below the
  // traefik restart) so a failed push — which would leave CA-scaled workers
  // unable to pull the app image — still fails the deploy.
  //
  // In an HA deploy the two clusters reach this point concurrently, but
  // pushImageOverSshTunnel holds a process-wide mutex (two simultaneous
  // uploads thrash the operator uplink into `unknown blob` failures — see the
  // "Uplink serialization" block in registry-push.js). So the SECOND cluster's
  // perf duration below includes its lock wait, not just its transfer: read a
  // large `registryPush.app` on one arm together with the `[push] ... acquired
  // push lock after Ns wait` line before calling it a slow push.
  const registryPushPromise = perfAsync(`deploy.${perfPrefix}.registryPush.app`, () =>
    pushImageToLocalRegistry({
      tag: imageTag,
      masterIp,
      sshKey: sshKeyPath,
      khPath,
      localTunnelPort: appPushPort,
      // Must match the masterPrivateIp buildAppImage used to build imageTag's
      // registry-ref prefix (M3 Task 2) — undefined falls through to this
      // callee's own '10.0.1.1' default, same as the renderCarbonAutoscalerConfig
      // call site above.
      masterPrivateIp,
    }),
  );
  // Attach a no-op rejection guard so a push failure that lands WHILE the CA /
  // db work below is still running doesn't surface as an
  // unhandledRejection — the real `await registryPushPromise` at the end
  // re-throws it and fails the deploy.
  registryPushPromise.catch(() => {});
  // 5a'. Apply cluster-autoscaler manifests SEPARATELY. CA lives in
  //      kube-system but base/'s parent kustomization sets
  //      `namespace: vibecarbon`, whose namespace transformer would
  //      override our kube-system metadata. Mirrors the CCM/CSI
  //      separate-install pattern (those are commented in
  //      base/kustomization.yaml and applied via cloud-init). The
  //      child kustomization at carbon/k8s/base/cluster-autoscaler/
  //      sets `namespace: kube-system` explicitly, which only takes
  //      effect when applied standalone like this.
  await runKubectlWithRetry(['apply', '-k', join(projectDir, 'k8s/base/cluster-autoscaler')], {
    env,
    description: 'applyK3sManifests: kubectl apply -k cluster-autoscaler',
  });
  // 5a''. Patch BOTH container images in one call.
  //
  //       `carbon-autoscaler`: deployment.yaml ships the
  //       `{{CARBON_AUTOSCALER_IMAGE}}` placeholder (kustomize has no
  //       built-in var-substitution for a container image string), so
  //       resolve it here the same way the domain/SITE_URL placeholders
  //       below are patched at deploy time.
  //
  //       `cluster-autoscaler`: the manifest already carries the mirrored
  //       ghcr ref as a literal, so this is belt-and-braces — but load-bearing
  //       belt-and-braces. `apply -k` above reads the PROJECT's checked-in
  //       copy of this manifest, and a project generated before the mirror
  //       landed still pins registry.k8s.io there, i.e. still walks into the
  //       403 that cost a deploy on 2026-07-31 (src/lib/images.js). Re-pinning
  //       here makes images.js authoritative at deploy time no matter how old
  //       the project's k8s/ tree is.
  //
  //       Both refs come from src/lib/images.js, the single source of truth.
  await runKubectlWithRetry(
    [
      '-n',
      'kube-system',
      'set',
      'image',
      'deployment/cluster-autoscaler',
      `carbon-autoscaler=${carbonAutoscalerImageRef()}`,
      `cluster-autoscaler=${clusterAutoscalerImageRef()}`,
    ],
    {
      env,
      description:
        'applyK3sManifests: kubectl set image deployment/cluster-autoscaler (carbon-autoscaler sidecar)',
    },
  );
  // 5b. Patch the domain-specific resources that the base/ kustomization
  //     ships with placeholder values (`app.example.com` + a placeholder
  //     ClusterIssuer name). Without this, cert-manager tries to issue a Let's
  //     Encrypt prod cert for `app.example.com` — ACME refuses (IANA-reserved
  //     domain), the Order errors, the Certificate's secret never lands,
  //     ingress TLS fails, and the app's progressDeadlineSeconds expires
  //     during rollout-status (step 9) → deploy fails ~26 min in. The
  //     placeholder is intentional in the template (the comment says
  //     "patched at deploy time"); this is the patch.
  //
  // Issuer choice: `ACME_CA_SERVER` points at staging for e2e tests
  // (and any dev env that wants to avoid LE rate limits). Read from
  // .env.local first (per-project), then fall back to process.env so the
  // e2e harness can inject the staging URL via env without writing
  // it into the project's .env.local. Anything else gets the prod issuer.
  // Provider suffix (cloudflare/hetzner/manual) determines which solver
  // — DNS-01 vs HTTP-01 — cert-manager actually uses; see pickIssuerName.
  const acmeServer = envLocal?.ACME_CA_SERVER || readOperatorVar('ACME_CA_SERVER').value || '';
  const issuerName = pickIssuerName({ dnsProvider, acmeServer });
  // DNS-01 issuers (cloudflare, hetzner) support wildcard SANs — one cert
  // covers *.${domain} so every IngressRoute subdomain is included without
  // separate per-router ACME orders. Manual (HTTP-01) falls back to apex-only.
  const dnsNames = certificateDnsNames(domain, issuerName);
  // Single-ACME-issuer policy (d4 2026-08-28 — acme-issuer-policy.js): a
  // pilot-standby's Certificate references the local self-signed issuer so
  // two clusters never solve DNS-01 for the same names concurrently
  // (cert-manager's DO solver keys challenge records by name; concurrent
  // issuers live-lock). The REAL issuer name rides along in the promote
  // annotation on BOTH roles — the failover promote step (and every
  // reconverge redeploy, via this same branch under the swapped role)
  // re-points issuerRef from it.
  const effectiveIssuer = pilotStandby ? STANDBY_SELFSIGNED_ISSUER : issuerName;
  if (pilotStandby) {
    console.error(
      `[pilot-standby] certificate issuerRef -> ${STANDBY_SELFSIGNED_ISSUER} ` +
        `(single-ACME-issuer policy; promote annotation carries ${issuerName})`,
    );
  }
  await runKubectlWithRetry(
    [
      '-n',
      'vibecarbon',
      'patch',
      'certificate',
      'vibecarbon-tls',
      '--type=merge',
      '-p',
      JSON.stringify({
        metadata: { annotations: { [PROMOTE_ISSUER_ANNOTATION]: issuerName } },
        spec: { dnsNames, issuerRef: { name: effectiveIssuer, kind: 'ClusterIssuer' } },
      }),
    ],
    { env, description: 'applyK3sManifests: kubectl patch certificate/vibecarbon-tls' },
  );
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
    // and still runs the stack it was given then. Bring it to what a fresh
    // pilot standby looks like: no observability pods (no scrape or Grafana
    // spend, no second Prometheus watching a zeroed app tier) and no ACME
    // issuer behind grafana-tls (single-ACME-issuer policy, see the
    // vibecarbon-tls patch above). Scale, not delete, so the PVCs keep their
    // history; the apply above restores `replicas: 1` from the manifests and
    // re-points the issuer the day this cluster is promoted again. A fresh
    // standby has no such namespace and this is a no-op.
    await demoteObservabilityOnStandby({ env, issuerName });
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
        runKubectlWithRetry(['apply', '-k', renderedObservabilityDir], {
          env,
          description: 'applyK3sManifests: kubectl apply -k k8s/base/observability',
        }),
      );
    } finally {
      // Same cleanup contract as the rendered k8s/base copy — deploys must
      // not leak a temp dir per run (T4 review).
      rmSync(renderedObservabilityDir, { recursive: true, force: true });
    }
    // Patch the LOCAL grafana-tls Certificate (issuer + dnsNames) in the
    // observability namespace. Same issuer as vibecarbon-tls, but apex-only
    // dnsNames — deliberately NOT the same list. Two Certificates asking one
    // ACME account for an identical identifier set get handed one shared
    // Boulder order and race its finalize; see
    // observabilityCertificateDnsNames for the full account.
    await runKubectlWithRetry(
      [
        '-n',
        'vibecarbon-observability',
        'patch',
        'certificate',
        'grafana-tls',
        '--type=merge',
        '-p',
        JSON.stringify({
          // Primary-only path (a pilot-standby skips observability entirely),
          // so the issuerRef stays ACME; the promote annotation still rides
          // along so promoteAcmeIssuer treats every deploy-owned Certificate
          // uniformly.
          metadata: { annotations: { [PROMOTE_ISSUER_ANNOTATION]: issuerName } },
          spec: {
            dnsNames: observabilityCertificateDnsNames(domain),
            issuerRef: { name: issuerName, kind: 'ClusterIssuer' },
          },
        }),
      ],
      { env, description: 'applyK3sManifests: kubectl patch certificate/grafana-tls' },
    );
  }
  if (pilotStandby) {
    // Pilot-light: CA has nothing to scale for until a failover promotes
    // this cluster, so zero it the same way as the app Deployment above.
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
      { env, description: 'applyK3sManifests: zero cluster-autoscaler deployment (pilot standby)' },
    );
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
  // 5e. Wait for the rollout the `apply -k cluster-autoscaler` + `set image`
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
          ['-n', 'kube-system', 'rollout', 'status', 'deploy/cluster-autoscaler', '--timeout=300s'],
          { env, description: 'applyK3sManifests: cluster-autoscaler rollout status' },
        );
      } catch (err) {
        // Capture runs through runDeployDiagnostic (silent:true + re-emit) so
        // every byte lands in ~/.vibecarbon/logs/<env>-<ts>.log. The previous
        // `silent: false` version wrote to inherited fds, which the deploy-log
        // tee cannot see — on the 2026-07-31 e3 run it left a bare header and
        // cost a blind RCA. See the "Deploy-time diagnostic capture" block.
        await captureClusterAutoscalerDiagnostics({ env });
        throw err;
      }
    });
  }
  // 6. Patch the app deployment to use the sideloaded image BEFORE waiting on
  //    the db. base/ ships image=ghcr.io/<owner>/<repo>:main — no pull secret
  //    in local-first mode, so leaving it pointed at GHCR triggers an
  //    ImagePullBackOff for the whole db wait. Switching now means the app
  //    pods come up on the sideloaded image immediately (their readiness stays
  //    503 until the db answers); we still wait for their rollout below.
  await runKubectlWithRetry(
    ['-n', 'vibecarbon', 'set', 'image', 'deployment/app', `app=${imageTag}`],
    { env, description: 'applyK3sManifests: kubectl set image deployment/app' },
  );
  // 7. Wait for the db StatefulSet (applied with base in step 5) to be Ready:
  //    WAL archiving is on from its first boot (startup flags, see
  //    k8s/base/db/statefulset.yaml), so there is no archiving setup or
  //    restart after it. A changed wal-archive.sh rolls the pod through its
  //    template's sha annotation, inside this same wait.
  await perfAsync(`deploy.${perfPrefix}.awaitDb`, () => awaitDbRollout({ env }));
  // Gate the psql-bearing steps after this (the RLS audit, the wal-g audit,
  // the HA primary configuration) on the condition, not the proxy: the pod
  // being Ready is its readiness probe's verdict at one instant, and this
  // re-proves the REAL server accepts TCP right now (mitigation-audit
  // cluster 5 root fix; the d4 run-2 RCA in awaitPostgresAccepting).
  await awaitPostgresAccepting({ env, dbPod: DB_POD });
  // NOTE: the wal-g backup audit deliberately does NOT live here. It is the one
  // check whose subject can rot with ZERO in-cluster change (keys revoked at the
  // provider, bucket deleted), so it must not sit behind the persisted
  // `k3s-apply` skip gate — see deployK3s, which runs it unconditionally.
  // 8. No migration step: the app applies db/migrations itself at startup
  //    (under an advisory lock, so replicas take turns) and the readiness
  //    probe stays 503 until it has. A restored database carries its ledger,
  //    so there is no restore special case either.
  // 9. Wait for app rollout. The deployment template already has
  //    imagePullPolicy: IfNotPresent, so kubelet uses the sideloaded image
  //    without pulling. 300s wasn't enough on a cold deploy where the app
  //    pods stay unready until the database converges, hence 10m.
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
      await Promise.race([rollout, migrationWatch]);
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
  // Block on the backgrounded in-cluster registry push (kicked off right after
  // localRegistry.wait, above). It ran concurrently with the CA rollout +
  // db rollout + migrations + app rollout — nothing above reads the
  // registry — so awaiting it here keeps a failed push FATAL to the deploy
  // (CA-scaled workers must be able to pull the app image) without having
  // serialized its ~90-140s S3 upload onto the critical path.
  await registryPushPromise;
}

/**
 * Deploy a k3s cluster on Hetzner.
 *
 * Cold-path implementation through to "kubeconfig saved + cluster reachable."
 * App install + sideload land in a follow-up commit (Task 7).
 *
 * @param {K3sDeployOptions} options
 * @returns {Promise<{masterIp: string, floatingIp: string, dbIp: string, dbPrivateIp: string, workerIps: string[], networkId: string|number, kubeconfig: string, sshKeyPath: string}>}
 */
/**
 * Probe an existing Pulumi stack for its k3s token so a re-deploy replays it.
 *
 * Returns the stack's stored `k3sToken`, or undefined when the stack is
 * fresh/unreadable — the program then mints one exactly as before (cold
 * deploy path). Errors never propagate: an unreachable backend degrades to
 * cold behavior on a stack that, being unreachable, upStack will fail on
 * anyway with its own clearer error. See the call-site comment in
 * deployK3s's k3s-infra block for why replay is load-bearing (userData
 * immutability → full-cluster replace).
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
    probe = classifyK3sTokenProbe({ error: err instanceof Error ? err : new Error(String(err)) });
  }
  if (probe.status !== 'recovered') {
    log(
      `[k3s-infra] k3s token probe: ${probe.status} (${probe.reason}), minting a fresh token (fresh-stack path)`,
    );
  }
  return probe.priorK3sToken;
}

export async function deployK3s(options) {
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
  s.start('Preflight (docker + ssh + kubectl + helm)');
  for (const tool of ['docker', 'ssh', 'kubectl', 'helm']) {
    // checkDependency does a pure in-process PATH lookup (no child process),
    // so there's nothing to make async here — matches the same preflight
    // idiom used in deploy.js / github.js / ci-setup.js.
    if (!checkDependency(tool)) {
      throw new Error(`Required tool '${tool}' not found on PATH`);
    }
  }
  s.stop('Preflight OK');

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
    k3sVersion: K3S_VERSION,
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
      k3sVersion: K3S_VERSION,
      apiToken: options.apiToken,
      labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
      allowedSshIps: allowedCidrs,
      allowedK8sApiIps: allowedCidrs,
    };
    // Replay the stack's existing k3s token before building the real
    // program. The token is interpolated into every node's cloud-init
    // userData, and a userData change makes Pulumi REPLACE the server —
    // master included, which is etcd + PVC data loss on a live cluster.
    // The role reconciler makes re-running this block on an EXISTING stack
    // routine (primary↔standby shapes hash differently after a failover
    // swap), so the token must come from the stack; only a genuinely fresh
    // stack mints one. RCA 2026-07-17 e4 rig: the post-failover reconverge
    // deploy replaced ALL servers of BOTH clusters because this path
    // generated fresh tokens. Same probe-and-replay contract as scale's
    // converge seam.
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
    const { outputs } = await perfAsync(`deploy.${perfPrefix}.iac.upStack`, () =>
      upStack(options.environment, program, {
        provider: providerIdFor(options),
        providerToken: options.apiToken,
        s3Config: options.s3Config,
        projectName: options.projectName,
        // Recover stale-EMPTY outputs reads in place (read-only poll inside
        // upStack) — the hard gate below stays the loud last resort. Same
        // family member as the compose provision sites (bc94b18): this gate
        // was validation-without-recovery, the exact pre-fix shape that
        // failed e1's restore re-deploy twice on 2026-08-06/07.
        requiredOutputs: ['masterIp', 'floatingIp'],
      }),
    );
    if (!outputs.masterIp || !outputs.floatingIp) {
      throw new Error('Pulumi outputs missing masterIp or floatingIp');
    }
    state.completeStep('k3s-infra', outputs);
    s.stop(`Cluster provisioned: master=${outputs.masterIp} floating=${outputs.floatingIp}`);
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
    floatingIp,
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
  if (!masterPrivateIp || !dbPrivateIp) {
    throw new Error(
      'k3s-infra step result is missing masterPrivateIp/dbPrivateIp — the IaC ' +
        'program outputs both; a stale persisted step result predates them. ' +
        'Re-run the infra step (redeploy) to refresh the outputs.',
    );
  }

  // 4. Wait for cloud-init to finish + k3s to be Ready
  if (!state.shouldSkip('k3s-ready', { masterIp })) {
    state.startStep('k3s-ready', { masterIp });
    s.start('Waiting for k3s on master (cloud-init + Ready)');
    // 1200s (20 min) covers cold-init + apt-install + k3s-download + k3s-up.
    // Earlier 600s budget tripped on 2026-04-27 morning matrix when apt was
    // mid-install at the timeout (cloud-init-output.log diagnostics
    // confirmed). The diagnostic capture inside waitForK3sReady means a
    // genuine bug surfaces with cloud-init log content, so a longer budget
    // costs us nothing — we still get the same actionable signal on real
    // failures, just don't false-positive on slow apt mornings.
    await perfAsync(`deploy.${perfPrefix}.waitForReady`, () =>
      waitForK3sReady(masterIp, privateKeyPath, khPath, 1200),
    );
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
  // rationale (why only provisioning re-seeds).
  for (const seedIp of [masterIp, dbIp, ...(workerIps ?? [])].filter(Boolean)) {
    await seedKnownHosts(khPath, seedIp);
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

  // The wal-g-equipped db image is a pre-published image pulled from ghcr —
  // no per-deploy build or sideload. The db StatefulSet's container and both
  // its inits reference it (see buildDbManifestValues).
  const dbImageTag = resolveDbImageTag();

  // Opportunistic image pre-pull on every node — deliberately NOT awaited: it
  // overlaps the build/sideload/manifest work below so kubelet finds the
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
    kubeconfig = await fetchKubeconfig(
      masterIp,
      privateKeyPath,
      khPath,
      projectDir,
      options.environment,
    );
    state.completeStep('k3s-kubeconfig', { kubeconfig });
    s.stop('Kubeconfig saved');
  } else {
    kubeconfig = state.getStepResult('k3s-kubeconfig').kubeconfig;
  }

  // 6. Build the app image locally.
  // The gate folds the CONTENT of the build context (app source + Dockerfile)
  // and of the VITE_* build args into its inputs — see buildK3sBuildInputs for
  // why each one is load-bearing, and for the stale-image bug the coarse inputs
  // alone shipped.
  const buildInputs = buildK3sBuildInputs({
    projectName: options.projectName,
    domain: options.domain,
    masterPrivateIp,
    projectDir,
  });
  if (!state.shouldSkip('k3s-build', buildInputs)) {
    state.startStep('k3s-build', buildInputs);
    s.start(`Building app image (${masterPrivateIp}:5000/...)`);
    const built = await buildAppImage(
      projectDir,
      options.projectName,
      false,
      options.domain,
      masterPrivateIp,
    );
    state.completeStep('k3s-build', {
      tag: built.tag,
      gitSha: built.gitSha,
      isDirty: built.isDirty,
    });
    s.stop(`Image built: ${built.tag}`);
  }
  const { tag: imageTag } = state.getStepResult('k3s-build');

  // 7b. Sideload to every node (parallel SSH within sideloadK3s) AND fan out
  //     the app+db sideloads against each other. Both writes go through
  //     `docker save | ssh ... gunzip | k3s ctr import` against disjoint
  //     image refs on the same target nodes — kernel disk buffer + sshd
  //     multiplex two parallel streams. Critical path = max(app, db).
  //     The db image only NEEDS the database node (db is pinned there), but
  //     sideloading to all nodes is harmless and keeps the target list shared.
  const sshTargets = [`root@${masterIp}`];
  if (dbIp) sshTargets.push(`root@${dbIp}`);
  for (const wIp of workerIps ?? []) sshTargets.push(`root@${wIp}`);
  const sideloadInputs = { imageTag, targets: sshTargets.join(',') };
  const sideloadTasks = [];
  if (!state.shouldSkip('k3s-sideload', sideloadInputs)) {
    state.startStep('k3s-sideload', sideloadInputs);
    sideloadTasks.push(
      perfAsync(`deploy.${perfPrefix}.sideload.app`, () =>
        sideloadK3s({ tag: imageTag, sshTargets, sshKey: privateKeyPath, khPath }),
      ).then(() => state.completeStep('k3s-sideload')),
    );
  }
  if (sideloadTasks.length > 0) {
    s.start(`Sideloading app to ${sshTargets.length} node(s)`);
    await Promise.all(sideloadTasks);
    s.stop('Sideload complete (app)');
  }

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
  });
  if (!state.shouldSkip('k3s-apply', applyInputs)) {
    state.startStep('k3s-apply', applyInputs);
    s.start('Applying k8s manifests + starting the database + rolling out app');
    const envLocal = loadEnvLocal(join(projectDir, '.env.local'));
    await perfAsync(`deploy.${perfPrefix}.applyManifests`, () =>
      applyK3sManifests({
        perfPrefix,
        kubeconfig,
        projectDir,
        projectName: options.projectName,
        imageTag,
        dbImageTag,
        envLocal,
        domain: options.domain || 'localhost',
        s3Config: options.s3Config,
        backupBucketName: options.backupBucketName,
        restore: options.restore,
        dnsProvider: options.dnsProvider,
        // Resolved upstream (deploy effects) for whichever DNS provider is
        // selected — the DNS credential is independent of the compute one,
        // except on Hetzner-compute + Hetzner-DNS where they are the same
        // Cloud API token (the separate dns.hetzner.com console + token were
        // retired May 2026, zone management folded into the Cloud Console).
        dnsToken: options.dnsToken,
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
        // Phase 6: registry-push wiring. operator opens an SSH tunnel
        // to master:5000 inside applyK3sManifests; the same SSH coords
        // sideloadK3s already used (privateKeyPath + per-env khPath).
        masterIp,
        sshKeyPath: privateKeyPath,
        khPath,
        // HA passes a per-cluster port so primary + standby don't race
        // for `localhost:5000` on the operator host. Single-cluster
        // deploys leave it undefined → applyK3sManifests defaults to 5000.
        localTunnelPort: options.localTunnelPort,
        // The database node's own private IP — rendered (buildDbManifestValues)
        // into the seed-standby init's SEED_PRIMARY_HOST (repl-gateway relay
        // endpoint). Already in scope from infraOutputs (returned below).
        dbPrivateIp,
        // M3 Task 2: the master's own private IP — renderCarbonAutoscalerConfig
        // (CA-spawned worker join target) and pushImageToLocalRegistry
        // (registry-ref host, must match buildAppImage's masterPrivateIp
        // above). Already in scope from infraOutputs (returned below).
        masterPrivateIp,
        // M3 Task 9c: this cluster's VPC CIDR — drives the provider-
        // conditional S3-egress-VPC-allowance manifest. Already in scope
        // from infraOutputs (destructured above with its resume-compat
        // fallback).
        vpcCidr,
      }),
    );
    state.completeStep('k3s-apply');
    s.stop('App rolled out');
  }

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
  //     Gated only on S3 being configured at all (mirrors the archiving-enable
  //     block); the probe independently re-checks that from inside the
  //     container and self-skips a WALG_ROLE=standby node.
  //     THROWS on failure — see src/lib/deploy/walg-audit.js.
  if (options.s3Config?.accessKey) {
    await perfAsync(`deploy.${perfPrefix}.verifyWalgBackups`, () =>
      verifyWalgBackups({ kubeconfig }),
    );
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
    workerIps,
    networkId,
    kubeconfig,
    sshKeyPath: privateKeyPath,
    imageTag,
  };
}
