/**
 * Classify a step failure as infra / regression / flake / unknown.
 *
 * The classifier looks at the error message and exit context. The signal
 * that "this is a regression" requires comparing against the last green
 * run for the same scenario+step+mode — that's done separately in the
 * runner's diff-vs-green pass and overrides the classification here.
 *
 * Rationale (see PR 1BM commit msg): a 0/4 morning of "infra is having
 * a bad day" reads very differently from a 0/4 morning of real bugs we
 * shipped. Without this, every fail looks the same in the summary and
 * triage starts at line 1 of every log every time.
 */

import type { FailureCategory } from '../scenarios/types.js';

/**
 * Infra-flake patterns. These are signals from external systems that
 * went sideways (or were slow) on the day we ran — not bugs in our
 * code. Keep the list focused; over-matching here is worse than under-
 * matching because it hides real bugs as "oh just infra".
 *
 * Ordered loosely by frequency of occurrence in real matrix runs.
 */
// Exported for the attribution census in
// tests/unit/lib/mitigation-attribution-census.test.ts: every reason here is
// eligible for the runner's flake auto-retry, so every reason must map to a
// root-cause class in docs/mitigations.yml whose attribution is not 'ours'.
export const INFRA_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Hetzner cloud-init / k3s install never completed the SSH probe.
  // Two phrasings: the throw message (`k3s did not become ready`) and
  // the spinner-truncated form when only stderr is captured ("Waiting
  // for k3s on master ... Canceled" — the spinner prefix made it past
  // truncation but the throw didn't, observed 2026-04-27 morning matrix).
  { pattern: /k3s\s+(binary did not appear|did not become ready)/i, reason: 'k3s install timeout' },
  {
    pattern: /Waiting for k3s on (master|node).{0,200}Canceled/is,
    reason: 'k3s install timeout',
  },
  // Hetzner cloud capacity exhausted in the requested location/server type.
  // `resource_unavailable` is the API code; observed in compose-ha scale
  // when nbg1 ran out of cx33 capacity briefly. Transient; retry usually
  // succeeds on the next attempt or in a different location.
  { pattern: /resource_unavailable|placement.*not available/i, reason: 'Hetzner capacity' },
  // Hetzner API 5xx / rate limit / fetch failed during sweep, deploy, etc.
  { pattern: /HTTP\/[\d.]+ 5\d\d|api\.hetzner\.cloud.*5\d\d/i, reason: 'Hetzner API 5xx' },
  // DigitalOcean API 5xx — incl. Cloudflare-fronted gateway shapes (524
  // origin timeout). Live evidence 2026-08-08: the DO platform incident
  // ("Droplets, Reserved IPs, ... across multiple regions") surfaced as
  // `POST https://api.digitalocean.com/v2/droplets: 524 <!DOCTYPE html>`
  // inside the Pulumi droplet create and read as [unknown].
  { pattern: /api\.digitalocean\.com.{0,80}\b5\d\d\b/i, reason: 'DigitalOcean API 5xx' },
  // TF-bridge "nil state" wrapping of a malformed/empty cloud-API response
  // during a resource operation. Live evidence 2026-08-09 (same DO incident,
  // aftershock): the Reserved IP create failed with this wording while the
  // identical call had succeeded 35 minutes earlier in the same scenario.
  // The wording comes from the pulumi TF bridge, so it covers every bridged
  // provider (digitalocean, linode, vultr), not one cloud.
  {
    pattern: /expected non-nil error with nil state during (Create|Read|Update|Delete)/i,
    reason: 'cloud API nil-state response (TF-bridge transient)',
  },
  // Pulumi S3 state backend answering AccessDenied on list/lock blobs —
  // the Hetzner Object Storage LIST-auth-lag family at the state-backend
  // site. Live evidence 2026-08-09 (round A, e4): a ≥6-minute mid-life
  // lockout window on a bucket that had served the whole lifecycle, with
  // the same credentials working again minutes later. Scoped to the
  // state-backend wording (blob/could-not-list-bucket) so a genuinely
  // misconfigured credential — which fails EVERY call forever, incl. the
  // very first deploy — still reads as a real error elsewhere.
  {
    pattern: /could not list bucket.{0,80}AccessDenied|blob \(code=Unknown\): AccessDenied/i,
    reason: 'state-backend S3 auth lag (Hetzner OS transient)',
  },
  // Rate-limit pattern: must include error context. Bare "rate-limit" by
  // itself matches Traefik's `middleware.traefik.io/rate-limit` resource
  // name in normal deploy output, which is NOT an error (false-positive
  // observed 2026-04-27). Require either (a) the camelCase "rateLimited"
  // (used by ACME responses), (b) "429" followed by error words, or
  // (c) "rate limit" with explicit error context.
  {
    // `rate[ _-]?limit\w*[ _]` covers Hetzner's API-code form
    // `rate_limit_exceeded` (2026-08-07 family sweep: `\s+` before the verb
    // meant the underscore form classified as `unknown`, so the runner's
    // infra-only flake retry could never fire on a Hetzner 429).
    pattern:
      /rateLimited|429\s+(too many|rate.?limit)|too many (certificates|requests)|rate[ _-]?limit(?:ed|ing)?[\s_](exceed|reach|hit|exceeds|throttl)/i,
    reason: 'rate limit',
  },
  // Network / DNS / TLS / generic fetch noise
  {
    pattern: /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ENETUNREACH|EAI_AGAIN/i,
    reason: 'network error',
  },
  { pattern: /TLS handshake|SSL|self[- ]signed certificate/i, reason: 'TLS error' },
  // S3 / Object Storage transient.
  //
  // The 5xx half is word-bounded and distance-bounded for the same reason
  // the DigitalOcean and Hetzner rules above are. It used to be a bare
  // `S3.*5\d\d`, and `.*` happily crossed an entire error message to find
  // three digits ANYWHERE — including inside our own bucket names. Live
  // evidence 2026-08-20 (s2, scaleway/compose-ha): a permanent Pulumi
  // backend-URL error was classified `[infra: S3 transient]` because the
  // matched text was `s3://vc-e2e-state-local-6586` — the `586` came out of
  // the bucket's RANDOM stateBucketGeneration hex. That is the worst shape
  // of bug: whether a deterministic failure gets auto-retried forever
  // depended on the dice roll that named the bucket.
  //
  // Anything that no longer matches falls through to `unknown`, which the
  // runner deliberately does NOT auto-retry — the right home for an error
  // we have not positively identified as somebody else's outage.
  {
    pattern: /\bS3\b.{0,80}\b5\d\d\b|RequestTimeout|SlowDown|InternalError/i,
    reason: 'S3 transient',
  },
  // Docker Hub / registry transient. Same bounding as the S3 rule above —
  // swept with it, since `registry-1\.docker\.io.*5\d\d` carried the
  // identical unbounded-`.*` shape and would misfire the same way on a
  // digest or tag that happens to contain a 5xx-looking digit run.
  {
    pattern: /docker.*manifest unknown|toomanyrequests|registry-1\.docker\.io.{0,80}\b5\d\d\b/i,
    reason: 'Docker Hub transient',
  },
  // SSH connection blip — but be conservative, repeated SSH timeouts can be a real bug
  { pattern: /ssh.*Connection (refused|timed out|reset)/i, reason: 'SSH connection blip' },
  // Cert-manager Let's Encrypt issuance pending (related to rate limit but distinct signal)
  {
    pattern: /TRAEFIK DEFAULT CERT|certificate.*not (yet )?ready|order.*errored/i,
    reason: 'LE cert pending',
  },
  // Generic "Cancelled" mid-step often = our own per-step timeout firing on a slow op,
  // not necessarily infra — leave to "unknown" so it doesn't get auto-retried.
];

/**
 * Patterns that mean "this is definitely OUR code, not infra". Catches
 * cases where an error contains both kinds of signal — e.g. a SQL error
 * inside an HTTP response will also match the network catch-all if we
 * aren't careful. Code patterns win.
 *
 * Exported for the precedence census in
 * tests/unit/e2e/classify-failure.test.ts: adding a row here without a
 * covering census sample fails that suite, because "code beats infra" is
 * kept true by nothing more than the order of two loops in classifyFailure.
 */
export const CODE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /TypeError:|ReferenceError:|SyntaxError:|RangeError:/i, reason: 'JS exception' },
  { pattern: /Cannot find module|MODULE_NOT_FOUND/i, reason: 'missing module' },
  {
    pattern: /undefined is not a function|is not a (function|constructor)/i,
    reason: 'JS exception',
  },
  {
    pattern: /UNIQUE constraint failed|FOREIGN KEY constraint/i,
    reason: 'SQL constraint violation',
  },
  { pattern: /No backups found in S3/i, reason: 'restore precondition violated' },
  // The deploy's ACME watchdog only says this after it has detected a
  // terminal cert-manager Order AND spent its whole repair budget failing to
  // clear it (src/lib/deploy/k8s/acme-order-recovery.js). It must outrank the
  // "LE cert pending" infra pattern below, which would otherwise match the
  // `state "errored"` in the same sentence and auto-retry the scenario as a
  // flake — hiding exactly the defect the watchdog exists to expose.
  {
    pattern: /terminally failed after \d+ recovery attempts/i,
    reason: 'ACME issuance terminally failed',
  },
  // Project quota cap. Distinct from `resource_unavailable` (capacity —
  // proven provider-side, stays infra above): quota means "your project hit
  // the limit for this resource type", and the only trigger ever observed in
  // e2e is residue from OUR prior runs — 2026-04-27, 6 leaked servers from a
  // previous matrix capped the project at 14/limit (71b24027). A re-run
  // against the same capped project fails identically, so no retry can help;
  // sitting in INFRA_PATTERNS this made our own destroy-leak defect eligible
  // for the runner's flake auto-retry (attribution audit 2026-08-15). Quota
  // is code-owned: surface it, sweep the leak, then re-run.
  // Hetzner phrasings: `resource_limit_exceeded` (API code), and human
  // strings `<resource> limit reached` / `<resource> limit exceeded`
  // (servers, placement_group, firewall, Floating IP, ssh_key).
  {
    pattern:
      /resource_limit_exceeded|(server|placement_group|firewall|floating[ _]?ip|ssh[ _]?key|volume|network)\s+limit\s+(reached|exceeded)/i,
    reason: 'project quota exhausted (leak residue)',
  },
];

export interface ClassifyResult {
  category: FailureCategory;
  reason?: string;
}

/**
 * Classify a failure based on the error message and (optionally) exit
 * code or stderr. Returns 'unknown' when nothing matches — better to
 * surface "I don't know" than to mis-tag as 'infra' and hide a bug.
 */
export function classifyFailure(args: {
  errorMessage?: string;
  errorStack?: string;
  stderr?: string;
  stdout?: string;
}): ClassifyResult {
  const haystack = [args.errorMessage, args.errorStack, args.stderr, args.stdout]
    .filter(Boolean)
    .join('\n');

  // Check code patterns FIRST — they outrank infra. A JS exception inside
  // an HTTP response should classify as code, not as "network error".
  for (const { pattern, reason } of CODE_PATTERNS) {
    if (pattern.test(haystack)) return { category: 'unknown', reason: `code: ${reason}` };
  }

  for (const { pattern, reason } of INFRA_PATTERNS) {
    if (pattern.test(haystack)) return { category: 'infra', reason };
  }

  return { category: 'unknown' };
}

/**
 * Roll up per-step categories into a single scenario category. Worst
 * wins (regression > infra > flake > unknown) so a scenario that has
 * ONE regression and three infra fails is correctly labeled regression.
 */
export function rollUpScenarioCategory(
  stepCategories: ReadonlyArray<FailureCategory | undefined>,
): FailureCategory | undefined {
  const set = new Set(stepCategories.filter(Boolean));
  if (set.size === 0) return undefined;
  if (set.has('regression')) return 'regression';
  if (set.has('unknown')) return 'unknown';
  if (set.has('infra')) return 'infra';
  if (set.has('flake')) return 'flake';
  return undefined;
}
