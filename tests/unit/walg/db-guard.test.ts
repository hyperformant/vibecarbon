import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * carbon/volumes/db/db-guard.sh is the compose db container's entrypoint. A
 * restore leaves `.vc-restore-in-progress` in PGDATA while it swaps the
 * fetched cluster in; a boot that finds it with no restore running would
 * start postgres on a half-moved data directory (or initdb an empty one), so
 * it refuses and says what to do. Otherwise it hands over to the image's own
 * db-entrypoint.sh unchanged.
 */
const GUARD = join(process.cwd(), 'carbon/volumes/db/db-guard.sh');

let dir: string;
let pgdata: string;
let bin: string;

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
