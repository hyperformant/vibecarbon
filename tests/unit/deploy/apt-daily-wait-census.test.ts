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
 * builds.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseAst } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aptGet,
  aptQuietUpdate,
  aptWaitForDailyUnits,
  UNATTENDED_UPGRADE,
} from '../../../src/lib/deploy/apt.js';
import { exchangeAndBringUpTunnel } from '../../../src/lib/deploy/wireguard.js';
import * as ssh from '../../../src/lib/ssh.js';
import { dockerUpdateArgv, UPGRADE_ARGV } from '../../../src/lib/update/execute.js';
import { INSPECT_SCRIPT } from '../../../src/lib/update/inspect.js';
import { type AstNode, isFunctionNode, walkAst } from '../../_shared/ast-walk.js';
import { REPO_ROOT, sourceFiles } from '../../_shared/source-files.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** What the wireguard tunnel setup sends over ssh, with ssh faked. */
async function wireguardCommands(): Promise<string[]> {
  const calls: string[] = [];
  vi.spyOn(ssh, 'sshRun').mockImplementation(async (_ip, _key, argv) => {
    calls.push((argv as string[]).join(' '));
    return String(argv).includes('wg pubkey') ? 'FWxNbddwB9ap1+Nfhv++GcS2CtEh/5CNPiCKF9UIkS4=' : '';
  });
  await exchangeAndBringUpTunnel({
    primaryIp: '10.0.0.1',
    standbyIp: '10.0.0.2',
    sshKeyPath: '/k',
  });
  return calls.filter((c) => c.includes('wireguard-tools'));
}

/**
 * Files whose apt refreshes and unattended-upgrade runs wait for the daily
 * units first. `built` gives the commands the file really builds that refresh
 * or upgrade, for the order check on what runs.
 */
const WAITS: Record<string, { why: string; built: () => Promise<string[]> }> = {
  'src/lib/update/inspect.js': {
    why: "update's check: one wait before the reporter, apt-get update, the dry run and Docker's refresh",
    built: async () => [INSPECT_SCRIPT('compose'), INSPECT_SCRIPT('k8s')],
  },
  'src/lib/update/execute.js': {
    why: "update's install and its Docker upgrade",
    built: async () => [UPGRADE_ARGV.join(' '), dockerUpdateArgv().join(' ')],
  },
  'src/lib/deploy/wireguard.js': {
    why: 'the wireguard-tools install, a minute or two after the server booted',
    built: wireguardCommands,
  },
};

/** Files that refresh or upgrade with no wait, each with the reason. */
const EXEMPT: Record<string, string> = {
  'src/lib/deploy/apt.js':
    "the helpers themselves: aptInstallOrRefresh's fallback refresh is counted at each call of aptInstallOrRefresh",
  'src/lib/iac/docker-install.js':
    "cloud-init's runcmd at first boot: cloud-init's final stage is ordered before apt-daily.service (apt.js), and the dpkg lock timeout covers the rest",
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

function srcSites(): Site[] {
  return sourceFiles(join(REPO_ROOT, 'src'), { exts: ['.js'] }).flatMap((f) =>
    sitesIn(relative(REPO_ROOT, f), readFileSync(f, 'utf8')),
  );
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

  it.each(Object.keys(WAITS))('%s: what it builds waits before it refreshes', async (rel) => {
    const built = await WAITS[rel].built();
    expect(built.length).toBeGreaterThan(0);
    for (const cmd of built) expect(waitsFirst(cmd), cmd).toBe('ok');
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
