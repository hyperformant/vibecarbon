import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The app no longer migrates at boot: app-migrate applies db/migrations as the
// owner and sets app_service's password. A restore to a point before a
// deployed migration, or from a backup that carries an older app_service
// password, must rerun it before the app starts, or the app answers 503 (or
// cannot log in) after a "successful" restore.

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/command.js')>();
  return { ...actual, runCommandAsync: vi.fn() };
});
vi.mock('../../../src/lib/ssh.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/ssh.js')>();
  return { ...actual, sshRunScript: vi.fn(async () => '') };
});

import { runCommandAsync } from '../../../src/lib/command.js';
import { composeFileFlags } from '../../../src/lib/deploy/bundle.js';
import {
  renderComposeCommand,
  VC_COMPOSE,
  VC_COMPOSE_SCRIPT,
} from '../../../src/lib/deploy/compose/command.js';
import { restoreCompose } from '../../../src/lib/deploy/compose/index.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const MIGRATE = `cd /opt/proj && ${VC_COMPOSE} run --rm --no-deps app-migrate`;

/** A resolved restore point, as restore.js hands it to restoreCompose. */
const RESTORE = {
  backup: 'base_000000010000000000000002',
  lineage: '7699032860122738725',
  target: 'latest',
  recoveryConf: '-restore_command\nrestore_command = \'wal-g wal-fetch "%f" "%p"\'',
  assertWritable: async () => 'writable',
};

function sentCommands(): string[] {
  return vi.mocked(runCommandAsync).mock.calls.map((c) => String((c[0] as string[]).at(-1)));
}

function remoteCommands(): string[] {
  return sentCommands().filter((s) => s.includes(VC_COMPOSE));
}

let migrateFails = false;

beforeEach(() => {
  migrateFails = false;
  vi.mocked(runCommandAsync).mockReset();
  vi.mocked(runCommandAsync).mockImplementation(async (argv: unknown) => {
    const cmd = String((argv as string[]).at(-1));
    if (cmd.includes('pg_is_in_recovery')) return 'f\n';
    if (migrateFails && cmd.includes('app-migrate')) throw new Error('exit 1');
    return '';
  });
});

describe('restoreCompose reruns app-migrate before the app comes back', () => {
  it('runs app-migrate to completion after ANALYZE and before `start app`', async () => {
    await restoreCompose('1.2.3.4', '/tmp/key', 'proj', RESTORE, { staleRetryDelaysMs: [] });
    const cmds = remoteCommands();
    const analyzeIdx = cmds.findIndex((c) => /psql\b.*\bANALYZE\b/.test(c));
    const migrateIdx = cmds.indexOf(MIGRATE);
    const appStartIdx = cmds.indexOf(`cd /opt/proj && ${VC_COMPOSE} start app`);
    expect(migrateIdx, `no app-migrate run in:\n${cmds.join('\n')}`).toBeGreaterThan(-1);
    expect(migrateIdx).toBeGreaterThan(analyzeIdx);
    expect(migrateIdx).toBeLessThan(appStartIdx);
  });

  it('a failed migration fails the restore loudly and leaves the app stopped', async () => {
    migrateFails = true;
    await expect(
      restoreCompose('1.2.3.4', '/tmp/key', 'proj', RESTORE, { staleRetryDelaysMs: [] }),
    ).rejects.toThrow(/app-migrate failed after the restore/);
    expect(remoteCommands().some((c) => c.endsWith(`${VC_COMPOSE} start app`))).toBe(false);
  });
});

/**
 * DO compose-ha scale, 2026-11-04: "restoreCompose: app-migrate failed after
 * the restore ... docker compose run --rm --no-deps app-migrate ... failed to
 * solve: ... "/docker-entrypoint.sh": not found". The bare run read
 * docker-compose.yml alone, where app-migrate is a build; the server has no
 * build context. The prod override gives it the deployed image and resets the
 * build, so the migrate step must run with the server's whole -f set.
 */
describe('the post-restore migrate runs from the server -f set (prod override included)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('the command restoreCompose sends reaches compose with docker-compose.prod.yml', async () => {
    await restoreCompose('1.2.3.4', '/tmp/key', 'proj', RESTORE, { staleRetryDelaysMs: [] });
    const migrate = sentCommands().find((c) => c.includes('app-migrate'));
    expect(migrate).toBe(MIGRATE);

    // Run it on a stand-in server dir: the bundle's vc-compose (single compose
    // server: no replication overlay) and a docker that records its argv.
    const server = mkdtempSync(join(tmpdir(), 'vc-restore-migrate-'));
    dirs.push(server);
    writeFileSync(join(server, VC_COMPOSE_SCRIPT), renderComposeCommand(composeFileFlags({})));
    writeFileSync(
      join(server, 'docker'),
      `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${server}/argv"\n`,
    );
    chmodSync(join(server, 'docker'), 0o755);
    const r = spawnSync('sh', ['-c', String(migrate).replace('/opt/proj', server)], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${server}:${process.env.PATH}` },
    });
    expect(r.status, r.stderr).toBe(0);
    const argv = readFileSync(join(server, 'argv'), 'utf-8').trim().split('\n');
    expect(argv.slice(0, 5)).toEqual([
      'compose',
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.prod.yml',
    ]);
    expect(argv.slice(-4)).toEqual(['run', '--rm', '--no-deps', 'app-migrate']);
  });

  it('in that set app-migrate is the deployed image, its build reset (and a build in the base file)', () => {
    const block = (file: string) => {
      const text = readFileSync(join(REPO, 'carbon', file), 'utf-8');
      return text.split(/^ {2}app-migrate:\s*$/m)[1]?.split(/^ {2}\S/m)[0] ?? '';
    };
    const base = block('docker-compose.yml');
    const prod = block('docker-compose.prod.yml');
    expect(base).toMatch(/^ {4}build:\s*$/m);
    expect(base).not.toMatch(/^ {4}image:/m);
    expect(prod).toMatch(/^ {4}image: \$\{APP_IMAGE/m);
    expect(prod).toMatch(/^ {4}build: !reset null\s*$/m);
  });

  it('every Compose call it sends, on success and on a failed fetch, goes through vc-compose', async () => {
    await restoreCompose('1.2.3.4', '/tmp/key', 'proj', RESTORE, { staleRetryDelaysMs: [] });
    vi.mocked(runCommandAsync).mockImplementation(async (argv: unknown) => {
      const cmd = String((argv as string[]).at(-1));
      if (cmd.includes('bash /restore.sh')) throw new Error('fetch failed');
      if (cmd.includes('--entrypoint sh db')) return 'VC_MARKER_ABSENT\n';
      return '';
    });
    await expect(
      restoreCompose('1.2.3.4', '/tmp/key', 'proj', RESTORE, { staleRetryDelaysMs: [] }),
    ).rejects.toThrow(/nothing was moved/);
    const cmds = sentCommands();
    expect(cmds.filter((c) => /\bdocker compose\b|-f docker-compose/.test(c))).toEqual([]);
    for (const c of remoteCommands()) {
      expect(c.startsWith(`cd /opt/proj && ${VC_COMPOSE} `), c).toBe(true);
    }
    // stop app, stop db, the restore run, start db, migrate, start app, and
    // the failure path's probe and restart all appear.
    expect(remoteCommands().some((c) => c.includes('--entrypoint sh db'))).toBe(true);
    expect(remoteCommands().some((c) => c.includes(' run --rm --name proj-db-restore '))).toBe(
      true,
    );
  });
});
