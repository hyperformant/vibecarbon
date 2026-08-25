/**
 * k3s-on-Hetzner deploy backend.
 *
 * The Pulumi program is `hetzner-k8s.js`; cloud-init scripts are
 * `carbon/cloud-init/k3s/{master,supabase,worker}-init.sh`.
 *
 * End-to-end flow on a cold deploy:
 *   1. Preflight: docker, ssh, kubectl, helm on PATH; server-type architecture.
 *   2. Generate (or reuse) the SSH keypair under projectDir/.vibecarbon/ssh-<env>.
 *   3. Pulumi up — cloud-init installs k3s + hcloud-ccm/csi on each node.
 *   4. Wait for SSH on master + `/tmp/k3s-ready` marker.
 *   5. scp `/etc/rancher/k3s/k3s.yaml` from master, patch server URL to public IP.
 *   6. Build app image locally (10.0.1.1:5000/<project>:<sha>[-dirty]-<ts>).
 *   7. Sideload via `docker save TAG | ssh node 'k3s ctr images import -'` per node.
 *   8. `kubectl apply -k k8s/base/` (cert-manager via infra/, traefik, app).
 *   9. (helm-render supabase values + helm install supabase.)
 *   10. `kubectl set image deploy/app app=<tag>` + rollout-status.
 *
 * Warm path: skip 1-5; rebuild image (6); sideload (7) skipping unchanged tag;
 * apply changed manifests (8); rollout (10).
 *
 * Target cold-deploy time: ≤ 3 min for single-master + supabase + 0 workers.
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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { progressLog, spinner } from '../../cli/progress.js';
import { checkDependency, runCommandAsync, writeSecretFile } from '../../command.js';
import { featureConfigKeys, featureSecretKeys } from '../../config-registry.js';
import { DNS01_PROVIDERS } from '../../dns-provider.js';
import { buildHostKeyOptsForPath, knownHostsPath, seedKnownHosts } from '../../host-keys.js';
import {
  carbonAutoscalerImageRef,
  clusterAutoscalerImageRef,
  csiSidecarSetImagePlan,
  dbImageRef,
} from '../../images.js';
import { perfAsync } from '../../perf.js';
import { providerFor, providerIdFor } from '../../providers/index.js';
import { pollUntil, runWithRetry } from '../../retry.js';
import { shEscape } from '../../shell.js';
import { scpWithRetry } from '../../ssh.js';
import { postAdminUser, waitForGotrueHealth } from '../admin-user.js';
import { collectComposeBuildArgs } from '../compose/build-args.js';
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
import {
  awaitCertManagerAdmission,
  awaitControlPlaneServing,
  awaitPostgresAccepting,
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
// NetworkPolicies (app/registry/supabase-db S3-purposed sibling policies).
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
 * projectName/domain/supabaseUrl/masterPrivateIp are all unchanged, so
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
 *     can see them: rotating the anon key or flipping a feature flag changes
 *     the shipped bundle with the whole tree byte-identical. Digested rather
 *     than carried as values so a public-but-sensitive key never lands in
 *     `.vibecarbon/deploy-state-<env>.json` if the state format ever starts
 *     persisting inputs.
 *
 * The coarse inputs stay because neither digest can see them: `domain` /
 * `supabaseUrl` are baked into the bundle (a change to the URL DERIVATION
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
 * @returns {{ projectName: string, domain: string|undefined, supabaseUrl: string|undefined, masterPrivateIp: string, sourceDigest: string, buildArgsDigest: string }}
 */
export function buildK3sBuildInputs({ projectName, domain, masterPrivateIp, projectDir }) {
  const buildArgs = domain ? collectComposeBuildArgs(projectDir, { projectName, domain }) : {};
  return {
    projectName,
    domain,
    supabaseUrl: domain ? `https://${domain}` : undefined,
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
 * right because the step's most durability-critical render — the Supabase
 * chart's PVC classes — comes from a provider STATIC, not from either manifest
 * tree. Neither digest can see it, so without this key a warm/state-resumed
 * redeploy would happily skip `k3s-apply` and leave a cluster's database on
 * whatever class it originally bound (RCA: kept k8s-ha rig e4, 2026-08-05 —
 * node-local `local-path` under PGDATA). Adding the key also means the FIRST
 * redeploy after this CLI upgrade re-runs the step everywhere, which is exactly
 * how the fix reaches already-deployed environments.
 *
 * @param {{ imageTag: string, dbImageTag: string, restore?: string, projectDir: string, storageClass?: string }} args
 * @returns {{ imageTag: string, dbImageTag: string, restore: string, storageClass: string, manifestDigest: string, bundledManifestDigest: string }}
 */
export function buildK3sApplyInputs({ imageTag, dbImageTag, restore, projectDir, storageClass }) {
  return {
    imageTag,
    dbImageTag,
    restore: restore ?? '',
    storageClass: storageClass ?? '',
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
 * whole vibecarbon-secrets Secret — every configure-managed OAuth/SMTP/billing
 * key plus REDIS_*), to the Supabase values render (ADMIN_EMAIL,
 * ADMIN_PASSWORD, MICROSOFT_TENANT_ID, GOTRUE_MAILER_AUTOCONFIRM), and to
 * ACME_CA_SERVER. None of that was in the gate. `.env.local` sits in neither
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
  // Sorted so key ORDER in the file is not a change; ADMIN_*/ACME_CA_SERVER/
  // GOTRUE_MAILER_AUTOCONFIRM/MICROSOFT_TENANT_ID join SECRET_KEYS because the
  // values render reads them directly.
  const watched = [
    ...SECRET_KEYS,
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
    'MICROSOFT_TENANT_ID',
    'GOTRUE_MAILER_AUTOCONFIRM',
    'ACME_CA_SERVER',
  ].sort();
  for (const key of watched) {
    const value = envLocal[key];
    if (value === undefined) continue;
    hash.update(`${key}=${value}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

/** The db image is pre-published + multi-arch — pulled, never built/sideloaded. */
export function resolveDbImageTag() {
  return dbImageRef();
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
 * Don't use this for `kubectl wait` / `kubectl rollout status` /
 * `kubectl logs --follow`. They have their own --timeout and piping
 * their stdio through buffered spawnSync would hide live progress.
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
 * boots master/supabase/worker nodes with, or a CA-spawned worker would
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
 * (api, studio, dashboard, grafana, n8n …) without separate per-subdomain
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
 * @property {string} supabaseServerType
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
const SUPABASE_HELM_REPO_URL = 'https://supabase-community.github.io/supabase-kubernetes';
const SUPABASE_HELM_REPO_NAME = 'supabase-community';
const SUPABASE_HELM_CHART = `${SUPABASE_HELM_REPO_NAME}/supabase`;
// PINNED: supabase.values.yaml is schema-coupled to the chart's values
// contract, so the chart version must move in lockstep with the template —
// never float it. Chart 0.7.1 (published 2026-07-14) switched environment.*
// from MAPS to LISTS of {name, value} and instantly broke every unpinned
// deploy ("supabase.env.render at <.name>: can't evaluate field name" —
// helm coalesce kept our then-map values over the new list defaults). Under
// the list schema helm REPLACES lists wholesale, so our values carry each
// overridden component's FULL default list — bumping this pin requires
// re-diffing those lists against the new chart's defaults (see the
// environment section header in carbon/k8s/values/supabase.values.yaml),
// bumping the scaffolded k8s/gitops/supabase/helm-release.yaml pin, and
// running the k8s e2e scenario.
// PIN BUMP CHECKLIST (4 lockstep artifacts): this constant, the gitops
// helm-release.yaml, the values env-list re-diff, AND regenerate
// tests/fixtures/supabase-chart-workloads.json via
// `node scripts/gen-chart-workloads-snapshot.mjs` (drives the standby
// zero-overlay drift guard + failover scale-up derivation).
//
// BUMP TRAP for 0.7.2 (verified 2026-07-30 by diffing both chart tarballs):
// 0.7.1's realtime Deployment HARDCODES the startup command --
//   command: ["/bin/sh"]
//   args: ["-c", "/app/bin/migrate && /app/bin/realtime eval
//          'Realtime.Release.seeds(Realtime.Repo)' && /app/bin/server"]
// 0.7.2 makes both values-driven, guarded by `{{- with
// .Values.deployment.realtime.command }}`, and defaults them to EMPTY LISTS
// (values.yaml:460-461). `with` skips an empty list, so the container silently
// falls back to the image entrypoint. Our values set environment.realtime but
// nothing under deployment.realtime, so a naive bump DROPS realtime's migrate
// + seed step with no error. Bumping to 0.7.2+ means adding
// deployment.realtime.command/args to supabase.values.yaml carrying the 0.7.1
// literals. No image tags changed between 0.7.1 and 0.7.2, so there is no
// security pressure to take this bump.
const SUPABASE_HELM_CHART_VERSION = '0.7.1';

/**
 * StatefulSet annotation recording the sha of the wal-archive.sh ConfigMap the
 * running db pod was started with. Exists because that script is mounted with
 * `subPath`, and subPath ConfigMap mounts are never updated in place — see the
 * freshness step in applyK3sManifests for the full reasoning.
 */
export const WAL_ARCHIVE_SHA_ANNOTATION = 'vibecarbon.dev/wal-archive-sha';
const SUPABASE_HELM_RELEASE_NAME = 'supabase';
const SUPABASE_HELM_TIMEOUT = '15m';

/**
 * Components whose images the pre-pull skips: `db` is vibecarbon's own
 * wal-g image (built + sideloaded, never pulled from a registry), and the
 * rest are disabled in carbon/k8s/values/supabase.values.yaml
 * (deployment.<comp>.enabled: false) so their pods never exist. A unit
 * drift-guard (k3s-prepull-images.test.ts) keeps this list in lockstep with
 * the values file.
 */
export const PREPULL_EXCLUDED_COMPONENTS = [
  'db',
  'functions',
  'analytics',
  'vector',
  'minio',
  // minioClient's init-bucket container is template-gated on
  // deployment.minio.enabled — off in our values, so it never runs.
  'minioClient',
];

/**
 * Parse the `image:` section of `helm show values` output into fully
 * qualified image refs for `ctr images pull`. Line-based on purpose (the CLI
 * carries no YAML dependency) — the chart's values shape is stable:
 *
 *   image:
 *     <component>:
 *       repository: supabase/gotrue
 *       tag: v2.177.0
 *
 * Bare Docker Hub repos are qualified to `docker.io/...` (single-segment
 * official images get `library/`); refs that fail a strict character
 * allowlist are dropped — they end up inside a remote shell script, so
 * nothing outside [A-Za-z0-9._/:-] may pass.
 *
 * @param {string} valuesYaml - raw `helm show values` output
 * @param {{exclude?: string[]}} [opts]
 * @returns {string[]} deterministic, duplicate-free image refs
 */
export function parseChartImages(valuesYaml, { exclude = [] } = {}) {
  const images = [];
  const lines = valuesYaml.split('\n');
  const start = lines.findIndex((l) => /^image:\s*$/.test(l));
  if (start === -1) return images;

  let comp = null;
  let repo = null;
  let tag = null;
  const flush = () => {
    if (!comp || !repo || tag == null || exclude.includes(comp)) return;
    if (!/^[A-Za-z0-9._/-]+$/.test(repo) || !/^[A-Za-z0-9._-]+$/.test(tag)) return;
    const firstSegment = repo.split('/')[0];
    let qualified;
    if (firstSegment.includes('.') || firstSegment.includes(':')) {
      qualified = repo; // already carries a registry host
    } else if (repo.includes('/')) {
      qualified = `docker.io/${repo}`;
    } else {
      qualified = `docker.io/library/${repo}`;
    }
    images.push(`${qualified}:${tag}`);
  };

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next top-level key — image section over
    const compMatch = line.match(/^ {2}([\w-]+):/);
    if (compMatch) {
      flush();
      comp = compMatch[1];
      repo = null;
      tag = null;
      continue;
    }
    const repoMatch = line.match(/^ {4}repository:\s*"?([^"\n]+?)"?\s*$/);
    if (repoMatch) {
      repo = repoMatch[1];
      continue;
    }
    const tagMatch = line.match(/^ {4}tag:\s*"?([^"\n]+?)"?\s*$/);
    if (tagMatch) {
      tag = tagMatch[1];
    }
  }
  flush();
  return [...new Set(images)];
}

/**
 * The two images of the `cluster-autoscaler` pod (upstream CA + our
 * carbon-autoscaler sidecar), pre-pulled AHEAD of the supabase chart images.
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
 * Assemble the pre-pull list: cluster-autoscaler pod first, chart images
 * after, duplicate-free and order-stable.
 *
 * @param {string[]} chartImages
 * @returns {string[]}
 */
export function buildPrePullImages(chartImages) {
  return [...new Set([...clusterAutoscalerPodImages(), ...(chartImages ?? [])])];
}

/**
 * One-line pre-pull summary for the deploy log. Lives here rather than inline
 * at the call site so the fire-and-forget shape
 * (`prePullChartImages(...).then(...).catch(...)`) stays compact enough to
 * read — and to keep its structural guard in k3s-prepull-images.test.ts
 * meaningful.
 *
 * A chart-enumeration failure is reported WITHOUT swallowing the fact that
 * the cluster-autoscaler images still pulled — otherwise the line reads as
 * "the pre-pull did nothing", which is the opposite of what happened.
 *
 * @param {{images: number, nodes: number, chartError: Error|null}} result
 * @param {number} elapsedMs
 * @returns {string}
 */
export function formatPrePullSummary(result, elapsedMs) {
  const base = `[prepull] ${result.images} images on ${result.nodes} node(s) in ${Math.round(elapsedMs / 1000)}s`;
  if (!result.chartError) return base;
  const why = (result.chartError.message || String(result.chartError)).slice(0, 120);
  return `${base}, chart list unavailable (${why}); cluster-autoscaler images only`;
}

/**
 * Opportunistic image pre-pull. The supabase pods' images pull from Docker
 * Hub when helm installs — on slow-pull regions that is the dominant cost of
 * the helm wait (hil measured ~135s to all-pods-Ready vs ash's 55-59s on
 * identical images). Firing `ctr images pull` on every node right after k3s
 * is Ready moves those pulls 2-3 minutes earlier, overlapping the sideload /
 * manifest work, so kubelet finds the images already present. The
 * cluster-autoscaler pod's images ride along at the front of the list — see
 * clusterAutoscalerPodImages().
 *
 * Fully fire-and-forget by contract: the caller must NOT await this into the
 * deploy's critical path, and every failure mode (repo fetch, SSH, a single
 * pull) degrades to today's behavior — kubelet pulls on demand. One SSH per
 * node (parallel across nodes); pulls run sequentially inside a node to
 * bound NIC + containerd churn. `|| true` per image keeps one bad ref from
 * aborting the rest.
 *
 * Chart enumeration failing does NOT cancel the CA pulls: those two are the
 * incident-critical pair, and `helm show values` reaching out to a chart repo
 * is exactly the kind of network step that has no business taking them down
 * with it. The error is surfaced on the result for the caller to log.
 *
 * @returns {Promise<{images: number, nodes: number, chartImages: number, chartError: Error|null}>}
 */
export async function prePullChartImages({ nodeIps, sshKeyPath, khPath }) {
  let chartImages = [];
  let chartError = null;
  try {
    // Enumerate from the PINNED chart's default values so the pull list can
    // never drift from what helm installs. repo add is idempotent.
    await runCommandAsync(
      ['helm', 'repo', 'add', SUPABASE_HELM_REPO_NAME, SUPABASE_HELM_REPO_URL],
      { silent: true, ignoreError: true },
    );
    const valuesYaml = await runCommandAsync(
      ['helm', 'show', 'values', SUPABASE_HELM_CHART, '--version', SUPABASE_HELM_CHART_VERSION],
      { silent: true },
    );
    if (typeof valuesYaml !== 'string' || !valuesYaml.trim()) {
      throw new Error('helm show values returned nothing');
    }
    chartImages = parseChartImages(valuesYaml, { exclude: PREPULL_EXCLUDED_COMPONENTS });
  } catch (err) {
    chartError = err instanceof Error ? err : new Error(String(err));
  }
  const images = buildPrePullImages(chartImages);
  const targets = (nodeIps ?? []).filter(Boolean);
  if (images.length === 0 || targets.length === 0) {
    return { images: images.length, nodes: 0, chartImages: chartImages.length, chartError };
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
  return {
    images: images.length,
    nodes: targets.length,
    chartImages: chartImages.length,
    chartError,
  };
}

// cert-manager-webhook-hetzner (third-party chart for the Hetzner DNS-01
// solver): repo/chart/version/release-name now live on
// DNS01_PROVIDERS.hetzner.webhook in src/lib/dns-provider.js — see that
// row's comment for the pinning rationale.

/**
 * Parse a `.env.local` file into a plain object.
 *
 * Strict subset of dotenv: `KEY=VALUE` per line, optional surrounding
 * single/double quotes stripped, lines starting with `#` or blank ignored.
 * Values with `=` in them are preserved (split-once on the first `=`).
 *
 * @param {string} envPath
 * @returns {Record<string, string>}
 */
function loadEnvLocal(envPath) {
  if (!existsSync(envPath)) {
    throw new Error(`loadEnvLocal: ${envPath} not found. Run 'vibecarbon create' to generate it.`);
  }
  const out = {};
  const raw = readFileSync(envPath, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
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
  // App image: collect VITE_* build args (incl. VITE_SUPABASE_URL rewritten to
  // https://<domain> — single public origin) so the browser bundle ships with
  // real config instead of empty strings. buildLocalImage previously passed NO build args, so the
  // k8s SPA crashed on load with "Missing Supabase environment variables" —
  // compose plumbs these via collectComposeBuildArgs, k8s did not. The backup
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
 * and the supabase node run their own k3s install asynchronously
 * (worker-init.sh / supabase-init.sh) which can take 1-3 min after the
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
 * (workers/supabase finish their k3s install asynchronously after the master
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
 * Generated infra secrets that must land in the in-cluster vibecarbon-secrets
 * Secret. The Supabase Helm chart reads JWT_SECRET + ANON_KEY +
 * SERVICE_ROLE_KEY via secretRef from this Secret; the app Deployment reads
 * DB_PASSWORD + the rest via envFrom.
 *
 * These are generated at deploy time (not user-configured), so they stay
 * local here rather than in the config-registry.
 */
const INFRA_SECRET_KEYS = [
  'DB_PASSWORD',
  'JWT_SECRET',
  'ANON_KEY',
  'SERVICE_ROLE_KEY',
  'REALTIME_SECRET',
  'LOGFLARE_API_KEY',
  'VAULT_ENC_KEY',
  'PG_META_CRYPTO_KEY',
  'DB_ENC_KEY',
  'REPL_PASSWORD',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
  'ADMIN_PASSWORD_HASH',
];

/**
 * Full allowlist of .env.local keys that land in vibecarbon-secrets: generated
 * infra secrets plus every configure-managed runtime key (billing/OAuth/SMTP,
 * both secret and non-secret) from the config-registry. The app Deployment
 * pulls the whole Secret via `envFrom`, so feature config reaches the pod
 * without a second per-key list here. Client-side VITE_* keys are deliberately
 * excluded — they're baked into the image at build time, not runtime env.
 */
export const SECRET_KEYS = [...INFRA_SECRET_KEYS, ...featureSecretKeys(), ...featureConfigKeys()];

/**
 * Apply the in-cluster `vibecarbon-secrets` Secret from the project's
 * `.env.local`. Idempotent: rendered as a Secret manifest and piped to
 * `kubectl apply -f -` (server-side apply semantics) so re-runs upsert
 * cleanly.
 *
 * Must run BEFORE the base/ kustomization apply, because the app
 * Deployment in base/ references this Secret via envFrom.
 *
 * S3 backup credentials (S3_ACCESS_KEY/SECRET_KEY/BUCKET/ENDPOINT/REGION)
 * are merged in if `s3Config` is provided — backup CronJob reads them.
 * `backupBucketName` is the dedicated backup bucket (separate from the
 * storage bucket in s3Config.bucket); without it, backup.sh falls back to
 * the storage bucket and uploads dumps next to user files (observed
 * 2026-04-27 k8s-ha matrix #6 — restore couldn't find backups).
 *
 * @param {{kubeconfig: string, envLocal: Record<string,string>, s3Config?: {accessKey: string, secretKey: string, bucket: string, endpoint: string, region: string}, backupBucketName?: string|null}} args
 */
export async function applyVibecarbonSecrets({ kubeconfig, envLocal, s3Config, backupBucketName }) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  /** @type {Record<string,string>} */
  const stringData = {};
  for (const key of SECRET_KEYS) {
    if (envLocal[key]) stringData[key] = envLocal[key];
  }
  // .env.local stores Supabase keys with the SUPABASE_ prefix (matches the
  // app's runtime env vars), but the supabase Helm chart's secretRefKey
  // mapping reads them under their bare names from this Secret. Translate.
  // Without this, kubelet fails kong/storage/studio/app pods with
  // "couldn't find key ANON_KEY in Secret vibecarbon/vibecarbon-secrets".
  if (!stringData.ANON_KEY && envLocal.SUPABASE_ANON_KEY) {
    stringData.ANON_KEY = envLocal.SUPABASE_ANON_KEY;
  }
  if (!stringData.SERVICE_ROLE_KEY && envLocal.SUPABASE_SERVICE_ROLE_KEY) {
    stringData.SERVICE_ROLE_KEY = envLocal.SUPABASE_SERVICE_ROLE_KEY;
  }
  // Supabase chart's db.secretRefKey.database maps to DB_NAME in this Secret.
  // Neither .env.local nor SECRET_KEYS supplies it, so the chart-canonical
  // default "postgres" is hardcoded — kubelet otherwise fails the supabase-db
  // pod with "couldn't find key DB_NAME in Secret vibecarbon/vibecarbon-secrets".
  if (!stringData.DB_NAME) stringData.DB_NAME = envLocal.POSTGRES_DB || 'postgres';
  // Redis addon: the redis Deployment reads REDIS_PASSWORD from this Secret
  // (required secretKeyRef — without it the pod can never start), and the
  // app's distributed rate-limit store connects via REDIS_URL, delivered by
  // the app Deployment's envFrom on this Secret. `redis` is the addon's
  // ClusterIP Service in the same namespace. Compose's equivalent wiring
  // lives in services/redis/compose/docker-compose.yml (app env extension).
  if (envLocal.REDIS_ENABLED === 'true' && envLocal.REDIS_PASSWORD) {
    stringData.REDIS_PASSWORD = envLocal.REDIS_PASSWORD;
    stringData.REDIS_URL = `redis://:${envLocal.REDIS_PASSWORD}@redis:6379`;
  }
  if (s3Config) {
    stringData.S3_ACCESS_KEY = s3Config.accessKey;
    stringData.S3_SECRET_KEY = s3Config.secretKey;
    stringData.S3_BUCKET = s3Config.bucket;
    stringData.S3_ENDPOINT = s3Config.endpoint;
    stringData.S3_REGION = s3Config.region;
    // AWS-SDK-format credentials file for wal-g in the supabase-db pod. The
    // supabase Helm chart can't inject secret env on the db container
    // (environment.db is string-only), so instead of a post-helm env patch
    // (which helm would strip every upgrade → a db restart every deploy) we
    // mount THIS key as a file and point AWS_SHARED_CREDENTIALS_FILE at it
    // (volume is helm-owned → never stripped → no per-deploy restart). See
    // k8s/values/supabase.values.yaml deployment.db.volumes.
    stringData.S3_CREDENTIALS_INI = `[default]\naws_access_key_id=${s3Config.accessKey}\naws_secret_access_key=${s3Config.secretKey}\n`;
  }
  if (backupBucketName) {
    stringData.S3_BACKUP_BUCKET = backupBucketName;
  }
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
  // Build secret YAML; pipe to kubectl apply via stdin (values never hit
  // a shell argv). stringData → kubectl base64-encodes for us.
  const secretYaml = [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    '  name: vibecarbon-secrets',
    '  namespace: vibecarbon',
    'type: Opaque',
    'stringData:',
    ...Object.entries(stringData).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
  ].join('\n');
  await runKubectlWithRetry(['apply', '-f', '-'], {
    env,
    input: secretYaml,
    description: 'applyVibecarbonSecrets: kubectl apply Secret/vibecarbon-secrets',
  });
}

/**
 * Provision the SCOPED secret + config the isolated Grafana needs in the
 * `vibecarbon-observability` namespace (H-9). Secrets/ConfigMaps are
 * namespace-scoped, so Grafana's `grafana-secrets`/`grafana-config` refs would
 * resolve to nothing after the namespace move.
 *
 * SECURITY: this deliberately ships ONLY the three keys Grafana reads —
 * ADMIN_EMAIL + ADMIN_PASSWORD (its login) and SITE_URL (root URL) — NOT the
 * whole vibecarbon-secrets bundle. No DB / service-role / JWT material crosses
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
 * The pinned chart's `persistence.<key>` entries that OUR values file actually
 * renders a PersistentVolumeClaim for (PVC object name is `supabase-<key>`).
 *
 * Kept in lockstep with `tests/fixtures/supabase-chart-workloads.json` (`pvcs`)
 * — the same 4th lockstep artifact the standby zero-overlay is pinned against.
 * A chart bump that adds or renames a PVC fails
 * tests/unit/deploy/k3s-supabase-storage-class.test.ts's drift guard; regenerate
 * with `node scripts/gen-chart-workloads-snapshot.mjs` and update this list.
 */
export const SUPABASE_PVC_KEYS = ['db', 'imgproxy', 'pgsodium', 'snippets', 'storage'];

/**
 * The PVC objects whose StorageClass decides the DATABASE's durability model:
 * `supabase-db` (PGDATA) and `supabase-pgsodium` (the encryption key root).
 * Everything else the chart provisions is a cache that a redeploy rebuilds, so
 * the wrong-class guard below is bounded to these two.
 */
export const SUPABASE_DB_CRITICAL_PVCS = ['supabase-db', 'supabase-pgsodium'];

/**
 * Build the `helm --set` expression that pins the provider's StorageClass on
 * every chart PVC.
 *
 * RCA (kept k8s-ha rig e4, 2026-08-05): nothing pinned it. The chart's
 * `_pvc.tpl` emits `storageClassName` only `{{- if $persistence.storageClassName }}`
 * and our values file left it unset, so every Supabase PVC was created with NO
 * class and the kube-apiserver's DefaultStorageClass admission plugin stamped
 * whichever class was default at that instant. That is a race, not a choice:
 * k3s ships `local-path` annotated `is-default-class: "true"` and
 * hetznercloud/csi-driver's `hcloud-volumes` is annotated the same way (its
 * StorageClass is byte-identical at v2.9.0 and at the v2.18.1 pinned now),
 * and with two defaults the plugin picks the NEWEST by creationTimestamp. The
 * rig's standby won that race (CSI volumes); a state-resumed deploy of the
 * primary lost it and put PGDATA on node-local disk — no detachable volume, so
 * replication, failover and wal-g restore all silently lose their footing.
 *
 * `--set` rather than a values-template placeholder on purpose: helm applies
 * `--set` AFTER every `-f`, and the values file installSupabase renders is the
 * PROJECT'S copy (laid down once by `create`, never re-synced), so a template
 * placeholder would be silently absent on every project older than this fix —
 * the exact failure mode being fixed.
 *
 * @param {string} storageClass - `ProviderClass.K8S_STORAGE_CLASS`
 * @returns {string} comma-joined `persistence.<key>.storageClassName=<class>`
 */
export function buildSupabaseStorageClassSetArg(storageClass) {
  if (!storageClass) {
    throw new Error(
      'installSupabase: no storageClass, ProviderClass.K8S_STORAGE_CLASS is empty. ' +
        'Refusing to install Supabase without a pinned StorageClass: the chart would ' +
        "fall back to the cluster's default class, which can be k3s' node-local " +
        'local-path and silently breaks replication/failover/restore.',
    );
  }
  return SUPABASE_PVC_KEYS.map((k) => `persistence.${k}.storageClassName=${storageClass}`).join(
    ',',
  );
}

/**
 * Pre-flight the two ways a Supabase install can end up on node-local storage,
 * and fail LOUD instead of proceeding.
 *
 * 1. The provider's StorageClass is absent from the cluster. cloud-init installs
 *    the CSI driver on a best-effort 3-try loop whose failure is never checked
 *    (`carbon/cloud-init/k3s/master-init.sh`), and `/tmp/k3s-ready` is touched
 *    regardless — so a cluster genuinely can come up with only `local-path`.
 *    With the class now pinned the PVCs would sit Pending and `helm --wait`
 *    would burn its full 15m timeout; this turns that into an instant, named
 *    failure.
 * 2. A db-critical PVC already exists on a DIFFERENT class. `spec.storageClassName`
 *    is immutable, so helm's next upgrade would be rejected by the API server
 *    with an opaque "spec is immutable" error — and, worse, a deploy that
 *    predates this fix may already have bound PGDATA to local-path.
 *
 * Probe failures are NOT fatal: a transient apiserver blip must not fail a
 * deploy, and the `--set` pin still prevents a silent wrong-class bind (the PVC
 * would stay Pending and helm would fail loudly). An EMPTY StorageClass listing
 * is treated as "could not verify" rather than "none exist" — every real k3s
 * cluster has at least `local-path`, so an empty list means the probe, not the
 * cluster, came up short.
 *
 * @param {{storageClass: string, namespace?: string, env: NodeJS.ProcessEnv}} args
 *   `env` must already carry KUBECONFIG (installSupabase builds it that way).
 */
export async function assertSupabaseStorageClass({ storageClass, namespace = 'vibecarbon', env }) {
  /** @param {string[]} args */
  const probe = async (args, description) => {
    try {
      return await runKubectlWithRetry(args, { env, captureStdout: true, description });
    } catch (err) {
      console.error(
        `[storage-class] probe skipped (${(err?.message || String(err)).slice(0, 160)}), ` +
          'the --set pin still prevents a silent wrong-class bind',
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
    'assertSupabaseStorageClass: kubectl get pvc',
  );
  /** @type {[string, string][]} */
  const mismatched = [];
  for (const line of (pvcOut ?? '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const observed = line.slice(idx + 1).trim();
    if (!SUPABASE_DB_CRITICAL_PVCS.includes(name)) continue;
    if (observed !== storageClass) mismatched.push([name, observed]);
  }
  if (mismatched.length > 0) {
    const detail = mismatched
      .map(([name, observed]) => `  - ${name}: ${observed || '(no class)'}`)
      .join('\n');
    throw new Error(
      `installSupabase: database PVC(s) are on the WRONG StorageClass; expected ${storageClass}:\n` +
        `${detail}\n` +
        "A PVC's spec.storageClassName is immutable, so this cannot be repaired in place. " +
        'These volumes are node-local, not detachable: replication, failover and wal-g ' +
        'restore do not work against them.\n' +
        'Remediation (DESTRUCTIVE; the local copy of this data is deleted):\n' +
        `  kubectl -n ${namespace} scale statefulset supabase-supabase-db --replicas=0\n` +
        `  kubectl -n ${namespace} delete pvc ${mismatched.map(([n]) => n).join(' ')}\n` +
        '  then re-run deploy. If this cluster holds the only copy of the data, take a ' +
        'wal-g backup first and bring it back with `vibecarbon restore` afterwards.',
    );
  }

  const scOut = await probe(
    ['get', 'storageclass', '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}'],
    'assertSupabaseStorageClass: kubectl get storageclass',
  );
  const classes = (scOut ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (classes.length > 0 && !classes.includes(storageClass)) {
    throw new Error(
      `installSupabase: StorageClass '${storageClass}' does not exist in this cluster ` +
        `(found: ${classes.join(', ')}). The provider's CSI driver did not install — ` +
        'cloud-init applies it on a best-effort retry loop whose failure is not checked. ' +
        'Refusing to install Supabase: without it the database PVCs would fall back to ' +
        "the cluster's default class (k3s' node-local local-path). Check the master's " +
        '/var/log/cloud-init-output.log, re-apply the CSI driver, then re-run deploy.',
    );
  }
}

/**
 * How many not-ready pods the helm-failure message names before summarizing
 * the rest as a count. A deploy error must stay one readable line, and past
 * the first handful the names stop adding signal.
 */
const SUPABASE_POD_NAME_CAP = 8;

/**
 * The `kubectl get pods` argv behind the helm-failure explanation.
 *
 * Scoped to the release's own label selector: the `vibecarbon` namespace also
 * carries our app and any addons, and helm's `--wait` was not waiting on
 * those.
 *
 * PHASE and the READY condition are both read because `--wait` gates on
 * READY, not on phase — a Running-but-not-Ready pod times helm out exactly
 * like a Pending one, and reporting phase alone would call it healthy.
 *
 * @returns {string[]}
 */
export function supabasePodListArgs() {
  return [
    'kubectl',
    '-n',
    'vibecarbon',
    'get',
    'pods',
    '-l',
    'app.kubernetes.io/instance=supabase',
    '-o',
    'custom-columns=NAME:.metadata.name,PHASE:.status.phase,READY:.status.conditions[?(@.type=="Ready")].status',
    '--no-headers',
  ];
}

/**
 * Turn `supabasePodListArgs`' output into the one-line truth about what helm's
 * `--wait` actually left behind.
 *
 * @param {string} raw - `kubectl get pods … --no-headers` stdout
 * @returns {string}
 */
export function summarizeSupabasePods(raw) {
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
    return 'No Supabase pods exist in the namespace; the release never created any.';
  }

  const notReady = pods.filter((p) => !p.ready);
  if (notReady.length === 0) {
    return (
      `All ${pods.length} Supabase pods are Ready, helm failed for a reason other than pod ` +
      `readiness (a hook, a release lock, or its own timeout racing the last pod to Ready); ` +
      `see its output above.`
    );
  }

  const named = notReady.slice(0, SUPABASE_POD_NAME_CAP).map((p) => `${p.name} (${p.phase})`);
  const overflow = notReady.length - named.length;
  return (
    `${pods.length - notReady.length}/${pods.length} Supabase pods are Ready; ` +
    `${notReady.length} never became Ready: ${named.join(', ')}` +
    `${overflow > 0 ? `, +${overflow} more` : ''}.`
  );
}

/**
 * Read the release's pods so the helm-failure error can say what actually
 * happened instead of asserting a state it never checked.
 *
 * Never throws: this runs INSIDE the construction of another error, and a
 * failure to list pods must not replace the helm failure it was trying to
 * explain. It also must not fall back to the zero-pod wording — claiming
 * "no pods" because kubectl was unreachable is the same lie in a new place.
 *
 * @param {NodeJS.ProcessEnv} env - carries KUBECONFIG
 * @returns {Promise<string>}
 */
async function describeSupabasePods(env) {
  try {
    const raw = await runCommandAsync(supabasePodListArgs(), { env, silent: true });
    return summarizeSupabasePods(raw);
  } catch (err) {
    const detail = String(err?.message ?? err)
      .trim()
      .slice(0, 160);
    return (
      `Could not list the release's pods to report what state they are in (${detail}) — ` +
      `check them by hand with \`kubectl -n vibecarbon get pods\`.`
    );
  }
}

/**
 * Render the project's k8s/values/supabase.values.yaml template and
 * `helm upgrade --install` the supabase community chart. Waits for the
 * release to converge before returning.
 *
 * Direct `helm upgrade --install` keeps Flux off the deploy path; Flux
 * is opt-in via `vibecarbon configure cicd`.
 *
 * @param {{kubeconfig: string, projectDir: string, projectName: string, domain: string, storageClass: string, envLocal?: Record<string,string>, role?: 'primary'|'standby'}} args
 */
export async function installSupabase({
  kubeconfig,
  projectDir,
  projectName,
  domain,
  s3Config,
  envLocal,
  dbImageTag,
  backupBucketName,
  walgRole = 'primary',
  supabasePrivateIp = '10.0.1.2',
  role,
  storageClass,
}) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  // Pin the provider's StorageClass on every chart PVC. Throws when it is
  // missing rather than letting the chart inherit the cluster default — see
  // buildSupabaseStorageClassSetArg for the RCA. Computed FIRST so an
  // unthreaded storageClass fails before any cluster mutation.
  const storageClassSetArg = buildSupabaseStorageClassSetArg(storageClass);
  await assertSupabaseStorageClass({ storageClass, env });
  // Render the values template — substitute every {{TOKEN}} the template
  // uses so the rendered yaml is fully valid before helm sees it.
  const valuesTemplatePath = join(projectDir, 'k8s/values/supabase.values.yaml');
  if (!existsSync(valuesTemplatePath)) {
    throw new Error(
      `installSupabase: ${valuesTemplatePath} not found. Project must include the supabase values template.`,
    );
  }
  if (!dbImageTag) {
    throw new Error(
      'installSupabase: dbImageTag is required (the pre-published wal-g db image, pulled from ghcr).',
    );
  }
  // Split the full image ref into repository + tag for the chart's
  // image.db.{repository,tag} (and the walg-restore init's `{{DB_IMAGE}}:{{DB_IMAGE_TAG}}`).
  // dbImageTag is now the pre-published `ghcr.io/<org>/postgres:<pg>-walg<ver>`
  // ref — split on the LAST colon so the registry host (and any future port
  // colon) stays in the repository.
  const lastColon = dbImageTag.lastIndexOf(':');
  const dbImageRepo = dbImageTag.slice(0, lastColon);
  const dbImageVer = dbImageTag.slice(lastColon + 1);
  // WAL-G S3 prefix — dedicated backup bucket if provided, else the storage
  // bucket (mirrors compose's S3_BACKUP_BUCKET:-S3_BUCKET fallback). Never
  // leave it as s3:/// (wal-g would error).
  //
  // SINGLE canonical prefix (NO role segment). Reads (backup-fetch/restore/
  // reseed) and writes (backup-push/wal-push) must all agree on ONE prefix — a
  // role-segmented prefix made the standby read an empty `…/walg/standby` and
  // fail restore/reseed with "No backups found" (caught by compose-ha scale
  // e2e). Anti-collision (finding #3: a standby / bring-up-phase independent
  // primary must never WRITE here) is enforced by the WALG_ROLE WRITE-GUARD:
  // wal-archive.sh and the backup CronJob both no-op when WALG_ROLE=standby.
  // walgRole is rendered into the db env below so those write guards can read it.
  const walgBucket = backupBucketName || s3Config?.bucket || '';
  const walgS3Prefix = walgBucket
    ? `s3://${walgBucket}/backups/${projectName || 'vibecarbon'}/walg`
    : '';
  const rendered = readFileSync(valuesTemplatePath, 'utf-8')
    .replace(/\{\{DOMAIN\}\}/g, domain || 'localhost')
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName || 'vibecarbon')
    .replace(/\{\{S3_BACKUP_BUCKET\}\}/g, walgBucket)
    .replace(/\{\{WALG_S3_PREFIX\}\}/g, walgS3Prefix)
    .replace(/\{\{WALG_ROLE\}\}/g, walgRole)
    .replace(/\{\{S3_ENDPOINT\}\}/g, s3Config?.endpoint ?? '')
    .replace(/\{\{S3_REGION\}\}/g, s3Config?.region ?? '')
    // Storage-service S3 wiring. DISTINCT from S3_BACKUP_BUCKET above: user
    // objects live in the storage bucket (s3Config.bucket), wal-g backups in
    // the dedicated backup bucket. Rendering the same name into both would
    // put customer uploads and WAL segments in one bucket.
    //
    // These exist because the storage block shipped with literal `stub`
    // region/bucket, no endpoint and no credentials while STORAGE_BACKEND was
    // already `s3` — every upload 500'd with
    // `CredentialsProviderError: Could not load credentials from any
    // providers` (live DO k8s, 2026-08-21). Invisible for months because the
    // e2e storage checks skipped on a bucket nothing created.
    .replace(/\{\{S3_STORAGE_BUCKET\}\}/g, s3Config?.bucket ?? '')
    .replace(/\{\{S3_ACCESS_KEY\}\}/g, s3Config?.accessKey ?? '')
    .replace(/\{\{S3_SECRET_KEY\}\}/g, s3Config?.secretKey ?? '')
    .replace(/\{\{DB_IMAGE\}\}/g, dbImageRepo)
    .replace(/\{\{DB_IMAGE_TAG\}\}/g, dbImageVer)
    // Studio dashboard creds — sourced from .env.local at deploy time. Empty
    // string fallback keeps yaml valid; chart inlines them into the
    // chart-generated supabase-dashboard secret.
    .replace(/\{\{ADMIN_EMAIL\}\}/g, envLocal?.ADMIN_EMAIL ?? '')
    .replace(/\{\{ADMIN_PASSWORD\}\}/g, envLocal?.ADMIN_PASSWORD ?? '')
    // Microsoft OAuth tenant URL for GoTrue's AZURE provider — mirrors
    // compose's `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID:-common}`
    // interpolation, which a k8s env valueFrom cannot express. Rendered even
    // when Microsoft OAuth is unconfigured (harmless — the provider stays
    // disabled without MICROSOFT_ENABLED in vibecarbon-secrets).
    .replace(
      /\{\{AZURE_TENANT_URL\}\}/g,
      `https://login.microsoftonline.com/${envLocal?.MICROSOFT_TENANT_ID || 'common'}`,
    )
    // Signup-confirmation opt-in (configure → SMTP). Fail-safe: only the
    // literal 'false' (require confirmation emails) is honored — anything
    // else renders 'true' (auto-confirm), because without working SMTP a
    // false here 500s every signup.
    .replace(
      /\{\{GOTRUE_MAILER_AUTOCONFIRM\}\}/g,
      envLocal?.GOTRUE_MAILER_AUTOCONFIRM === 'false' ? 'false' : 'true',
    )
    // Repl-gateway relay endpoint for the standby seed init: the standby's
    // OWN supabase-node private IP + the relay port (see the seed-standby
    // init in the values file). Rendered on every tier; only a standby's
    // first boot ever dials it.
    .replace(/\{\{REPL_RELAY_HOST\}\}/g, supabasePrivateIp || '10.0.1.2')
    .replace(/\{\{REPL_RELAY_PORT\}\}/g, String(REPL_GATEWAY_PORT));
  const tmpValues = join(tmpdir(), `vibecarbon-supabase-values-${process.pid}-${Date.now()}.yaml`);
  // SECURITY: the rendered values contain ADMIN_EMAIL/ADMIN_PASSWORD and live
  // for the whole `helm upgrade --wait` window — write 0o600, never 0o644.
  writeSecretFile(tmpValues, rendered);
  // Declared here (not inside the `if`) so the `finally` below can always
  // reach it for cleanup, whether or not role === 'standby' set it.
  let overlayPath = null;
  try {
    // Pilot-light: the standby's app tier renders at 0 replicas. Scalars merge
    // across -f files (unlike env LISTS, replaced wholesale) so this overlay
    // must only ever carry replicaCount keys — drift guard:
    // tests/unit/deploy/standby-overlay-drift.test.ts
    if (role === 'standby') {
      const overlaySrc = join(projectDir, 'k8s/values/supabase.standby.values.yaml');
      if (!existsSync(overlaySrc)) {
        throw new Error(`installSupabase: standby overlay missing at ${overlaySrc}`);
      }
      const overlayText = readFileSync(overlaySrc, 'utf-8');
      if (/\{\{[A-Z0-9_]+\}\}/.test(overlayText)) {
        throw new Error('installSupabase: standby overlay must not contain placeholders');
      }
      overlayPath = join(tmpdir(), `supabase.standby.values.${Date.now()}.yaml`);
      writeFileSync(overlayPath, overlayText, { mode: 0o600 });
    }
    // Seed-script ConfigMap: rendered fresh every deploy from the shared
    // builder (one source of truth with the failover/restore reseeds) and
    // applied BEFORE helm so the db pod's seed-standby init can mount it on
    // first boot. Secret-free by contract — REPL_PASSWORD reaches the script
    // via env only.
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
    // Best-effort: a transient apiserver blip here must not hard-fail the
    // whole deploy. The ConfigMap's ABSENCE is already fully handled — the
    // init container's volume mount is optional and its command guards on
    // the mounted file being present (`[ -f /etc/vibecarbon/seed-standby.sh
    // ] && exec bash … ; … exit 0`) — so losing this apply just means the
    // standby's first-boot seed self-skips and the serial reseed path covers
    // replication later. Caught (not ignoreError) so the failure is still
    // logged loudly instead of silently swallowed.
    await runCommandAsync(['kubectl', 'apply', '-f', '-'], {
      silent: true,
      env,
      input: seedConfigMap,
    }).catch((err) => {
      console.error(
        `[seed-standby] ConfigMap apply failed (${err?.message || err}), seed init will self-skip; serial reseed covers replication`,
      );
    });
    // Add the supabase-community helm repo (idempotent — non-zero if exists).
    // helm repo add fails if the repo already exists; `helm repo update`
    // below refreshes either way, hence ignoreError.
    await runCommandAsync(
      ['helm', 'repo', 'add', SUPABASE_HELM_REPO_NAME, SUPABASE_HELM_REPO_URL],
      {
        silent: true,
        ignoreError: true,
        env,
      },
    );
    await runCommandAsync(['helm', 'repo', 'update', SUPABASE_HELM_REPO_NAME], {
      silent: true,
      env,
    });
    // --wait blocks until all pods are Ready. --create-namespace is a no-op
    // if vibecarbon namespace already exists.
    //
    // Async (spawn-based via runCommandAsync) — `helm --wait --timeout 15m`
    // can block for 1-15 minutes. A sync execFileSync would block Node's
    // event loop the whole time, inflating every concurrent perfAsync's
    // `Date.now()` measurement on parallel branches. In HA the standby
    // cluster's installSupabase runs in parallel with primary's; without
    // this, primary's blocking helm-wait makes standby's perf substep
    // numbers unreadable (RCA from iter-validate6, where standby's
    // certManager.wait reported 21 minutes despite kubectl wait finishing
    // in seconds — the wall-clock was inflated by primary's blocking).
    const helmStart = Date.now();
    const helmOk = await runCommandAsync(
      [
        'helm',
        'upgrade',
        '--install',
        SUPABASE_HELM_RELEASE_NAME,
        SUPABASE_HELM_CHART,
        '--version',
        SUPABASE_HELM_CHART_VERSION,
        '--namespace',
        'vibecarbon',
        '--create-namespace',
        '-f',
        tmpValues,
        ...(overlayPath ? ['-f', overlayPath] : []),
        // AFTER every -f on purpose: helm applies --set last, so the pin holds
        // even against a project values file that predates this fix (the
        // project copy is laid down once by `create` and never re-synced).
        '--set',
        storageClassSetArg,
        '--wait',
        '--timeout',
        SUPABASE_HELM_TIMEOUT,
      ],
      { silent: false, env },
    );
    // runCommandAsync resolves `false` (does NOT reject) for non-silent
    // callers on non-zero exit. Without this check a failed helm install
    // let the deploy march on and die 3 steps later with a misleading
    // "pods supabase-supabase-db-0 not found" at WAL-archiving setup
    // (CI run 29348429215 — unpinned chart 0.7.1 schema break).
    if (helmOk !== true) {
      throw new Error(
        `installSupabase: helm upgrade --install failed for ${SUPABASE_HELM_CHART} ` +
          `--version ${SUPABASE_HELM_CHART_VERSION} (release ${SUPABASE_HELM_RELEASE_NAME}). ` +
          `helm's output is streamed above. ${await describeSupabasePods(env)}`,
      );
    }
    const helmDur = Math.round((Date.now() - helmStart) / 1000);
    // Snapshot pod state immediately after `--wait` returns. Each pod's
    // age tells us how long IT took to become Ready (kubectl AGE = now -
    // pod.creationTimestamp; for newly-created pods the age ≈ helm wait).
    // Without this, the only signal for a slow installSupabase is the
    // umbrella perfAsync number — which collapses 14+ pods into one
    // duration. iter-perfwave2 showed primary 3m47s vs standby 1m43s
    // with no way to localize which pod was the long pole.
    try {
      const podSnapshot = (
        await runCommandAsync(
          [
            'kubectl',
            '-n',
            'vibecarbon',
            'get',
            'pods',
            '-l',
            'app.kubernetes.io/instance=supabase',
            '-o',
            'custom-columns=NAME:.metadata.name,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount,AGE:.metadata.creationTimestamp,NODE:.spec.nodeName',
            '--no-headers',
          ],
          { env, silent: true },
        )
      ).trim();
      console.error(`[supabase] helm-wait ${helmDur}s; post-wait pods:\n${podSnapshot}`);
    } catch (e) {
      console.error(
        `[supabase] helm-wait ${helmDur}s; pod snapshot failed: ${e.message?.slice(0, 80)}`,
      );
    }
  } finally {
    try {
      unlinkSync(tmpValues);
    } catch {
      // non-fatal: leave tmp file, OS will clean /tmp eventually
    }
    if (overlayPath) {
      try {
        unlinkSync(overlayPath);
      } catch {
        // non-fatal: leave tmp file, OS will clean /tmp eventually
      }
    }
  }
}

/**
 * Wait until the supabase storage schema has fully initialized — specifically
 * until `storage.buckets` has ALL the columns our app migration inserts:
 * `public`, `file_size_limit`, and `allowed_mime_types`. The supabase chart's
 * storage-api container runs its own schema migrations on startup which lag
 * helm's `--wait`-Ready signal by 30-90s on cold clusters, and it adds these
 * columns in SEPARATE migrations (`public` earlier, `file_size_limit` +
 * `allowed_mime_types` in a later one). Running our own migrations against an
 * in-progress storage schema fails with errors like "column 'file_size_limit'
 * of relation 'buckets' does not exist" when an INSERT INTO storage.buckets
 * references a column the storage container hasn't added yet. Waiting only for
 * `public` was insufficient: it let the app migration race the later
 * file_size_limit migration (observed 2026-04-26 e2e #4 for `public`, and again
 * 2026-07-11 k8s-ha standby for `file_size_limit` after deploy timing tightened).
 *
 * Polls every 5s for up to maxWaitSec. Idempotent: if the column already
 * exists (warm path), returns immediately on first probe.
 *
 * Each kubectl exec is bounded to ~15s wall via `--request-timeout=15s` plus
 * a Node-side kill backstop. A bare `spawnSync(kubectl exec)` with no
 * timeout can hang for arbitrary time when the apiserver streaming
 * connection wedges, which silently bypasses maxWaitSec — observed
 * 2026-05-08 e2e run #3 where standby's poll ran ~1005s against a
 * nominal maxWaitSec=300 and rolled into the parallel primary's 16.7-min
 * rolloutApp window. Bounding each call also lets first-failure stderr
 * surface so a real storage-api crashloop is distinguishable from an exec
 * connectivity issue. Uses async spawn so the parent's event loop stays
 * free for the parallel HA branch.
 *
 * @param {{kubeconfig: string, maxWaitSec?: number}} args
 */
export async function waitForSupabaseStorageSchema({ kubeconfig, maxWaitSec = 600 }) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  // Require all three columns 00001_init inserts — a later storage-api
  // migration adds file_size_limit + allowed_mime_types, so waiting only for
  // `public` races that migration. count(*) must reach 3.
  const probeSql = `SELECT count(*) FROM information_schema.columns WHERE table_schema='storage' AND table_name='buckets' AND column_name IN ('public','file_size_limit','allowed_mime_types');`;
  const perCallSec = 15;
  let attempt = 0;
  let firstErrLogged = false;
  try {
    // Fixed 5s spacing (initialDelayMs === maxDelayMs, no backoff growth) —
    // matches the old hand-rolled `while` loop's constant waitMs exactly.
    await pollUntil(
      async () => {
        attempt += 1;
        const { status, stdout, stderr } = await execKubectlOnce(
          [
            '-n',
            'vibecarbon',
            'exec',
            '-i',
            `--request-timeout=${perCallSec}s`,
            'supabase-supabase-db-0',
            '--',
            'psql',
            '-U',
            'supabase_admin',
            '-d',
            'postgres',
            '-tA',
          ],
          { env, input: probeSql, killAfterMs: (perCallSec + 5) * 1000 },
        );
        if (status === 0 && stdout.trim() === '3') return true;
        if (!firstErrLogged && (status !== 0 || stderr)) {
          // Surface the first failure so a real crashloop / connectivity
          // issue is visible instead of silently looping. Subsequent polls
          // stay quiet to keep the deploy log readable.
          const msg = (stderr || stdout || '(no output)').trim().slice(-500);
          console.log(
            `[waitForSupabaseStorageSchema] attempt ${attempt} status=${status ?? '?'} — ${msg}`,
          );
          firstErrLogged = true;
        }
        return false;
      },
      {
        budgetMs: maxWaitSec * 1000,
        initialDelayMs: 5000,
        maxDelayMs: 5000,
        description: 'storage.buckets public + file_size_limit + allowed_mime_types columns',
      },
    );
  } catch {
    throw new Error(
      `Supabase storage schema didn't add storage.buckets.{public,file_size_limit,allowed_mime_types} ` +
        `columns within ${maxWaitSec}s. Storage-api container may have crashlooped: check ` +
        `kubectl logs supabase-supabase-storage-0`,
    );
  }
}

/**
 * Single bounded kubectl exec: spawn-based (non-blocking), per-call kill
 * backstop on top of kubectl's own `--request-timeout`. Caller passes argv
 * starting after `kubectl`. Returns { status, stdout, stderr } with status
 * `null` if killed by the backstop.
 *
 * @param {string[]} argv
 * @param {{env: NodeJS.ProcessEnv, input?: string, killAfterMs: number}} opts
 */
function execKubectlOnce(argv, { env, input, killAfterMs }) {
  return new Promise((resolveFn) => {
    const child = spawn('kubectl', argv, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b.toString();
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, killAfterMs);
    child.on('error', () => {
      clearTimeout(killTimer);
      resolveFn({ status: null, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolveFn({ status: code, stdout, stderr });
    });
    if (input != null) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Apply the project's `supabase/migrations/*.sql` against the chart-installed
 * supabase-postgres pod. Runs each file in lexicographic order via
 * `kubectl exec -i ... psql -U supabase_admin -d postgres`. Errors per file
 * are surfaced — unlike compose's `|| true` swallow — so a broken migration
 * stops the deploy with a useful error instead of a 503 readiness probe
 * loop downstream.
 *
 * The supabase-db StatefulSet pod must be Ready (helm `--wait` ensures this).
 *
 * @param {{kubeconfig: string, projectDir: string}} args
 */
export async function applyMigrations({ kubeconfig, projectDir }) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  const migrationsDir = join(projectDir, 'supabase', 'migrations');
  if (!existsSync(migrationsDir)) {
    // Project has no migrations directory — skip silently. Matches compose
    // behaviour (which `|| true`'s past a missing dir).
    return;
  }
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) return;
  // Wait for supabase's own storage-api schema to finish initializing —
  // some project migrations (e.g. INSERT INTO storage.buckets with a
  // `public` column) reference columns added by storage-api's startup
  // migrations, which can lag helm's --wait Ready signal.
  await waitForSupabaseStorageSchema({ kubeconfig });
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    try {
      await runCommandAsync(
        [
          'kubectl',
          '-n',
          'vibecarbon',
          'exec',
          '-i',
          'supabase-supabase-db-0',
          '--',
          'psql',
          '-U',
          'supabase_admin',
          '-d',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
          // Each migration file is atomic — a mid-file failure must not leave
          // partial schema behind (see docs/rca/2026-08-25-migration-drift.md).
          '--single-transaction',
        ],
        { env, input: sql, silent: true },
      );
    } catch (err) {
      // silent:true buffers stdout/stderr instead of streaming them
      // (unlike the old stdio: [...,'inherit','inherit']) — print them here
      // on failure so the operator still sees the psql error output.
      if (err.stdout) process.stdout.write(err.stdout);
      if (err.stderr) process.stderr.write(err.stderr);
      throw new Error(
        `applyMigrations: ${file} failed with exit ${err.status}. ` +
          `Fix the migration or set ON_ERROR_STOP=0 manually.`,
      );
    }
  }

  // Ground-truth RLS audit (see src/lib/deploy/rls-audit.js): query the live
  // catalog and refuse to proceed if any public table reached the schema
  // without row-level security — the browser reaches public tables directly
  // through PostgREST, so an un-RLS'd table is a live data breach regardless
  // of how it was created (migration, hand edit, dependency).
  const auditOut = await runCommandAsync(
    [
      'kubectl',
      '-n',
      'vibecarbon',
      'exec',
      '-i',
      'supabase-supabase-db-0',
      '--',
      'psql',
      '-U',
      'supabase_admin',
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
    throw new Error(`applyMigrations: ${rlsAuditFailureMessage(unprotected)}`);
  }
}

/**
 * Ground-truth BACKUP audit for the k8s path — the kubectl-exec twin of the
 * `docker compose exec` probe compose/index.js runs inside runMigrations.
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
export async function verifyWalgBackups({ kubeconfig, dbPod = 'supabase-supabase-db-0' }) {
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
 * Reload PostgREST's schema cache after applyMigrations.
 *
 * The chart's `rest` (supabase-supabase-rest) pod comes up during helm
 * `--wait`, BEFORE applyMigrations runs — so its in-memory schema cache
 * predates the app tables. Reads of /rest/v1/<table> then 404 with PGRST205
 * ("Could not find the table ... in the schema cache") until PostgREST
 * reloads. No DDL-watch event trigger exists in the app migrations or db init
 * to auto-NOTIFY (verified), so issue the canonical reload explicitly.
 *
 * This is the k8s mirror of the compose fix (compose/index.js): same intent —
 * `NOTIFY pgrst, 'reload schema'` on the db — via `kubectl exec` instead of
 * `docker compose exec`. Best-effort: a missed reload self-heals whenever the
 * rest pod next restarts (e.g. the k8s-ha replication path rollout-restarts it
 * anyway), so a failure here is logged, not fatal.
 *
 * @param {{kubeconfig: string}} args
 */
export async function reloadPostgrest({ kubeconfig }) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  const { status, stderr } = await execKubectlOnce(
    [
      '-n',
      'vibecarbon',
      'exec',
      '-i',
      '--request-timeout=15s',
      'supabase-supabase-db-0',
      '--',
      'psql',
      '-U',
      'supabase_admin',
      '-d',
      'postgres',
      '-c',
      "NOTIFY pgrst, 'reload schema'",
    ],
    { env, killAfterMs: 20_000 },
  );
  if (status !== 0) {
    progressLog(
      `[migrate] PostgREST schema reload NOTIFY failed (non-fatal, self-heals on rest restart): ${(stderr || '').trim().slice(-200)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// provisionAdminUser's `kubectl port-forward` child. Constants + helpers live
// at module scope so the forward's diagnostics are greppable from a deploy log
// and unit-testable through provisionAdminUser's injected `spawnImpl` seam.
//
// Twin of compose/index.js's `openAdminTunnel` (#226), which fixed this
// evidence hole on the `ssh -L` side first. Deliberately duplicated rather
// than shared: the two children differ in binary, in stderr vocabulary, and —
// most importantly — in whether the local port may be WALKED. Keep them in
// sync by hand when either grows a new evidence channel.
// ---------------------------------------------------------------------------

/** Bounded stderr tail kept per port-forward child. */
const ADMIN_PF_STDERR_TAIL_LINES = 10;
const ADMIN_PF_STDERR_TAIL_CHARS = 2000;
/** Grace for a dying child's stderr to flush when 'close' never arrives. */
const ADMIN_PF_EXIT_FLUSH_MS = 500;
/**
 * `kubectl port-forward`'s own wording for a local bind collision. It reports
 * the OS error verbatim ("bind: address already in use") and then its own
 * summary ("unable to listen on any of the requested ports"); either alone is
 * enough to classify.
 */
const ADMIN_PF_BIND_CONFLICT = /address already in use|unable to listen on any of the requested/i;

/**
 * Last-N-lines tail of a child's stderr, bounded by chars first and then lines
 * so neither a chatty session nor one runaway line can paste a whole log into
 * a deploy error.
 *
 * @param {string} text
 * @returns {string}
 */
function tailPortForwardStderr(text) {
  return text
    .slice(-ADMIN_PF_STDERR_TAIL_CHARS)
    .split('\n')
    .slice(-ADMIN_PF_STDERR_TAIL_LINES)
    .join('\n');
}

/**
 * Flatten a fetch rejection into one log-safe line.
 *
 * Node's fetch throws a bland `TypeError: fetch failed` and hides the part
 * that actually discriminates the failure (ECONNREFUSED = nothing listening on
 * the forwarded port, vs ETIMEDOUT / socket hang up = the forward is up but
 * GoTrue isn't answering) in `.cause`.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeAdminFetchError(err) {
  if (!err) return 'no fetch error recorded';
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  const detail = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  const code = (cause instanceof Error ? /** @type {any} */ (cause).code : undefined) ?? err.code;
  let text = detail && detail !== err.message ? `${err.message} (${detail})` : err.message;
  if (code && !text.includes(code)) text += ` [${code}]`;
  return text;
}

/**
 * Open provisionAdminUser's `kubectl port-forward` child, wrapped with the
 * evidence its failure paths need: a bounded stderr tail, the exit code/signal
 * (or spawn error), and a `settled` promise that resolves the moment the child
 * dies.
 *
 * stderr is PIPED for the reason #226 established on the compose side: it is
 * the only channel carrying the child's own diagnosis, and the previous
 * `stdio: 'ignore'` discarded it. A forward that cannot bind its local port,
 * names a service that does not exist, or loses its apiserver connection
 * prints exactly that and exits — under 'ignore' the deploy only ever saw the
 * wrapper's "Could not reach GoTrue via kubectl port-forward", which is
 * un-RCA-able without a re-run.
 *
 * @param {object} args
 * @param {number} args.localPort
 * @param {NodeJS.ProcessEnv} args.env - carries KUBECONFIG
 * @param {typeof spawn} args.spawnImpl
 */
function openAdminPortForward({ localPort, env, spawnImpl }) {
  const child = spawnImpl(
    'kubectl',
    ['-n', 'vibecarbon', 'port-forward', 'svc/supabase-supabase-auth', `${localPort}:9999`],
    { env, stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  /** @type {{code: number|null, signal: string|null}|null} */
  let exitInfo = null;
  /** @type {Error|null} */
  let spawnError = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let flushTimer = null;
  let resolveSettled = () => {};
  const settled = new Promise((resolve) => {
    resolveSettled = resolve;
  });
  const finish = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    resolveSettled();
  };

  child.stderr?.on?.('data', (chunk) => {
    stderr = tailPortForwardStderr(stderr + String(chunk));
  });
  // A spawn-level failure ('error', e.g. ENOENT) must not crash the deploy as
  // an unhandled ChildProcess event — it stays folded into the same retry
  // budget as any other reach failure, but now carries its message.
  child.on('error', (err) => {
    spawnError = err;
    finish();
  });
  // Settle on 'close' where possible (stderr is flushed by then); 'exit' can
  // fire with data still queued on the pipe. If 'close' never arrives, the
  // grace timer settles anyway so an attempt can't hang waiting for it.
  child.on('close', finish);
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    if (!flushTimer) flushTimer = setTimeout(finish, ADMIN_PF_EXIT_FLUSH_MS);
  });

  return {
    localPort,
    /** Resolves once the child has died (never, for a healthy forward). */
    settled,
    get dead() {
      return exitInfo !== null || spawnError !== null;
    },
    /** True when kubectl's stderr names a local bind collision. */
    get bindConflict() {
      return ADMIN_PF_BIND_CONFLICT.test(stderr);
    },
    /** One-line `kubectl: …` clause for a deploy error / retry log line. */
    describe() {
      if (spawnError) return `kubectl: spawn failed: ${spawnError.message}`;
      const tail = stderr.trim().replace(/\s*\n\s*/g, ' / ');
      let state;
      if (exitInfo === null) state = 'still running';
      else if (exitInfo.code === null || exitInfo.code === undefined)
        state = `killed by ${exitInfo.signal ?? 'an unknown signal'}`;
      else state = `exited ${exitInfo.code}${exitInfo.signal ? ` (${exitInfo.signal})` : ''}`;
      return tail ? `kubectl: ${state}; ${tail}` : `kubectl: ${state}, no stderr`;
    },
    /** Idempotent teardown — safe to call on every exit path. */
    close() {
      try {
        child.kill();
      } catch {
        // already gone
      }
      child.stderr?.destroy?.();
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
    },
  };
}

/**
 * Create the production app super-admin in `auth.users` via GoTrue's admin API.
 *
 * The k8s mirror of compose/index.js `createAdminUser`: identical GoTrue
 * admin-API contract (POST the super_admin payload with the service-role
 * bearer, idempotent on 422 via the shared admin-user helper), reached via
 * `kubectl port-forward svc/supabase-supabase-auth` instead of an `ssh -L`
 * tunnel. Goes direct to GoTrue (auth :9999, path `/admin/users`) — no Kong
 * `/auth/v1` prefix to strip.
 *
 * Without this, a k8s deploy shipped a prod app the operator couldn't log
 * into: ADMIN_EMAIL/ADMIN_PASSWORD only seeded the Supabase Studio dashboard
 * basic-auth secret, never an app `auth.users` row.
 *
 * M3 Task 9h: the port-forward + HTTP reach gets a budgeted retry (same
 * tunnel-then-operation shape as the registry push's retries, which live in
 * registry-push.js — a backgrounded local forward that needs re-opening on
 * failure, not a plain probe). `helm upgrade --install --wait` (installSupabase) already
 * gates on every chart pod, including auth/GoTrue, reaching Available BEFORE
 * this step ever runs (see applyK3sManifests step 8c below) — so there is no
 * missing ordering wait to add; a failure here is a transient port-forward /
 * apiserver hiccup against an already-Ready pod, the same class of blip the
 * cert-manager readiness poll above absorbs, not a readiness race. A battery
 * run (d3 run 6) hit exactly that: the single old attempt failed, logged a
 * warning, and the deploy "succeeded" with no admin.users row — customer CI
 * would ship the same half-configured stack. Exhausting the retry budget now
 * fails the deploy loudly instead: pre-release, no half-configured success.
 *
 * Credentials-missing (no ADMIN_EMAIL/ADMIN_PASSWORD/SUPABASE_SERVICE_ROLE_KEY
 * resolvable from `envLocal`) is NOT retryable (there's nothing to poll for)
 * but is NOT a soft return either (M3 Task 9h fix round 1): `create` always
 * writes these into the project's `.env.local`, and they're also
 * GH-Environment-managed CI secrets (see github-environments.js) — a real
 * customer CI run with a missing/misnamed secret hits this exact branch, and
 * a soft `{success: false}` here reproduces the identical bug this task
 * exists to kill (deploy "succeeds", no admin.users row). It throws.
 *
 * Diagnosability (twin of #226, which fixed the same hole on compose's `ssh
 * -L` tunnel): every failure path now carries WHY. The forward child is
 * spawned with a PIPED stderr and its tail / exit code / signal / spawn error
 * are captured (openAdminPortForward above), the health poll's LAST fetch
 * error is recorded through `waitForGotrueHealth`'s `fetchImpl` seam, and both
 * land in the thrown message AND in every per-attempt retry log line. Before
 * this, a failing attempt produced the bare wrapper string "Could not reach
 * GoTrue via kubectl port-forward" — indistinguishable between a missing
 * service, a squatted local port, a dead apiserver connection and a GoTrue
 * that answers 503, and un-RCA-able without re-running the deploy.
 *
 * @param {{kubeconfig: string, envLocal: Record<string,string>, localPort?: number, spawnImpl?: typeof spawn, fetchImpl?: typeof fetch}} args
 *   (The former `retryDelaysMs` ladder is removed — band-aid removal
 *   2026-08-16; one attempt, loud failure.)
 *
 *   `spawnImpl` / `fetchImpl` — injection seams for the `kubectl port-forward`
 *   child and the health-poll fetch (same DI convention as admin-user.js's
 *   `fetchImpl`, and as compose's `createAdminUser`). Production callers omit
 *   both; tests inject fakes so the forward's diagnostics can be asserted
 *   without mocking `node:child_process` (builtin-module mocks are not
 *   reliably scoped per file under the parallel unit run — see
 *   k3s-admin-port-forward-diagnostics.test.ts's header).
 * @returns {Promise<{success: boolean, message: string}>} resolves only on
 *   success (admin created, or already exists — idempotent).
 * @throws {Error} if required admin credentials are missing from `envLocal`,
 *   or if GoTrue stays unreachable (or the admin-user POST keeps failing)
 *   through the whole retry budget.
 */
export async function provisionAdminUser({
  kubeconfig,
  envLocal,
  localPort = 15000,
  spawnImpl = spawn,
  fetchImpl = fetch,
}) {
  const adminEmail = envLocal?.ADMIN_EMAIL;
  const adminPassword = envLocal?.ADMIN_PASSWORD;
  const serviceRoleKey = envLocal?.SERVICE_ROLE_KEY ?? envLocal?.SUPABASE_SERVICE_ROLE_KEY;
  if (!adminEmail || !adminPassword || !serviceRoleKey) {
    const missing = [
      !adminEmail && 'ADMIN_EMAIL',
      !adminPassword && 'ADMIN_PASSWORD',
      !serviceRoleKey && 'SUPABASE_SERVICE_ROLE_KEY',
    ].filter(Boolean);
    throw new Error(
      `Admin credentials missing (${missing.join(', ')}) — admin login will not work. Expected ` +
        `as keys in the project's .env.local for a local deploy, or as the matching ` +
        `per-environment GitHub Environment secret(s) for a CI deploy.`,
    );
  }

  const env = { ...process.env, KUBECONFIG: kubeconfig };

  // 4 attempts total (3 retries): [3s, 6s, 12s] backoff. Each attempt also
  // pays waitForGotrueHealth's own ~10s internal poll (20 x 500ms) before
  // declaring that attempt's port-forward unreachable, so the worst case is
  // ~61s — generous for a transient blip against a pod helm --wait already
  // confirmed Ready, well short of the cert-manager budget above (that one
  // covers pods that may not even be scheduled yet).
  // The retry ladder that lived here is REMOVED (band-aid removal,
  // 2026-08-16): its enumerated triggers were GoTrue answering 500 while its
  // DB session pool was refused (closed at the source by
  // awaitPostgresAccepting) and forward wedges (owned per-attempt by the
  // open→use→teardown lifecycle below). One attempt; a failure is loud and
  // carries the full per-phase cause.
  const attemptErrors = [];

  // One attempt: open a fresh port-forward, wait for GoTrue to answer
  // through it, POST the admin user, then always tear the forward down.
  // Mirrors the registry push's per-attempt tunnel lifecycle (open →
  // use → teardown in `finally`, registry-push.js) so a wedged forward from a failed attempt
  // can't block the next attempt from re-opening the same localPort — kept
  // fixed (not walked, unlike the push tunnel) because HA runs primary and
  // standby's provisionAdminUser in parallel on adjacent bases (15000 /
  // 15001, mirroring the 5000/5001 registry-tunnel split); a per-attempt
  // port offset could walk one cluster's retry straight into the other's.
  // The retry backoff (min 3s) is ample for kubectl port-forward to release
  // the port after `pf.kill()`.
  const attemptOnce = async () => {
    // A spawn-level failure ('error', e.g. ENOENT) is captured by the helper
    // rather than crashing the deploy as an unhandled ChildProcess event —
    // folded into the same retry budget as any other reach failure, but now
    // carrying its message instead of masquerading as a reach timeout.
    const pf = openAdminPortForward({ localPort, env, spawnImpl });
    try {
      // Record the last health-poll fetch error through waitForGotrueHealth's
      // existing `fetchImpl` seam. That helper returns a bare boolean by
      // design (compose reads it the same way), so wrapping the fetch here
      // keeps the cause without changing a contract shared with the compose
      // path.
      let lastFetchError = null;
      const probeFetch = async (url, init) => {
        // The forward is already gone; fail fast instead of spending the rest
        // of the poll's budget fetching a closed port.
        if (pf.dead) throw new Error('kubectl port-forward exited');
        try {
          const res = await fetchImpl(url, init);
          if (!res.ok) lastFetchError = new Error(`HTTP ${res.status} from ${url}`);
          return res;
        } catch (err) {
          lastFetchError = err;
          throw err;
        }
      };

      // Race the reach poll against the forward's own death so a bind
      // collision (or a missing service) is classified immediately instead of
      // after the poll burns its full ~10s budget.
      const outcome = await Promise.race([
        waitForGotrueHealth(`http://localhost:${localPort}/health`, {
          attempts: 20,
          intervalMs: 500,
          fetchImpl: probeFetch,
        }).then((ok) => (ok ? 'healthy' : 'unreachable')),
        pf.settled.then(() => 'forward-died'),
      ]);

      if (outcome !== 'healthy') {
        // Everything the next RCA needs, on one line: which port, what the
        // last HTTP attempt actually said, and what kubectl itself reported.
        //
        // A bind collision gets an explicit remedy because this path CANNOT
        // route around it: unlike compose's tunnel (which walks 19876 →
        // 19885), the port here is fixed, since HA provisions primary and
        // standby in parallel on adjacent bases (15000/15001) and a walk could
        // step one cluster's retry straight onto the other's.
        throw new Error(
          `Could not reach GoTrue via kubectl port-forward on localhost:${localPort} ` +
            `(last error: ${describeAdminFetchError(lastFetchError)}; ${pf.describe()})` +
            (pf.bindConflict
              ? `, local port ${localPort} is already bound (a leaked port-forward from an ` +
                `earlier run, or another process on this machine). This port is fixed, not ` +
                `walked: the HA pair provisions primary and standby in parallel on 15000/15001, ` +
                `so walking could collide the two. Kill the stale forward and re-run.`
              : ''),
        );
      }

      const result = await postAdminUser({
        adminUsersUrl: `http://localhost:${localPort}/admin/users`,
        serviceRoleKey,
        adminEmail,
        adminPassword,
      });
      if (!result.success) {
        throw new Error(result.message);
      }
      return result;
    } finally {
      // Every exit path — success, unreachable, POST failure and throw — reaps
      // this attempt's forward.
      pf.close();
    }
  };

  try {
    return await attemptOnce();
  } catch (err) {
    attemptErrors.push(err instanceof Error ? err.message : String(err));
    // Loud failure (M3 Task 9h): no warning-and-continue crutch. States what
    // failed, the consequence, and what was attempted so the operator/CI log
    // is actionable without re-running to discover it. Framed as "admin-user
    // provisioning failed" rather than "GoTrue unreachable" — attemptErrors
    // can mix unreachable-port-forward failures with reachable-but-erroring
    // postAdminUser calls (e.g. a transient 500), and the message must cover
    // both. Numbered per-attempt, same shape as the registry push's
    // exhausted-attempts error (registry-push.js).
    throw new Error(
      `GoTrue admin-user provisioning failed after ${attemptErrors.length} attempt${attemptErrors.length === 1 ? '' : 's'} — ` +
        `admin login will not work. Errors: ${attemptErrors.map((m, i) => `[#${i + 1}] ${m}`).join(' | ')}`,
    );
  }
}

/**
 * The four `ALTER SYSTEM` settings that turn on continuous WAL archiving for
 * wal-g on the chart-installed supabase-db.
 */
export const WAL_ARCHIVING_SETTINGS = [
  "ALTER SYSTEM SET archive_mode='on'",
  "ALTER SYSTEM SET archive_command='bash /etc/postgresql/wal-archive.sh %p'",
  "ALTER SYSTEM SET archive_timeout='900'",
  "ALTER SYSTEM SET wal_level='replica'",
];

/**
 * Build the `kubectl exec … psql …` argument list that enables WAL archiving.
 *
 * Each `ALTER SYSTEM` MUST be its own `-c` option. psql sends a single `-c`
 * string as one simple-query request, and Postgres runs a multi-statement
 * simple query inside ONE implicit transaction — where `ALTER SYSTEM` is
 * rejected with "ALTER SYSTEM cannot run inside a transaction block". The
 * documented remedy (and the compose/ha.js pattern) is to pass each statement
 * as a separate `-c`, so every ALTER SYSTEM is its own implicit transaction.
 *
 * @param {string} dbPod - e.g. `supabase-supabase-db-0`
 * @returns {string[]}
 */
export function enableWalArchivingPsqlArgs(dbPod) {
  return [
    '-n',
    'vibecarbon',
    'exec',
    dbPod,
    '--',
    'psql',
    '-U',
    'supabase_admin',
    '-d',
    'postgres',
    ...WAL_ARCHIVING_SETTINGS.flatMap((stmt) => ['-c', stmt]),
  ];
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
 * project's own tracked files: mirrors `installSupabase`'s
 * supabase.values.yaml rendering, which reads the project's checked-in
 * template and writes the substituted result to a temp file for `helm -f`
 * rather than mutating the template in place — the same reasoning applies
 * here (a redeploy would otherwise leave the operator's git working tree
 * permanently dirty).
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
  // Prefix carries the source dir's basename (e.g. `observability`) so the
  // rendered path stays recognizable in `kubectl` error output/logs, and so
  // any argv/log matching on the addon name (e.g. tests asserting the
  // observability apply ran) still finds it after the path swap.
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
  const tmpDir = mkdtempSync(join(tmpdir(), `vibecarbon-k8s-storageclass-${basename(dir)}-`));
  const copyInto = (srcDir, destDir) => {
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        copyInto(srcPath, destPath);
        continue;
      }
      const content = readFileSync(srcPath, 'utf-8');
      writeFileSync(
        destPath,
        content.includes('{{K8S_STORAGE_CLASS}}')
          ? content.replaceAll('{{K8S_STORAGE_CLASS}}', storageClass)
          : content,
      );
    }
  };
  copyInto(dir, tmpDir);
  return tmpDir;
}

/**
 * `renderK8sStorageClassPlaceholder`, but a NO-OP when the tree has no
 * placeholder to resolve.
 *
 * Applied to `k8s/base`, whose contents vary per project: only the addon
 * subdirectories `add` copies in (redis, n8n) carry the placeholder. Returning
 * the original path when there is nothing to substitute keeps the argv, the
 * kustomize root and every log line byte-identical for the overwhelmingly
 * common case, so the temp-copy path is entered only when it is load-bearing.
 *
 * @param {string} dir
 * @param {string} storageClass
 * @returns {string} `dir` itself, or a rendered temp copy
 */
export function renderK8sStorageClassPlaceholderIfPresent(dir, storageClass) {
  const hasPlaceholder = (d) =>
    readdirSync(d, { withFileTypes: true }).some((entry) => {
      const full = join(d, entry.name);
      if (entry.isDirectory()) return hasPlaceholder(full);
      return readFileSync(full, 'utf-8').includes('{{K8S_STORAGE_CLASS}}');
    });
  if (!existsSync(dir) || !hasPlaceholder(dir)) return dir;
  return renderK8sStorageClassPlaceholder(dir, storageClass);
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

/**
 * Apply cert-manager + vibecarbon-secrets + the project's k8s/infra +
 * k8s/base kustomizations, install supabase via helm, patch the app
 * deployment to use the locally-sideloaded image, and wait for rollout.
 *
 * Local-first by default — no Flux on the deploy path; Flux is opt-in
 * via `vibecarbon configure cicd`.
 *
 * @param {{kubeconfig: string, projectDir: string, projectName: string, imageTag: string, dbImageTag: string, envLocal: Record<string,string>, domain: string, s3Config?: {accessKey: string, secretKey: string, bucket: string, endpoint: string, region: string}, backupBucketName?: string|null, restore?: string|null, dnsProvider?: string|null, dnsToken?: string|null, apiToken?: string, providerId?: string, ProviderClass?: typeof import('../../providers/base.js').BaseProvider, region?: string, environment?: string, minWorkers?: number, maxWorkers?: number, caBoundsMin?: number, workerServerType?: string, k3sToken?: string, masterIp?: string, sshKeyPath?: string, khPath?: string, supabasePrivateIp?: string, masterPrivateIp?: string, vpcCidr?: string, role?: 'primary'|'standby'}} args
 *   `restore` (when set, e.g. 'latest' or an ISO timestamp) skips applyMigrations
 *   — the wal-g-restored DB already carries schema_migrations.
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
  restore,
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
  // The supabase node's Hetzner private-network IP (deterministic in the IaC
  // program; deployK3s threads it through from infraOutputs). Rendered into
  // the seed-standby init's SEED_PRIMARY_HOST via installSupabase — see
  // installSupabase's {{REPL_RELAY_HOST}} replace.
  supabasePrivateIp,
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
  // primary behavior). Drives walgRole below and is forwarded to
  // installSupabase so it can append the standby zero overlay `-f`.
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
  //     found on CSINode". installSupabase's `helm upgrade --wait` then sat
  //     until its 15m timeout and the deploy died. The other two nodes pulled
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
  //     Mirrors the Supabase pattern at step 7. `row.webhook` is null for
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
      // See installSupabase above for the full RCA (iter-validate6 standby
      // certManager.wait reporting 21min when actual was seconds).
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
  // 4. Create vibecarbon-secrets BEFORE base/ — base/'s Deployment
  //    references it via envFrom; without it kubelet fails container
  //    creation with `secret "vibecarbon-secrets" not found`.
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
  // 5. Apply base (namespace, network-policies, app, backup, traefik, config).
  //
  // Rendered first when — and ONLY when — the tree carries an unresolved
  // {{K8S_STORAGE_CLASS}}. `add redis` / `add n8n` copy their PVCs into
  // k8s/base/<addon>/, and nothing ever substituted the placeholder on this
  // path: kubectl accepts the literal (storageClassName is a free-form
  // reference) and the PVC sits Pending forever. It cannot be patched after
  // the fact — storageClassName is immutable once the object exists — so the
  // substitution has to happen before this apply. A project with no such addon
  // gets the original path, byte-identical argv included.
  const baseDir = renderK8sStorageClassPlaceholderIfPresent(
    join(projectDir, 'k8s/base'),
    ProviderClass.K8S_STORAGE_CLASS,
  );
  await perfAsync(`deploy.${perfPrefix}.applyBase`, () =>
    runKubectlWithRetry(['apply', '-k', baseDir], {
      env,
      description: 'applyK3sManifests: kubectl apply -k k8s/base',
    }),
  );
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
  // The db image is NOT pushed here: it's pinned to the static supabase
  // node, reaches it via sideload, and the chart references it with
  // imagePullPolicy: IfNotPresent — CA workers never run postgres.
  const appPushPort = localTunnelPort;
  // Kick off the registry push CONCURRENTLY — do NOT await it here. It exists
  // only so future cluster-autoscaler-spawned workers can pull the app image;
  // the app pods themselves run the SIDELOADED image (step 6 sets
  // deployment/app to imageTag with imagePullPolicy: IfNotPresent), and NOTHING
  // between here and the end of this function reads the in-cluster registry. So
  // this ~90-140s S3-blob upload overlaps the CA rollout + Supabase install +
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
  // Supabase work below is still running doesn't surface as an
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
  const acmeServer = envLocal?.ACME_CA_SERVER || process.env.ACME_CA_SERVER || '';
  const issuerName = pickIssuerName({ dnsProvider, acmeServer });
  // DNS-01 issuers (cloudflare, hetzner) support wildcard SANs — one cert
  // covers *.${domain} so every IngressRoute subdomain is included without
  // separate per-router ACME orders. Manual (HTTP-01) falls back to apex-only.
  const dnsNames = certificateDnsNames(domain, issuerName);
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
        spec: { dnsNames, issuerRef: { name: issuerName, kind: 'ClusterIssuer' } },
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
      // Same cleanup contract as installSupabase's temp values files —
      // deploys must not leak a temp dir per run (T4 review).
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
        const ok = await runCommandAsync(
          [
            'kubectl',
            '-n',
            'kube-system',
            'rollout',
            'status',
            'deploy/cluster-autoscaler',
            '--timeout=300s',
          ],
          { silent: false, env },
        );
        if (ok === false)
          throw new Error('cluster-autoscaler rollout status failed (timeout 300s)');
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
  // 6. Patch the app deployment to use the sideloaded image BEFORE installSupabase.
  //    base/ ships image=ghcr.io/<owner>/<repo>:main — no pull secret in
  //    local-first mode, so leaving it pointed at GHCR triggers
  //    ImagePullBackOff that races against installSupabase's `--wait`.
  //    Switching now means the app pods come up on the sideloaded image
  //    immediately; we still wait for rollout after Supabase converges.
  await runKubectlWithRetry(
    ['-n', 'vibecarbon', 'set', 'image', 'deployment/app', `app=${imageTag}`],
    { env, description: 'applyK3sManifests: kubectl set image deployment/app' },
  );
  // 7. Install Supabase via helm. Blocks until release converges (15m
  //    timeout in chart). image.db points at the wal-g-equipped db image
  //    (sideloaded in step 7b), and the chart mounts wal-archive.sh + the
  //    non-secret WALG_* env from supabase.values.yaml.
  // Derive the wal-g WRITE-GUARD role (NOT a path segment) from the explicit
  // `role` option — Task 6 fans out deployK3s with role: 'primary' /
  // 'standby'; single-cluster deploys leave role undefined → 'primary'.
  // Rendered into the db container env as WALG_ROLE so wal-archive.sh + the
  // backup CronJob no-op on the standby. The S3 prefix itself stays
  // canonical (no role segment).
  const walgRole = role === 'standby' ? 'standby' : 'primary';
  await perfAsync(`deploy.${perfPrefix}.installSupabase`, async () =>
    installSupabase({
      kubeconfig,
      projectDir,
      projectName,
      domain,
      s3Config,
      envLocal,
      dbImageTag,
      backupBucketName,
      walgRole,
      supabasePrivateIp,
      role,
      // The chart's PVCs must NOT inherit the cluster's default StorageClass —
      // on k3s that can be node-local `local-path`, which silently breaks
      // replication/failover/restore (RCA: kept k8s-ha rig e4, 2026-08-05).
      // Same provider static the add-on manifests resolve
      // `{{K8S_STORAGE_CLASS}}` from.
      storageClass: ProviderClass?.K8S_STORAGE_CLASS,
    }),
  );
  // 7b. Enable continuous WAL archiving on the supabase-db. The chart can't
  //     inject secret env (environment.db is string-only) or postgres archive
  //     flags, so we (a) ALTER SYSTEM the archive params (persisted to
  //     postgresql.auto.conf on the PVC), and (b) inject the SECRET S3 creds
  //     via a strategic-merge env patch (merged by env name → idempotent;
  //     re-applied every deploy because helm upgrade strips non-chart env).
  //     The cred patch rolls the pod when it changes the template; on first
  //     enable that rollout is what makes postgres pick up archive_mode.
  //     Skipped without S3 (dev / no backups configured).
  if (s3Config?.accessKey) {
    // Set when the block below rolls the db pod, so the wal-archive.sh
    // freshness check that follows does not roll it a SECOND time.
    let dbPodJustRolled = false;
    await perfAsync(`deploy.${perfPrefix}.enableWalArchiving`, async () => {
      const dbSts = 'supabase-supabase-db';
      const dbPod = `${dbSts}-0`;
      // Gate on ACCEPTING, not Running, before the psql calls below — the
      // 0fbb296f RCA's root cause, closed at the source (mitigation-audit
      // cluster 5). The per-call PSQL_LIFECYCLE ladder is REMOVED: a
      // lifecycle FATAL past a proven-accepting gate is a regression and
      // fails the deploy loudly.
      await awaitPostgresAccepting({ env, dbPod });
      // S3 creds reach the db container as a mounted file (helm-owned, see
      // supabase.values.yaml walg-s3-creds volume) — no env patch, so no
      // db restart on warm deploys. Only the archive params need ALTER
      // SYSTEM, and archive_mode flips only with a RESTART. So: check the
      // RUNNING archive_mode; if already 'on' (persisted in
      // postgresql.auto.conf from a prior enable), this is a warm deploy —
      // nothing to do. If 'off', set the params and restart ONCE.
      let archiveMode = '';
      try {
        archiveMode = (
          await runKubectlWithRetry(
            [
              '-n',
              'vibecarbon',
              'exec',
              dbPod,
              '--',
              'psql',
              '-U',
              'supabase_admin',
              '-d',
              'postgres',
              '-tAc',
              'SHOW archive_mode',
            ],
            {
              env,
              captureStdout: true,
              description: 'applyK3sManifests: read archive_mode',
            },
          )
        )
          ?.toString()
          .trim();
      } catch {
        // Treat an unreadable value as "not yet enabled" — the worst case is
        // one extra ALTER SYSTEM + restart, which is idempotent.
      }
      if (archiveMode === 'on') {
        progressLog('[k3s] WAL archiving already enabled, skipping ALTER SYSTEM + restart.');
        return;
      }
      await runKubectlWithRetry(enableWalArchivingPsqlArgs(dbPod), {
        env,
        description: 'applyK3sManifests: enable WAL archiving (ALTER SYSTEM)',
      });
      // archive_mode requires a restart (reload is insufficient). Restart the
      // StatefulSet ONCE; persisted to postgresql.auto.conf on the PVC, so
      // subsequent deploys hit the archiveMode==='on' fast path above.
      await runKubectlWithRetry(
        ['-n', 'vibecarbon', 'rollout', 'restart', `statefulset/${dbSts}`],
        { env, description: 'applyK3sManifests: restart supabase-db to enable WAL archiving' },
      );
      await runKubectlWithRetry(
        ['-n', 'vibecarbon', 'rollout', 'status', `statefulset/${dbSts}`, '--timeout=300s'],
        { env, description: 'applyK3sManifests: wait supabase-db rollout (WAL archiving)' },
      );
      dbPodJustRolled = true;
    });
    // 7c. Make a CHANGED wal-archive.sh actually reach the running database.
    //
    // The script is mounted with `subPath: wal-archive.sh`
    // (carbon/k8s/values/supabase.values.yaml), and a subPath ConfigMap mount is
    // NEVER updated in place by the kubelet — unlike a whole-directory mount, it
    // is materialised once at container start. So `kubectl apply` of a new
    // ConfigMap changes the object and changes nothing the database executes:
    // the old script keeps running until the pod is recreated for some unrelated
    // reason. That is not a theoretical staleness window — it is how a fix to
    // this script reaches ZERO existing clusters on a routine `vibecarbon
    // deploy` (the failover path self-heals only because `set env` rolls the
    // pod, which routine deploys never do).
    //
    // So: hash what we shipped, keep it in an annotation on the StatefulSet, and
    // roll the pod when the two disagree. The hash covers the WHOLE ConfigMap
    // file rather than just the script body — a superset, deliberately: it needs
    // no YAML parsing (this module carries no YAML dependency), it cannot drift
    // from how the file is applied, and the only cost of the extra breadth is
    // one db roll if someone edits a comment in that file.
    await perfAsync(`deploy.${perfPrefix}.walArchiveScriptFreshness`, async () => {
      const dbSts = 'supabase-supabase-db';
      const cmPath = join(projectDir, 'k8s/base/backup/configmap-walg.yaml');
      if (!existsSync(cmPath)) return;
      const want = createHash('sha256').update(readFileSync(cmPath)).digest('hex').slice(0, 16);
      let have = '';
      try {
        have = (
          await runKubectlWithRetry(
            [
              '-n',
              'vibecarbon',
              'get',
              `statefulset/${dbSts}`,
              '-o',
              `jsonpath={.metadata.annotations.${WAL_ARCHIVE_SHA_ANNOTATION.replace(/\./g, '\\.')}}`,
            ],
            { env, captureStdout: true, description: 'applyK3sManifests: read wal-archive sha' },
          )
        )
          ?.toString()
          .trim();
      } catch {
        // Unreadable annotation == unknown == treat as stale. One extra roll is
        // the safe direction; silently running a stale archive_command is not.
      }
      if (have === want) {
        progressLog('[k3s] wal-archive.sh is current in the db pod; no restart needed.');
        return;
      }
      // A pod that this deploy ALREADY recreated is running the current
      // ConfigMap by construction — record the hash, skip the second roll.
      if (dbPodJustRolled) {
        progressLog('[k3s] db pod was just rolled, wal-archive.sh is current.');
      } else {
        progressLog('[k3s] wal-archive.sh changed, restarting supabase-db so it takes effect.');
        await runKubectlWithRetry(
          ['-n', 'vibecarbon', 'rollout', 'restart', `statefulset/${dbSts}`],
          { env, description: 'applyK3sManifests: restart supabase-db (wal-archive.sh changed)' },
        );
        await runKubectlWithRetry(
          ['-n', 'vibecarbon', 'rollout', 'status', `statefulset/${dbSts}`, '--timeout=300s'],
          { env, description: 'applyK3sManifests: wait supabase-db rollout (wal-archive.sh)' },
        );
      }
      await runKubectlWithRetry(
        [
          '-n',
          'vibecarbon',
          'annotate',
          `statefulset/${dbSts}`,
          `${WAL_ARCHIVE_SHA_ANNOTATION}=${want}`,
          '--overwrite',
        ],
        { env, description: 'applyK3sManifests: record wal-archive.sh sha' },
      );
    });
  }
  // NOTE: the wal-g backup audit deliberately does NOT live here. It is the one
  // check whose subject can rot with ZERO in-cluster change (keys revoked at the
  // provider, bucket deleted), so it must not sit behind the persisted
  // `k3s-apply` skip gate — see deployK3s, which runs it unconditionally.
  // 8. Apply project SQL migrations against the chart-installed postgres.
  //    SKIPPED when restoring: a wal-g restore brings the full DB including
  //    supabase_migrations.schema_migrations, so re-running migrations would
  //    hit duplicate-key errors (applyMigrations deliberately does not
  //    swallow them). On a normal deploy, helm's `--wait` guarantees the db
  //    pod is up; without migrations the app's /api/health/ready 503s.
  if (pilotStandby) {
    // Pilot-light: no app tier is reading the schema on a standby yet, and
    // applyMigrations execs against a pod whose migrations wouldn't matter —
    // skip both it and its nested waitForSupabaseStorageSchema poll.
    console.error('[pilot-standby] skipping applyMigrations, app tier is zeroed until failover');
    console.error(
      '[pilot-standby] skipping waitForSupabaseStorageSchema, app tier is zeroed until failover',
    );
  } else if (restore) {
    progressLog(
      `[k3s] restore=${restore} requested, skipping applyMigrations (restored DB carries schema_migrations).`,
    );
  } else {
    await perfAsync(`deploy.${perfPrefix}.applyMigrations`, async () =>
      applyMigrations({ kubeconfig, projectDir }),
    );
  }
  // 8b. Reload PostgREST's schema cache so it sees the tables applyMigrations
  //     just created. rest came up during helm --wait (before migrations) and
  //     no DDL-watch trigger exists to auto-NOTIFY — without this, /rest/v1/*
  //     404s with PGRST205 until rest restarts. Mirrors the compose fix.
  if (pilotStandby) {
    console.error('[pilot-standby] skipping reloadPostgrest, app tier is zeroed until failover');
  } else {
    await perfAsync(`deploy.${perfPrefix}.reloadPostgrest`, async () =>
      reloadPostgrest({ kubeconfig }),
    );
  }
  // 8c. Create the production app super-admin via GoTrue's admin API. Mirrors
  //     the compose path — without it the operator can't log into their own
  //     deployed app (ADMIN_* only seeds the Studio dashboard secret, never an
  //     auth.users row). Runs unconditionally (incl. restore: idempotent on
  //     422, and a backup predating admin-creation still gets seeded). In HA
  //     both clusters run this against their independently-writable DB at
  //     deploy time (same as applyMigrations); the localPort is derived from
  //     localTunnelPort so the parallel primary/standby port-forwards don't
  //     race for the same bind. FATAL on ANY failure (M3 Task 9h, fix round
  //     1): provisionAdminUser retries the whole port-forward + HTTP flow
  //     under its own budget and throws once it's exhausted, AND throws
  //     immediately on missing admin credentials — no soft return remains.
  //     A transient blip here used to warn-and-continue, shipping a deploy
  //     with no admin.users row behind a false "success" (battery d3 run 6);
  //     a missing/misnamed CI secret hit the exact same failure mode via the
  //     credentials-missing branch.
  //     SKIPPED on a pilot standby: GoTrue isn't running yet (auth Deployment
  //     is part of the zeroed app tier), so the port-forward would just spin
  //     until provisionAdminUser's retry budget is exhausted.
  if (pilotStandby) {
    console.error('[pilot-standby] skipping createAdminUser, app tier is zeroed until failover');
  } else {
    await perfAsync(`deploy.${perfPrefix}.createAdminUser`, async () => {
      // provisionAdminUser now always either succeeds or throws (see its
      // doc comment) — no soft-fail return remains to branch on here.
      const adminResult = await provisionAdminUser({
        kubeconfig,
        envLocal,
        localPort: 15000 + (localTunnelPort - 5000),
      });
      progressLog(`[k3s] ${adminResult.message}`);
    });
  }
  // 9. Wait for app rollout. The deployment template already has
  //    imagePullPolicy: IfNotPresent, so kubelet uses the sideloaded image
  //    without pulling. 300s wasn't enough on a cold deploy where the app
  //    pods stay Pending behind kong/auth converge — bump to 10m to match
  //    the helm `--wait` budget.
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
    await perfAsync(`deploy.${perfPrefix}.rolloutApp`, async () => {
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
  // Supabase install + migrations + app rollout — nothing above reads the
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
 * @returns {Promise<{masterIp: string, floatingIp: string, supabaseIp: string, supabasePrivateIp: string, workerIps: string[], networkId: string|number, kubeconfig: string, sshKeyPath: string}>}
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

  // 3. Pulumi up — provisions network, firewall, master, supabase, workers,
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
    supabaseType: options.supabaseServerType,
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
      supabaseServerType:
        options.supabaseServerType || options.serverType || Provider.DEFAULT_K8S_NODE_TYPE,
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
    // Fallback default covers state.json step results persisted before this
    // field existed.
    masterPrivateIp = '10.0.1.1',
    floatingIp,
    supabaseIp,
    supabasePrivateIp = '10.0.1.2',
    workerIps,
    networkId,
    // DO-only real Pulumi output (the Vpc's actual ipRange). Fallback
    // default (Provider.DEFAULT_VPC_CIDR — empty string on Hetzner,
    // '10.10.0.0/20' on DO) covers state.json step results persisted
    // before this field existed, same reasoning as
    // masterPrivateIp/supabasePrivateIp above. HetznerProvider.
    // getS3EgressExtraCidrs ignores this value entirely, so an unused ''
    // fallback there is harmless.
    vpcCidr = Provider.DEFAULT_VPC_CIDR,
  } = infraOutputs;

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
  for (const seedIp of [masterIp, supabaseIp, ...(workerIps ?? [])].filter(Boolean)) {
    await seedKnownHosts(khPath, seedIp);
  }

  // HA fan-out hook: surface this cluster's infra identity the moment the
  // nodes exist, k3s answers, and host keys are pinned — the HA deploy uses
  // it to start replication transport prep (WireGuard + gateways) while this
  // cluster's manifests/helm are still installing. Fire-and-forget: the
  // callback is not awaited and must never fail this deploy.
  if (typeof options.onInfraReady === 'function') {
    try {
      options.onInfraReady({ masterIp, floatingIp, supabaseIp, supabasePrivateIp });
    } catch {
      // opportunistic hook — a listener bug must not break the deploy
    }
  }

  // Opportunistic image pre-pull on every node — deliberately NOT awaited: it
  // overlaps the build/sideload/manifest work below so kubelet finds the
  // images already present when helm installs (slow-pull regions measured
  // ~135s of the helm wait in image pulls alone) and when the
  // cluster-autoscaler rollout wait starts (a 403'd CA pull ate the full 300s
  // budget on 2026-07-31). Any failure just means kubelet pulls on demand,
  // exactly as before.
  const prePullStart = Date.now();
  prePullChartImages({
    nodeIps: [masterIp, supabaseIp, ...(workerIps ?? [])],
    sshKeyPath: privateKeyPath,
    khPath,
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

  // 7. The wal-g-equipped db image (supabase/postgres + wal-g) is now a
  //    pre-published, multi-arch image pulled from ghcr — no per-deploy build
  //    or sideload. The supabase Helm chart's image.db + the walg-restore init
  //    container both reference it (see installSupabase + supabase.values.yaml).
  const dbImageTag = resolveDbImageTag();

  // 7b. Sideload to every node (parallel SSH within sideloadK3s) AND fan out
  //     the app+db sideloads against each other. Both writes go through
  //     `docker save | ssh ... gunzip | k3s ctr import` against disjoint
  //     image refs on the same target nodes — kernel disk buffer + sshd
  //     multiplex two parallel streams. Critical path = max(app, db).
  //     The db image only NEEDS the supabase node (db is pinned there), but
  //     sideloading to all nodes is harmless and keeps the target list shared.
  const sshTargets = [`root@${masterIp}`];
  if (supabaseIp) sshTargets.push(`root@${supabaseIp}`);
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

  // 8. Apply manifests + supabase Helm release + roll out the app.
  // The gate folds the CONTENT of BOTH applied manifest trees (the project
  // copy and the CLI's own bundled `carbon/k8s`) into its inputs — see
  // buildK3sApplyInputs for why each one is load-bearing.
  const applyInputs = buildK3sApplyInputs({
    imageTag,
    dbImageTag,
    restore: options.restore,
    projectDir,
    // The Supabase chart's PVC classes are rendered from this provider static,
    // and no manifest digest can see it — see buildK3sApplyInputs.
    storageClass: Provider.K8S_STORAGE_CLASS,
  });
  if (!state.shouldSkip('k3s-apply', applyInputs)) {
    state.startStep('k3s-apply', applyInputs);
    s.start('Applying k8s manifests + installing Supabase + rolling out app');
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
        // and installSupabase's standby zero-overlay. The k8s-ha fan-out
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
        // The supabase node's own private IP — installSupabase renders it
        // into the seed-standby init's SEED_PRIMARY_HOST (repl-gateway relay
        // endpoint). Already in scope from infraOutputs (returned below).
        supabasePrivateIp,
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
    supabaseIp,
    // The supabase node's Hetzner private-network IP (deterministic in the IaC
    // program, but threaded through the output rather than hardcoded at the use
    // site). setupReplication renders it into the repl-gateway egress
    // NetworkPolicy + socat bind for this cluster.
    supabasePrivateIp,
    workerIps,
    networkId,
    kubeconfig,
    sshKeyPath: privateKeyPath,
    imageTag,
  };
}
