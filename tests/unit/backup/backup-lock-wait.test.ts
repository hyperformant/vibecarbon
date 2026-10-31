/**
 * compose-backup.sh's lock: an opt-in bounded wait (LOCK_WAIT seconds).
 *
 * A cron run and an on-demand run must never push at once, so the script
 * takes a flock. Cron keeps today's behaviour (LOCK_WAIT unset or 0: a held
 * lock is an immediate skipped:already-running, exit 75). The first base after
 * a promotion (pushBaseBackupAfterPromote) cannot treat that skip as done: the
 * run holding the lock is either a fast standby-role skip or a push of the
 * very base it wants, so it waits for the lock within a budget and then pushes.
 *
 * Runs the real script under bash with a stub `docker` on PATH and a lock
 * file in a scratch dir (VC_BACKUP_LOCKFILE), held by a real `flock` process.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { composeBackupCmd } from '../../../src/lib/deploy/compose/index.js';

const SCRIPT = fileURLToPath(new URL('../../../carbon/backup/compose-backup.sh', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'backup-lock-wait-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let holder: ChildProcess | null = null;
afterEach(() => {
  holder?.kill('SIGKILL');
  holder = null;
});

/** A project dir whose `docker compose exec` stub prints a pushed marker. */
function project() {
  const dir = mkdtempSync(join(scratch, 'p-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\necho "docker $*" >> "${log}"\necho BACKUP_RESULT=pushed:base_000000020000000000000005\n`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  return { dir, bin, lock: join(dir, 'backup.lock'), calls: () => readFileSync(log, 'utf-8') };
}

/** Hold the lock for `seconds` in another process; resolves once it is held. */
async function holdLock(lock: string, seconds: number) {
  holder = spawn('flock', [lock, 'sleep', String(seconds)], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (spawnSync('flock', ['-n', lock, 'true']).status !== 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the lock was never taken');
}

function runBackup(p: ReturnType<typeof project>, env: Record<string, string> = {}) {
  const started = Date.now();
  const r = spawnSync('bash', [SCRIPT], {
    cwd: p.dir,
    encoding: 'utf-8',
    env: { PATH: `${p.bin}:${process.env.PATH}`, VC_BACKUP_LOCKFILE: p.lock, ...env },
    timeout: 30_000,
  });
  return { ...r, elapsedMs: Date.now() - started, calls: p.calls() };
}

describe('compose-backup.sh lock wait', () => {
  it('no LOCK_WAIT (cron): a held lock is an immediate skip, as before', async () => {
    const p = project();
    await holdLock(p.lock, 5);
    const r = runBackup(p);
    expect(r.status).toBe(75);
    expect(r.stdout).toContain('BACKUP_RESULT=skipped:already-running');
    expect(r.elapsedMs).toBeLessThan(2_000);
    expect(r.calls).toBe('');
  });

  it('a lock released within LOCK_WAIT: the run waits, then pushes', async () => {
    const p = project();
    await holdLock(p.lock, 1);
    const r = runBackup(p, { LOCK_WAIT: '10' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('BACKUP_RESULT=pushed:base_000000020000000000000005');
    expect(r.stdout).not.toContain('already-running');
    expect(r.calls).toContain('docker compose exec');
  });

  it('a lock held past LOCK_WAIT: skipped, as today', async () => {
    const p = project();
    await holdLock(p.lock, 10);
    const r = runBackup(p, { LOCK_WAIT: '1' });
    expect(r.status).toBe(75);
    expect(r.stdout).toContain('BACKUP_RESULT=skipped:already-running');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(900);
    expect(r.calls).toBe('');
  });

  it('a symlink at the lock path is refused, its target untouched', () => {
    const p = project();
    const target = join(p.dir, 'victim');
    writeFileSync(target, 'keep');
    symlinkSync(target, p.lock);
    const r = runBackup(p);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is a symlink, refusing');
    expect(r.calls).toBe('');
    expect(readFileSync(target, 'utf-8')).toBe('keep');
  });

  it('the lock is opened without truncation', () => {
    const p = project();
    writeFileSync(p.lock, 'keep');
    const r = runBackup(p);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(p.lock, 'utf-8')).toBe('keep');
  });

  it('a LOCK_WAIT that is not a whole number of seconds is no wait', async () => {
    const p = project();
    await holdLock(p.lock, 5);
    const r = runBackup(p, { LOCK_WAIT: '5; rm -rf /' });
    expect(r.status).toBe(75);
    expect(r.elapsedMs).toBeLessThan(2_000);
  });
});

describe('composeBackupCmd lock wait', () => {
  it('binds LOCK_WAIT to bash only when asked', () => {
    expect(composeBackupCmd('/opt/x', 5)).not.toContain('LOCK_WAIT');
    expect(composeBackupCmd('/opt/x', 5, { lockWaitS: 900 })).toMatch(
      /LOCK_WAIT=900 RETAIN=5 bash backup\/compose-backup\.sh/,
    );
    expect(composeBackupCmd('/opt/x', 5, { lockWaitS: -1 })).not.toContain('LOCK_WAIT');
  });
});
