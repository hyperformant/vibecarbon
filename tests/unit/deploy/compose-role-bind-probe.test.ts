/**
 * The compose twin of podMountsWalgRoleDir: does the RUNNING db container bind
 * the role directory? A container created from a scaffold before the role file
 * has no bind, so a role write on the host never reaches it. Failover refuses
 * that node before any change (compose-ha-failover-role-bind.test.ts).
 *
 * The probe script runs here for real against a fake `docker` on PATH.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  composeDbMountsWalgRoleDir,
  composeRoleBindProbeShell,
  WALG_ROLE_DIR,
} from '../../../src/lib/deploy/walg-role.js';
import { shEscape } from '../../../src/lib/shell.js';

const work = mkdtempSync(join(tmpdir(), 'vc-role-bind-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A PATH dir whose `docker inspect` prints `mounts` for acme-db, or fails. */
function fakeDocker(name: string, mounts: string[] | null) {
  const bin = join(work, name);
  mkdirSync(bin, { recursive: true });
  const body =
    mounts === null
      ? 'echo "Error: No such object" >&2; exit 1'
      : `[ "$1" = inspect ] || exit 9\nfor a; do last="$a"; done\n[ "$last" = acme-db ] || exit 8\nprintf '%s\\n' ${mounts.map(shEscape).join(' ')}`;
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  return bin;
}
function probe(bin: string) {
  return spawnSync('sh', ['-c', composeRoleBindProbeShell('acme')], {
    encoding: 'utf-8',
    env: { PATH: `${bin}:/usr/bin:/bin` },
  });
}

describe('composeRoleBindProbeShell', () => {
  it('reports present when the db container binds the role directory', () => {
    const r = probe(fakeDocker('yes', ['/var/lib/postgresql/data', WALG_ROLE_DIR]));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('VC_ROLE_BIND=present');
  });

  it('reports absent for a container from before the bind (a prefix is not a match)', () => {
    const r = probe(fakeDocker('no', ['/var/lib/postgresql/data', `${WALG_ROLE_DIR}-old`]));
    expect(r.stdout.trim()).toBe('VC_ROLE_BIND=absent');
  });

  it('prints nothing when the container cannot be inspected', () => {
    const r = probe(fakeDocker('gone', null));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('refuses an unsafe project name', () => {
    expect(() => composeRoleBindProbeShell('a b; rm -rf /')).toThrow();
  });
});

describe('composeDbMountsWalgRoleDir', () => {
  const args = { ip: '203.0.113.5', sshKeyPath: '/k', projectName: 'acme' };

  it('sends the probe as one `sh -c` token and reads the verdict', async () => {
    const run = vi.fn(async () => 'VC_ROLE_BIND=present\n');
    expect(await composeDbMountsWalgRoleDir({ ...args, run })).toBe(true);
    expect(run.mock.calls[0]).toEqual([
      '203.0.113.5',
      '/k',
      ['sh', '-c', composeRoleBindProbeShell('acme')],
      { timeout: 30_000 },
    ]);
    run.mockResolvedValueOnce('VC_ROLE_BIND=absent\n');
    expect(await composeDbMountsWalgRoleDir({ ...args, run })).toBe(false);
  });

  it('is null (unknown, never a refusal) when the probe prints nothing or ssh fails', async () => {
    expect(await composeDbMountsWalgRoleDir({ ...args, run: vi.fn(async () => '') })).toBeNull();
    const fail = vi.fn(async () => {
      throw new Error('ssh: connect timed out');
    });
    expect(await composeDbMountsWalgRoleDir({ ...args, run: fail })).toBeNull();
  });
});
