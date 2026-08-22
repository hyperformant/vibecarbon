/**
 * Unit tests for the bounded wal-g retry over Hetzner Object Storage
 * read-after-write staleness (src/lib/deploy/walg-staleness.js and its two
 * compose call sites).
 *
 * THE INCIDENT (compose scale, e2e env e1, 2026-07-31 ~21:49Z)
 * -----------------------------------------------------------
 * Blue/green scale pushed a wal-g base backup from the OLD server (success),
 * then seconds later the NEW server's `restoreCompose` ran `wal-g backup-fetch`
 * and died on the very first S3 LIST:
 *
 *   INFO: Selecting the latest backup...
 *   ERROR: Failed to select backup: list folder in storage "default": failed to
 *   list s3 folder: 'backups/<project>/walg/basebackups_005/': NoSuchBucket:
 *     status code: 404, request id: tx…-nbg1-prod1-ceph5
 *
 * The bucket existed — the push into it had JUST succeeded from the other host.
 * The new server's first read landed on a Hetzner Object Storage frontend that
 * had not caught up. Same class as the pulumi stack-file / lock-blob 404s that
 * PR #220 recovered on the `up` path (src/lib/iac/index.js), in a fourth
 * spelling, on the same `nbg1-prod1-ceph5` backend.
 *
 * WHAT IS PINNED HERE
 * -------------------
 *  - the signature matcher, driven by the VERBATIM incident text, and the
 *    non-matching errors that must stay fatal;
 *  - the budget shape (5 attempts, 2/4/8/16s — PR #220's ladder) and that
 *    exhausting it propagates the ORIGINAL error, so a genuinely missing
 *    bucket is still a real answer;
 *  - the loud per-retry log line;
 *  - both compose call sites (fetch + push) through the real exec stack with
 *    only `runCommandAsync` mocked — the same reliable src-module mock
 *    compose-admin-user-retry.test.ts uses (node: builtins are NOT mocked;
 *    sshRunScript writes to a real temp dir);
 *  - the k8s walg-restore init container's bash mirror, including a real
 *    `bash -n` syntax check (that script has no unit-testable JS seam — it is
 *    executed by the kubelet — so syntax is pinned here or nowhere).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCommandAsync = vi.fn();
vi.mock('../../../src/lib/command.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/command.js')>(
    '../../../src/lib/command.js',
  );
  return { ...actual, runCommandAsync: (...args: unknown[]) => runCommandAsync(...args) };
});

const progressLog = vi.fn();
vi.mock('../../../src/lib/cli/progress.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/cli/progress.js')>(
    '../../../src/lib/cli/progress.js',
  );
  return { ...actual, progressLog: (...args: unknown[]) => progressLog(...args) };
});

const stalenessPromise = import('../../../src/lib/deploy/walg-staleness.js');
const composePromise = import('../../../src/lib/deploy/compose/index.js');

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * The failure verbatim from the incident log (project prefix kept), including
 * wal-g's leading INFO line and the tab-indented aws-sdk continuation.
 */
const INCIDENT_OUTPUT = [
  'INFO: 2026/07/31 21:49:34.132719 Selecting the latest backup...',
  `ERROR: 2026/07/31 21:49:34.283117 Failed to select backup: list folder in storage "default": failed to list s3 folder: 'backups/testapp-compose-1785533926349-2tboii/walg/basebackups_005/': NoSuchBucket:`,
  '\tstatus code: 404, request id: tx0000092403b6c24fbd2c6-006a6d186e-99ac3a-nbg1-prod1-ceph5, host id: ',
].join('\n');

/** Build the error shape `runCommandAsync` rejects with on a remote non-zero exit. */
function execError(text: string, { onStdout = false } = {}) {
  const err = new Error(
    onStdout ? 'Command failed: ssh -i /tmp/key root@10.0.0.1 …' : `Command failed: ssh …\n${text}`,
  ) as Error & { stdout: string; stderr: string; status: number };
  err.stdout = onStdout ? text : '';
  err.stderr = onStdout ? '' : text;
  err.status = 1;
  return err;
}

/** Zero-delay ladder so the call-site tests exercise 5 attempts without waiting. */
const NO_DELAYS = [0, 0, 0, 0];

describe('walg staleness signature', () => {
  it('matches the verbatim incident output on message, stdout, or stderr', async () => {
    const { isWalgStaleStorageError } = await stalenessPromise;
    expect(isWalgStaleStorageError(execError(INCIDENT_OUTPUT))).toBe(true);
    expect(isWalgStaleStorageError(execError(INCIDENT_OUTPUT, { onStdout: true }))).toBe(true);
    expect(isWalgStaleStorageError(new Error(INCIDENT_OUTPUT))).toBe(true);
  });

  it('matches the sibling 404 spellings of the same class', async () => {
    const { isWalgStaleStorageError } = await stalenessPromise;
    // A just-written object 404'd by a stale frontend mid-fetch.
    expect(
      isWalgStaleStorageError(
        new Error('ERROR: failed to fetch sentinel: NoSuchKey: status code: 404, request id: tx…'),
      ),
    ).toBe(true);
    // aws-sdk's bare NotFound rendering carries the status code but no code word.
    expect(isWalgStaleStorageError(new Error('NotFound: status code: 404, request id: tx…'))).toBe(
      true,
    );
  });

  it('matches wal-g\'s own "object not found in storage" wording (2026-08-06 incident, verbatim)', async () => {
    const { isWalgStaleStorageError } = await stalenessPromise;
    // Compose scale, env e1, ~23:21Z: the fetch's LIST saw the just-pushed
    // backup's sentinel, then the GET for its files_metadata.json landed on a
    // frontend that had not caught up. wal-g's storage abstraction renders
    // that 404 in its own words — no NoSuchKey, no aws-sdk status line — so
    // the pattern's first three spellings all missed it and the scale died on
    // attempt 1.
    expect(
      isWalgStaleStorageError(
        execError(
          "ERROR: 2026/08/06 23:21:56.202088 Failed to fetch backup: failed to fetch files metadata: object 'base_000000010000000000000004/files_metadata.json' not found in storage",
        ),
      ),
    ).toBe(true);
  });

  it('does NOT match errors that are real answers or unrelated failures', async () => {
    const { isWalgStaleStorageError } = await stalenessPromise;
    // wal-g's own "the prefix is empty" wording: a fresh environment, not a
    // stale frontend — the LIST demonstrably reached the bucket.
    expect(isWalgStaleStorageError(new Error('ERROR: No backups found'))).toBe(false);
    expect(isWalgStaleStorageError(new Error('InvalidAccessKeyId: status code: 403'))).toBe(false);
    expect(
      isWalgStaleStorageError(new Error('write /var/lib/postgresql/data: no space left')),
    ).toBe(false);
    expect(isWalgStaleStorageError(undefined)).toBe(false);
  });
});

describe('withWalgStaleStorageRetry', () => {
  beforeEach(() => {
    progressLog.mockReset();
  });

  it('uses PR #220s budget shape: 5 attempts, 2/4/8/16s exponential, 30s cap', async () => {
    const { WALG_STALE_RETRY_DELAYS_MS } = await stalenessPromise;
    expect(WALG_STALE_RETRY_DELAYS_MS).toEqual([2000, 4000, 8000, 16000]);
    expect(Math.max(...WALG_STALE_RETRY_DELAYS_MS)).toBeLessThanOrEqual(30_000);
  });

  it('retries the incident failure and returns the later success', async () => {
    const { withWalgStaleStorageRetry } = await stalenessPromise;
    const fn = vi
      .fn()
      .mockRejectedValueOnce(execError(INCIDENT_OUTPUT))
      .mockResolvedValueOnce('fetched');

    await expect(
      withWalgStaleStorageRetry(fn, 'backup list', { delaysMs: NO_DELAYS }),
    ).resolves.toBe('fetched');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('logs each retry loudly with attempt count and the delay', async () => {
    const { withWalgStaleStorageRetry } = await stalenessPromise;
    const fn = vi
      .fn()
      .mockRejectedValueOnce(execError(INCIDENT_OUTPUT))
      .mockRejectedValueOnce(execError(INCIDENT_OUTPUT))
      .mockResolvedValueOnce('ok');

    // Distinct, small delays: pins that the announced wait is the one actually
    // slept (delaysMs[attempt - 1]) without paying the real ladder's seconds.
    await withWalgStaleStorageRetry(fn, 'backup list', { delaysMs: [0, 1000, 8000, 16000] });

    expect(progressLog).toHaveBeenCalledTimes(2);
    expect(progressLog.mock.calls[0][0]).toBe(
      '[walg] backup list hit a stale storage frontend (attempt 1/5), retrying in 0s',
    );
    expect(progressLog.mock.calls[1][0]).toBe(
      '[walg] backup list hit a stale storage frontend (attempt 2/5), retrying in 1s',
    );
  });

  it('fails immediately on a non-matching error — no retry, error untouched', async () => {
    const { withWalgStaleStorageRetry } = await stalenessPromise;
    const boom = execError('ERROR: InvalidAccessKeyId: status code: 403');
    const fn = vi.fn().mockRejectedValue(boom);

    await expect(
      withWalgStaleStorageRetry(fn, 'backup list', { delaysMs: NO_DELAYS }),
    ).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(progressLog).not.toHaveBeenCalled();
  });

  it('a genuinely missing bucket still fails: budget exhausts and the original error propagates', async () => {
    const { withWalgStaleStorageRetry } = await stalenessPromise;
    const last = execError(INCIDENT_OUTPUT);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(execError(INCIDENT_OUTPUT))
      .mockRejectedValueOnce(execError(INCIDENT_OUTPUT))
      .mockRejectedValueOnce(execError(INCIDENT_OUTPUT))
      .mockRejectedValueOnce(execError(INCIDENT_OUTPUT))
      .mockRejectedValueOnce(last);

    await expect(
      withWalgStaleStorageRetry(fn, 'backup list', { delaysMs: NO_DELAYS }),
    ).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(5);
    expect(progressLog).toHaveBeenCalledTimes(4);
  });
});

/** Remote command string of every ssh/scp `runCommandAsync` call, in order. */
function remoteCommands(): string[] {
  return runCommandAsync.mock.calls.map((call) => (call[0] as string[]).join(' '));
}

function restoreExecCount(): number {
  return remoteCommands().filter((cmd) => cmd.includes('bash /restore.sh')).length;
}

function backupPushCount(): number {
  return remoteCommands().filter((cmd) => cmd.includes('backup/compose-backup.sh')).length;
}

/**
 * Drive the real ssh stack with only `runCommandAsync` faked: `behavior` sees
 * the joined argv and may throw; everything else answers benignly, with the
 * post-restore promotion probe reporting `f` (promoted) so restoreCompose's
 * verify loop exits on its first pass.
 */
function mockExec(behavior: (cmd: string) => void = () => {}) {
  runCommandAsync.mockReset();
  runCommandAsync.mockImplementation(async (argv: string[]) => {
    const cmd = Array.isArray(argv) ? argv.join(' ') : String(argv);
    behavior(cmd);
    if (cmd.includes('pg_is_in_recovery')) return 'f';
    return '';
  });
}

describe('restoreCompose — wal-g backup-fetch staleness retry (the incident seam)', () => {
  beforeEach(() => {
    progressLog.mockReset();
  });

  it('retries the fetch on the verbatim incident output and completes the restore', async () => {
    const { restoreCompose } = await composePromise;
    let fetches = 0;
    mockExec((cmd) => {
      if (cmd.includes('bash /restore.sh')) {
        fetches += 1;
        if (fetches === 1) throw execError(INCIDENT_OUTPUT);
      }
    });

    await restoreCompose('10.0.0.1', '/tmp/key', 'testapp', 'latest', {
      staleRetryDelaysMs: NO_DELAYS,
    });

    expect(restoreExecCount()).toBe(2);
    expect(progressLog.mock.calls.map((c) => c[0])).toContain(
      '[walg] backup-fetch (restore) hit a stale storage frontend (attempt 1/5), retrying in 0s',
    );
  });

  it('retries when the 404 arrives on stdout (docker compose run merges the container stream)', async () => {
    const { restoreCompose } = await composePromise;
    let fetches = 0;
    mockExec((cmd) => {
      if (cmd.includes('bash /restore.sh')) {
        fetches += 1;
        if (fetches === 1) throw execError(INCIDENT_OUTPUT, { onStdout: true });
      }
    });

    await restoreCompose('10.0.0.1', '/tmp/key', 'testapp', 'latest', {
      staleRetryDelaysMs: NO_DELAYS,
    });

    expect(restoreExecCount()).toBe(2);
  });

  it('fails fast on a non-staleness restore failure — one attempt, original error', async () => {
    const { restoreCompose } = await composePromise;
    mockExec((cmd) => {
      if (cmd.includes('bash /restore.sh')) {
        throw execError('ERROR: could not locate required checkpoint record');
      }
    });

    await expect(
      restoreCompose('10.0.0.1', '/tmp/key', 'testapp', 'latest', {
        staleRetryDelaysMs: NO_DELAYS,
      }),
    ).rejects.toThrow(/could not locate required checkpoint record/);
    expect(restoreExecCount()).toBe(1);
    expect(progressLog).not.toHaveBeenCalled();
  });

  it('exhausts the budget on a bucket that really is gone, then propagates', async () => {
    const { restoreCompose } = await composePromise;
    mockExec((cmd) => {
      if (cmd.includes('bash /restore.sh')) throw execError(INCIDENT_OUTPUT);
    });

    await expect(
      restoreCompose('10.0.0.1', '/tmp/key', 'testapp', 'latest', {
        staleRetryDelaysMs: NO_DELAYS,
      }),
    ).rejects.toThrow(/NoSuchBucket/);
    expect(restoreExecCount()).toBe(5);
  });
});

describe('backupCompose — wal-g backup-push staleness retry', () => {
  beforeEach(() => {
    progressLog.mockReset();
  });

  it('retries the push/prune on a stale-frontend 404 and completes', async () => {
    const { backupCompose } = await composePromise;
    let pushes = 0;
    mockExec((cmd) => {
      if (cmd.includes('backup/compose-backup.sh')) {
        pushes += 1;
        if (pushes === 1) throw execError(INCIDENT_OUTPUT);
      }
    });

    await backupCompose('10.0.0.1', '/tmp/key', 'testapp', { staleRetryDelaysMs: NO_DELAYS });

    expect(backupPushCount()).toBe(2);
  });

  it('propagates a failed push instead of swallowing it (scale must abort before the restore)', async () => {
    const { backupCompose } = await composePromise;
    mockExec((cmd) => {
      if (cmd.includes('backup/compose-backup.sh')) {
        throw execError('ERROR: pg_backup_start: permission denied');
      }
    });

    await expect(
      backupCompose('10.0.0.1', '/tmp/key', 'testapp', { staleRetryDelaysMs: NO_DELAYS }),
    ).rejects.toThrow(/permission denied/);
    expect(backupPushCount()).toBe(1);
  });
});

describe('k8s walg-restore init container — bash mirror of the same retry', () => {
  const valuesPath = join(REPO_ROOT, 'carbon', 'k8s', 'values', 'supabase.values.yaml');

  /** Extract the walg-restore init container's inline bash body from the values file. */
  function walgRestoreScript(): string {
    const yaml = readFileSync(valuesPath, 'utf-8');
    const start = yaml.indexOf('- name: walg-restore');
    expect(start).toBeGreaterThan(-1);
    const body = yaml.slice(start);
    const cmdStart = body.indexOf('- |\n');
    expect(cmdStart).toBeGreaterThan(-1);
    const lines = body.slice(cmdStart + 4).split('\n');
    const indent = lines[0].match(/^\s*/)?.[0] ?? '';
    const out: string[] = [];
    for (const line of lines) {
      if (line.trim() !== '' && !line.startsWith(indent)) break;
      out.push(line.slice(indent.length));
    }
    return out.join('\n');
  }

  it('wraps backup-fetch in a bounded retry on the same 404 signatures', () => {
    const script = walgRestoreScript();
    expect(script).toMatch(/wal-g backup-fetch/);
    // Bounded loop with the same 5-attempt budget as the compose path.
    expect(script).toMatch(/WALG_FETCH_ATTEMPTS=5/);
    expect(script).toMatch(/NoSuchBucket/);
    expect(script).toMatch(/NoSuchKey/);
    expect(script).toMatch(/status code: 404/);
    // wal-g's own 404 wording (2026-08-06 incident) — must stay in lockstep
    // with WALG_STALE_STORAGE_PATTERN's fourth spelling.
    expect(script).toMatch(/not found in storage/);
    // Same loud line the compose path logs.
    expect(script).toMatch(/\[walg\] backup-fetch hit a stale storage frontend/);
  });

  it('is syntactically valid bash (no e2e can catch a typo here before a customer does)', () => {
    const res = spawnSync('bash', ['-n'], { input: walgRestoreScript(), encoding: 'utf-8' });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });
});
