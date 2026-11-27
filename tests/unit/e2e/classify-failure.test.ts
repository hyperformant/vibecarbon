/**
 * Unit tests for the e2e failure classifier. The classifier is the
 * load-bearing piece behind the run summary's category column — it decides
 * whether a 0/4 morning is "infra is having a bad day" or "we shipped bugs".
 */

import { describe, expect, it } from 'vitest';
import { standbyDbRebuildHint } from '../../../src/lib/deploy/db-workload.js';
import { summarizeDbPods, summarizeNotReadyNodes } from '../../../src/lib/deploy/k8s/k3s.js';
import { awaitDbPodReady } from '../../../src/lib/deploy/k8s/readiness.js';
import { readRepoFile } from '../../_shared/source-files.js';
import { DB_POD_UID, FAILED_ATTACH_MESSAGE } from '../../_shared/vultr-failed-attach-event.js';
import {
  CODE_PATTERNS,
  classifiableTail,
  classifyFailure,
  rollUpScenarioCategory,
} from '../../e2e/utils/classify-failure.js';

describe('classifyFailure', () => {
  it('flags k3s readiness timeout as infra', () => {
    const result = classifyFailure({
      errorMessage: 'k3s did not become ready on 5.6.7.8 within 600s',
    });
    expect(result.category).toBe('infra');
    expect(result.reason).toMatch(/k3s install timeout/i);
  });

  it('flags spinner-truncated k3s timeout as infra', () => {
    // 2026-04-27 morning matrix — when the deploy CLI throws, cli-runner
    // captures stderr that ends with the spinner text ("Waiting for k3s
    // on master ... Canceled") rather than the actual throw message.
    // The classifier should still tag this correctly.
    const result = classifyFailure({
      errorMessage:
        'Deploy exited with code 1: ◐ Waiting for k3s on master (cloud-init + Ready)... Canceled',
    });
    expect(result.category).toBe('infra');
  });

  it('flags Hetzner resource_unavailable as infra', () => {
    const result = classifyFailure({
      errorMessage: 'Hetzner API error: error during placement (resource_unavailable)',
    });
    expect(result.category).toBe('infra');
    expect(result.reason).toMatch(/Hetzner capacity/);
  });

  it('flags Hetzner project quota (server limit reached) as code-owned, NOT retryable infra', () => {
    // Attribution audit 2026-08-15: the only observed trigger for a quota cap
    // in e2e is residue from OUR prior runs — 2026-04-27, 6 leaked servers
    // from a previous matrix capped the project at 14/limit (71b24027). A
    // scenario re-run against the same capped project fails identically, so
    // flake-retry can never help; classifying quota as 'infra' made our own
    // destroy-leak defect eligible for auto-retry, which masks it. Quota now
    // classifies as code-owned so it surfaces for cleanup instead.
    const result = classifyFailure({
      errorMessage: 'Hetzner API error: server limit reached (resource_limit_exceeded)',
    });
    expect(result.category).toBe('unknown');
    expect(result.reason).toBe('code: project quota exhausted (leak residue)');
  });

  it('flags DigitalOcean API 5xx (incl. the 524 gateway-timeout shape) as infra', () => {
    // Live evidence 2026-08-08: DO platform incident ("Droplets, Reserved
    // IPs, ... across multiple regions") surfaced as `POST
    // https://api.digitalocean.com/v2/droplets: 524 <!DOCTYPE html>` in the
    // Pulumi droplet create — categorized [unknown] at the time.
    const result = classifyFailure({
      errorMessage:
        'Error creating droplet: POST https://api.digitalocean.com/v2/droplets: 524 <!DOCTYPE html>',
    });
    expect(result.category).toBe('infra');
    expect(result.reason).toMatch(/DigitalOcean API/i);
  });

  it('flags the TF-bridge nil-state create error as infra', () => {
    // Live evidence 2026-08-09 (same DO incident, aftershock): the Reserved
    // IP create returned a nil/empty state and pulumi-digitalocean wrapped
    // it as this wording — the same call had succeeded 35 minutes earlier
    // in the same scenario. The wording is TF-bridge-generic, so it covers
    // every bridged provider, not just DO.
    const result = classifyFailure({
      errorMessage:
        'expected non-nil error with nil state during Create of urn:pulumi:d3::vibecarbon::digitalocean:index/reservedIp:ReservedIp::ingress',
    });
    expect(result.category).toBe('infra');
    expect(result.reason).toMatch(/nil-state/i);
  });

  it('flags Pulumi state-backend AccessDenied (Hetzner OS auth lag) as infra', () => {
    // Live evidence 2026-08-09 (round A, e4): the state bucket answered
    // AccessDenied to pre-init, both upStacks, and the pre-destroy refresh
    // for a ≥6-minute window — then the SAME credentials listed and deleted
    // the bucket fine minutes later in the sweep. Documented Hetzner OS
    // LIST-auth-lag family, new site: mid-life lockout (bucket had worked
    // for hours), hel1, under Hetzner's standing "high Object Storage
    // traffic may lead to timeouts" advisory.
    const result = classifyFailure({
      errorMessage:
        'HA deploy failed — primary: error: could not list bucket: blob (code=Unknown): AccessDenied:',
    });
    expect(result.category).toBe('infra');
    expect(result.reason).toMatch(/S3 auth/i);
  });

  it('flags placement_group quota as code-owned (leak residue)', () => {
    expect(classifyFailure({ errorMessage: 'placement_group limit reached' }).category).toBe(
      'unknown',
    );
  });

  it('flags Floating IP quota as code-owned (leak residue)', () => {
    expect(classifyFailure({ errorMessage: 'Floating IP limit exceeded' }).category).toBe(
      'unknown',
    );
    // Underscore variant from API JSON.
    expect(classifyFailure({ errorMessage: 'floating_ip limit reached' }).category).toBe('unknown');
  });

  it('flags firewall quota as code-owned (leak residue)', () => {
    expect(classifyFailure({ errorMessage: 'firewall limit reached' }).category).toBe('unknown');
  });

  it('still flags capacity exhaustion (resource_unavailable) as infra — a different class', () => {
    // Capacity is PROVEN provider-side (2026-04-28: hel1 out of cx23 for ~4h,
    // b118f4b0); quota is our residue. The reclassification of quota must not
    // drag the capacity row with it.
    expect(
      classifyFailure({ errorMessage: 'error during placement (resource_unavailable)' }).category,
    ).toBe('infra');
  });

  it('flags Hetzner 5xx as infra', () => {
    const result = classifyFailure({
      errorMessage: 'GET https://api.hetzner.cloud/v1/servers returned HTTP/2 503',
    });
    expect(result.category).toBe('infra');
  });

  it('flags a db-rollout pod stuck on a NotReady NODE as infra — host died', () => {
    // RCA 2026-09-01 (PG17 cert, k8s-ha standby): worker went dark
    // mid-deploy (kubelet 502, SSH timeout, provider API "running"), db
    // pod froze in Init, run hard-failed [unknown]. Both clauses required.
    const withNode = classifyFailure({
      errorMessage:
        'HA deploy failed — standby: awaitDbRollout: statefulset/db did not become Ready within 900s ... ' +
        'The db pod never became Ready: db-0 (Pending). ' +
        'Node(s) NotReady: testapp-e4-standby-db (Ready=Unknown) — the pod may be stuck ' +
        'because its HOST died or lost its kubelet, not because of the workload.',
    });
    expect(withNode.category).toBe('infra');
    expect(withNode.reason).toMatch(/node NotReady/i);
    // A stuck pod on HEALTHY nodes stays unknown — that is our bug until
    // proven otherwise.
    expect(
      classifyFailure({
        errorMessage: 'The db pod never became Ready: db-0 (Pending).',
      }).category,
    ).toBe('unknown');
  });

  it('classifies a verification failure THROUGH its carried detail lines (storage staleness)', () => {
    // The verification throw now carries bounded [fail] detail lines (run
    // 33435737752: the bare "N verification(s) failed: <names>" hid the
    // NoSuchBucket spelling from this very classifier).
    const result = classifyFailure({
      errorMessage:
        '1 verification(s) failed: file_upload_roundtrip\n' +
        '[fail] file_upload_roundtrip: upload: PUT to the presigned URL returned 404: ' +
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code></Error>',
    });
    expect(result.category).toBe('infra');
    expect(result.reason).toBe('S3 transient');
  });

  it("flags Let's Encrypt rate limit as infra", () => {
    const result = classifyFailure({
      errorMessage: '429 urn:ietf:params:acme:error:rateLimited: too many certificates',
    });
    expect(result.category).toBe('infra');
  });

  it('does NOT flag Traefik rate-limit middleware resource name as rate-limit infra', () => {
    // False-positive observed 2026-04-27 morning matrix: the bare
    // /rate-limit/ regex matched `middleware.traefik.io/rate-limit created`
    // in normal deploy output and mis-classified the scenario as 'infra'.
    // Tightened regex requires error context (exceeded / 429 too many / rateLimited).
    const result = classifyFailure({
      stdout: 'middleware.traefik.io/rate-limit created',
    });
    expect(result.category).toBe('unknown');
  });

  it('flags "rate limit exceeded" as infra (the words ARE error context)', () => {
    expect(classifyFailure({ errorMessage: 'API rate limit exceeded' }).category).toBe('infra');
  });

  it("flags Hetzner's underscore API-code form rate_limit_exceeded as infra (2026-08-07 sweep)", () => {
    // The API returns the code verbatim; the old `\s+` before the verb meant
    // this classified as `unknown` and the runner's infra-only flake retry
    // could never fire on a Hetzner 429.
    expect(classifyFailure({ errorMessage: 'API error: rate_limit_exceeded (429)' }).category).toBe(
      'infra',
    );
  });

  it("still does NOT flag Traefik's rate-limit middleware resource name (2026-04-27 false positive)", () => {
    expect(
      classifyFailure({ errorMessage: 'middleware.traefik.io/rate-limit created' }).category,
    ).toBe('unknown');
  });

  it('flags fetch failed as infra', () => {
    expect(classifyFailure({ errorMessage: 'fetch failed' }).category).toBe('infra');
    expect(classifyFailure({ stderr: 'connect ETIMEDOUT 1.2.3.4:443' }).category).toBe('infra');
  });

  it('flags TRAEFIK DEFAULT CERT as infra (LE pending)', () => {
    const result = classifyFailure({
      errorMessage: 'public health probe failed; cert is TRAEFIK DEFAULT CERT',
    });
    expect(result.category).toBe('infra');
  });

  it('does NOT flag a watchdog-confirmed terminal ACME failure as retryable infra', () => {
    // Verbatim shape of the deploy's fail-fast message, built from the
    // 2026-08-11 e3 restore failure. It contains `order ... state "errored"`,
    // which the "LE cert pending" infra pattern matches — so without the
    // code-pattern override this would be auto-retried as a flake even though
    // the watchdog already proved it is not transient.
    const result = classifyFailure({
      errorMessage:
        'Public health probe failed: cert-manager issuance for vibecarbon/vibecarbon-tls is ' +
        'terminally failed after 2 recovery attempts (order vibecarbon-tls-1-3540367894, state ' +
        '"errored"): Failed to finalize Order: 403 urn:ietf:params:acme:error:orderNotReady: ' +
        'Error finalizing order :: Order was already processing.',
    });
    expect(result.category).not.toBe('infra');
    expect(result.reason).toContain('ACME issuance terminally failed');
  });

  it('still flags a plain errored order as infra (issuance genuinely pending)', () => {
    expect(classifyFailure({ errorMessage: 'order is in "errored" state' }).category).toBe('infra');
  });

  /**
   * Census: every CODE pattern must survive contact with an INFRA pattern.
   * `classifyFailure` walks CODE_PATTERNS before INFRA_PATTERNS, and the only
   * thing keeping that true is the order of two loops. A code signal that
   * silently classified as infra would be auto-retried as a flake — which is
   * exactly how the terminal-ACME case would have stayed invisible.
   *
   * Each sample pairs one code marker with `fetch failed`, the broadest infra
   * pattern in the table. Add a row here whenever CODE_PATTERNS grows.
   */
  const CODE_SAMPLES: Array<[string, string]> = [
    ['JS exception', 'TypeError: x is not iterable'],
    ['missing module', "Cannot find module './nope.js'"],
    ['JS exception', 'undefined is not a function'],
    ['SQL constraint violation', 'UNIQUE constraint failed: orgs.slug'],
    ['ACME issuance terminally failed', 'terminally failed after 2 recovery attempts'],
    ['project quota exhausted (leak residue)', 'server limit reached (resource_limit_exceeded)'],
  ];

  it.each(CODE_SAMPLES)('code beats infra: %s', (reason, sample) => {
    const result = classifyFailure({ errorMessage: `${sample} — fetch failed` });
    expect(result.category).not.toBe('infra');
    expect(result.reason).toBe(`code: ${reason}`);
  });

  it('the census covers every CODE pattern — a new row without a sample fails here', () => {
    // Drives off the real export, so a 7th pattern added upstream cannot slip
    // in uncensused. Both directions matter: a pattern with no sample is
    // untested precedence, and a sample matching no pattern is dead weight
    // that would survive the pattern being deleted.
    expect(CODE_SAMPLES).toHaveLength(CODE_PATTERNS.length);
    for (const { pattern, reason } of CODE_PATTERNS) {
      expect(
        CODE_SAMPLES.some(([, sample]) => pattern.test(sample)),
        `no census sample matches CODE pattern ${pattern} (${reason})`,
      ).toBe(true);
    }
    for (const [reason, sample] of CODE_SAMPLES) {
      expect(
        CODE_PATTERNS.some((p) => p.pattern.test(sample) && p.reason === reason),
        `census sample "${sample}" matches no CODE pattern with reason "${reason}"`,
      ).toBe(true);
    }
  });

  it('the bare infra half of each sample really does classify as infra', () => {
    // Control: proves the samples above are genuinely contested, not just
    // strings no infra pattern would have claimed anyway.
    expect(classifyFailure({ errorMessage: 'fetch failed' }).category).toBe('infra');
  });

  it('returns unknown when nothing matches', () => {
    const result = classifyFailure({
      errorMessage: 'Step canceled after 1475s during sideload',
    });
    expect(result.category).toBe('unknown');
  });

  it('code patterns win over infra patterns (JS exception in HTTP response)', () => {
    // Imagine an error that contains both "fetch failed" AND a TypeError.
    // We want to surface the code bug, not hide it as "infra network noise".
    const result = classifyFailure({
      errorMessage: "TypeError: Cannot read properties of undefined (reading 'foo')",
      stderr: 'fetch failed',
    });
    expect(result.category).toBe('unknown');
    expect(result.reason).toMatch(/code:/);
  });

  it('flags missing module as code, not infra', () => {
    const result = classifyFailure({
      errorMessage: "Cannot find module '../foo.js'",
    });
    expect(result.category).toBe('unknown');
    expect(result.reason).toMatch(/code:/);
  });
});

describe('5xx patterns require a real status code, not any three digits', () => {
  // Regression pins for the 2026-08-20 s2 misclassification: a PERMANENT
  // Pulumi backend-URL error read as `[infra: S3 transient]` because the
  // bare `S3.*5\d\d` pattern found `586` inside the bucket's random
  // stateBucketGeneration hex (`vc-e2e-state-local-6586f2`). Auto-retry of
  // a deterministic failure hinged on the dice roll that named the bucket.
  const backendUrlError =
    'error: unable to open bucket s3://vc-e2e-state-local-6586f2' +
    '?endpoint=s3.fr-par.scw.cloud&region=fr-par&s3ForcePathStyle=true' +
    '&request_checksum_calculation=when_supported: ' +
    'unknown query parameter "request_checksum_calculation"';

  it('a bucket name containing a 5xx-looking digit run is NOT S3 transient', () => {
    const result = classifyFailure({ errorMessage: backendUrlError });
    expect(result.reason ?? '').not.toMatch(/S3 transient/i);
  });

  it('and therefore is not auto-retryable infra', () => {
    // `unknown` is the deliberate home for a failure we have not positively
    // identified as somebody else's outage — the runner does not retry it.
    expect(classifyFailure({ errorMessage: backendUrlError }).category).not.toBe('infra');
  });

  it('still classifies a genuine S3 5xx as transient', () => {
    // The non-vacuity half: tightening must not blind the rule.
    for (const msg of [
      'operation error S3: PutObject, StatusCode: 503, RequestID: abc123',
      'S3 request failed with status 500',
      'RequestTimeout',
      'SlowDown',
    ]) {
      expect(classifyFailure({ errorMessage: msg }).reason, msg).toMatch(/S3 transient/i);
    }
  });

  it('classifies object-storage staleness 404s as S3 transient (2026-08-30 backup RCA)', () => {
    // Run 33287840597, hetzner compose backup: a stale storage frontend
    // answered NoSuchBucket for a bucket the same run had written minutes
    // earlier, and wal-g's own rendering of the same 404 wedged retention.
    // Both are the documented pulumi-state-backend-consistency weather (see
    // src/lib/deploy/walg-staleness.js) — retryable, and with the orphan
    // sweep (walg-retention-orphan-sweep.test.ts) a retry can now succeed.
    for (const msg of [
      "failed to upload 'backups/x/walg/basebackups_005/base_1/files_metadata.json' to bucket 'x-backups': NoSuchBucket: ",
      "ERROR: 2026/08/30 02:36:25.545992 object 'base_000000020000000000000014_backup_stop_sentinel.json' not found in storage",
    ]) {
      const result = classifyFailure({ errorMessage: msg });
      expect(result.reason, msg).toMatch(/S3 transient/i);
      expect(result.category, msg).toBe('infra');
    }
  });

  it('the Docker Hub rule is bounded the same way', () => {
    expect(
      classifyFailure({
        errorMessage: 'pulling registry-1.docker.io/library/postgres@sha256:5991abc',
      }).reason ?? '',
    ).not.toMatch(/Docker Hub transient/i);
    expect(
      classifyFailure({
        errorMessage: 'registry-1.docker.io returned 503 Service Unavailable',
      }).reason,
    ).toMatch(/Docker Hub transient/i);
  });
});

describe("the db pod's last-warning clause never decides a classification", () => {
  // The clause is built by the product's own summarizeDbPods, so a change to
  // its shape that the classifier's mask no longer covers fails here.
  const PODS = `db-0   Pending   <none>   ${DB_POD_UID}\n`;
  const PREFIX =
    'awaitDbRollout: statefulset/db did not become Ready within 900s ' +
    '(Command failed: kubectl -n vibecarbon rollout status statefulset/db --timeout=900s). ';
  const DEAD_NODE = summarizeNotReadyNodes('master True\nproj-db Unknown');
  const withWarning = (reason: string, message: string) =>
    summarizeDbPods(PODS, new Map([['db-0', { reason, message }]]));
  // Each failure classifies as the same failure did before the clause existed.
  const expectInert = (summary: string) => {
    const plain = summarizeDbPods(PODS);
    expect(summary).not.toBe(plain);
    for (const tail of ['', DEAD_NODE]) {
      const msg = `${PREFIX}${summary}${tail}`;
      const before = classifyFailure({ errorMessage: `${PREFIX}${plain}${tail}` });
      expect(classifyFailure({ errorMessage: msg }), msg).toEqual(before);
      expect(classifyFailure({ errorMessage: msg, errorStack: `Error: ${msg}\n    at x` })).toEqual(
        before,
      );
    }
  };

  it('the FailedAttachVolume clause of perf run 45940611622 classifies as the message without it', () => {
    const summary = withWarning('FailedAttachVolume', FAILED_ATTACH_MESSAGE);
    expect(summary).toContain(`last warning FailedAttachVolume: ${FAILED_ATTACH_MESSAGE})`);
    expectInert(summary);
    // Spelled out: a stuck pod on healthy nodes stays ours, a dead node infra.
    expect(classifyFailure({ errorMessage: `${PREFIX}${summary}` })).toEqual({
      category: 'unknown',
    });
    expect(classifyFailure({ errorMessage: `${PREFIX}${summary}${DEAD_NODE}` })).toEqual({
      category: 'infra',
      reason: 'k8s node NotReady (host died)',
    });
  });

  it('cluster words a rule would match stay inert, at any length', () => {
    for (const [reason, message] of [
      ['FailedCreatePodSandBox', 'failed to pull image: net/http: TLS handshake timeout'],
      ['FailedMount', 'dial tcp 10.0.0.2:443: connect: ETIMEDOUT (fetch failed)'],
      ['FailedAttachVolume', 'storage API answered HTTP/1.1 503 InternalError: SlowDown'],
      ['BackOff', 'TypeError: undefined is not a function'],
      ['NodeNotReady', 'never became Ready. Node(s) NotReady: forged (Ready=False)'],
      ['FailedAttachVolume', `${FAILED_ATTACH_MESSAGE} ${'z'.repeat(400)}`],
      ['R'.repeat(200), `rate limit exceeded ${'z'.repeat(700)}`],
    ]) {
      expectInert(withWarning(reason, message));
    }
  });

  it("the step's tail cut drops the clause before it drops our words (k8s-ha standby)", () => {
    // The detail a failed `deploy -restore` step throws (extractDeployFailureDetail:
    // the Error: line, then the failed perf marker) for a standby whose db
    // node died: the db pod stuck Pending on its node selector.
    const detail = (summary: string) =>
      'Error: HA deploy failed — standby: awaitDbRollout: statefulset/db did not become ' +
      'Ready within 900s (awaitDbRollout: rollout status statefulset/db failed with exit 1: ' +
      `error: timed out waiting for the condition). ${summary}${DEAD_NODE} ` +
      `${standbyDbRebuildHint('prod')} | [perf] deploy.k3s-ha.standby.awaitDb 900123ms (failed)`;
    const thrown = (text: string) => `deploy -restore latest exited with code 1: ${text}`;
    const today = detail(summarizeDbPods(PODS));
    expect(today.length).toBeLessThanOrEqual(1000);
    const before = classifyFailure({ errorMessage: thrown(today) });
    expect(before).toEqual({ category: 'infra', reason: 'k8s node NotReady (host died)' });
    for (const [reason, message] of [
      ['FailedAttachVolume', FAILED_ATTACH_MESSAGE],
      // The scheduler's word for a pod whose only eligible node is unreachable.
      [
        'FailedScheduling',
        '0/3 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, ' +
          "2 node(s) didn't match Pod's node affinity/selector. preemption: 0/3 nodes are available: " +
          '3 Preemption is not helpful for scheduling.',
      ],
    ]) {
      const now = detail(withWarning(reason, message));
      expect(now.length).toBeGreaterThan(1000);
      // A plain tail cut would lose "never became Ready", and the node rule with it.
      expect(now.slice(-1000)).not.toContain('never became Ready');
      expect(classifyFailure({ errorMessage: thrown(classifiableTail(now, 1000)) })).toEqual(
        before,
      );
      expect(classifiableTail(now, 1000)).toBe(today);
    }
    // Within budget nothing is cut, and the warning stays for the reader.
    const short = withWarning('FailedAttachVolume', FAILED_ATTACH_MESSAGE);
    expect(classifiableTail(short, 1000)).toBe(short);
  });

  it('every failed deploy step cuts its output with classifiableTail', () => {
    // A deploy is the one command whose output can carry the clause
    // (awaitDbRollout); each step that runs one throws `<step> exited with
    // code N: <tail of its output>`.
    const src = readRepoFile('tests/e2e/scenarios/_run-lifecycle.ts');
    const tails = [
      ...src.matchAll(/`([^`]*[Dd]eploy[^`]*) exited with code \$\{[^}]+\}: \$\{([^}]+)\}/g),
    ];
    expect(tails.map((m) => m[1]).sort()).toEqual([
      'Deploy',
      'Re-deploy before restore',
      'Reconverge deploy',
      'Warm deploy',
      'Warm redeploy (with change)',
      'deploy -restore latest',
    ]);
    for (const [, step, tail] of tails) expect(tail, step).toMatch(/^classifiableTail\(/);
  });
});

describe("the skipped apply's last-warning clause never decides a classification", () => {
  // The message is awaitDbPodReady's own, from its exec seam: the db pod not
  // Ready, then (when given) one Warning event on it.
  const skippedApplyFailure = async (warning?: { reason: string; message: string }) => {
    let t = 0;
    const err = await awaitDbPodReady({
      env: {},
      budgetMs: 3_000,
      sleep: async () => {
        t += 1_000;
      },
      nowFn: () => t,
      exec: async (argv: string[]) =>
        argv.includes('events')
          ? JSON.stringify({
              items: warning
                ? [
                    {
                      type: 'Warning',
                      involvedObject: { kind: 'Pod', name: 'db-0', uid: DB_POD_UID },
                      lastTimestamp: '2026-11-27T05:13:47Z',
                      ...warning,
                    },
                  ]
                : [],
            })
          : JSON.stringify({
              metadata: { name: 'db-0', uid: DB_POD_UID },
              status: {
                conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
              },
            }),
    }).catch((e: Error) => e);
    return String((err as Error).message);
  };
  // As a failed deploy step throws it (extractDeployFailureDetail: the Error:
  // line, then the failed perf marker).
  const step = (msg: string) =>
    `Deploy exited with code 1: Error: ${msg} | [perf] deploy.k3s.full 190000ms (failed)`;

  it('the FailedAttachVolume clause, and words a rule would match, classify as the message without them', async () => {
    const today = await skippedApplyFailure();
    expect(today).toMatch(/db-0 is not Ready \(ContainersNotReady\)$/);
    const before = classifyFailure({ errorMessage: step(today) });
    expect(before).toEqual({ category: 'unknown' });
    for (const warning of [
      { reason: 'FailedAttachVolume', message: FAILED_ATTACH_MESSAGE },
      { reason: 'FailedCreatePodSandBox', message: 'net/http: TLS handshake timeout' },
      { reason: 'FailedMount', message: 'dial tcp 10.0.0.2:443: connect: ETIMEDOUT' },
      { reason: 'BackOff', message: 'TypeError: undefined is not a function' },
      { reason: 'R'.repeat(200), message: `rate limit exceeded ${'z'.repeat(700)}` },
    ]) {
      const now = await skippedApplyFailure(warning);
      expect(now).toContain('; last warning ');
      expect(classifyFailure({ errorMessage: step(now) }), now).toEqual(before);
      expect(classifyFailure({ errorMessage: now, errorStack: `Error: ${now}\n    at x` })).toEqual(
        classifyFailure({ errorMessage: today, errorStack: `Error: ${today}\n    at x` }),
      );
    }
  });

  it("the step's tail cut leaves the words it left before (a k8s-ha deploy, both clusters failed)", async () => {
    // The standby's skipped apply gave up behind a primary whose db rollout
    // failed on a dead node: the node clause is near the front, and a tail cut
    // that kept the warning would push it out.
    const primary =
      'awaitDbRollout: statefulset/db did not become Ready within 900s (timed out). ' +
      `${summarizeDbPods(`db-0 Pending <none> ${DB_POD_UID}`)}` +
      `${summarizeNotReadyNodes('master True\nproj-db Unknown')} ${standbyDbRebuildHint('prod')}`;
    const detail = (standby: string) =>
      `Error: HA deploy failed — primary: ${primary} | standby: ${standby} | [perf] deploy (failed)`;
    const today = detail(await skippedApplyFailure());
    const now = detail(
      await skippedApplyFailure({ reason: 'FailedAttachVolume', message: FAILED_ATTACH_MESSAGE }),
    );
    expect(today.length).toBeLessThanOrEqual(1000);
    expect(now.length).toBeGreaterThan(1000);
    expect(classifyFailure({ errorMessage: today })).toEqual({
      category: 'infra',
      reason: 'k8s node NotReady (host died)',
    });
    // A plain tail cut would lose the primary's "never became Ready".
    expect(classifyFailure({ errorMessage: now.slice(-1000) }).category).toBe('unknown');
    expect(classifiableTail(now, 1000)).toBe(classifiableTail(today, 1000));
    expect(
      classifyFailure({
        errorMessage: `Deploy exited with code 1: ${classifiableTail(now, 1000)}`,
      }),
    ).toEqual(
      classifyFailure({
        errorMessage: `Deploy exited with code 1: ${classifiableTail(today, 1000)}`,
      }),
    );
    // Within budget the warning stays for the reader.
    const alone = step(
      await skippedApplyFailure({ reason: 'FailedAttachVolume', message: FAILED_ATTACH_MESSAGE }),
    );
    expect(classifiableTail(alone, 1000)).toBe(alone);
  });
});

describe('rollUpScenarioCategory', () => {
  it('returns undefined when all steps passed', () => {
    expect(rollUpScenarioCategory([undefined, undefined, undefined])).toBeUndefined();
  });

  it('regression beats everything else', () => {
    expect(rollUpScenarioCategory(['regression', 'infra', 'flake'])).toBe('regression');
    expect(rollUpScenarioCategory(['infra', 'regression'])).toBe('regression');
  });

  it("unknown beats infra (we don't know what it is — investigate)", () => {
    expect(rollUpScenarioCategory(['infra', 'unknown'])).toBe('unknown');
  });

  it('infra beats flake', () => {
    expect(rollUpScenarioCategory(['flake', 'infra'])).toBe('infra');
  });

  it('flake alone returns flake', () => {
    expect(rollUpScenarioCategory(['flake', undefined, undefined])).toBe('flake');
  });

  it('skips undefined entries', () => {
    expect(rollUpScenarioCategory([undefined, 'infra', undefined])).toBe('infra');
  });
});
