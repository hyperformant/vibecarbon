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
 * any writer (every walg-role.js export that takes a role, or a shell write
 * of the role file), is a known site, counted per function. A demotion drops the inactive
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
import {
  type CallSite,
  findCalls,
  functionRanges,
  lex,
  lexMask,
  matchBracket,
} from '../helpers/js-call-scan.js';
import { k8sRoleReply } from '../helpers/k8s-role-kubectl.js';

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

  it('writes the standby role first (intent, then live file), then drops inactive slots: the compose order', async () => {
    const calls: Array<{ argv: string[]; input?: string }> = [];
    const kubectl = vi.fn(async (_ip: string, argv: string[], opts?: { input?: string }) => {
      calls.push({ argv, input: opts?.input });
      return k8sRoleReply(argv) ?? '';
    });
    const out = await demoteK8sWalgRole({ ip: '10.0.0.1', kubectl, ...quiet });
    const drop = calls.findIndex((c) => c.argv.includes(DROP_INACTIVE_SLOTS_SQL));
    const role = calls.findIndex((c) => String(c.input).includes('VC_WALG_ROLE_INTENT: standby'));
    const live = calls.findIndex((c) => c.argv.join(' ').includes('walg-role.tmp'));
    expect(role).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(role);
    expect(drop).toBeGreaterThan(live);
    expect(calls[drop].argv).toEqual(expect.arrayContaining(['exec', 'db-0', 'psql']));
    expect(out).toMatchObject({ slotsDropped: true, intent: true, live: true });
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

  it('a failed role write throws before any slot drop, and does not also warn about the slot', async () => {
    const warn = vi.fn();
    const kubectl = vi.fn(async () => {
      throw new Error('ssh: connect to host 10.0.0.1 port 22: Connection refused');
    });
    await expect(demoteK8sWalgRole({ ip: '10.0.0.1', kubectl, warn })).rejects.toThrow(
      /Connection refused/,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(
      kubectl.mock.calls.some(([, argv]) =>
        (argv as unknown as string[]).includes(DROP_INACTIVE_SLOTS_SQL),
      ),
    ).toBe(false);
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

const ROLE_MODULE = 'src/lib/deploy/walg-role.js';

/**
 * The role writers, read from walg-role.js's exports by one rule: an exported
 * function that takes a `role` (positional or destructured) writes it, except
 * the `assert*` validators, which only check it. A new writer is censused the
 * day it is exported; the rule itself is pinned below.
 */
function writersOf(source: string): { writers: string[]; validators: string[] } {
  const { mask } = lex(source);
  const writers: string[] = [];
  const validators: string[] = [];
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)\s*\(/gm)) {
    const paren = (m.index ?? 0) + m[0].length - 1;
    const params = source.slice(paren, matchBracket(source, mask, paren) + 1);
    if (!/(?<![\w$.])role(?![\w$])/.test(params)) continue;
    (/^assert/.test(m[1]) ? validators : writers).push(m[1]);
  }
  return { writers: writers.sort(), validators: validators.sort() };
}

const WRITERS = writersOf(readFileSync(join(ROOT, ROLE_MODULE), 'utf-8')).writers;

/** Source files the call scanner reads. */
const JS_FILE = /\.(m|c)?[jt]s$/;

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

const JS_ROOTS = ['src', 'tests/e2e'];

/**
 * `file:function`, once per write, of every write that can set a node to
 * standby: a writer call whose role is not the literal `primary` (a variable
 * role can be standby), and every shell line that writes the role file. A
 * writer composing another writer inside walg-role.js passes its caller's role
 * through and is censused at that caller. Throws (via findCalls) on a source
 * the scanner cannot read soundly.
 */
function standbyWriteSites(root: string): string[] {
  const js = JS_ROOTS.flatMap((d) => walk(root, d)).filter((f) => JS_FILE.test(f));
  const fromCalls = js.flatMap((f) =>
    findCalls(readFileSync(join(root, f), 'utf-8'), WRITERS)
      .filter((c) => roleOf(c) !== 'primary')
      .filter((c) => !(f === ROLE_MODULE && WRITERS.includes(c.fn)))
      .map((c) => `${f}:${c.fn}`),
  );
  const shell = walk(root, 'carbon')
    .filter((f) => /\.(sh|ya?ml)$/.test(f))
    .flatMap((f) =>
      readFileSync(join(root, f), 'utf-8')
        .split('\n')
        .filter(
          (l) =>
            !/^\s*#/.test(l) &&
            /(?<![>&\d])>{1,2}(?!&)\s*\S*walg-role\b|\bmv\b[^\n]*\bwalg-role\b/.test(l),
        )
        .map(() => `${f}:shell`),
    );
  return [...fromCalls, ...shell].sort();
}

/** The site list an allowlist expects: each site once per write. */
const expectedSites = (writes: Record<string, StandbyWrite>): string[] =>
  Object.entries(writes)
    .flatMap(([site, w]) => Array.from({ length: w.calls }, () => site))
    .sort();

/** Every walked JS/TS source the scanner cannot read soundly, with the reason. */
function unscannable(root: string): string[] {
  return JS_ROOTS.flatMap((d) => walk(root, d))
    .filter((f) => JS_FILE.test(f))
    .flatMap((f) => lex(readFileSync(join(root, f), 'utf-8')).errors.map((e) => `${f}: ${e}`));
}

/** The function body text of `name` in a file. */
function functionText(root: string, file: string, name: string): string {
  const text = readFileSync(join(root, file), 'utf-8');
  const range = functionRanges(text, lexMask(text)).find((r) => r.name === name);
  return range ? text.slice(range.start, range.end + 1) : '';
}

const DROPS_SLOTS = 'drops-slots';

/** One allowlisted site: how many standby writes it holds, and why each is safe. */
interface StandbyWrite {
  calls: number;
  why: string;
}

/** The drops-slots sites whose function does not drop the inactive slots. */
function unpairedDemoters(root: string, writes: Record<string, StandbyWrite>): string[] {
  return Object.entries(writes)
    .filter(([, w]) => w.why === DROPS_SLOTS)
    .map(([site]) => site)
    .filter((site) => {
      const [file, fn] = site.split(':');
      return !/dropInactiveReplicationSlots\(/.test(functionText(root, file, fn));
    });
}

/**
 * Why a deploy-time standby write never lands on a node holding a failover's
 * stale slot. An unplanned failover cannot reach the old primary, so its
 * demotion (and slot drop) may never have run. What makes the deploy safe:
 *
 *   1. the HA deploy refuses while a failover journal exists
 *      (assertNoFailoverInFlight, src/lib/deploy/orchestrator.js), so it never
 *      runs on a half-swapped config;
 *   2. swapHaRoles (src/failover.js) swaps the roles and clears the journal in
 *      one save, so once the deploy runs, the config names the old primary as
 *      a retired side;
 *   3. the deploy's retired-fence pass (reconcileRetiredFence, orchestrator.js,
 *      first thing once SSH is let in) demotes that side through
 *      demoteK8sWalgRole / demoteComposeWalgRole (retired-fence.js), which
 *      drop its inactive slots, before any role write below.
 *
 * Known gap: when the retired side is unreachable, the fence only warns. Its
 * slots are then cleared by the reseed that rebuilds it as the standby
 * (PGDATA is wiped and replaced), not by a drop.
 */
const DEPLOY_GUARANTEE =
  'a deploy runs only with no failover journal (orchestrator.js assertNoFailoverInFlight); ' +
  'swapHaRoles swaps the roles and clears the journal in one save; the retired-fence pass ' +
  'demotes a retired old primary through demoteK8sWalgRole / demoteComposeWalgRole, which ' +
  'drop its slots, before this write (unreachable: the fence warns, and the reseed that ' +
  'rebuilds it as the standby wipes PGDATA and its slots)';

/**
 * Every standby role write, with its count per function. `drops-slots`: a
 * demotion, which drops the node's inactive replication slots in the same
 * function. Anything else is a write on a node that holds no slot a failover
 * leaves behind, with the reason.
 */
const STANDBY_WRITES: Record<string, StandbyWrite> = {
  'src/lib/deploy/walg-role.js:demoteK8sWalgRole': { calls: 1, why: DROPS_SLOTS },
  'src/lib/deploy/compose/ha.js:demoteComposeWalgRole': { calls: 1, why: DROPS_SLOTS },
  'src/failover.js:disarmStandby': {
    calls: 1,
    why:
      "failover's disarm after a failed arm or journal write (no journal at entry): the " +
      'standby is still in recovery and was never promoted, so it holds no slot a failover ' +
      'leaves behind',
  },
  'src/lib/deploy/compose/ha.js:disarmComposeStandby': {
    calls: 1,
    why:
      "failover's disarm after a failed arm or journal write (no journal at entry): the " +
      'standby is still in recovery and was never promoted',
  },
  'src/lib/deploy/compose/ha.js:disarmStandby': {
    calls: 1,
    why:
      'composeFailoverAbortBackend (failover -abort): the standby it writes was never ' +
      'promoted (the abort runs only before a proven promote), its writers are stopped and ' +
      'its db is proven down; the next start is a deploy that reseeds it (PGDATA and slots)',
  },
  'src/lib/deploy/effects/compose-ha.js:haWriteNodeRoles': {
    calls: 1,
    why: `compose-ha deploy role write: ${DEPLOY_GUARANTEE}`,
  },
  'src/lib/deploy/k8s/k3s.js:applyVibecarbonSecrets': {
    calls: 1,
    why: `k8s deploy intent, applied before the db pod exists: ${DEPLOY_GUARANTEE}`,
  },
  'src/lib/deploy/k8s/k3s.js:writeDeployWalgRole': {
    calls: 1,
    why: `k8s deploy live role write: ${DEPLOY_GUARANTEE}`,
  },
  'src/scale.js:prepareReplacementServer': {
    calls: 1,
    why:
      'a replacement server takes the role of the one it replaces before its db first ' +
      'starts: a new standby has an empty PGDATA, reseeded from the primary, so no slot',
  },
  'carbon/volumes/db/db-guard.sh:shell': {
    calls: 2,
    why:
      'db-guard.sh applies the k8s intent on container start, before postgres runs (the tmp ' +
      'write and the rename); the CLI write that set a standby intent is one of the sites above',
  },
  'carbon/k8s/base/backup/configmap-walg.yaml:shell': {
    calls: 2,
    why: "db-guard.sh's ConfigMap copy (byte-identical, walg-archive-script-parity.test.ts)",
  },
};

describe('census: every standby role write is a demotion that drops slots', () => {
  it('the writers are walg-role.js exports that take a role; only assert* validators are not', () => {
    const { writers, validators } = writersOf(readFileSync(join(ROOT, ROLE_MODULE), 'utf-8'));
    expect(writers).toEqual(
      [
        'composeWalgRoleWriteShell',
        'dbRoleConfigMapManifest',
        'k8sWalgRoleExecArgv',
        'setK8sWalgRole',
        'walgRoleWriteShell',
        'writeComposeWalgRole',
      ].sort(),
    );
    expect(validators).toEqual(['assertWalgRole']);
  });

  it('every walked source lexes cleanly, so no call can hide from the scanner', () => {
    expect(unscannable(ROOT)).toEqual([]);
  });

  it('every standby-capable role write is a known site, counted per function', () => {
    expect(standbyWriteSites(ROOT)).toEqual(expectedSites(STANDBY_WRITES));
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
      'src/e.mjs': "export function e() { return setK8sWalgRole({ role: 'standby' }); }\n",
    });
    try {
      expect(standbyWriteSites(dir)).toEqual([
        'carbon/x.sh:shell',
        'src/a.js:a',
        'src/b.js:b',
        'src/e.mjs:e',
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
      expect(
        unpairedDemoters(dir, { 'src/demote.js:demote': { calls: 1, why: DROPS_SLOTS } }),
      ).toEqual(['src/demote.js:demote']);
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

  it('a second standby write in an allowlisted function is caught by its count', () => {
    const dir = fixture({
      'src/demote.js': [
        'export async function demote(ip) {',
        '  await dropInactiveReplicationSlots(run);',
        "  await setK8sWalgRole({ ip, kubectl, role: 'standby' });",
        "  await writeComposeWalgRole({ ip, role: 'standby' });",
        '}',
        '',
      ].join('\n'),
    });
    try {
      const allow = { 'src/demote.js:demote': { calls: 1, why: DROPS_SLOTS } };
      expect(standbyWriteSites(dir)).not.toEqual(expectedSites(allow));
      expect(standbyWriteSites(dir)).toEqual(['src/demote.js:demote', 'src/demote.js:demote']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a new exported writer that takes a role is censused without a list edit', () => {
    const { writers, validators } = writersOf(
      [
        'export function assertWalgRole(role) {}',
        'export async function moveRole({ ip, role }) {}',
        'export function roleless(ip) {}',
        '',
      ].join('\n'),
    );
    expect(writers).toEqual(['moveRole']);
    expect(validators).toEqual(['assertWalgRole']);
  });

  it('a source the lexer misreads fails loudly instead of dropping a call', () => {
    const misread = "if (x) /\\(/.test(y); setK8sWalgRole({ role: 'standby' });\n";
    expect(lex(misread).errors).not.toEqual([]);
    expect(() => findCalls(misread, WRITERS)).toThrow(/cannot scan soundly/);
    const dir = fixture({ 'src/misread.js': misread });
    try {
      expect(unscannable(dir)).toEqual([
        expect.stringMatching(/^src\/misread\.js: unterminated regex/),
      ]);
      expect(() => standbyWriteSites(dir)).toThrow(/cannot scan soundly/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a call that never closes fails loudly', () => {
    expect(() => findCalls("setK8sWalgRole({ role: 'standby' }\n", WRITERS)).toThrow(
      /cannot scan soundly|no closing paren/,
    );
  });
});
