/**
 * The bundle upload (`cat tarball | ssh 'mkdir && tar -x …'`) must ride the
 * shared SSH transport protections and retry never-started transport drops.
 *
 * RCA 2026-08-16 (run 31961619204, compose-ha scale FAIL): the upload to a
 * freshly-created replacement server died with `kex_exchange_identification:
 * read: Connection reset by peer` after a 140s hang. This call site predates
 * the shared-opts chokepoint: its hand-rolled argv carried only host-key
 * pinning + BatchMode — no ConnectTimeout, no ServerAlive keepalives (the
 * banner-exchange-hang protections), no ControlMaster, and no transport
 * retry, even though a kex reset is precisely the "provably never started,
 * safe to retry" class lib/ssh.js#sshRun already classifies and retries.
 * Cluster 3's root fix landed at the chokepoints; this site bypassed them.
 *
 * The remote command (mkdir -p / tar -x / cp / daemon-reload) is idempotent,
 * so the never-started constraint is belt-and-suspenders — but keeping the
 * same classifier as sshRun means the two retry policies cannot drift.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms?: number, value?: unknown) =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms)),
}));

const runCommandAsync = vi.fn();
vi.mock('../../../src/lib/command.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/command.js')>(
    '../../../src/lib/command.js',
  );
  return { ...actual, runCommandAsync: (...args: unknown[]) => runCommandAsync(...args) };
});

vi.mock('../../../src/lib/cli/progress.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/cli/progress.js')>(
    '../../../src/lib/cli/progress.js',
  );
  return {
    ...actual,
    progressLog: vi.fn(),
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  };
});

const composePromise = import('../../../src/lib/deploy/compose/index.js');

/** The kex-reset shape sshRun's never-started classifier recognises. */
function kexResetError() {
  const err = new Error(
    'Command failed: bash -c cat "$1" | ssh …\nkex_exchange_identification: read: Connection reset by peer',
  ) as Error & { status: number; stderr: string };
  err.status = 255;
  err.stderr =
    'kex_exchange_identification: read: Connection reset by peer\nConnection reset by 1.2.3.4 port 22';
  return err;
}

/** A genuine remote failure (tar/gzip) — must NOT be retried. */
function remoteFailure() {
  const err = new Error(
    'Command failed: bash -c …\ngzip: stdin: unexpected end of file',
  ) as Error & {
    status: number;
    stderr: string;
  };
  err.status = 2;
  err.stderr = 'gzip: stdin: unexpected end of file';
  return err;
}

async function settled<T>(p: Promise<T>) {
  let done = false;
  const r = p.then(
    (v) => {
      done = true;
      return { ok: true as const, v };
    },
    (e) => {
      done = true;
      return { ok: false as const, e };
    },
  );
  for (let i = 0; i < 120 && !done; i++) {
    await vi.advanceTimersByTimeAsync(1000);
  }
  return r;
}

const uploadCalls = () =>
  runCommandAsync.mock.calls.filter((c) => (c[0] as string[])[0] === 'bash');

describe('setupServerFiles bundle-upload transport', () => {
  let bundleDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    bundleDir = mkdtempSync(join(tmpdir(), 'vc-bundle-upload-'));
    writeFileSync(join(bundleDir, 'docker-compose.yml'), 'services: {}\n');
    runCommandAsync.mockReset().mockResolvedValue('');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(bundleDir, { recursive: true, force: true });
  });

  const run = () =>
    composePromise.then(({ setupServerFiles }) =>
      settled(
        setupServerFiles('1.2.3.4', '/tmp/.vibecarbon/deploy_key_ci2', 'proj', {
          bundlePath: bundleDir,
        }),
      ),
    );

  it('the upload ssh carries the shared connection opts (keepalives, timeout, mux)', async () => {
    const r = await run();
    expect(r.ok).toBe(true);

    const [argv] = uploadCalls()[0] as [string[]];
    const script = argv[2];
    // The banner-exchange-hang protections and per-call-churn fix, from the
    // single shared source — not a hand-rolled subset that drifts.
    expect(script).toContain('ServerAliveInterval=15');
    expect(script).toContain('ServerAliveCountMax=4');
    expect(script).toContain('ConnectTimeout=');
    expect(script).toContain('ControlMaster=auto');
    expect(script).toContain('BatchMode=yes');
  });

  it('retries a never-started kex reset and succeeds on the second attempt', async () => {
    let uploads = 0;
    runCommandAsync.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'bash') {
        uploads++;
        if (uploads === 1) throw kexResetError();
      }
      return '';
    });

    const r = await run();

    expect(r.ok).toBe(true);
    expect(uploadCalls()).toHaveLength(2);
  });

  it('does NOT retry a genuine remote failure (command ran; not transport)', async () => {
    runCommandAsync.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'bash') throw remoteFailure();
      return '';
    });

    const r = await run();

    expect(r.ok).toBe(false);
    expect(uploadCalls()).toHaveLength(1);
    expect((r as { ok: false; e: Error }).e.message).toContain('gzip');
  });
});
