/**
 * Census: every apt refresh and every unattended-upgrade we run on a server
 * after it booted waits for Ubuntu's daily apt units first.
 *
 * `apt-get update` takes apt's lists lock without waiting for it (the dpkg
 * lock timeout does not apply to it), and unattended-upgrade exits 1 at once
 * when the daily job's own unattended-upgrade holds its lock. Perf run
 * 45940611622 (vultr/k8s-ha, 2026-11-27): `vibecarbon update` checked both db
 * nodes about 4 minutes after they booted, while apt-daily-upgrade was
 * installing there, and skipped both with "unattended-upgrade exited 1".
 * update's check (inspect.js) was the one post-boot apt script that did not
 * call aptWaitForDailyUnits() first.
 *
 * Every src/ call that refreshes apt's lists or runs unattended-upgrade is
 * found by reading the code: aptGet('update ...'), aptQuietUpdate(),
 * aptInstallOrRefresh() (its fallback refreshes) and UNATTENDED_UPGRADE. Its
 * file must be in WAITS, where the same script waits first, or in EXEMPT, with
 * the reason. A WAITS file proves the order twice: in its source (a wait
 * earlier in the same function or declaration) and in the commands it really
 * sends over ssh.
 *
 * The waits are only real if ssh lets them run: an outer timeout shorter than
 * the waits inside it kills the command while apt is lawfully waiting (#46).
 * Every src/ file that runs ssh and builds an apt command is driven with ssh
 * faked (SENT), and every call it makes that carries apt must pass a timeout
 * of at least the waits its own script holds, read from that script (each
 * `timeout N systemd-run` and each `DPkg::Lock::Timeout=N`), plus
 * MARGIN_SECONDS for the apt work itself. The WireGuard install had 420 s for
 * up to 900 s of waits until this census.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseAst } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APT_DAILY_UNITS_WAIT_SECONDS,
  APT_LOCK_OPT,
  aptGet,
  aptQuietUpdate,
  aptWaitForDailyUnits,
  UNATTENDED_UPGRADE,
} from '../../../src/lib/deploy/apt.js';
import { exchangeAndBringUpTunnel } from '../../../src/lib/deploy/wireguard.js';
import * as ssh from '../../../src/lib/ssh.js';
import { executeUpdatePlan } from '../../../src/lib/update/execute.js';
import { INSPECT_SCRIPT, inspectTarget } from '../../../src/lib/update/inspect.js';
import { type AstNode, calleeName, isFunctionNode, walkAst } from '../../_shared/ast-walk.js';
import { REPO_ROOT, sourceFiles } from '../../_shared/source-files.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** One ssh call as a file really makes it: its argv and stdin as one text, and its timeout. */
type Sent = { script: string; timeoutMs: number | undefined };
type SshOpts = { input?: unknown; timeout?: number };

const sentOf = (argv: unknown, opts?: SshOpts): Sent => ({
  script: [(argv as string[]).join(' '), typeof opts?.input === 'string' ? opts.input : ''].join(
    '\n',
  ),
  timeoutMs: opts?.timeout,
});

/** update's check on a compose server and on a k8s node, with ssh faked. */
async function inspectSent(): Promise<Sent[]> {
  const sent: Sent[] = [];
  const sshRun = async (_ip: string, _key: string, argv: string[], opts: SshOpts) => {
    sent.push(sentOf(argv, opts));
    throw new Error('ssh is faked');
  };
  for (const kind of ['compose', 'k8s'] as const) {
    const target = { name: 'web-1', ip: '10.0.0.1', side: 'primary', role: 'server', kind };
    await inspectTarget(target as never, { sshRun, envName: 'prod' }).catch(() => {});
  }
  return sent;
}

/**
 * update's install and its Docker upgrade: one compose step for each, where
 * ssh records the call and fails, so the run stops there and reaches nothing
 * else. Every other remote dep throws.
 */
async function executeSent(): Promise<Sent[]> {
  const sent: Sent[] = [];
  const unreached = async () => {
    throw new Error('not reached in this drive');
  };
  const deps = {
    sshRun: async (_ip: string, _key: string, argv: string[], opts: SshOpts) => {
      sent.push(sentOf(argv, opts));
      throw new Error('ssh is faked');
    },
    sshRunScript: async () => '',
    sshKubectl: unreached,
    verifyAppHealth: unreached,
    fetchPublicDomain: unreached,
    now: () => 0,
    sleep: async () => {},
  };
  const ctx = {
    envName: 'prod',
    sshKeyPath: '/k',
    domain: null,
    projectName: 'shop',
    yes: true,
    confirm: async () => true,
    log: { step() {}, info() {}, warn() {} },
  };
  const target = {
    name: 'web-1',
    ip: '10.0.0.1',
    side: 'primary',
    role: 'server',
    kind: 'compose',
  };
  const planWith = (over: object) => ({
    envName: 'prod',
    tier: 'compose',
    steps: [{ target, state: {}, install: 0, docker: null, restart: 'none', ...over }],
    skipped: [],
    total: null,
    outageServers: [],
  });
  const docker = { packages: [{ name: 'docker-ce', from: '5:28.1.0', to: '5:29.0.1' }] };
  for (const plan of [planWith({ install: 3 }), planWith({ docker })]) {
    await executeUpdatePlan(plan as never, ctx as never, deps as never);
  }
  return sent;
}

/** The WireGuard tunnel setup on both nodes, with ssh faked. */
async function wireguardSent(): Promise<Sent[]> {
  const sent: Sent[] = [];
  vi.spyOn(ssh, 'sshRun').mockImplementation(async (_ip, _key, argv, opts) => {
    sent.push(sentOf(argv, opts as SshOpts));
    return String(argv).includes('wg pubkey') ? 'FWxNbddwB9ap1+Nfhv++GcS2CtEh/5CNPiCKF9UIkS4=' : '';
  });
  await exchangeAndBringUpTunnel({
    primaryIp: '10.0.0.1',
    standbyIp: '10.0.0.2',
    sshKeyPath: '/k',
  });
  return sent;
}

/**
 * Every src/ file that runs ssh and builds an apt command, with a drive of the
 * ssh calls it really makes. A file that refreshes in WAITS needs one too.
 */
const SENT: Record<string, () => Promise<Sent[]>> = {
  'src/lib/update/inspect.js': inspectSent,
  'src/lib/update/execute.js': executeSent,
  'src/lib/deploy/wireguard.js': wireguardSent,
};

/** Files whose apt refreshes and unattended-upgrade runs wait for the daily units first. */
const WAITS: Record<string, string> = {
  'src/lib/update/inspect.js':
    "update's check: one wait before the reporter, apt-get update, the dry run and Docker's refresh",
  'src/lib/update/execute.js': "update's install and its Docker upgrade",
  'src/lib/deploy/wireguard.js':
    'the wireguard-tools install, a minute or two after the server booted',
};

/** Files that refresh or upgrade with no wait, each with the reason. */
const EXEMPT: Record<string, string> = {
  'src/lib/deploy/apt.js':
    "the helpers themselves: aptInstallOrRefresh's fallback refresh is counted at each call of aptInstallOrRefresh",
  'src/lib/iac/docker-install.js':
    "cloud-init's runcmd at first boot: cloud-final's own Before=apt-daily.service (upstream systemd/cloud-final.service) runs it before apt-daily's refresh, and the dpkg lock timeout covers the rest",
  'src/lib/deploy/compose/server-floors.js':
    'a command printed for a person to run when Docker is too old, never run by vibecarbon',
};

/** The apt.js names a site is made of, and the wait. */
const NAMES = ['aptGet', 'aptQuietUpdate', 'aptInstallOrRefresh', 'UNATTENDED_UPGRADE'];
const WAIT = 'aptWaitForDailyUnits';

type Site = { rel: string; line: number; what: string; ordered: boolean };

/** The local name each apt.js helper goes by in a file: its import, or its own name in apt.js. */
function localNames(rel: string, ast: AstNode): Map<string, string> {
  const names = new Map<string, string>();
  if (rel.endsWith('deploy/apt.js')) {
    for (const n of [...NAMES, WAIT]) names.set(n, n);
    return names;
  }
  walkAst(ast, (n) => {
    if (n.type !== 'ImportDeclaration' || !/(^|\/)apt\.js$/.test(n.source?.value ?? '')) return;
    for (const sp of n.specifiers ?? []) {
      const imported = sp.imported?.name ?? sp.imported?.value;
      if (sp.type === 'ImportSpecifier' && [...NAMES, WAIT].includes(imported)) {
        names.set(sp.local.name, imported);
      }
    }
  });
  return names;
}

/** Whether aptGet's argument is a refresh. One the code cannot read counts as one. */
function refreshes(arg: AstNode): boolean {
  if (arg?.type === 'Literal' && typeof arg.value === 'string')
    return /^\s*update\b/.test(arg.value);
  if (arg?.type === 'TemplateLiteral') {
    const head = arg.quasis[0]?.value?.cooked ?? '';
    return head.trim() === '' ? arg.expressions.length > 0 : /^\s*update\b/.test(head);
  }
  return true;
}

/** An identifier that names the binding rather than reading it. */
function isDeclaration(n: AstNode, parent: AstNode): boolean {
  if (!parent) return false;
  if (parent.type === 'ImportSpecifier' || parent.type === 'ExportSpecifier') return true;
  if (parent.type === 'VariableDeclarator' && parent.id === n) return true;
  if (parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return true;
  return parent.type === 'Property' && parent.key === n && !parent.shorthand && !parent.computed;
}

/** The innermost function or declaration around a node: the script it belongs to. */
function scopeOf(ancestors: AstNode[]): AstNode {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (isFunctionNode(a) || a.type === 'VariableDeclarator') return a;
  }
  return ancestors[0];
}

/**
 * Every refresh or unattended-upgrade site in one file's code (comments and
 * imports never count). `ordered`: a wait comes earlier in the same scope.
 */
function sitesIn(rel: string, text: string): Site[] {
  const ast = parseAst(text);
  const names = localNames(rel, ast);
  if (names.size === 0) return [];
  const waits: number[] = [];
  const found: { start: number; scope: AstNode; what: string }[] = [];
  walkAst(ast, (n, ancestors) => {
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier') {
      const name = names.get(n.callee.name);
      const site =
        name === 'aptQuietUpdate' ||
        name === 'aptInstallOrRefresh' ||
        (name === 'aptGet' && refreshes(n.arguments?.[0]));
      if (name === WAIT) waits.push(n.start);
      else if (site) found.push({ start: n.start, scope: scopeOf(ancestors), what: `${name}()` });
    } else if (n.type === 'Identifier' && names.get(n.name) === 'UNATTENDED_UPGRADE') {
      if (!isDeclaration(n, ancestors.at(-1)))
        found.push({ start: n.start, scope: scopeOf(ancestors), what: 'UNATTENDED_UPGRADE' });
    }
  });
  return found.map((f) => ({
    rel,
    line: text.slice(0, f.start).split('\n').length,
    what: f.what,
    ordered: waits.some((w) => w >= f.scope.start && w < f.start),
  }));
}

/** Every src/ file's path and text, read once for the whole census. */
let srcTexts: { rel: string; text: string }[] | undefined;
function srcFiles() {
  srcTexts ??= sourceFiles(join(REPO_ROOT, 'src'), { exts: ['.js'] }).map((f) => ({
    rel: relative(REPO_ROOT, f),
    text: readFileSync(f, 'utf8'),
  }));
  return srcTexts;
}

function srcSites(): Site[] {
  return srcFiles().flatMap(({ rel, text }) => sitesIn(rel, text));
}

/** Files with a site that no table names, and table entries with no site left. */
function classify(sites: Site[], waits: string[], exempt: string[]) {
  const files = new Set(sites.map((s) => s.rel));
  const known = new Set([...waits, ...exempt]);
  return {
    unclassified: [...files].filter((f) => !known.has(f)).sort(),
    stale: [...known].filter((f) => !files.has(f)).sort(),
    both: waits.filter((f) => exempt.includes(f)),
  };
}

/** A refresh as apt-get prints on a command line: apt-get, its options, then update. */
const REFRESH = /\bapt-get(?: -\S+ \S+)* update\b/;

/**
 * Whether a built command waits before its first refresh or upgrade. A
 * command with neither fails, so the check cannot pass on nothing.
 */
function waitsFirst(cmd: string): 'ok' | 'no refresh' | 'no wait' | 'wait after' {
  const at = [cmd.search(REFRESH), cmd.indexOf(UNATTENDED_UPGRADE)].filter((i) => i >= 0);
  if (at.length === 0) return 'no refresh';
  const wait = cmd.indexOf(aptWaitForDailyUnits());
  if (wait < 0) return 'no wait';
  return wait < Math.min(...at) ? 'ok' : 'wait after';
}

/** The ssh runners a remote apt command goes through: imported, or called directly or on deps. */
const SSH_RUNNERS = new Set(['sshRun', 'sshRunScript', 'sshKubectl']);
/** apt.js builders that put an apt-get (with the lock wait) into a command. */
const APT_GETS = new Set(['aptGet', 'aptQuietUpdate', 'aptInstallOrRefresh']);

/**
 * In one file's code: whether it runs ssh and builds an apt command, and how
 * many daily-unit waits and apt-get builders it calls.
 */
function sshAptIn(rel: string, text: string) {
  const ast = parseAst(text);
  const names = localNames(rel, ast);
  let ssh = false;
  let lockOpt = false;
  let waits = 0;
  let aptGets = 0;
  const imports = (n: AstNode, from: RegExp, wanted: Set<string>) =>
    n.type === 'ImportDeclaration' &&
    from.test(n.source?.value ?? '') &&
    (n.specifiers ?? []).some((sp: AstNode) => wanted.has(sp.imported?.name ?? sp.imported?.value));
  walkAst(ast, (n) => {
    // inspect.js calls its sshRun as `run`, so an import counts as running ssh.
    if (imports(n, /(^|\/)ssh\.js$/, SSH_RUNNERS)) ssh = true;
    if (imports(n, /(^|\/)apt\.js$/, new Set(['APT_LOCK_OPT']))) lockOpt = true;
    if (n.type !== 'CallExpression') return;
    if (SSH_RUNNERS.has(calleeName(n) ?? '')) ssh = true;
    const name = n.callee?.type === 'Identifier' ? names.get(n.callee.name) : undefined;
    if (name === WAIT) waits += 1;
    if (name && APT_GETS.has(name)) aptGets += 1;
  });
  return { sshApt: ssh && (waits + aptGets > 0 || lockOpt), waits, aptGets };
}

function srcSshApt() {
  return srcFiles().map(({ rel, text }) => ({ rel, ...sshAptIn(rel, text) }));
}

/** Margin past the waits for the apt work itself: the headroom #46 gave the WireGuard install. */
const MARGIN_SECONDS = 120;

/**
 * The seconds a script can sit waiting, read from the script itself: each
 * `timeout N systemd-run` (the daily units) and each `DPkg::Lock::Timeout=N`
 * (one per apt-get). A negative lock timeout waits forever.
 */
function waitSeconds(script: string): number {
  let total = 0;
  for (const m of script.matchAll(/\btimeout (-?\d+) systemd-run\b/g)) total += Number(m[1]);
  for (const m of script.matchAll(/DPkg::Lock::Timeout=(-?\d+)/g)) {
    total += Number(m[1]) < 0 ? Number.POSITIVE_INFINITY : Number(m[1]);
  }
  return total;
}

/** Whether a call's script runs apt at all: a wait, an apt-get or unattended-upgrade. */
const carriesApt = (script: string) => /systemd-run|apt-get|unattended-upgrade/.test(script);

/** Why a call's timeout does not outlast its script's waits, or null when it does. */
function boundProblem(call: Sent): string | null {
  if (!carriesApt(call.script)) return null;
  const need = (waitSeconds(call.script) + MARGIN_SECONDS) * 1000;
  if (call.timeoutMs === undefined) return `no timeout, needs at least ${need} ms`;
  return call.timeoutMs >= need ? null : `timeout ${call.timeoutMs} ms, needs at least ${need} ms`;
}

/**
 * Whether a drive reached the file's whole code: at least as many daily-unit
 * waits, and apt-get lock options, as the file has calls that build them.
 */
function reachesAll(counts: { waits: number; aptGets: number }, sent: Sent[]): string[] {
  const count = (re: RegExp) => sent.reduce((n, c) => n + (c.script.match(re)?.length ?? 0), 0);
  const waits = count(/\btimeout -?\d+ systemd-run\b/g);
  const locks = count(/DPkg::Lock::Timeout=/g);
  const missed: string[] = [];
  if (waits < counts.waits) missed.push(`${counts.waits} waits in the code, ${waits} sent`);
  if (locks < counts.aptGets) missed.push(`${counts.aptGets} apt-gets in the code, ${locks} sent`);
  return missed;
}

describe('apt daily-units wait census', () => {
  it('every file with an apt refresh or unattended-upgrade is classified, and no entry is stale', () => {
    const r = classify(srcSites(), Object.keys(WAITS), Object.keys(EXEMPT));
    expect(r.unclassified, 'classify each in WAITS or EXEMPT, with the reason').toEqual([]);
    expect(r.stale, 'no refresh there any more, so drop the entry').toEqual([]);
    expect(r.both).toEqual([]);
  });

  it('in a WAITS file, every site has a wait earlier in the same function or declaration', () => {
    const offenders = srcSites()
      .filter((s) => s.rel in WAITS && !s.ordered)
      .map((s) => `${s.rel}:${s.line} ${s.what}`);
    expect(offenders).toEqual([]);
  });

  it.each(Object.keys(WAITS))('%s: what it sends waits before it refreshes', async (rel) => {
    expect(SENT[rel], 'a WAITS file needs a SENT drive').toBeDefined();
    const refreshing = (await SENT[rel]())
      .map((c) => c.script)
      .filter((s) => waitsFirst(s) !== 'no refresh');
    expect(refreshing.length).toBeGreaterThan(0);
    for (const script of refreshing) expect(waitsFirst(script), script).toBe('ok');
  });

  it("update's check waits once, before the restart state and every apt command", () => {
    for (const kind of ['compose', 'k8s'] as const) {
      const script = INSPECT_SCRIPT(kind);
      const wait = script.indexOf(aptWaitForDailyUnits());
      expect(script.split(aptWaitForDailyUnits())).toHaveLength(2);
      expect(wait).toBeGreaterThan(-1);
      expect(wait).toBeLessThan(script.indexOf('echo @@host'));
      expect(wait).toBeLessThan(script.indexOf(aptGet('update -qq')));
      expect(wait).toBeLessThan(script.indexOf(`${UNATTENDED_UPGRADE} --dry-run`));
      if (kind === 'compose') expect(wait).toBeLessThan(script.indexOf('apt-get -c '));
    }
  });

  it('finds the known sites, so the census cannot pass on nothing', () => {
    const at = srcSites().map((s) => `${s.rel} ${s.what}`);
    expect(at).toEqual(
      expect.arrayContaining([
        'src/lib/update/inspect.js aptGet()',
        'src/lib/update/inspect.js UNATTENDED_UPGRADE',
        'src/lib/update/inspect.js aptQuietUpdate()',
        'src/lib/update/execute.js UNATTENDED_UPGRADE',
        'src/lib/update/execute.js aptQuietUpdate()',
        'src/lib/deploy/wireguard.js aptQuietUpdate()',
        'src/lib/iac/docker-install.js aptQuietUpdate()',
        'src/lib/iac/docker-install.js aptInstallOrRefresh()',
        'src/lib/deploy/compose/server-floors.js aptGet()',
        'src/lib/deploy/apt.js aptGet()',
      ]),
    );
  });
});

describe('every ssh call that runs apt outlasts its waits', () => {
  it('every file that runs ssh and builds an apt command has a SENT drive, and no entry is stale', () => {
    const files = srcSshApt()
      .filter((f) => f.sshApt)
      .map((f) => f.rel)
      .sort();
    expect(files).toEqual(Object.keys(SENT).sort());
  });

  it.each(Object.keys(SENT))('%s: each call passes a timeout past its waits', async (rel) => {
    const sent = await SENT[rel]();
    const apt = sent.filter((c) => carriesApt(c.script));
    expect(apt.length).toBeGreaterThan(0);
    const short = apt.map(boundProblem).filter(Boolean);
    expect(short).toEqual([]);
  });

  it.each(Object.keys(SENT))(
    '%s: the drive reaches every wait and apt-get in the code',
    async (rel) => {
      const counts = srcSshApt().find((f) => f.rel === rel);
      expect(counts?.waits ?? 0).toBeGreaterThan(0);
      expect(reachesAll(counts as { waits: number; aptGets: number }, await SENT[rel]())).toEqual(
        [],
      );
    },
  );

  it('the waits are read from the scripts as they are sent', () => {
    // The three files' scripts, at today's values: 300 s for the daily
    // units, 300 s per apt-get.
    expect(waitSeconds(aptWaitForDailyUnits())).toBe(APT_DAILY_UNITS_WAIT_SECONDS);
    expect(waitSeconds(APT_LOCK_OPT)).toBe(300);
  });
});

describe('the census bites', () => {
  const head =
    "import { aptGet, aptQuietUpdate, aptInstallOrRefresh, aptWaitForDailyUnits, UNATTENDED_UPGRADE } from '../deploy/apt.js';\n" +
    "import { aptGet as g } from './apt.js';\n";

  it('finds each kind of site, and not an install, a comment or an import', () => {
    const src =
      head +
      "aptGet('update -qq');\n" +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      'aptGet(`update ${x}`);\n' +
      "aptGet('install -y curl');\n" +
      'aptGet(args);\n' +
      'aptQuietUpdate();\n' +
      "aptInstallOrRefresh('p');\n" +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      'const c = `${UNATTENDED_UPGRADE} --dry-run`;\n' +
      "// aptGet('update')\n" +
      "g('update');\n";
    expect(sitesIn('src/x.js', src).map((s) => `${s.line} ${s.what}`)).toEqual([
      '3 aptGet()',
      '4 aptGet()',
      '6 aptGet()',
      '7 aptQuietUpdate()',
      '8 aptInstallOrRefresh()',
      '9 UNATTENDED_UPGRADE',
      '11 aptGet()',
    ]);
  });

  it('a file that imports nothing from apt.js has no sites', () => {
    expect(sitesIn('src/y.js', "const aptGet = (a) => a;\naptGet('update');\n")).toEqual([]);
  });

  it('a wait counts only earlier in the same function or declaration', () => {
    const src =
      head +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      'function good() { return `${aptWaitForDailyUnits()}; ${aptQuietUpdate()}`; }\n' +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      'function late() { return `${aptQuietUpdate()}; ${aptWaitForDailyUnits()}`; }\n' +
      'function elsewhere() { return aptWaitForDailyUnits(); }\n' +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      'const ARGV = [`${UNATTENDED_UPGRADE} --verbose`];\n';
    expect(sitesIn('src/x.js', src).map((s) => `${s.line} ${s.ordered}`)).toEqual([
      '3 true',
      '4 false',
      '6 false',
    ]);
  });

  it('an unclassified file, a stale entry and a file in both tables are named', () => {
    const site = (rel: string): Site => ({ rel, line: 1, what: 'aptGet()', ordered: true });
    expect(
      classify([site('src/a.js'), site('src/new.js')], ['src/a.js', 'src/gone.js'], ['src/a.js']),
    ).toEqual({
      unclassified: ['src/new.js'],
      stale: ['src/gone.js'],
      both: ['src/a.js'],
    });
  });

  it('a file counts when it runs ssh by any route and builds apt, not one without both', () => {
    const imp = "import { aptGet, aptWaitForDailyUnits } from './apt.js';\n";
    expect(sshAptIn('src/a.js', `${imp}deps.sshRun(ip, k, [aptGet('install -y x')]);\n`)).toEqual({
      sshApt: true,
      waits: 0,
      aptGets: 1,
    });
    expect(
      sshAptIn('src/b.js', `${imp}sshRunScript(ip, k, aptWaitForDailyUnits());\n`).sshApt,
    ).toBe(true);
    expect(sshAptIn('src/c.js', `${imp}const s = aptGet('install -y x');\n`).sshApt).toBe(false);
    expect(sshAptIn('src/d.js', "sshRun(ip, k, ['apt-get', 'update']);\n").sshApt).toBe(false);
    const viaImport = "import { sshRun } from '../ssh.js';\nconst run = deps.run ?? sshRun;\n";
    expect(sshAptIn('src/f.js', `${imp}${viaImport}run(ip, k, [aptGet('update')]);\n`).sshApt).toBe(
      true,
    );
    expect(
      sshAptIn(
        'src/e.js',
        "import { APT_LOCK_OPT } from './apt.js';\nsshRun(ip, k, [APT_LOCK_OPT]);\n",
      ).sshApt,
    ).toBe(true);
  });

  it('a bound must cover every wait in the script plus the margin', () => {
    const script = `${aptWaitForDailyUnits()}; ${aptQuietUpdate()} && ${aptGet('install -y x')}`;
    const need = (300 + 300 + 300 + MARGIN_SECONDS) * 1000;
    expect(boundProblem({ script, timeoutMs: need })).toBeNull();
    expect(boundProblem({ script, timeoutMs: need - 1 })).toMatch(/needs at least/);
    expect(boundProblem({ script, timeoutMs: undefined })).toMatch(/^no timeout/);
    expect(
      boundProblem({ script: 'wg pubkey < /etc/wireguard/key', timeoutMs: undefined }),
    ).toBeNull();
    // apt waits forever on a negative lock timeout: no bound outlasts that.
    expect(
      boundProblem({ script: 'apt-get -o DPkg::Lock::Timeout=-1 update', timeoutMs: 10 ** 12 }),
    ).toMatch(/needs at least/);
  });

  it('a drive that misses a wait or an apt-get in the code is named', () => {
    const sent = [{ script: `${aptWaitForDailyUnits()}; ${aptQuietUpdate()}`, timeoutMs: 1 }];
    expect(reachesAll({ waits: 1, aptGets: 1 }, sent)).toEqual([]);
    expect(reachesAll({ waits: 2, aptGets: 2 }, sent)).toEqual([
      '2 waits in the code, 1 sent',
      '2 apt-gets in the code, 1 sent',
    ]);
  });

  it('a built command must wait first, and must refresh at all', () => {
    const wait = aptWaitForDailyUnits();
    expect(waitsFirst(`${wait}; ${aptQuietUpdate()}`)).toBe('ok');
    expect(waitsFirst(`${wait}; ${UNATTENDED_UPGRADE} --verbose`)).toBe('ok');
    expect(waitsFirst(`${aptGet('update')}; ${wait}`)).toBe('wait after');
    expect(waitsFirst(`${wait}; ${aptGet('install -y x')}; ${UNATTENDED_UPGRADE}`)).toBe('ok');
    expect(waitsFirst(`${UNATTENDED_UPGRADE} --dry-run`)).toBe('no wait');
    expect(waitsFirst(`${wait}; ${aptGet('install -y x')}`)).toBe('no refresh');
  });
});
