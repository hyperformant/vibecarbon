/**
 * Every demotion drops the old primary's inactive replication slots
 * (HA-correctness Task 7, H5).
 *
 * After a failover the old primary still holds the slot its standby streamed
 * through. Nobody streams from it any more, so it is inactive, and it would pin
 * WAL on that node until max_slot_wal_keep_size. Each demotion path runs
 * DROP_INACTIVE_SLOTS_SQL:
 *
 *   - compose: demoteComposeWalgRole (failover, and the retired fence's compose
 *     WALG_ROLE step);
 *   - k8s: demoteK8sWalgRole (failover's restorePromotedWalgRole, and the
 *     retired fence's k8s WALG_ROLE step).
 *
 * The drop works on a write-fenced server: verified on
 * postgres:17.11-walg3.0.9-r2 with default_transaction_read_only=on.
 *
 * Census: the k8s standby role write (`k8sSetWalgRoleArgv('standby')`) lives
 * only in demoteK8sWalgRole, and the compose one (`composeRoleEnv('standby')`)
 * only in demoteComposeWalgRole plus the deploy-time role merge, which runs on
 * a standby that is in recovery or about to be reseeded (a reseed replaces
 * PGDATA, slots included).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { demoteComposeWalgRole } from '../../../src/lib/deploy/compose/ha.js';
import { DROP_INACTIVE_SLOTS_SQL } from '../../../src/lib/deploy/replication-slot.js';
import { demoteK8sWalgRole } from '../../../src/lib/deploy/walg-role.js';

const ROOT = join(__dirname, '../../..');

describe('DROP_INACTIVE_SLOTS_SQL', () => {
  it('is the reviewed statement', () => {
    expect(DROP_INACTIVE_SLOTS_SQL).toBe(
      'SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE NOT active',
    );
  });
});

describe('demoteK8sWalgRole', () => {
  const quiet = { warn: () => {} };

  it('drops inactive slots before the role write rolls the db pod', async () => {
    const calls: string[][] = [];
    const kubectl = vi.fn(async (_ip: string, argv: string[]) => {
      calls.push(argv);
      return '';
    });
    const out = await demoteK8sWalgRole({ ip: '10.0.0.1', kubectl, ...quiet });
    const drop = calls.findIndex((a) => a.includes(DROP_INACTIVE_SLOTS_SQL));
    const role = calls.findIndex((a) => a.includes('WALG_ROLE=standby'));
    expect(drop).toBeGreaterThan(-1);
    expect(role).toBeGreaterThan(drop);
    expect(calls[drop]).toEqual(expect.arrayContaining(['exec', 'db-0', 'psql']));
    expect(out).toEqual({ slotsDropped: true });
  });

  it('a failed drop still demotes, and warns once with the cause', async () => {
    const warn = vi.fn();
    const kubectl = vi.fn(async (_ip: string, argv: string[]) => {
      if (argv.includes(DROP_INACTIVE_SLOTS_SQL)) throw new Error('pod db-0 is not running');
      return '';
    });
    const out = await demoteK8sWalgRole({ ip: '10.0.0.1', kubectl, warn });
    expect(kubectl.mock.calls.some(([, a]) => a.includes('WALG_ROLE=standby'))).toBe(true);
    expect(out).toEqual({ slotsDropped: false });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('pod db-0 is not running');
  });

  it('a failed role write throws, and does not also warn about the slot', async () => {
    const warn = vi.fn();
    const kubectl = vi.fn(async () => {
      throw new Error('ssh: connect to host 10.0.0.1 port 22: Connection refused');
    });
    await expect(demoteK8sWalgRole({ ip: '10.0.0.1', kubectl, warn })).rejects.toThrow(
      /Connection refused/,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('demoteComposeWalgRole drops inactive slots', () => {
  it('after the db recreate, on the old primary', async () => {
    const commands: string[] = [];
    const run = vi.fn(async (_ip: string, _k: string, command: string) => {
      commands.push(command);
      return '';
    });
    const ok = await demoteComposeWalgRole({
      oldPrimaryIp: '10.0.0.1',
      sshKeyPath: '/k',
      projectName: 'myapp',
      deps: { run, mergeEnv: async () => {}, log: () => {}, warn: () => {} },
    });
    expect(ok).toBe(true);
    const recreate = commands.findIndex((c) => c.includes('up -d'));
    const drop = commands.findIndex((c) => c.includes(DROP_INACTIVE_SLOTS_SQL));
    expect(recreate).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(recreate);
    expect(commands[drop]).toContain('docker compose exec -T db psql');
  });

  it('a failed drop keeps the demotion verdict and warns once', async () => {
    const warn = vi.fn();
    const run = vi.fn(async (_ip: string, _k: string, command: string) => {
      if (command.includes(DROP_INACTIVE_SLOTS_SQL)) throw new Error('db is restarting');
      return '';
    });
    const ok = await demoteComposeWalgRole({
      oldPrimaryIp: '10.0.0.1',
      sshKeyPath: '/k',
      projectName: 'myapp',
      deps: { run, mergeEnv: async () => {}, log: () => {}, warn },
    });
    expect(ok).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('db is restarting');
  });
});

// ---------------------------------------------------------------------------
// census
// ---------------------------------------------------------------------------

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

/** The name of the function a source offset sits in (nearest preceding declaration). */
function enclosingFunction(text: string, at: number): string {
  const decls = [...text.slice(0, at).matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)];
  return decls.at(-1)?.[1] ?? '<module>';
}

/** `file:function` for every code (non-comment) line matching `pattern`. */
function sitesOf(files: Array<{ path: string; text: string }>, pattern: RegExp): string[] {
  return files.flatMap(({ path, text }) => {
    const out: string[] = [];
    let offset = 0;
    for (const line of text.split('\n')) {
      if (!/^\s*(\/\/|\*|\/\*)/.test(line) && pattern.test(line)) {
        out.push(`${path}:${enclosingFunction(text, offset)}`);
      }
      offset += line.length + 1;
    }
    return out;
  });
}

const SOURCES = walk(join(ROOT, 'src'))
  .filter((p) => p.endsWith('.js'))
  .map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf-8') }));

const K8S_STANDBY_WRITE = /k8sSetWalgRoleArgv\(\s*'standby'\s*\)/;
const COMPOSE_STANDBY_WRITE = /composeRoleEnv\(\s*'standby'\s*\)/;

/** The only places a node is set to the standby role. */
const K8S_DEMOTERS = ['src/lib/deploy/walg-role.js:demoteK8sWalgRole'];
const COMPOSE_DEMOTERS = [
  // deploy-time role merge: the standby is in recovery or is about to be
  // reseeded, which replaces PGDATA and every slot in it.
  'src/lib/deploy/effects/compose-ha.js:haMergeWalgRole',
  'src/lib/deploy/compose/ha.js:demoteComposeWalgRole',
];

describe('census: every standby role write is a demotion that drops slots', () => {
  it('k8s: only demoteK8sWalgRole writes WALG_ROLE=standby', () => {
    expect(sitesOf(SOURCES, K8S_STANDBY_WRITE)).toEqual(K8S_DEMOTERS);
  });

  it('compose: only demoteComposeWalgRole (and the deploy-time merge) writes it', () => {
    expect(sitesOf(SOURCES, COMPOSE_STANDBY_WRITE).sort()).toEqual([...COMPOSE_DEMOTERS].sort());
  });

  it('both k8s demotion paths go through demoteK8sWalgRole', () => {
    for (const path of ['src/failover.js', 'src/lib/deploy/retired-fence.js']) {
      const text = SOURCES.find((s) => s.path === path)?.text ?? '';
      expect(text, path).toMatch(/demoteK8sWalgRole\(/);
    }
  });

  it('bites: a stray standby role write is reported with its function', () => {
    const stray = {
      path: 'src/lib/deploy/stray.js',
      text: "async function sneakyDemote(ip) {\n  await kubectl(ip, k8sSetWalgRoleArgv('standby'));\n}\n",
    };
    expect(sitesOf([...SOURCES, stray], K8S_STANDBY_WRITE)).toEqual([
      ...K8S_DEMOTERS,
      'src/lib/deploy/stray.js:sneakyDemote',
    ]);
  });
});
