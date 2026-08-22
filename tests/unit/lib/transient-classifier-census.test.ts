/**
 * Census of the transient-error-classifier family (2026-08-07).
 *
 * This repo retries around ~20 independent "is this error worth retrying?"
 * classifiers — HTTP status sets, wording regexes, inverse terminal sets —
 * and the family has now drifted twice in two days: the 2026-08-06 sweep
 * found s3-base treating HTTP 500 as fatal while classify-failure and
 * fetch-retry retried it, and the very next audit found the SAME file still
 * treating 429 as fatal while fetch-retry retried it (Ceph/Spaces rate-limit
 * under e2e load, so a fatal 429 aborts a deploy a sibling layer would have
 * absorbed). Point behavioral tests pin each member; nothing pinned the
 * FAMILY, so each fix left the next sibling open.
 *
 * THIS test is the class guard. It sweeps src/ for classifier declarations
 * (three detectors below), requires every detected site to carry a REGISTRY
 * row declaring its domain, and enforces per-domain floors:
 *
 *   http-status-set  — must retry at least {408, 429, 500, 502, 503, 504}.
 *   network-wording  — must cover BOTH a timeout wording AND a
 *                      connection-drop wording (each vocabulary below).
 *   drop-wording-only— drop wordings required; timeout handled elsewhere
 *                      (notes must say where).
 *   delegating       — routes to another registered classifier; no vocab of
 *                      its own to floor-check (notes say what it delegates to).
 *   domain-specific  — not a network classifier (lock races, stale storage);
 *                      notes must justify the exemption.
 *   inverse-terminal — lists what is NEVER retried instead of what is;
 *                      notes must justify.
 *
 * Accepted limits (mirrors shared-helper-consumers.test.ts): a classifier
 * whose identifier avoids transient/retryable vocabulary AND whose pattern
 * carries fewer than two canonical transient wordings escapes detection.
 * Known deliberate instances: WALG_STALE_STORAGE_PATTERN (stale-storage
 * wordings, walg-staleness.js) and PUSH_PERMANENT_PATTERN (auth/manifest
 * wordings, registry-push.js) — both domain-specific by construction. A new
 * escape needs a reviewer to miss all three detectors at once; the positive
 * controls at the bottom keep the detectors themselves honest.
 *
 * A sub-property worth asking about EVERY row, orthogonal to `domain`:
 * "fresh-server-shell-reachable" — does this classifier's input ever
 * include the stdout/stderr of a command that ran on a freshly-provisioned
 * server's OWN shell (SSH'd into it, or a build running natively on it), as
 * opposed to a call made from the operator's already-stable local machine
 * (fetch/SDK calls, kubectl-over-KUBECONFIG, Pulumi/docker push locally)?
 * Only rows where the answer is yes can see the DNS-not-settled wording
 * class (apk/apt/glibc/musl/Node) documented on isTransientBuildError
 * (remote-build.js) and isTransientSshCommandError (lib/ssh.js since
 * 2026-08-11; compose/index.js re-exports it) — and both widen their retry
 * ladder specifically because of it, remote-build.js inside its own loop and
 * isTransientSshCommandError at its sshRunAsync call site in
 * compose/index.js (see DNS_NOT_SETTLED_RETRY_DELAYS_MS, declared in
 * remote-build.js and shared by both). The scp ladder that also consumes this
 * classifier deliberately does NOT widen — an scp runs no remote command, so
 * container-resolver wordings cannot reach it; see scpWithRetry. A new
 * classifier that
 * IS fresh-server-shell-reachable and skips this wording will reproduce the
 * exact bug those two were fixed for; one that is NOT reachable (the other
 * ~18 rows below — operator-local HTTP/SDK/CLI calls) correctly has no
 * business adding it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/** Named declarations that self-identify as retry classifiers. */
const DECL_RE =
  /(?:const|let|var|function)\s+([A-Za-z0-9_$]*(?:transient|retryable|retriable)[A-Za-z0-9_$]*)\s*[=(]/i;

/** Inline classifier: an `isTransient:` retry option bound to a function
 *  LITERAL (a named reference delegates to a declaration the other
 *  detectors already see). */
const INLINE_RE =
  /\bisTransient\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/;

/** Canonical transient wordings; a SCREAMING_SNAKE regex constant carrying
 *  two or more of these is a transient classifier regardless of what it is
 *  named. (camelCase locals routinely quote these wordings for diagnostics —
 *  image.js's looksLikeSshBlocked operator hint — so the constant-case
 *  restriction is what separates classifiers from error prose; a camelCase
 *  VOCABULARY-bearing classifier would escape this detector, but detectors
 *  A/B cover every naming convention actually in the tree.) */
const VOCAB_PROBES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'connection reset',
  'connection refused',
  'connection timed out',
  'timed out',
  'SlowDown',
  'ServiceUnavailable',
  'broken pipe',
  'banner exchange',
  'kex_exchange',
  'socket hang up',
  'too many requests',
  'throttl',
];
const NAMED_CONST_RE = /(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*=/;
/** A line that OPENS a regex literal (not a comment, not division). */
const REGEX_OPEN_RE = /=\s*\/(?![/*])/;
const REGEX_NEXT_LINE_RE = /^\s*\/(?![/*])/;

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------

/** Every HTTP-status transient set must retry at least these. 425 (Too
 *  Early) stays optional — only generic HTTP layers see it. */
const STATUS_FLOOR = [408, 429, 500, 502, 503, 504];

const TIMEOUT_VOCAB = /ETIMEDOUT|TimeoutError|timed[ _-]?out|timedOut|timeout|deadline exceeded/i;
const DROP_VOCAB =
  /ECONNRESET|connection reset|connection refused|connection closed|broken pipe|socket hang up|hang up|\bEOF\b/i;

type Domain =
  | 'http-status-set'
  | 'network-wording'
  | 'drop-wording-only'
  | 'delegating'
  | 'domain-specific'
  | 'inverse-terminal';

interface RegistryRow {
  file: string;
  /** Declared identifier, or `isTransient@<n>` for the n-th inline literal in the file. */
  name: string;
  domain: Domain;
  /** Required for every domain without a mechanical floor. */
  notes?: string;
}

/**
 * The family. A NEW classifier must be added here — the exact-match
 * assertions below fail until it is, which is the point: registering forces
 * choosing a domain, and choosing a domain applies the floor.
 */
const REGISTRY: RegistryRow[] = [
  { file: 'src/lib/fetch-retry.js', name: 'TRANSIENT_STATUS', domain: 'http-status-set' },
  { file: 'src/lib/fetch-retry.js', name: 'isTransientNetworkError', domain: 'network-wording' },
  {
    file: 'src/lib/providers/s3-base.js',
    name: 'TRANSIENT_HTTP_STATUSES',
    domain: 'http-status-set',
  },
  {
    file: 'src/lib/providers/s3-base.js',
    name: 'TRANSIENT_S3_ERROR_RE',
    domain: 'network-wording',
  },
  {
    file: 'src/lib/providers/s3-base.js',
    name: 'isTransientS3Error',
    domain: 'delegating',
    notes:
      'Combines TRANSIENT_S3_ERROR_RE (name/message) with TRANSIENT_HTTP_STATUSES ($metadata).',
  },
  { file: 'src/lib/deploy/plan/runner.js', name: 'DEPLOY_TRANSIENT', domain: 'network-wording' },
  {
    file: 'src/lib/deploy/k8s/k3s.js',
    name: 'KUBECTL_TRANSIENT_PATTERN',
    domain: 'network-wording',
  },
  {
    file: 'src/lib/deploy/k8s/k3s.js',
    name: 'isTransient@1',
    domain: 'delegating',
    notes:
      'runKubectlWithRetry: KUBECTL_TRANSIENT_PATTERN plus the per-call transientExtra widening.',
  },
  {
    file: 'src/lib/deploy/k8s/k3s.js',
    name: 'isTransient@2',
    domain: 'delegating',
    notes:
      'kubectl rollout status retry: KUBECTL_TRANSIENT_PATTERN over kubectlErrorHaystack, on ' +
      'ROLLOUT_RETRY_DELAYS_MS. (Was described as runHelmWithWebhookRetry / ' +
      'KUBECTL_WEBHOOK_UNAVAILABLE_PATTERN until 2026-08-20 — both were deleted with the ' +
      'cert-manager warm-up ladder in 7a45cbd7, and the note outlived them. The census walks ' +
      'file+name, so a note describing a deleted function stays green: notes are load-bearing ' +
      'documentation, and this row is the proof they can rot.)',
  },
  {
    file: 'src/lib/iac/state-error.js',
    name: 'THROTTLE_PATTERN',
    domain: 'domain-specific',
    notes:
      'Server-side backpressure from the object store, for classifyStateError. Deliberately NARROWER ' +
      'than iac/index.js STATE_BACKEND_THROTTLE_PATTERN, which also matches lock wording: a held lock ' +
      'is contention we usually caused ourselves, and collapsing the two is why 38 of 40 events in run ' +
      '31898658781 printed one indistinguishable line and the class was misread as a consistency ' +
      'problem for months. Lock shapes are separate causes here. Floor-exempt: storage-layer status ' +
      'vocabulary only, no network wordings — the transport underneath is retried by the S3 layer. ' +
      'Duplicates STATE_BACKEND_THROTTLE_PATTERN by design while the nested branches are still live; ' +
      'that row goes away when they do.',
  },
  { file: 'src/lib/deploy/prompts.js', name: 'isTransient', domain: 'network-wording' },
  { file: 'src/lib/ssh.js', name: 'SSH_TRANSPORT_NEVER_STARTED_RE', domain: 'network-wording' },
  {
    // Moved here from deploy/compose/index.js on 2026-08-11: the scp ladder in
    // lib/ssh.js needs the same classification, and lib/ssh.js cannot import
    // the compose module (which imports it) without a cycle. compose/index.js
    // re-exports it, so its importers are unchanged. Its DNS-not-settled
    // sub-predicate moved with it and stays unregistered — its NAME carries no
    // transient/retryable vocabulary and it declares no regex CONSTANT, so no
    // detector sees it; it is reached only through this row's classifier.
    file: 'src/lib/ssh.js',
    name: 'isTransientSshCommandError',
    domain: 'network-wording',
  },
  {
    file: 'src/lib/deploy/remote-build.js',
    name: 'isTransientBuildError',
    domain: 'drop-wording-only',
    notes:
      'Timeout is classified at the call site via err.timedOut (execa SIGTERMs the child, which ' +
      'prints nothing — no wording ever reaches this regex).',
  },
  {
    file: 'src/lib/deploy/remote-build.js',
    name: 'transient',
    domain: 'delegating',
    notes: 'The call-site join of err.timedOut with isTransientBuildError(lastOutput).',
  },
  {
    file: 'src/lib/deploy/walg-audit.js',
    name: 'NON_RETRYABLE_CODES',
    domain: 'inverse-terminal',
    notes:
      'Lists what can NEVER clear on retry (missing creds, stale standby role) — raised ' +
      'mid-failover where pointless backoff is RTO; everything else retries by default.',
  },
  {
    file: 'src/lib/deploy/walg-audit.js',
    name: 'isTransient@1',
    domain: 'delegating',
    notes:
      'Flag-driven: retries unless the thrower stamped walgRetryable=false (NON_RETRYABLE_CODES).',
  },
  {
    file: 'src/lib/backup-s3.js',
    name: 'isTransient@1',
    domain: 'inverse-terminal',
    notes:
      'Restore download: retries everything except terminal S3 answer names (NoSuchBucket/' +
      'NoSuchKey/...), which are real answers, not blips.',
  },
  {
    file: 'src/lib/deploy/registry-push.js',
    name: 'isTransient@1',
    domain: 'delegating',
    notes: 'Negation of PUSH_PERMANENT_PATTERN (auth/manifest errors terminal; all else retries).',
  },
];

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

interface Site {
  file: string;
  line: number;
  name: string;
  window: string;
}

function findSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        findSourceFiles(join(dir, entry.name), out);
      }
    } else if (entry.name.endsWith('.js')) {
      out.push(relative(ROOT, join(dir, entry.name)));
    }
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

/** Count how many canonical wordings a declaration window carries. */
function probeHits(window: string): number {
  return VOCAB_PROBES.filter((p) => window.toLowerCase().includes(p.toLowerCase())).length;
}

function detectLine(line: string): string | null {
  const decl = DECL_RE.exec(line);
  if (decl) return decl[1];
  if (INLINE_RE.test(line)) return 'isTransient@inline';
  return null;
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of findSourceFiles(join(ROOT, 'src'))) {
    const lines = readFileSync(join(ROOT, file), 'utf-8').split('\n');
    const detections: Array<{ index: number; name: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;
      const named = detectLine(lines[i]);
      if (named) {
        detections.push({ index: i, name: named });
        continue;
      }
      // Vocabulary-bearing SCREAMING_SNAKE regex constant: reads like a
      // transient classifier even if its name does not say so.
      const constDecl = NAMED_CONST_RE.exec(lines[i]);
      if (constDecl) {
        const window = lines.slice(i, i + 5).join('\n');
        const opensRegex =
          REGEX_OPEN_RE.test(lines[i]) || REGEX_NEXT_LINE_RE.test(lines[i + 1] ?? '');
        if (opensRegex && probeHits(window) >= 2) {
          detections.push({ index: i, name: constDecl[1] });
        }
      }
    }
    let inlineCount = 0;
    for (let d = 0; d < detections.length; d++) {
      const { index } = detections[d];
      let { name } = detections[d];
      if (name === 'isTransient@inline') {
        inlineCount += 1;
        name = `isTransient@${inlineCount}`;
      }
      const end = d + 1 < detections.length ? detections[d + 1].index : index + 40;
      sites.push({
        file,
        line: index + 1,
        name,
        window: lines.slice(index, Math.min(end, index + 40)).join('\n'),
      });
    }
  }
  return sites;
}

function statusFloorViolations(window: string): number[] {
  return STATUS_FLOOR.filter((code) => !new RegExp(`\\b${code}\\b`).test(window));
}

const sites = collectSites();
const keyOf = (s: { file: string; name: string }) => `${s.file} :: ${s.name}`;

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe('transient-classifier census', () => {
  it('the detectors still see the classifier population (not vacuously green)', () => {
    // ~20 sites existed when this was written. If a refactor collapses this
    // toward zero the sweep has gone blind — fix the detectors, not the floor.
    expect(sites.length).toBeGreaterThanOrEqual(15);
  });

  it('every detected classifier carries a REGISTRY row (and none is stale)', () => {
    const detected = new Set(sites.map(keyOf));
    const registered = new Set(REGISTRY.map(keyOf));
    const unregistered = sites.filter((s) => !registered.has(keyOf(s)));
    const stale = REGISTRY.filter((r) => !detected.has(keyOf(r)));
    expect(
      unregistered.map((s) => `${s.file}:${s.line}  ${s.name}`),
      'New transient classifier(s) detected. Add a REGISTRY row with a domain — and before ' +
        'writing a NEW classifier, check whether an existing registered one (fetch-retry, ' +
        's3-base, DEPLOY_TRANSIENT, KUBECTL_TRANSIENT_PATTERN...) already covers the call site.',
    ).toEqual([]);
    expect(
      stale.map(keyOf),
      'These REGISTRY rows no longer match a detected classifier — renamed, moved, or deleted. ' +
        'Update the row so the table stays an honest inventory.',
    ).toEqual([]);
  });

  it('every http-status-set retries the shared floor (408/429/500/502/503/504)', () => {
    const rows = REGISTRY.filter((r) => r.domain === 'http-status-set');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      const site = sites.find((s) => keyOf(s) === keyOf(row));
      expect(site, `registered http-status-set not detected: ${keyOf(row)}`).toBeDefined();
      expect(
        statusFloorViolations(site!.window),
        `${keyOf(row)} treats these statuses as fatal while sibling classifiers retry them ` +
          '(the exact drift that shipped 500-as-fatal and then 429-as-fatal in s3-base):',
      ).toEqual([]);
    }
  });

  it('every network-wording classifier covers BOTH timeout and connection-drop wordings', () => {
    const rows = REGISTRY.filter((r) => r.domain === 'network-wording');
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const violations: string[] = [];
    for (const row of rows) {
      const site = sites.find((s) => keyOf(s) === keyOf(row));
      expect(
        site,
        `registered network-wording classifier not detected: ${keyOf(row)}`,
      ).toBeDefined();
      if (!TIMEOUT_VOCAB.test(site!.window)) violations.push(`${keyOf(row)} — no timeout wording`);
      if (!DROP_VOCAB.test(site!.window))
        violations.push(`${keyOf(row)} — no connection-drop wording`);
    }
    expect(
      violations,
      'A network classifier missing half the vocabulary retries timeouts but dies on resets ' +
        '(or vice versa). Either add the wording or reclassify the row with a reasoned domain.',
    ).toEqual([]);
  });

  it('drop-wording-only classifiers cover the drop vocabulary', () => {
    for (const row of REGISTRY.filter((r) => r.domain === 'drop-wording-only')) {
      const site = sites.find((s) => keyOf(s) === keyOf(row));
      expect(site, `not detected: ${keyOf(row)}`).toBeDefined();
      expect(DROP_VOCAB.test(site!.window), `${keyOf(row)} — no connection-drop wording`).toBe(
        true,
      );
    }
  });

  it('every floor-exempt row documents why (notes are load-bearing, not decoration)', () => {
    const exemptDomains: Domain[] = [
      'drop-wording-only',
      'delegating',
      'domain-specific',
      'inverse-terminal',
    ];
    for (const row of REGISTRY.filter((r) => exemptDomains.includes(r.domain))) {
      expect(
        row.notes && row.notes.length >= 20,
        `${keyOf(row)} is exempt from vocabulary floors — its notes must say why.`,
      ).toBe(true);
    }
  });
});

describe('detector sanity (not vacuously permissive)', () => {
  it('DECL_RE flags transient/retryable-named declarations in any casing', () => {
    expect(detectLine('const FOO_TRANSIENT_STATUSES = new Set([500]);')).toBe(
      'FOO_TRANSIENT_STATUSES',
    );
    expect(detectLine('export function isRetryableThing(e) {')).toBe('isRetryableThing');
    expect(detectLine('const isTransient =')).toBe('isTransient');
  });

  it('INLINE_RE flags inline function literals but NOT named references', () => {
    expect(detectLine('      isTransient: (err) => /blip/.test(err.message),')).toBe(
      'isTransient@inline',
    );
    expect(detectLine('      isTransient: async (err) => classify(err),')).toBe(
      'isTransient@inline',
    );
    // A named reference delegates to a declaration the other detectors see.
    expect(detectLine('      isTransient: isNeverStartedSshTransportFailure,')).toBeNull();
  });

  it('the status floor catches both historical drift shapes', () => {
    // 2026-08-06: 500 missing. 2026-08-07: 429 (and 408) missing.
    expect(statusFloorViolations('new Set([502, 503, 504])')).toEqual([408, 429, 500]);
    expect(statusFloorViolations('new Set([500, 502, 503, 504])')).toEqual([408, 429]);
    expect(statusFloorViolations('new Set([408, 425, 429, 500, 502, 503, 504])')).toEqual([]);
  });

  it('the wording floor catches the DEPLOY_TRANSIENT drift shape', () => {
    // The original DEPLOY_TRANSIENT source: timeout wording present, no drop wording.
    const original =
      '/SlowDown|ServiceUnavailable|\\b503\\b|network is unreachable|banner exchange|timed out/i';
    expect(TIMEOUT_VOCAB.test(original)).toBe(true);
    expect(DROP_VOCAB.test(original)).toBe(false);
  });
});
