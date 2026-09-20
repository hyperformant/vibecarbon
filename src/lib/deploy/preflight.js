import { checkDependency, runCommand } from '../command.js';
import { checkOperatorConfig } from '../operator-env.js';

/**
 * The Pulumi release that taught the DIY S3 backend to accept
 * `request_checksum_calculation` in the backend URL.
 *
 * Sourced, not guessed: pulumi/pulumi PR #24109 ("improve gcloud backcompat",
 * commit e4936998) merged 2026-07-29, and the first release cut after it was
 * v3.256.0 on 2026-08-04. That matches the version
 * BaseProvider.STATE_BACKEND_CHECKSUM_CALCULATION's RCA already names as the
 * one whose `translateLegacyS3Params` injects the parameter.
 *
 * Below this, a provider that PINS a checksum mode hands Pulumi a URL it does
 * not understand and every state operation dies at the very first one:
 *
 *   error: unable to open bucket s3://…?…&request_checksum_calculation=when_supported:
 *          unknown query parameter "request_checksum_calculation"
 *
 * That message names neither Pulumi nor a version, and it surfaces from
 * `pulumi stack select` before a single line of provider code runs — so the
 * operator sees a bucket error and goes looking at their object storage
 * credentials. Live 2026-08-20: a Scaleway compose-HA deploy failed exactly
 * this way against Pulumi v3.231.0, and finding the cause took reading the
 * RCA comment in providers/base.js.
 */
export const PULUMI_MIN_VERSION_FOR_BACKEND_CHECKSUM = '3.256.0';

/**
 * Read the installed Pulumi CLI version as `major.minor.patch`, or null when
 * it cannot be determined. Never throws: an unreadable version must not be a
 * deploy blocker — the guard below simply declines to assert.
 *
 * @param {{ run?: typeof runCommand }} [deps]
 * @returns {string|null}
 */
export function readPulumiVersion({ run = runCommand } = {}) {
  try {
    const out = run(['pulumi', 'version'], { silent: true });
    const text = typeof out === 'string' ? out : (out?.stdout ?? '');
    const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(text);
    return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
  } catch {
    return null;
  }
}

/** @returns {number} negative / 0 / positive, like a comparator */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * Refuse to start a deploy whose provider pins a state-backend checksum mode
 * on a Pulumi too old to parse it.
 *
 * Only fires for providers that actually pin one (today: Scaleway). Silence
 * from a provider means "Pulumi's default is fine here", and those deploys
 * are unaffected by the CLI's age — so this must not become a blanket
 * minimum-version gate. An unreadable version is not an error either: better
 * to let the deploy proceed and fail with Pulumi's own message than to block
 * on a version probe that could not run.
 *
 * @param {{ STATE_BACKEND_CHECKSUM_CALCULATION?: string }|null} ProviderClass
 * @param {string|null} installed - `major.minor.patch`, or null if unknown
 * @throws when the provider pins a mode and the CLI predates support for it
 */
export function assertPulumiSupportsBackendOptions(ProviderClass, installed) {
  const mode = ProviderClass?.STATE_BACKEND_CHECKSUM_CALCULATION;
  if (!mode) return;
  if (!installed) return;
  if (compareVersions(installed, PULUMI_MIN_VERSION_FOR_BACKEND_CHECKSUM) >= 0) return;
  throw new Error(
    `Pulumi ${installed} is too old for this provider's state backend.\n\n` +
      `  This provider pins \`request_checksum_calculation=${mode}\` on the Pulumi state\n` +
      `  backend URL, which Pulumi only understands from v${PULUMI_MIN_VERSION_FOR_BACKEND_CHECKSUM}.\n` +
      `  On ${installed} every state operation fails at the first one with\n` +
      `  \`unknown query parameter "request_checksum_calculation"\` — a bucket error\n` +
      '  that looks like an object-storage credential problem but is not.\n\n' +
      '  Upgrade:  curl -fsSL https://get.pulumi.com | sh\n' +
      '  Then reopen your shell and re-run.',
  );
}

/**
 * Throw the canonical "Configuration problems" refusal for every malformed
 * (or, under `presence: true`, missing) operator-config value in `scopes` +
 * `keys` — the one place this message is built, so every call site (the
 * pre-`gatherDeploymentConfig` gate in deploy.js, the two gates inside
 * `gatherDeploymentConfig` itself, and `checkDeployPrerequisites` below)
 * prints byte-identical output. A no-op when nothing is wrong.
 *
 * `presence`/`keys` are forwarded verbatim to `checkOperatorConfig` — see
 * its doc for what each means. Defaulting `presence: true` matches this
 * being the LAST-resort gate's own default; a caller running before an
 * interactive prompt passes `presence: false` explicitly.
 *
 * @param {Iterable<string>} scopes - config-registry.js scopes to validate.
 * @param {{ env?: Record<string, string|undefined>, presence?: boolean, keys?: string[] }} [opts]
 * @throws when `checkOperatorConfig` reports any problem
 */
export function assertOperatorConfig(
  scopes,
  { env = process.env, presence = true, keys = [] } = {},
) {
  const { problems } = checkOperatorConfig(scopes, { env, presence, keys });
  if (problems.length === 0) return;
  throw new Error(
    [
      'Configuration problems (nothing was provisioned):',
      ...problems.map((p) => `  - ${p}`),
      "Set them in .env.local (never committed; see .env.local.example for each variable's format).",
    ].join('\n'),
  );
}

/**
 * Host-side tools every deploy needs, checked before any Pulumi or SSH work.
 *
 * `pulumi` drives provisioning for every mode and is NOT an npm dependency —
 * the package ships the `@pulumi/*` SDK, not the CLI binary — so `engines`/npm
 * cannot catch its absence and a fresh user otherwise hits a raw `ENOENT`
 * mid-deploy. `ssh` reaches every server in every mode. The k8s path checks
 * docker/kubectl/helm in its own preflight (deploy/k8s/k3s.js); compose's local
 * docker is intentionally optional (it falls back to build-on-server), so it is
 * deliberately not required here.
 *
 * Presence is not the only thing that can be wrong with `pulumi`: a CLI that
 * is too OLD for the selected provider's state backend fails just as totally,
 * and far more confusingly. Hence the version assertion — provider-scoped, so
 * it only speaks up when it is actually load-bearing.
 *
 * Beyond host tools, a deploy also depends on the operator-facing config
 * values (provider/DNS/registry credentials, plus the always-checked
 * access/tls/state keys) being well-formed BEFORE any of that config is
 * used — a malformed value discovered mid-deploy (a live provider 401, a
 * Pulumi state-backend rejection) means the operator finds out only after
 * paying for a server or mutating DNS. `operatorScopes`/`operatorKeys` name
 * which `config-registry.js` scopes/individual keys apply to THIS deploy
 * (computed by the orchestrator from the resolved provider/DNS/registry
 * usage — see `assertOperatorConfig` for what `keys` is for); every problem
 * across all of them is collected and thrown together so the operator fixes
 * everything in one pass instead of one prompt at a time.
 *
 * This is DEFENSE IN DEPTH, not the only gate: `src/deploy.js` (Gate 1) and
 * `gatherDeploymentConfig` (Gates 2a/2b, `src/lib/deploy/prompts.js`) check
 * the same scopes earlier, before the network calls that resolving a deploy
 * config makes (the provider token's live verification, `fetchServerTypes`,
 * a DNS backend's zone lookup) — this call is what still catches a bad
 * value on any path that reaches here without having gone through those
 * (or a scope neither of them knew about yet, e.g. `registry`/`state`,
 * which aren't resolved until deep in `executeDeployment`).
 *
 * `operatorScopes`/`operatorKeys` default to `[]` — a DELIBERATE opt-out.
 * `checkDeployPrerequisites` has callers besides the orchestrator's own
 * deploy path (its unit tests, most namedly) that have no operator config
 * to check; passing nothing must remain side-effect-free for them, which is
 * exactly what `entriesForScopes([])` / an empty `keys` array produce.
 *
 * @param {string} tier - 'compose' | 'compose-ha' | 'k8s' | 'k8s-ha'
 * @param {object} [deps] - injectable for testing
 * @param {(bin: string) => boolean} [deps.has]
 * @param {object} [deps.ProviderClass] - the provider this deploy targets
 * @param {() => string|null} [deps.pulumiVersion]
 * @param {string[]} [deps.operatorScopes] - config-registry.js scopes to
 *   validate for this deploy (default: `[]`, i.e. skip the check — see the
 *   opt-out note above).
 * @param {string[]} [deps.operatorKeys] - individual registered keys to
 *   validate alongside `operatorScopes` (default: `[]`) — see
 *   `assertOperatorConfig`'s `keys` option.
 * @param {Record<string, string|undefined>} [deps.env] - injectable for
 *   testing; defaults to `process.env`.
 * @throws if a required tool is not on PATH, is unusable for this provider,
 *   or an in-scope operator config value is malformed or missing.
 */
export function checkDeployPrerequisites(
  _tier,
  {
    has = checkDependency,
    ProviderClass = null,
    pulumiVersion = readPulumiVersion,
    operatorScopes = [],
    operatorKeys = [],
    env = process.env,
  } = {},
) {
  const hints = {
    pulumi:
      'pulumi — install with `curl -fsSL https://get.pulumi.com | sh` (no sudo; drops the binary in ~/.pulumi/bin), then reopen your shell',
    ssh: 'ssh — install OpenSSH (bundled on macOS; `sudo apt install openssh-client` on Debian/Ubuntu)',
  };
  const required = ['pulumi', 'ssh'];
  const missing = required.filter((bin) => !has(bin));
  if (missing.length > 0) {
    throw new Error(
      `Missing host-side tools required to deploy:\n  - ${missing.map((b) => hints[b] ?? b).join('\n  - ')}`,
    );
  }
  // LAZY on purpose: reading the version shells out to `pulumi version`, and
  // only a provider that PINS a checksum mode can fail this check. Calling it
  // unconditionally made a pure-unit preflight test do real subprocess I/O and
  // time out in CI, where pulumi is not on the unit job's PATH (CI l2, PR #284
  // — green locally because pulumi IS on a dev PATH, which is exactly how a
  // probe like this hides). Do not hoist it back out.
  if (ProviderClass?.STATE_BACKEND_CHECKSUM_CALCULATION) {
    assertPulumiSupportsBackendOptions(ProviderClass, pulumiVersion());
  }

  // Operator config gate — AFTER host tools (a missing `pulumi`/`ssh` is a
  // machine problem the operator fixes once; a malformed credential is a
  // config problem they fix in .env.local, and hearing about every one of
  // them at once beats a live 401 five minutes into provisioning). `presence:
  // true` (the default): this is the last stop before real provisioning, so
  // a MISSING value is exactly as much a stop-ship as a malformed one — Gate
  // 1/2a/2b upstream are the ones that tolerate "not set yet, a prompt is
  // coming".
  assertOperatorConfig(operatorScopes, { env, keys: operatorKeys });
}
