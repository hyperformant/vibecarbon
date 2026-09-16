/**
 * Shared e2e environment setup — the single source of truth for everything
 * the harness establishes before it (or any `vibecarbon` child it spawns)
 * touches the network.
 *
 * TWO CONSUMERS, ONE SETUP:
 *   - `tests/e2e/runner.ts`     — full lifecycle runs (`pnpm test:e2e*`)
 *   - `scripts/iter-step.js`    — Pattern-2 single-step iteration against a
 *                                 kept rig
 *
 * Before this module existed, iter-step hand-rolled a subset of the runner's
 * child env and inherited none of its process-level setup. The gap was not
 * theoretical: an iter-step `deploy` against a kept rig failed its public
 * health probe purely because it lacked the runner's staging-CA handling,
 * and every iter-step run silently used PRODUCTION Let's Encrypt (5 certs /
 * week / identifier) instead of staging. Both consumers now call
 * `setupE2EEnv()` + `e2eCliEnv()` so a change here reaches both by
 * construction rather than by remembering to copy it.
 *
 * PLAIN JS ON PURPOSE: `scripts/iter-step.js` runs under bare `node`, which
 * cannot import a `.ts` module. Types live in JSDoc; `tsconfig.e2e.json` sets
 * `allowJs: true`, so the TypeScript runner imports this unchanged.
 */

import { randomBytes, X509Certificate } from 'node:crypto';
import dns from 'node:dns';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { pmScrubbedEnv } from '../../_shared/pm-env.js';
import { loadE2EEnvFile } from './e2e-env-file.js';
import { signingKeyOrNull, startLicenseStub } from './license-stub.js';

/** Repo root, resolved from this file (tests/e2e/utils/ → 3 up). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Vendored Let's Encrypt STAGING roots — see the header of that file. */
export const STAGING_CA_BUNDLE = join(
  REPO_ROOT,
  'tests',
  'e2e',
  'certs',
  'letsencrypt-staging-roots.pem',
);

/**
 * Force every deploy in the harness onto Let's Encrypt's staging ACME server.
 * Production LE caps at 5 certs / week / identifier and the matrix re-uses the
 * same {e3,e4}.appcarbon.dev names every run — by the 6th run the cert never
 * issues, the public probe times out, and the deploy fails (observed
 * 2026-04-26 matrix #8 k8s-ha: restore-redeploy stuck 20 min on TRAEFIK
 * DEFAULT CERT until probe timeout). Staging allows 30k/account/week.
 *
 * Read by:
 *   - src/lib/deploy/k8s/k3s.js → patches the Certificate's issuerRef to
 *     `letsencrypt-staging` (the ClusterIssuer already ships in
 *     cert-manager-resources).
 *   - src/lib/deploy/orchestrator.js probePublicHealth → swaps in an undici
 *     Agent that tolerates the staging chain.
 */
export const ACME_STAGING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/directory';

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * `NODE_EXTRA_CA_CERTS` as Node saw it when THIS process booted — captured at
 * module load, before anything below reassigns it.
 *
 * Node reads that variable exactly once during process init, so its value here
 * is the only evidence of whether this process's own sockets already trust the
 * staging roots. Needed because `tls.getCACertificates()` (the other way to
 * check) only exists on Node >= 22.15, while the `pnpm test:e2e*` scripts set
 * the variable on every version.
 */
const STARTUP_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;

/** Reset hook for unit tests — see `resetStagingTrustCacheForTests`. */
let inProcessTrustApplied = false;

/**
 * Read the vendored staging roots as individual PEM blocks.
 *
 * The bundle carries `#` provenance comments between blocks (OpenSSL and
 * Node's `NODE_EXTRA_CA_CERTS` loader both skip them), but
 * `tls.setDefaultCACertificates()` wants one certificate per array entry —
 * hence the split rather than passing the file wholesale.
 *
 * @param {string} [bundlePath]
 * @returns {string[]} One PEM-encoded certificate per entry.
 */
export function readStagingRootPems(bundlePath = STAGING_CA_BUNDLE) {
  const raw = readFileSync(bundlePath, 'utf-8');
  const blocks = raw.match(PEM_BLOCK);
  if (!blocks || blocks.length === 0) {
    throw new Error(`No PEM certificates found in staging CA bundle: ${bundlePath}`);
  }
  return blocks;
}

/**
 * Trust the Let's Encrypt staging roots — WITHOUT disabling TLS verification.
 *
 * Replaces the harness's former `NODE_TLS_REJECT_UNAUTHORIZED = '0'`, which
 * turned verification off process-wide and therefore also made a rig serving
 * a self-signed / expired / wrong-host certificate pass silently — the exact
 * class of misconfiguration these tests exist to catch. Adding four specific
 * roots keeps verification ON: staging chains validate, everything else still
 * fails.
 *
 * Two layers, because Node reads `NODE_EXTRA_CA_CERTS` exactly once at
 * process startup (verified empirically on Node 24.9: assigning
 * `process.env.NODE_EXTRA_CA_CERTS` at runtime has NO effect on this
 * process's own TLS):
 *
 *   1. `process.env.NODE_EXTRA_CA_CERTS` — for CHILD processes. Every
 *      `vibecarbon` CLI the harness spawns inherits it and starts with the
 *      staging roots already in its trust store.
 *   2. `tls.setDefaultCACertificates()` — for THIS process. Covers the
 *      runner's own in-process TLS (the `realtime_connect` WebSocket check,
 *      any bare `fetch`) when the env var wasn't already set at startup,
 *      e.g. `tsx tests/e2e/runner.ts` invoked directly rather than through
 *      the `pnpm test:e2e*` scripts (which do set it).
 *
 * If an operator already exported `NODE_EXTRA_CA_CERTS` (corporate MITM CA,
 * etc.) we merge rather than clobber: Node accepts only ONE path in that
 * variable, so both bundles are concatenated into a temp file (named uniquely
 * per call, so concurrent harness processes can't clobber each other) and the
 * variable is pointed at that.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env] Env object to mutate (default `process.env`).
 * @param {string} [opts.bundlePath] Override the vendored bundle (tests).
 * @param {boolean} [opts.applyInProcess] Set false to skip layer 2 — used by
 *   unit tests that assert on the env plumbing without mutating this
 *   process's global CA store.
 * @param {(msg: string) => void} [opts.warn] Warning sink (default `console.warn`).
 * @returns {{ bundlePath: string, caCertsPath: string, merged: boolean,
 *            trustedAtStartup: boolean, appliedInProcess: boolean, rootCount: number }}
 */
export function trustLetsEncryptStagingRoots(opts = {}) {
  const {
    env = process.env,
    bundlePath = STAGING_CA_BUNDLE,
    applyInProcess = true,
    warn = (msg) => console.warn(msg),
  } = opts;

  if (!existsSync(bundlePath)) {
    throw new Error(
      `Let's Encrypt staging CA bundle missing: ${bundlePath}\n` +
        `The e2e harness cannot verify staging certificates without it. ` +
        `Restore it from git (tests/e2e/certs/) — do NOT work around this by ` +
        `setting NODE_TLS_REJECT_UNAUTHORIZED.`,
    );
  }

  const roots = readStagingRootPems(bundlePath);

  // --- Layer 1: env var for child processes -------------------------------
  const existing = env.NODE_EXTRA_CA_CERTS;
  let caCertsPath = bundlePath;
  let merged = false;
  if (existing && resolve(existing) !== resolve(bundlePath)) {
    if (existsSync(existing)) {
      // Node honours a single path only — concatenate so the operator's own
      // trust anchors survive alongside ours.
      //
      // Unique per call, NOT a fixed filename: a full matrix run and an
      // `iter-step.js` run against a kept rig are routinely in flight at the
      // same time on one machine, and a shared path means whichever process
      // writes last defines what the other's children trust (or, worse, they
      // interleave mid-write and both read a truncated bundle). Left in
      // tmpdir() for the process lifetime — children read it lazily at their
      // own startup, so it cannot be unlinked on our way out.
      caCertsPath = join(
        tmpdir(),
        `vibecarbon-e2e-ca-bundle-${process.pid}-${randomBytes(4).toString('hex')}.pem`,
      );
      writeFileSync(
        caCertsPath,
        `${readFileSync(existing, 'utf-8')}\n${readFileSync(bundlePath, 'utf-8')}`,
      );
      merged = true;
    } else {
      warn(
        `[e2e-env] NODE_EXTRA_CA_CERTS pointed at a missing file (${existing}); ` +
          `replacing it with the Let's Encrypt staging bundle.`,
      );
    }
  }
  env.NODE_EXTRA_CA_CERTS = caCertsPath;

  // Whether THIS process already had the roots when it started — either
  // because Node booted with the variable pointing at our bundle (the `pnpm
  // test:e2e*` scripts), or because the store demonstrably contains them.
  const trustedAtStartup =
    (Boolean(STARTUP_CA_CERTS) && resolve(String(STARTUP_CA_CERTS)) === resolve(bundlePath)) ||
    hasStagingRoots(roots);

  // --- Layer 2: in-process trust ------------------------------------------
  let appliedInProcess = false;
  if (applyInProcess && !trustedAtStartup && !inProcessTrustApplied) {
    // Still reachable despite `engines.node: ">=24.15.0"` — engines is advisory
    // (no `engine-strict` anywhere), so a contributor on Node 22 hits this
    // branch. Keep the fallback.
    if (typeof tls.setDefaultCACertificates === 'function') {
      const current =
        typeof tls.getCACertificates === 'function' ? tls.getCACertificates('default') : [];
      tls.setDefaultCACertificates([...current, ...roots]);
      appliedInProcess = true;
      inProcessTrustApplied = true;
    } else {
      warn(
        `[e2e-env] This Node (${process.version}) has no tls.setDefaultCACertificates(), and ` +
          `NODE_EXTRA_CA_CERTS was not set at startup — in-process TLS checks will reject ` +
          `Let's Encrypt staging certificates. Run via 'pnpm test:e2e' (which sets the ` +
          `variable) or export NODE_EXTRA_CA_CERTS=${bundlePath} before invoking node.`,
      );
    }
  }

  return {
    bundlePath,
    caCertsPath,
    merged,
    trustedAtStartup,
    appliedInProcess,
    rootCount: roots.length,
  };
}

/**
 * True when every PEM in `roots` is already present in this process's default
 * CA set. Compared by raw DER (via `X509Certificate.raw`) so re-encoded PEM
 * whitespace can't produce a false negative.
 *
 * @param {string[]} roots
 * @returns {boolean}
 */
function hasStagingRoots(roots) {
  if (typeof tls.getCACertificates !== 'function') return false;
  try {
    const present = new Set(
      tls.getCACertificates('default').map((pem) => new X509Certificate(pem).raw.toString('base64')),
    );
    return roots.every((pem) => present.has(new X509Certificate(pem).raw.toString('base64')));
  } catch {
    return false;
  }
}

/** Test-only: forget that in-process trust was applied. */
export function resetStagingTrustCacheForTests() {
  inProcessTrustApplied = false;
}

/**
 * Pin DNS resolution to Cloudflare + Google public resolvers.
 *
 * Scenarios destroy and recreate infrastructure constantly; the system
 * resolver caches NXDOMAIN for domains that no longer exist, which fails ALL
 * subsequent health checks and verification requests for the cache TTL.
 */
export function pinPublicDns() {
  try {
    dns.setDefaultResultOrder('verbatim');
    dns.setServers(['1.1.1.1', '8.8.8.8']);
  } catch {
    // setServers throws on an empty/invalid list — both are caller errors,
    // not runtime concerns. Fall through with whatever resolver is current.
  }
}

/**
 * Hard-disable any ssh-askpass / interactive password fallback for every
 * child ssh/scp the harness (and the CLI children it spawns) might invoke.
 * Mirrors the same guard in src/cli.js — see that file for the full why.
 * tl;dr: a single ssh callsite missing BatchMode=yes can pop a graphical
 * password dialog that hangs the entire matrix until the operator-run budget
 * fires, and the failure surfaces as some unrelated timeout ("k3s not ready",
 * "Canceled mid-step"). These three env vars make that impossible regardless
 * of any individual ssh's flags.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function disableSshAskpass(env = process.env) {
  env.SSH_ASKPASS_REQUIRE = 'never';
  env.SSH_ASKPASS = '/bin/false';
  delete env.DISPLAY;
}

/**
 * Fail fast unless the licence signing key is present: the harness runs a
 * local stub of vibecarbon.com's licence API and every paid-tier deploy in
 * the matrix is checked against it. No key, no signed verdicts, and a
 * matrix leg would die 40 minutes in with "License not bound".
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} The signing key, as raw PEM.
 */
export function assertLicenseSigningKey(env = process.env) {
  const key = signingKeyOrNull(env);
  if (key) return key;
  throw new Error(
    '[e2e-env] VIBECARBON_LICENSE_PRIVATE_KEY is not set (shell or tests/.env.e2e).\n' +
      "It is the same value as vibecarbon-web's LICENSE_SIGNING_PRIVATE_KEY, as raw PEM.",
  );
}

/**
 * The licence API the harness runs against, once started. Module-level
 * because `setupE2EEnv()` is synchronous (it is called at module load by
 * `tests/e2e/runner.ts` and `scripts/iter-step.js`) while starting a server
 * is not — so the stub gets its own async entry point and the child-env
 * builder below reads it from here.
 *
 * @type {Awaited<ReturnType<typeof startLicenseStub>> | null}
 */
let licenseStub = null;

/**
 * Start the local licence API the whole run is checked against, and point
 * every CLI child at it.
 *
 * The CLI walks its PRODUCTION path against this stub: `activate` binds a
 * real Ed25519-signed key through `POST /api/v1/license/bind`, and each
 * gated deploy asks `/check` and verifies the signed verdict it gets back.
 * Only the host changes (`VIBECARBON_API_BASE`) — there is no test-only
 * bypass in the licensing code to change anything else.
 *
 * Idempotent: a second call returns the stub already running.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Awaited<ReturnType<typeof startLicenseStub>>>}
 */
export async function startE2ELicenseStub(env = process.env) {
  if (licenseStub) return licenseStub;
  licenseStub = await startLicenseStub({ privateKeyPem: assertLicenseSigningKey(env) });
  // Read back by `e2eCliEnv()` — both through this env (which is
  // `process.env`, the builder's default base) and from `licenseStub`
  // directly, so a caller passing its own base still reaches the stub.
  env.VIBECARBON_API_BASE = licenseStub.baseUrl;
  return licenseStub;
}

/** The running licence stub, or null before `startE2ELicenseStub()`. */
export function getE2ELicenseStub() {
  return licenseStub;
}

/**
 * Everything the e2e harness establishes at process level, in one call.
 * Idempotent — safe to call more than once.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {boolean} [opts.applyInProcess]
 * @param {(msg: string) => void} [opts.warn]
 * @returns {{ envFileKeys: string[], tls: ReturnType<typeof trustLetsEncryptStagingRoots> }}
 */
export function setupE2EEnv(opts = {}) {
  const { env = process.env, applyInProcess = true, warn = (msg) => console.warn(msg) } = opts;

  // Fold tests/.env.e2e (gitignored operator token file — see
  // tests/.env.e2e.example) into the env before any token is read. Real env
  // wins: a key already exported in the shell or set by CI (GitHub
  // Environments) is left untouched. Missing file is a no-op.
  const envFileKeys = [...loadE2EEnvFile(join(REPO_ROOT, 'tests', '.env.e2e'), env)];

  // After loadE2EEnvFile (the key may live in tests/.env.e2e), before any
  // network work — a licence failure should cost seconds, not a provisioned rig.
  // Only asserts the key is THERE; `startE2ELicenseStub()` (async, called by
  // the runner right after this) is what puts it to work.
  assertLicenseSigningKey(env);

  pinPublicDns();
  disableSshAskpass(env);
  env.ACME_CA_SERVER = ACME_STAGING_DIRECTORY;

  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    // Inherited from the operator's shell, not from us. Say so loudly: with
    // verification off, a rig serving a bogus certificate passes silently and
    // the suite's cert coverage is worthless.
    warn(
      `[e2e-env] NODE_TLS_REJECT_UNAUTHORIZED is set to "0" in your ` +
        `environment. TLS verification is DISABLED process-wide, so ` +
        `certificate misconfigurations on the rig will NOT be caught. Unset ` +
        `it — the harness trusts the Let's Encrypt staging roots explicitly.`,
    );
  }

  const tlsInfo = trustLetsEncryptStagingRoots({ env, warn, applyInProcess });

  return { envFileKeys, tls: tlsInfo };
}

/**
 * Env for a spawned `vibecarbon` CLI child.
 *
 * Shared by `runCli` (tests/e2e/utils/cli-runner.ts) and
 * `scripts/iter-step.js` so a step iterated against a kept rig runs under the
 * same env as the same step inside a full lifecycle run.
 *
 * Precedence: defaults < process.env < pins < `extra`. The real environment
 * overriding a default is deliberate (an operator can widen ALLOWED_SSH_IPS
 * or turn perf logging off from the shell); per-call `extra` wins over both.
 * The two licence variables are PINS, set after the inherited spread, because
 * a shell-exported value must not be able to send a child at production or
 * hand it the signing key — see their comments below.
 *
 * @param {Record<string, string | undefined>} [extra] Per-call overrides.
 * @param {NodeJS.ProcessEnv} [base] Env to inherit (default `process.env`).
 * @returns {Record<string, string>}
 */
export function e2eCliEnv(extra = {}, base = process.env) {
  const env = {
    // VIBECARBON_PERF=1 turns on the [perf] stderr lines emitted by every
    // deploy sub-step (setupServer, buildImageOnServer, pullComposeImages,
    // composeUp, migrations, ...) so the e2e log captures per-stage
    // wall-clock timings. Off-by-default outside e2e.
    VIBECARBON_PERF: '1',
    // H-2: deploys run with --yes from e2e scenarios, which require either a
    // populated operatorCidrs list or ALLOWED_SSH_IPS. E2E environments are
    // disposable — open SSH/k8s API to the world; the point of these
    // scenarios is exercising the deploy flow, not firewall hardening. Real
    // deploys go through the interactive auto-detect path.
    ALLOWED_SSH_IPS: '0.0.0.0/0,::/0',
    // `create` infers the package manager from npm_config_user_agent, and this
    // harness is launched by `pnpm test:e2e` — so spreading the raw environment
    // made every e2e project pnpm-based. The matrix then never exercised the
    // npm default a customer actually gets, and the first real-infra run after
    // the npm template migration died in the pnpm path it should never have
    // been on (2026-07-31: `pnpm install --frozen-lockfile` in the generated
    // project's Dockerfile). Scrub it so the harness tests the default.
    // A scenario wanting pnpm/bun must pass `-pm` explicitly, which wins.
    ...pmScrubbedEnv(base),
    // AFTER the spread, both of them, because both must beat the inherited
    // environment rather than lose to it.
    //
    // VIBECARBON_API_BASE is the only licence-related variable a child gets,
    // and it is a HOST, not a credential: it points the child's bind/check
    // requests at the local stub of vibecarbon.com's licence API
    // (startE2ELicenseStub() above). Licensing is deploy-mode-based, so
    // compose-ha/k8s/k8s-ha scenarios hit requireDeployEntitlement() every
    // time `deploy` runs, and the harness satisfies that the way a customer
    // does: a genuine Ed25519-signed key, bound to the project by `vibecarbon
    // activate`, re-checked against the API for a signed verdict on every
    // gated command. It FAILS CLOSED — with no stub running the child gets a
    // closed port and the call fails as 'unreachable', where an inherited or
    // shell-exported value could have sent a real request to production.
    VIBECARBON_API_BASE: licenseStub?.baseUrl ?? 'http://127.0.0.1:9',
    // The signing key mints keys and verdicts; only the STUB, in this
    // process, ever needs it. `...pmScrubbedEnv(base)` spreads the whole
    // parent environment, so without this blank a shell or CI job that
    // exported it would hand the private key to every CLI child — and the
    // CLI verifies against its embedded public key, so no child has any use
    // for it. Blanked rather than deleted: an empty value is unambiguous.
    VIBECARBON_LICENSE_PRIVATE_KEY: '',
    ...extra,
  };

  // Provider CLI token alias. `_run-lifecycle.ts` passes HCLOUD_TOKEN
  // explicitly to every step it runs; mirroring it here means an iterated
  // step gets the same child env. Only filled when absent — never overrides
  // an explicit value, and never synthesised for DigitalOcean (deploy
  // children must NOT receive DIGITALOCEAN_TOKEN so DO runs prove the
  // customer path — see _run-lifecycle.ts B8-3).
  if (!env.HCLOUD_TOKEN && env.HETZNER_API_TOKEN) {
    env.HCLOUD_TOKEN = env.HETZNER_API_TOKEN;
  }

  // Drop undefined values — spawn() rejects them on some platforms.
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
}
