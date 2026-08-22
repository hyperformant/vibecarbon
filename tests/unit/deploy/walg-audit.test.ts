/**
 * Deploy-time wal-g audit — unit coverage with the exec seam mocked.
 *
 * The gap this closes: `carbon/db/Dockerfile`'s `wal-g --version` proves the
 * BINARY runs, and deploy asserts `archive_mode=on`, but nothing proved wal-g
 * could reach the configured bucket from the deployed container. Wrong
 * credentials / a missing bucket / blocked egress shipped a green deploy with
 * ZERO recoverable backups three times over.
 *
 * The cases that matter most here are the two ways this check could be worse
 * than useless: false-failing a brand-new environment that legitimately has no
 * backups and no archived WAL yet, and false-passing a genuinely broken one.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.useFakeTimers() does not fake `node:timers/promises` (sinon limitation),
// so route runWithRetry's sleep through the faked global setTimeout — mirrors
// tests/unit/lib/retry.test.ts. Without it the 5s/15s audit backoff would run
// as real wall-clock delay on every failure test.
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms?: number, value?: unknown) =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms)),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

const {
  assertWalgBackupsWorking,
  composeWalgAuditShell,
  countWalgBackups,
  evaluateWalgAudit,
  buildWalgAuditProbe,
  k8sWalgAuditArgv,
  parseWalgAuditOutput,
  WALG_ARCHIVER_SQL,
  WALG_AUDIT_PROBE,
  WALG_AUDIT_RETRY_DELAYS_MS,
  walgAuditFailureMessage,
} = await import('../../../src/lib/deploy/walg-audit.js');

const k3s = await import('../../../src/lib/deploy/k8s/k3s.js');
const compose = await import('../../../src/lib/deploy/compose/index.js');

/** Drive a promise to settlement while advancing the faked clock. */
async function settled<T>(p: Promise<T>) {
  let done = false;
  const r = p.then(
    (v) => {
      done = true;
      return { ok: true as const, v };
    },
    (e: Error) => {
      done = true;
      return { ok: false as const, e };
    },
  );
  while (!done) await vi.advanceTimersByTimeAsync(1000);
  return r;
}

/** Build probe stdout the way the in-container script emits it. */
function probeOutput({
  rc = 0,
  list = '[]',
  archiver = '0|0|||||f',
  prefix = 's3://bkt/backups/proj/walg',
}: {
  rc?: number;
  list?: string;
  archiver?: string;
  prefix?: string;
} = {}): string {
  return [
    'WALG_AUDIT=probed',
    `WALG_AUDIT_PREFIX=${prefix}`,
    `WALG_AUDIT_RC=${rc}`,
    `WALG_AUDIT_ARCHIVER=${archiver}`,
    'WALG_AUDIT_LIST_BEGIN',
    list,
    'WALG_AUDIT_LIST_END',
  ].join('\n');
}

const ONE_BACKUP =
  '[{"backup_name":"base_000000010000000000000004","time":"2026-07-30T10:00:00Z"}]';

describe('WALG_AUDIT_PROBE (the in-container script)', () => {
  it("contains no single quote — it ships inside a bash -c '...' word", () => {
    // The compose path wraps this whole script in ONE single-quoted word that
    // the remote shell parses; a stray ' would split the command mid-script.
    expect(WALG_AUDIT_PROBE).not.toContain("'");
  });

  it('runs wal-g backup-list as the load-bearing storage probe', () => {
    expect(WALG_AUDIT_PROBE).toContain('wal-g backup-list --json');
    expect(WALG_AUDIT_PROBE).toContain('WALG_AUDIT_RC=$RC');
  });

  it('skips when backups are disabled — empty bucket renders the s3:/// form', () => {
    // docker-compose.yml renders WALG_S3_PREFIX as
    // s3://${S3_BACKUP_BUCKET:-${S3_BUCKET:-}}/backups/... so a no-S3 deploy
    // yields `s3:///backups/...`. Same guard shape as compose-backup.sh.
    expect(WALG_AUDIT_PROBE).toMatch(/case "\$PFX" in "" \| s3:\/\/\/\*\)[\s\S]*exit 0/);
  });

  it('detects credentials in BOTH wiring styles (compose env, k8s mounted file)', () => {
    expect(WALG_AUDIT_PROBE).toContain('AWS_ACCESS_KEY_ID');
    expect(WALG_AUDIT_PROBE).toContain('AWS_SHARED_CREDENTIALS_FILE');
  });

  it('skips a standby — its wal-g writes are guarded off by design', () => {
    expect(WALG_AUDIT_PROBE).toMatch(/WALG_ROLE:-primary[\s\S]*standby[\s\S]*exit 0/);
  });

  it('checks the standby guard BEFORE credentials, so a standby never fails on them', () => {
    expect(WALG_AUDIT_PROBE.indexOf('WALG_ROLE')).toBeLessThan(
      WALG_AUDIT_PROBE.indexOf('AWS_ACCESS_KEY_ID'),
    );
  });

  it('always exits 0 so the VERDICT is decided in JS, not in shell', () => {
    expect(WALG_AUDIT_PROBE.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('reads pg_stat_archiver and computes "failing now" in SQL, not JS', () => {
    // Comparing timestamps in Postgres avoids parsing its non-ISO timestamptz
    // rendering in JS, and comparing last_failed_time to last_archived_time
    // (rather than failed_count > 0) is what stops a long-since-fixed failure
    // from false-reddening every later warm redeploy.
    expect(WALG_ARCHIVER_SQL).toContain('FROM pg_stat_archiver');
    expect(WALG_ARCHIVER_SQL).toContain('last_failed_time > last_archived_time');
    expect(WALG_ARCHIVER_SQL).not.toContain("'");
    expect(WALG_AUDIT_PROBE).toContain(WALG_ARCHIVER_SQL);
  });
});

// The `WALG_ROLE=standby` skip is right at DEPLOY time and exactly wrong at
// FAILOVER time: after a promotion, a node still carrying the standby
// write-guard is not guarded, it is ROTTEN — wal-archive.sh drops every WAL
// segment and no base backup is ever taken, on the node that now holds the only
// live copy of the data. `requirePrimary` is how a caller that KNOWS the node
// must be a primary turns that skip into a failure.
describe('buildWalgAuditProbe({ requirePrimary })', () => {
  const strict = buildWalgAuditProbe({ requirePrimary: true });

  it('the default build IS the deploy-time probe (a genuine standby still skips)', () => {
    expect(buildWalgAuditProbe()).toBe(WALG_AUDIT_PROBE);
    expect(WALG_AUDIT_PROBE).toContain('WALG_AUDIT=skip:standby-write-guard');
    expect(WALG_AUDIT_PROBE).not.toContain('stale-standby-role');
  });

  it('requirePrimary FAILS on a standby role instead of skipping it', () => {
    expect(strict).toContain('WALG_AUDIT=fail:stale-standby-role');
    expect(strict).not.toContain('WALG_AUDIT=skip:standby-write-guard');
  });

  it('requirePrimary reads pg_is_in_recovery() so the message can name the shape', () => {
    expect(strict).toContain('SELECT pg_is_in_recovery()');
    expect(strict).toContain('WALG_AUDIT_RECOVERY=$REC');
    // Recovery state is REPORTED, never the verdict: the role alone decides,
    // so a psql that cannot answer does not turn a real failure into a pass.
    expect(strict).not.toMatch(/if \[ "\$REC" .*\]/);
  });

  it('both modes keep every invariant the deploy-time probe relies on', () => {
    for (const probe of [WALG_AUDIT_PROBE, strict]) {
      // Ships inside a bash -c '...' word.
      expect(probe).not.toContain("'");
      // Verdict decided in JS, so the script itself always exits 0.
      expect(probe.trimEnd().endsWith('exit 0')).toBe(true);
      // The no-backup-target skip still precedes the role branch, so a
      // backups-disabled node skips in BOTH modes rather than failing.
      expect(probe.indexOf('skip:no-backup-target')).toBeLessThan(probe.indexOf('WALG_ROLE'));
      // The role branch still precedes the credential check.
      expect(probe.indexOf('WALG_ROLE')).toBeLessThan(probe.indexOf('AWS_ACCESS_KEY_ID'));
    }
  });

  it('carries requirePrimary through both exec seams', () => {
    expect(composeWalgAuditShell({ requirePrimary: true })).toContain('stale-standby-role');
    expect(composeWalgAuditShell()).not.toContain('stale-standby-role');
    expect(k8sWalgAuditArgv(undefined, { requirePrimary: true }).at(-1)).toBe(strict);
    expect(k8sWalgAuditArgv().at(-1)).toBe(WALG_AUDIT_PROBE);
  });
});

describe('evaluateWalgAudit — stale standby role (the post-failover rot state)', () => {
  const stale = (recovery: string) =>
    evaluateWalgAudit(
      [
        'WALG_AUDIT=fail:stale-standby-role',
        'WALG_AUDIT_PREFIX=s3://bkt/backups/proj/walg',
        `WALG_AUDIT_RECOVERY=${recovery}`,
      ].join('\n'),
    );

  it('FAILS (never skips) and names the write-guard as the mechanism', () => {
    const r = stale('f');
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.failures[0].code).toBe('stale-standby-role');
    expect(r.failures[0].detail).toContain('WALG_ROLE=standby');
    expect(r.failures[0].detail).toContain('archives NOTHING');
    // The fix, not just the symptom: env is fixed at container-create time.
    expect(r.failures[0].detail).toContain('container being recreated');
  });

  it('distinguishes a promoted node from one that never left recovery', () => {
    expect(stale('f').failures[0].detail).toContain('NOT in recovery');
    expect(stale('t').failures[0].detail).toContain('STILL A REPLICA');
    expect(stale('').failures[0].detail).toContain('could not be read');
  });

  it('the message drops the storage-credential differential — this is not a storage fault', () => {
    const msg = walgAuditFailureMessage(stale('f'), 'compose', { context: 'failover' });
    expect(msg).toContain('WALG_ROLE=standby');
    expect(msg).not.toContain('S3_ACCESS_KEY');
    expect(msg).not.toContain('Refusing to finish a deploy');
    expect(msg).toContain('Failing the failover command');
  });

  it('a GENUINE standby still skips cleanly under the default probe', () => {
    const r = evaluateWalgAudit('WALG_AUDIT=skip:standby-write-guard');
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.failures).toEqual([]);
  });
});

describe('parseWalgAuditOutput', () => {
  it('reads the marker block a healthy probe emits', () => {
    const p = parseWalgAuditOutput(probeOutput({ list: ONE_BACKUP }));
    expect(p.outcome).toBe('probed');
    expect(p.prefix).toBe('s3://bkt/backups/proj/walg');
    expect(p.listStatus).toBe(0);
    expect(p.listOutput).toContain('base_000000010000000000000004');
  });

  it('reads skip markers', () => {
    expect(parseWalgAuditOutput('WALG_AUDIT=skip:no-backup-target')).toMatchObject({
      outcome: 'skip',
      reason: 'no-backup-target',
    });
  });

  it('treats output without the markers as unreadable', () => {
    expect(parseWalgAuditOutput('bash: line 1: docker: not found').outcome).toBe('unreadable');
    expect(parseWalgAuditOutput('').outcome).toBe('unreadable');
  });

  it('marks archiver state unreadable when psql could not answer', () => {
    const p = parseWalgAuditOutput(probeOutput({ archiver: '' }));
    expect(p.archiver.readable).toBe(false);
    expect(p.archiver.currentlyFailing).toBe(false);
  });
});

describe('countWalgBackups', () => {
  it('counts base backups out of merged stdout+stderr capture', () => {
    // The probe merges stderr (wal-g logs INFO there) so failures carry it.
    expect(countWalgBackups(`${ONE_BACKUP}\nINFO: 2026/07/30 done`)).toBe(1);
    expect(countWalgBackups('[]\nINFO: 2026/07/30 No backups found')).toBe(0);
  });

  it('returns null (unknown) rather than a misleading 0 when no array is present', () => {
    expect(countWalgBackups('ERROR: NoCredentialProviders')).toBeNull();
  });
});

describe('evaluateWalgAudit', () => {
  it('passes when wal-g reaches storage and reports backups', () => {
    const r = evaluateWalgAudit(
      probeOutput({
        list: ONE_BACKUP,
        archiver: '9|0|00000001000000000000000A||2026-07-30 11:00:00+00||f',
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(false);
    expect(r.backupCount).toBe(1);
    expect(r.failures).toEqual([]);
  });

  it('PASSES a brand-new environment: empty list and nothing archived yet', () => {
    // The false-failure this check must never produce. `wal-g backup-list`
    // exiting 0 with `[]` means storage is reachable and simply empty, and a
    // fresh cluster has archived no WAL yet (both archiver timestamps NULL).
    const r = evaluateWalgAudit(probeOutput({ rc: 0, list: '[]', archiver: '0|0|||||f' }));
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.backupCount).toBe(0);
    expect(r.notes.join(' ')).toMatch(/no base backups exist yet/);
    expect(r.notes.join(' ')).toMatch(/no WAL archived yet/);
  });

  it('PASSES when wal-g exits non-zero purely because the prefix is empty', () => {
    // Some wal-g builds exit 1 on "No backups found". That call still reached
    // the bucket in order to find it empty — a fresh env, not a broken one.
    const r = evaluateWalgAudit(probeOutput({ rc: 1, list: 'INFO: 2026/07/30 No backups found' }));
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('FAILS when wal-g cannot reach storage, naming the exit code and its error', () => {
    const r = evaluateWalgAudit(
      probeOutput({
        rc: 1,
        list: 'ERROR: 2026/07/30 failed to list: NoCredentialProviders: no valid providers',
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.code)).toContain('storage-unreachable');
    expect(r.failures[0].detail).toContain('exited 1');
    expect(r.failures[0].detail).toContain('NoCredentialProviders');
    expect(r.failures[0].detail).toContain('s3://bkt/backups/proj/walg');
  });

  it('FAILS when the archive_command itself is failing right now', () => {
    const r = evaluateWalgAudit(
      probeOutput({
        archiver:
          '4|2|000000010000000000000004|000000010000000000000005|2026-07-30 10:00:00+00|2026-07-30 11:00:00+00|t',
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.code)).toContain('archive-command-failing');
    expect(r.failures[0].detail).toContain('000000010000000000000005');
  });

  it('does NOT fail on a historical archive failure that has since recovered', () => {
    // failed_count is cumulative until pg_stat_reset_shared('archiver'), so a
    // count-based check would red every warm redeploy forever after one blip.
    // The SQL compares the two timestamps instead — here the last event was a
    // SUCCESS, so the archiver is healthy.
    const r = evaluateWalgAudit(
      probeOutput({
        archiver:
          '40|2|000000010000000000000009|000000010000000000000005|2026-07-30 12:00:00+00|2026-07-30 09:00:00+00|f',
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('does not fail merely because pg_stat_archiver was unreadable', () => {
    const r = evaluateWalgAudit(probeOutput({ archiver: '' }));
    expect(r.ok).toBe(true);
    expect(r.notes.join(' ')).toMatch(/archiver state unknown/);
  });

  it('skips (passing) when backups are not configured or the node is a standby', () => {
    for (const reason of ['no-backup-target', 'standby-write-guard']) {
      const r = evaluateWalgAudit(`WALG_AUDIT=skip:${reason}`);
      expect(r.ok).toBe(true);
      expect(r.skipped).toBe(true);
      expect(r.reason).toBe(reason);
    }
  });

  it('FAILS when a backup prefix is configured but no credentials reached the container', () => {
    // This is the "configured vs working" split: the operator asked for
    // backups, so a missing/misnamed S3 secret is a broken deploy, not an
    // opt-out. Skipping here would reproduce the exact silent failure the
    // audit exists to prevent.
    const r = evaluateWalgAudit(
      'WALG_AUDIT=fail:no-credentials\nWALG_AUDIT_PREFIX=s3://bkt/backups/proj/walg',
    );
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.failures[0].code).toBe('no-credentials');
    expect(r.failures[0].detail).toContain('s3://bkt/backups/proj/walg');
    expect(r.failures[0].detail).toContain('CONFIGURED');
  });

  it('FAILS on unreadable probe output rather than passing by default', () => {
    const r = evaluateWalgAudit('Error response from daemon: container db is not running');
    expect(r.ok).toBe(false);
    expect(r.failures[0].code).toBe('probe-unreadable');
    expect(r.failures[0].detail).toContain('container db is not running');
  });
});

describe('walgAuditFailureMessage', () => {
  const msg = walgAuditFailureMessage(
    { failures: [{ code: 'storage-unreachable', detail: 'wal-g exited 1: NoSuchBucket' }] },
    'compose',
  );

  it('leads with the consequence — a green deploy with no backups', () => {
    expect(msg).toContain('ZERO recoverable backups');
    expect(msg.toLowerCase()).toContain('refusing to finish a deploy');
  });

  it('names the likely causes an operator can act on', () => {
    expect(msg).toContain('credentials');
    expect(msg).toContain('S3_BACKUP_BUCKET');
    expect(msg).toContain('S3_ENDPOINT');
    expect(msg).toContain('egress');
    expect(msg).toContain('NoSuchBucket');
  });

  it('gives the reproduce command for the caller’s deploy path', () => {
    expect(msg).toContain('docker compose exec -T db wal-g backup-list');
    expect(walgAuditFailureMessage({ failures: [] }, 'k8s')).toContain(
      'kubectl -n vibecarbon exec supabase-supabase-db-0 -- wal-g backup-list',
    );
  });
});

describe('assertWalgBackupsWorking (exec seam mocked)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves without retrying when wal-g is healthy', async () => {
    const probe = vi.fn().mockResolvedValue(probeOutput({ list: ONE_BACKUP }));
    const r = await settled(assertWalgBackupsWorking({ probe, path: 'compose' }));
    expect(r.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('resolves on a brand-new environment without a single retry', async () => {
    const probe = vi.fn().mockResolvedValue(probeOutput({ rc: 0, list: '[]' }));
    const r = await settled(assertWalgBackupsWorking({ probe, path: 'k8s' }));
    expect(r.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('resolves without probing storage when backups are disabled', async () => {
    const probe = vi.fn().mockResolvedValue('WALG_AUDIT=skip:no-backup-target');
    const r = await settled(assertWalgBackupsWorking({ probe, path: 'compose' }));
    expect(r.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('THROWS loudly after exhausting the retry budget on a broken backup config', async () => {
    const probe = vi
      .fn()
      .mockResolvedValue(probeOutput({ rc: 1, list: 'ERROR: InvalidAccessKeyId' }));
    const r = await settled(assertWalgBackupsWorking({ probe, path: 'compose' }));
    expect(r.ok).toBe(false);
    expect(r.e.message).toContain('ZERO recoverable backups');
    expect(r.e.message).toContain('InvalidAccessKeyId');
    // 3 attempts total (delaysMs.length + 1) — a transient S3 blip gets two
    // more chances; a genuinely wrong credential fails all three in ~20s.
    expect(probe).toHaveBeenCalledTimes(WALG_AUDIT_RETRY_DELAYS_MS.length + 1);
  });

  it('recovers from a transient blip instead of reddening the deploy', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(probeOutput({ rc: 1, list: 'ERROR: 503 SlowDown' }))
      .mockResolvedValue(probeOutput({ list: ONE_BACKUP }));
    const r = await settled(assertWalgBackupsWorking({ probe, path: 'compose' }));
    expect(r.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not burn the retry budget on a verdict that cannot change', async () => {
    // Missing credentials are missing on attempt 3 too — fail immediately.
    const probe = vi
      .fn()
      .mockResolvedValue('WALG_AUDIT=fail:no-credentials\nWALG_AUDIT_PREFIX=s3://bkt/x');
    const r = await settled(assertWalgBackupsWorking({ probe, path: 'compose' }));
    expect(r.ok).toBe(false);
    expect(r.e.message).toContain('ZERO recoverable backups');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('wraps an exec failure in the same actionable message', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('Command failed: kubectl exec ... exit 1'));
    const r = await settled(assertWalgBackupsWorking({ probe, path: 'k8s' }));
    expect(r.ok).toBe(false);
    expect(r.e.message).toContain('could not be executed inside the db container');
    expect(r.e.message).toContain('kubectl -n vibecarbon exec');
  });
});

describe('exec seams', () => {
  it('compose runs the probe through docker compose exec on the db service', () => {
    const shell = composeWalgAuditShell();
    expect(shell.startsWith("docker compose exec -T db bash -c '")).toBe(true);
    expect(shell.endsWith("'")).toBe(true);
    expect(shell).toContain(WALG_AUDIT_PROBE);
    // Exactly two single quotes: the pair wrapping the probe.
    expect(shell.split("'").length - 1).toBe(2);
  });

  it('k8s runs the SAME probe through kubectl exec on the db pod', () => {
    expect(k8sWalgAuditArgv()).toEqual([
      '-n',
      'vibecarbon',
      'exec',
      'supabase-supabase-db-0',
      '--',
      'bash',
      '-c',
      WALG_AUDIT_PROBE,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Call-site pins: the audit is worthless if a deploy path stops invoking it.
// ---------------------------------------------------------------------------

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: () => void;
};

function makeFakeChild(stdout = '', exitCode = 0): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = new PassThrough();
  c.kill = () => {};
  setImmediate(() => {
    if (stdout) c.stdout.write(stdout);
    c.stdout.end();
    c.stderr.end();
    c.emit('close', exitCode);
  });
  return c;
}

describe('k8s deploy path calls the audit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('execs the probe in the supabase-db pod and passes when healthy', async () => {
    const { spawn } = await import('node:child_process');
    const mocked = vi.mocked(spawn);
    mocked.mockReset();
    mocked.mockImplementation((() =>
      makeFakeChild(probeOutput({ list: ONE_BACKUP }), 0)) as unknown as typeof spawn);

    const r = await settled(k3s.verifyWalgBackups({ kubeconfig: '/tmp/kc' }));
    expect(r.ok).toBe(true);
    const [bin, argv] = mocked.mock.calls[0] as unknown as [string, string[]];
    expect(bin).toBe('kubectl');
    expect(argv).toEqual(k8sWalgAuditArgv());
  });

  it('fails the deploy when the pod reports broken storage', async () => {
    const { spawn } = await import('node:child_process');
    const mocked = vi.mocked(spawn);
    mocked.mockReset();
    mocked.mockImplementation((() =>
      makeFakeChild(
        probeOutput({ rc: 1, list: 'ERROR: RequestError: dial tcp: i/o timeout' }),
        0,
      )) as unknown as typeof spawn);

    const r = await settled(k3s.verifyWalgBackups({ kubeconfig: '/tmp/kc' }));
    expect(r.ok).toBe(false);
    expect(r.e.message).toContain('ZERO recoverable backups');
  });
});

describe('k8s audit is NOT behind the persisted k3s-apply skip gate', () => {
  /**
   * The gap this pins (PR #210 review): step 7c originally lived inside
   * applyK3sManifests, which deployK3s only calls when `state.shouldSkip
   * ('k3s-apply', …)` is false. `buildK3sApplyInputs` hashes image tags +
   * restore + manifest digests, and `.vibecarbon/deploy-state-<env>.json`
   * persists across deploys — so a redeploy with unchanged images and manifests
   * skipped the audit entirely. That is EXACTLY the external-rot shape the
   * audit exists for (keys revoked at the provider, bucket deleted, nothing in
   * the cluster changed), and it would have stayed silent until some unrelated
   * change forced an image rebuild. Compose runs its audit every deploy; k8s
   * must too.
   *
   * Asserted structurally against the source: a behavioural test would have to
   * stand up all of deployK3s (Pulumi, SSH, kubeconfig, sideload), and the
   * regression is precisely a code-placement one — moving the call back inside
   * the gate block. Brace-matching finds the gate block's real extent rather
   * than eyeballing line numbers.
   */
  const SRC = readFileSync(
    fileURLToPath(new URL('../../../src/lib/deploy/k8s/k3s.js', import.meta.url)),
    'utf-8',
  );

  /** Source span of the `if (!state.shouldSkip('k3s-apply', …)) { … }` block. */
  function applyGateBlock(): string {
    const gateStart = SRC.indexOf("if (!state.shouldSkip('k3s-apply'");
    expect(gateStart, 'the k3s-apply gate must still exist').toBeGreaterThan(-1);
    const open = SRC.indexOf('{', gateStart);
    let depth = 0;
    for (let i = open; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}' && --depth === 0) return SRC.slice(open, i + 1);
    }
    throw new Error('unbalanced k3s-apply gate block');
  }

  it('deployK3s calls verifyWalgBackups OUTSIDE the k3s-apply gate block', () => {
    const block = applyGateBlock();
    // Self-check the extractor first: an empty or mis-sliced block would pass
    // the real assertion vacuously. The gated apply call must be inside it.
    expect(block).toContain('applyK3sManifests({');
    expect(block).toContain("state.completeStep('k3s-apply')");

    expect(block).not.toContain('verifyWalgBackups');
    expect(SRC).toContain('verifyWalgBackups({ kubeconfig })');
  });

  it('applyK3sManifests no longer runs the audit itself (no double-run, no gating)', () => {
    const applyStart = SRC.indexOf('export async function applyK3sManifests(');
    const deployStart = SRC.indexOf('export async function deployK3s(');
    expect(applyStart).toBeGreaterThan(-1);
    expect(deployStart).toBeGreaterThan(applyStart);
    expect(SRC.slice(applyStart, deployStart)).not.toContain('verifyWalgBackups(');
  });

  it('still runs only when S3 is configured — a backup-less deploy is untouched', () => {
    const call = SRC.indexOf('verifyWalgBackups({ kubeconfig })');
    const gate = SRC.lastIndexOf('if (options.s3Config?.accessKey) {', call);
    expect(gate).toBeGreaterThan(-1);
    // The gate must be the immediately-enclosing conditional, not some far
    // earlier one that happens to appear before the call.
    expect(call - gate).toBeLessThan(400);
  });
});

describe('compose deploy path calls the audit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * runMigrations issues a series of ssh commands; only the audit one carries
   * the WALG_AUDIT marker, so key the fake off the remote command string.
   */
  function mockSsh(auditStdout: string) {
    const seen: string[] = [];
    return vi.mocked(vi.fn()).mockImplementation(((_bin: string, argv: string[]) => {
      const remote = argv[argv.length - 1] ?? '';
      seen.push(remote);
      return makeFakeChild(remote.includes('WALG_AUDIT') ? auditStdout : '', 0);
    }) as never) as unknown as { mock: { calls: unknown[][] } } & ReturnType<typeof vi.fn>;
  }

  it('runs the audit over ssh after migrations and passes when healthy', async () => {
    const { spawn } = await import('node:child_process');
    const mocked = vi.mocked(spawn);
    mocked.mockReset();
    const impl = mockSsh(probeOutput({ list: ONE_BACKUP }));
    mocked.mockImplementation(impl as unknown as typeof spawn);

    const r = await settled(compose.runMigrations('10.0.0.1', '/tmp/key', 'proj'));
    expect(r.ok).toBe(true);
    const remoteCmds = mocked.mock.calls.map((c) => (c[1] as string[]).at(-1) as string);
    const auditCmd = remoteCmds.find((c) => c.includes('WALG_AUDIT'));
    expect(auditCmd, 'runMigrations must run the post-migration wal-g audit').toBeDefined();
    expect(auditCmd).toContain('cd /opt/proj &&');
    expect(auditCmd).toContain('docker compose exec -T db bash -c');
    // The RLS audit still runs, and the backup audit follows it.
    expect(remoteCmds.findIndex((c) => c.includes('relrowsecurity'))).toBeLessThan(
      remoteCmds.findIndex((c) => c.includes('WALG_AUDIT')),
    );
  });

  it('fails the deploy when the db container reports broken storage', async () => {
    const { spawn } = await import('node:child_process');
    const mocked = vi.mocked(spawn);
    mocked.mockReset();
    const impl = mockSsh(probeOutput({ rc: 1, list: 'ERROR: NoSuchBucket: the bucket is gone' }));
    mocked.mockImplementation(impl as unknown as typeof spawn);

    const r = await settled(compose.runMigrations('10.0.0.1', '/tmp/key', 'proj'));
    expect(r.ok).toBe(false);
    expect(r.e.message).toContain('ZERO recoverable backups');
    expect(r.e.message).toContain('NoSuchBucket');
  });

  it('does not fail a deploy that deliberately has backups disabled', async () => {
    const { spawn } = await import('node:child_process');
    const mocked = vi.mocked(spawn);
    mocked.mockReset();
    const impl = mockSsh('WALG_AUDIT=skip:no-backup-target');
    mocked.mockImplementation(impl as unknown as typeof spawn);

    const r = await settled(compose.runMigrations('10.0.0.1', '/tmp/key', 'proj'));
    expect(r.ok).toBe(true);
  });
});
