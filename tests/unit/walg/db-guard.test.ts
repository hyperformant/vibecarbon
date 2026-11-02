import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * carbon/volumes/db/db-guard.sh is the compose db container's entrypoint. A
 * restore leaves `.vc-restore-in-progress` in PGDATA while it swaps the
 * fetched cluster in; a boot that finds it with no restore running would
 * start postgres on a half-moved data directory (or initdb an empty one), so
 * it refuses and says what to do. Otherwise it hands over to the image's own
 * db-entrypoint.sh unchanged.
 */
const GUARD = fileURLToPath(new URL('../../../carbon/volumes/db/db-guard.sh', import.meta.url));

let dir: string;
let pgdata: string;
let bin: string;
let roleDir: string;

function runGuard(env: Record<string, string> = {}) {
  return spawnSync('sh', [GUARD, 'postgres', '-c', 'config_file=/x'], {
    encoding: 'utf-8',
    env: { PATH: `${bin}:${process.env.PATH}`, PGDATA: pgdata, ...env },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-db-guard-'));
  pgdata = join(dir, 'data');
  bin = join(dir, 'bin');
  mkdirSync(pgdata);
  mkdirSync(bin);
  roleDir = join(dir, 'role');
  mkdirSync(roleDir);
  const stub = join(bin, 'db-entrypoint.sh');
  writeFileSync(stub, '#!/bin/sh\necho "STUB-ENTRYPOINT $*"\n');
  chmodSync(stub, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('db-guard.sh', () => {
  it('refuses to boot over an interrupted restore', () => {
    writeFileSync(join(pgdata, '.vc-restore-in-progress'), 'in\n');
    const r = runGuard();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('restore interrupted; rerun vibecarbon restore');
    expect(r.stdout).not.toContain('STUB-ENTRYPOINT');
  });

  it('lets the restore itself through (RESTORE_BACKUP set)', () => {
    writeFileSync(join(pgdata, '.vc-restore-in-progress'), 'in\n');
    const r = runGuard({ RESTORE_BACKUP: 'base_000000010000000000000002' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('STUB-ENTRYPOINT postgres -c config_file=/x');
  });

  it('execs the image entrypoint with the same arguments on a normal boot', () => {
    const r = runGuard();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('STUB-ENTRYPOINT postgres -c config_file=/x');
  });
});

describe('db-guard.sh applies the k8s role intent', () => {
  it('writes the intent atomically into the role dir, then execs the entrypoint', () => {
    const r = runGuard({ VC_WALG_ROLE_INTENT: 'standby', VC_WALG_ROLE_DIR: roleDir });
    expect(r.status).toBe(0);
    expect(readFileSync(join(roleDir, 'walg-role'), 'utf-8')).toBe('standby\n');
    expect(existsSync(join(roleDir, 'walg-role.tmp'))).toBe(false);
    expect(r.stdout).toContain('STUB-ENTRYPOINT postgres');
  });

  it('no intent (compose, or a cluster before its first deploy): leaves the file alone', () => {
    writeFileSync(join(roleDir, 'walg-role'), 'primary\n');
    runGuard({ VC_WALG_ROLE_DIR: roleDir });
    expect(readFileSync(join(roleDir, 'walg-role'), 'utf-8')).toBe('primary\n');
  });

  it('a garbage intent REMOVES the file (no role means hold WAL)', () => {
    writeFileSync(join(roleDir, 'walg-role'), 'primary\n');
    runGuard({ VC_WALG_ROLE_INTENT: 'leader', VC_WALG_ROLE_DIR: roleDir });
    expect(existsSync(join(roleDir, 'walg-role'))).toBe(false);
  });

  it('the intent write ends in sync (the atomic-write constraint)', () => {
    expect(readFileSync(GUARD, 'utf-8')).toMatch(
      /mv -f "\$VC_ROLE_DIR\/walg-role\.tmp" "\$VC_ROLE_DIR\/walg-role"\n\s*sync/,
    );
  });

  it('an interrupted restore still refuses first, before any role write', () => {
    writeFileSync(join(pgdata, '.vc-restore-in-progress'), 'in\n');
    expect(runGuard({ VC_WALG_ROLE_INTENT: 'standby', VC_WALG_ROLE_DIR: roleDir }).status).toBe(1);
    expect(existsSync(join(roleDir, 'walg-role'))).toBe(false);
  });
});
