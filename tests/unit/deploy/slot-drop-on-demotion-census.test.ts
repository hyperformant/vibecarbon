/**
 * Every demotion drops the old primary's inactive replication slots
 * (HA-correctness Task 7, H5).
 *
 * After a failover the old primary still holds the slot its standby streamed
 * through. Nobody streams from it any more, so it is inactive, and it would pin
 * WAL on that node until max_slot_wal_keep_size. Each demotion path runs
 * DROP_INACTIVE_SLOTS_SQL:
 *
 *   - compose: demoteComposeWalgRole (failover, scale, and the retired fence's
 *     compose wal-g role step);
 *   - k8s: demoteK8sWalgRole (failover's old-primary demotion, its abort, and
 *     the retired fence's k8s wal-g role step).
 *
 * The drop works on a write-fenced server: verified on
 * postgres:17.11-walg3.0.9-r2 with default_transaction_read_only=on.
 *
 * Census: every write that can set a node's wal-g role to standby, through
 * any writer (setK8sWalgRole, writeComposeWalgRole, composeWalgRoleWriteShell,
 * walgRoleWriteShell, dbRoleConfigMapManifest, k8sWalgRoleExecArgv, or a shell
 * write of the role file), is a known site. A demotion drops the inactive
 * slots in the same function; every other site is a write on a node that holds
 * no slot a failover leaves behind, with its reason. A writer call whose role
 * is a variable counts: it can be standby. The calls are found by a bracket-
 * balancing scanner (tests/unit/helpers/js-call-scan.ts), so a call whose
 * arguments span lines is read whole; a line-based grep missed those.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { demoteComposeWalgRole } from '../../../src/lib/deploy/compose/ha.js';
import { DROP_INACTIVE_SLOTS_SQL } from '../../../src/lib/deploy/replication-slot.js';
import { demoteK8sWalgRole } from '../../../src/lib/deploy/walg-role.js';
import { composeRoleReply, composeRoleWriteOf } from '../helpers/compose-role-ssh.js';
import { type CallSite, findCalls, functionRanges, lexMask } from '../helpers/js-call-scan.js';

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

  it('drops inactive slots before the standby role write', async () => {
    const calls: Array<{ argv: string[]; input?: string }> = [];
    const kubectl = vi.fn(async (_ip: string, argv: string[], opts?: { input?: string }) => {
      calls.push({ argv, input: opts?.input });
      return '';
    });
    const out = await demoteK8sWalgRole({ ip: '10.0.0.1', kubectl, ...quiet });
    const drop = calls.findIndex((c) => c.argv.includes(DROP_INACTIVE_SLOTS_SQL));
    const role = calls.findIndex((c) => String(c.input).includes('VC_WALG_ROLE_INTENT: standby'));
    expect(drop).toBeGreaterThan(-1);
    expect(role).toBeGreaterThan(drop);
    expect(calls[drop].argv).toEqual(expect.arrayContaining(['exec', 'db-0', 'psql']));
    expect(out).toMatchObject({ slotsDropped: true, intent: true });
  });

  it('a failed drop still demotes, and warns once with the cause', async () => {
    const warn = vi.fn();
    const kubectl = vi.fn(async (_ip: string, argv: string[]) => {
      if (argv.includes(DROP_INACTIVE_SLOTS_SQL)) throw new Error('pod db-0 is not running');
      return '';
    });
    const out = await demoteK8sWalgRole({ ip: '10.0.0.1', kubectl, warn });
    expect(
      kubectl.mock.calls.some(([, , o]) =>
        String((o as { input?: string } | undefined)?.input).includes(
          'VC_WALG_ROLE_INTENT: standby',
        ),
      ),
    ).toBe(true);
    expect(out).toMatchObject({ slotsDropped: false, intent: true });
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
  /** A compose old primary: its role-file writes (argv) and psql (string) in one log. */
  const node = (over: { drop?: () => never; roleBack?: string } = {}) => {
    const commands: string[] = [];
    const run = vi.fn(async (_ip: string, _k: string, command: string) => {
      commands.push(command);
      if (command.includes(DROP_INACTIVE_SLOTS_SQL) && over.drop) over.drop();
      return '';
    });
    const roleRun = vi.fn(async (_ip: string, _k: string, argv: string[]) => {
      const command = argv.join(' ');
      commands.push(command);
      return over.roleBack ?? composeRoleReply(command) ?? '';
    });
    return { commands, run, roleRun };
  };

  it('after the host role write (standby), on the old primary, with no db recreate', async () => {
    const n = node();
    const ok = await demoteComposeWalgRole({
      oldPrimaryIp: '10.0.0.1',
      sshKeyPath: '/k',
      projectName: 'myapp',
      deps: { run: n.run, roleRun: n.roleRun, log: () => {}, warn: () => {} },
    });
    expect(ok).toBe(true);
    const write = n.commands.findIndex((c) => composeRoleWriteOf(c) === 'standby');
    const drop = n.commands.findIndex((c) => c.includes(DROP_INACTIVE_SLOTS_SQL));
    expect(write).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(write);
    expect(n.commands[drop]).toContain('docker compose exec -T db psql');
    expect(n.commands.some((c) => c.includes('up -d'))).toBe(false);
  });

  it('a failed drop keeps the demotion verdict and warns once', async () => {
    const warn = vi.fn();
    const n = node({
      drop: () => {
        throw new Error('db is restarting');
      },
    });
    const ok = await demoteComposeWalgRole({
      oldPrimaryIp: '10.0.0.1',
      sshKeyPath: '/k',
      projectName: 'myapp',
      deps: { run: n.run, roleRun: n.roleRun, log: () => {}, warn },
    });
    expect(ok).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('db is restarting');
  });

  it('a role file that does not read back standby is not demoted, warns, and drops nothing', async () => {
    const warn = vi.fn();
    const n = node({ roleBack: 'WALG_ROLE_FILE=primary' });
    const ok = await demoteComposeWalgRole({
      oldPrimaryIp: '10.0.0.1',
      sshKeyPath: '/k',
      projectName: 'myapp',
      deps: { run: n.run, roleRun: n.roleRun, log: () => {}, warn },
    });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/read back as "primary"/);
    expect(n.commands.some((c) => c.includes(DROP_INACTIVE_SLOTS_SQL))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// census
// ---------------------------------------------------------------------------

/** Every file under `dir` (relative to `root`), walked, never listed by hand. */
const walk = (root: string, dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((n) => {
    const p = join(dir, n);
    return statSync(join(root, p)).isDirectory() ? walk(root, p) : [p];
  });

/** Every role writer, by the name a caller spells. */
const WRITERS = [
  'setK8sWalgRole',
  'writeComposeWalgRole',
  'composeWalgRoleWriteShell',
  'walgRoleWriteShell',
  'dbRoleConfigMapManifest',
  'k8sWalgRoleExecArgv',
] as const;

/** The role a writer call writes: a literal word, or `variable` (could be standby). */
function roleOf(call: CallSite): 'primary' | 'standby' | 'variable' {
  let arg: string | undefined;
  if (call.name === 'setK8sWalgRole' || call.name === 'writeComposeWalgRole') {
    const obj = call.args[0] ?? '';
    const prop = /(?:^|[{,\s])role\s*(?::\s*([^,}]+?))?\s*(?=[,}]|$)/.exec(obj);
    arg = prop?.[1];
  } else if (call.name === 'composeWalgRoleWriteShell' || call.name === 'walgRoleWriteShell') {
    arg = call.args[1];
  } else {
    arg = call.args[0];
  }
  const word = /^(['"`])(primary|standby)\1$/.exec((arg ?? '').trim())?.[2];
  return word === 'primary' || word === 'standby' ? word : 'variable';
}

/**
 * `file:function` of every write that can set a node to standby: a writer
 * call whose role is not the literal `primary` (a variable role can be
 * standby), and every shell write of the role file. A writer composing
 * another writer inside walg-role.js passes its caller's role through and is
 * censused at that caller.
 */
function standbyWriteSites(root: string): string[] {
  const js = ['src', 'tests/e2e'].flatMap((d) => walk(root, d)).filter((f) => /\.(js|ts)$/.test(f));
  const fromCalls = js.flatMap((f) =>
    findCalls(readFileSync(join(root, f), 'utf-8'), WRITERS)
      .filter((c) => roleOf(c) !== 'primary')
      .filter(
        (c) =>
          !(f === 'src/lib/deploy/walg-role.js' && (WRITERS as readonly string[]).includes(c.fn)),
      )
      .map((c) => `${f}:${c.fn}`),
  );
  const shell = walk(root, 'carbon')
    .filter((f) => /\.(sh|ya?ml)$/.test(f))
    .filter((f) =>
      readFileSync(join(root, f), 'utf-8')
        .split('\n')
        .some(
          (l) =>
            !/^\s*#/.test(l) &&
            /(?<![>&\d])>{1,2}(?!&)\s*\S*walg-role\b|\bmv\b[^\n]*\bwalg-role\b/.test(l),
        ),
    )
    .map((f) => `${f}:shell`);
  return [...new Set([...fromCalls, ...shell])].sort();
}

/** The function body text of `name` in a file. */
function functionText(root: string, file: string, name: string): string {
  const text = readFileSync(join(root, file), 'utf-8');
  const range = functionRanges(text, lexMask(text)).find((r) => r.name === name);
  return range ? text.slice(range.start, range.end + 1) : '';
}

const DROPS_SLOTS = 'drops-slots';

/** The drops-slots sites whose function does not drop the inactive slots. */
function unpairedDemoters(root: string, writes: Record<string, string>): string[] {
  return Object.entries(writes)
    .filter(([, why]) => why === DROPS_SLOTS)
    .map(([site]) => site)
    .filter((site) => {
      const [file, fn] = site.split(':');
      return !/dropInactiveReplicationSlots\(/.test(functionText(root, file, fn));
    });
}

/**
 * Every standby role write. `drops-slots`: a demotion, which drops the node's
 * inactive replication slots in the same function. Anything else is a write on
 * a node that holds no slot a failover leaves behind, with the reason.
 */
const STANDBY_WRITES: Record<string, string> = {
  'src/lib/deploy/walg-role.js:demoteK8sWalgRole': DROPS_SLOTS,
  'src/lib/deploy/compose/ha.js:demoteComposeWalgRole': DROPS_SLOTS,
  'src/failover.js:disarmStandby':
    "failover's disarm after a failed arm or journal write (no journal at entry): the " +
    'standby is still in recovery and was never promoted, so it holds no slot a failover ' +
    'leaves behind',
  'src/lib/deploy/compose/ha.js:disarmComposeStandby':
    "failover's disarm after a failed arm or journal write (no journal at entry): the " +
    'standby is still in recovery and was never promoted',
  'src/lib/deploy/compose/ha.js:disarmStandby':
    'composeFailoverAbortBackend (failover -abort): writes the standby role file only once its writers are stopped and ' +
    'its db is proven down; the next start is a deploy that reseeds it (PGDATA and slots)',
  'src/lib/deploy/effects/compose-ha.js:haWriteNodeRoles':
    'deploy-time role write: the standby is in recovery or about to be reseeded, which ' +
    'replaces PGDATA and every slot in it; a former primary was demoted (slots dropped) by ' +
    'the failover that swapped the config',
  'src/lib/deploy/k8s/k3s.js:applyVibecarbonSecrets':
    "deploy-time intent (the configured role of this cluster's db, created before its pod): " +
    'the standby cluster is in recovery or about to be reseeded; a former primary was ' +
    'demoted by the failover that swapped the config',
  'src/lib/deploy/k8s/k3s.js:writeDeployWalgRole':
    'deploy-time live role write, same reason as the intent above',
  'src/scale.js:prepareReplacementServer':
    'a replacement server takes the role of the one it replaces before its db first starts: ' +
    'a new standby has an empty PGDATA, reseeded from the primary, so no slot',
  'carbon/volumes/db/db-guard.sh:shell':
    'db-guard.sh applies the k8s intent on container start, before postgres runs; the CLI ' +
    'write that set a standby intent is itself one of the sites above',
  'carbon/k8s/base/backup/configmap-walg.yaml:shell':
    "db-guard.sh's ConfigMap copy (byte-identical, walg-archive-script-parity.test.ts)",
};

describe('census: every standby role write is a demotion that drops slots', () => {
  it('every standby-capable role write is a known site', () => {
    expect(standbyWriteSites(ROOT)).toEqual(Object.keys(STANDBY_WRITES).sort());
  });

  it('every drops-slots site drops the inactive slots in the same function', () => {
    expect(unpairedDemoters(ROOT, STANDBY_WRITES)).toEqual([]);
  });

  it('both k8s demotion paths go through demoteK8sWalgRole', () => {
    for (const path of ['src/failover.js', 'src/lib/deploy/retired-fence.js']) {
      expect(readFileSync(join(ROOT, path), 'utf-8'), path).toMatch(/demoteK8sWalgRole\(/);
    }
  });
});

describe('census bites', () => {
  /** A temp repo: an empty src/, tests/e2e/ and carbon/, plus `files`. */
  const fixture = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-slot-census-'));
    for (const d of ['src', 'tests/e2e', 'carbon']) mkdirSync(join(dir, d), { recursive: true });
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    return dir;
  };

  /** The census as it was: one line, one regex (kept here only to prove what it missed). */
  const LINE_BASED =
    /writeComposeWalgRole\(\{[^)]*role:\s*'standby'|composeWalgRoleWriteShell\([^)]*'standby'/;

  const multiLine = [
    'export async function sneakyDemote(ip) {',
    '  await writeComposeWalgRole({',
    '    ip,',
    '    sshKeyPath,',
    '    projectName,',
    "    role: 'standby',",
    '  });',
    '}',
    '',
  ].join('\n');

  it('a multi-line standby write the line-based census missed is caught, with its function', () => {
    expect(multiLine.split('\n').some((l) => LINE_BASED.test(l))).toBe(false);
    const dir = fixture({ 'src/stray.js': multiLine });
    try {
      expect(standbyWriteSites(dir)).toEqual(['src/stray.js:sneakyDemote']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a variable role, a raw file write and a shell write are each caught; primary is not', () => {
    const dir = fixture({
      'src/a.js': 'function a(role) { return k8sWalgRoleExecArgv(role); }\n',
      'src/b.js': "const b = (dir) => {\n  return walgRoleWriteShell(dir, 'standby');\n};\n",
      'src/c.js': "function c() { return setK8sWalgRole({ ip, kubectl, role: 'primary' }); }\n",
      'tests/e2e/d.ts': "function d() { dbRoleConfigMapManifest('standby'); }\n",
      'carbon/x.sh': 'printf \'standby\\n\' > "$DIR/walg-role.tmp"\n',
    });
    try {
      expect(standbyWriteSites(dir)).toEqual([
        'carbon/x.sh:shell',
        'src/a.js:a',
        'src/b.js:b',
        'tests/e2e/d.ts:d',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a drops-slots site whose function drops nothing is caught', () => {
    const dir = fixture({
      'src/demote.js':
        "export async function demote(ip) {\n  await setK8sWalgRole({ ip, kubectl, role: 'standby' });\n}\n",
    });
    try {
      expect(standbyWriteSites(dir)).toEqual(['src/demote.js:demote']);
      expect(unpairedDemoters(dir, { 'src/demote.js:demote': DROPS_SLOTS })).toEqual([
        'src/demote.js:demote',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the scanner skips comments and strings, and reads template interpolations', () => {
    const text = [
      "// setK8sWalgRole({ role: 'standby' })",
      'const s = "setK8sWalgRole({ role: \'standby\' })";',
      'const re = /setK8sWalgRole\\(/;',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text for the scanner
      "const t = `x ${walgRoleWriteShell(d, 'standby')} y`;",
    ].join('\n');
    const calls = findCalls(text, WRITERS);
    expect(calls.map((c) => [c.name, roleOf(c)])).toEqual([['walgRoleWriteShell', 'standby']]);
  });
});
