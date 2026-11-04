/**
 * Census: the db is stopped in-pod only behind the wrapper guard, the reseed
 * repair is gone, and every kubectl argv that crosses ssh is quoted (Task A6).
 *
 * The RCA rule: an in-pod `pg_ctl stop` in a k8s db pod kills PID 1, the
 * kubelet restarts the container, and a standby whose wrapper does not swap
 * comes back as an independent primary. The one sanctioned in-pod stop is
 * `kill -QUIT 1`, spelled only in DB_IN_PLACE_STOP and DB_IN_PLACE_STOP_UNSEEDED
 * (src/lib/deploy/replication.js), sent only by restartDbContainerInPlace,
 * which only reseedStandbyInPlace calls, with the guard it got from
 * assertLiveDbGuardSupportsReseed. The unseeded stop (no recovery proof) is
 * reachable only from the cold deploy: `requireRecovery: false` is written in
 * exactly one place, setupReplication's reseedStandbyInPlace call.
 *
 * Remote commands survive ssh: every kubectl argv sent through ssh is joined
 * by shJoin (sshArgv, which sshKubectl reaches through sshRun) or
 * standbyKubectlCommand, never by a bare `join(' ')` the remote shell would
 * word-split. The earlier check (no-helper-pod-reseed-census) covered two
 * files; this one walks all of src/.
 *
 * Every rule is an AST walk over every .js file under src/, and every rule
 * has a bite test that plants the violation it bans.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
type Node = any;
type Src = { file: string; text: string };

function walkDir(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkDir(p, out);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const SRC: Src[] = walkDir(join(ROOT, 'src')).map((f) => ({
  file: relative(ROOT, f),
  text: readFileSync(f, 'utf-8'),
}));

function srcFile(file: string): Src {
  const s = SRC.find((x) => x.file === file);
  if (!s) throw new Error(`${file} is not under src/`);
  return s;
}

/** Line comments and JSDoc/block-comment continuation lines removed (text rules). */
const noComments = (s: string) => s.replace(/^\s*(\/\/|\/?\*).*$/gm, '');

/** Function name of a node that opens a named scope, or null. */
function scopeName(n: Node, parent: Node): string | null {
  if (n.type === 'FunctionDeclaration' && n.id) return n.id.name;
  if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') {
    if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') {
      return parent.id.name;
    }
    if (n.id) return n.id.name;
  }
  return null;
}

/** Visit every node with its ancestors and the innermost named function. */
function visit(text: string, fn: (n: Node, ancestors: Node[], fnName: string | null) => void) {
  const ast = parseAst(text);
  const rec = (n: Node, ancestors: Node[], names: (string | null)[]) => {
    const parent = ancestors[ancestors.length - 1];
    const own = scopeName(n, parent);
    const nextNames = own ? [...names, own] : names;
    fn(n, ancestors, nextNames[nextNames.length - 1] ?? null);
    const next = [...ancestors, n];
    for (const [k, v] of Object.entries(n)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      for (const c of Array.isArray(v) ? v : [v]) {
        if (c && typeof c === 'object' && typeof c.type === 'string') rec(c, next, nextNames);
      }
    }
  };
  rec(ast, [], []);
}

const lineOf = (text: string, n: Node) => text.slice(0, n.start).split('\n').length;
const at = (s: Src, n: Node) => `${s.file}:${lineOf(s.text, n)}`;
const isCall = (n: Node, name: string) =>
  n?.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === name;
const isJoinCall = (n: Node) =>
  n?.type === 'CallExpression' &&
  n.callee?.type === 'MemberExpression' &&
  !n.callee.computed &&
  n.callee.property?.name === 'join';
/** True when `n` or anything under it satisfies `pred`. */
function contains(n: Node, pred: (x: Node) => boolean): boolean {
  if (!n || typeof n !== 'object') return false;
  if (typeof n.type === 'string' && pred(n)) return true;
  for (const [k, v] of Object.entries(n)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    for (const c of Array.isArray(v) ? v : [v]) {
      if (c && typeof c === 'object' && contains(c, pred)) return true;
    }
  }
  return false;
}
const stringText = (n: Node): string =>
  n?.type === 'Literal' && typeof n.value === 'string'
    ? n.value
    : n?.type === 'TemplateLiteral'
      ? n.quasis.map((q: Node) => q.value.raw).join(' ')
      : '';

// ---------------------------------------------------------------------------
// Rule 1: pg_ctl stop appears nowhere in src code.
const PG_CTL_STOP = /pg_ctl[^\n]*\bstop\b/;
function pgCtlStops(files: Src[]): string[] {
  return files.filter((s) => PG_CTL_STOP.test(noComments(s.text))).map((s) => s.file);
}

// ---------------------------------------------------------------------------
// Rule 2: the PID 1 stop is spelled only in the two sanctioned constants.
const PID1_KILL = /kill\s+-(INT|TERM|QUIT|9|KILL|SIG\w+)\s+1\b/;
const STOP_CONSTANTS = ['DB_IN_PLACE_STOP', 'DB_IN_PLACE_STOP_UNSEEDED'];
function pid1Kills(files: Src[]): string[] {
  const out: string[] = [];
  for (const s of files) {
    visit(s.text, (n, anc) => {
      if (!PID1_KILL.test(stringText(n))) return;
      const decl = [...anc].reverse().find((a) => a.type === 'VariableDeclarator');
      const owner = decl?.id?.name;
      if (s.file === 'src/lib/deploy/replication.js' && STOP_CONSTANTS.includes(owner)) return;
      out.push(`${at(s, n)} (${owner ?? 'no constant'})`);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 3: the stop constants are spent only by restartDbContainerInPlace,
// once each; restartDbContainerInPlace is called only by reseedStandbyInPlace,
// once, with the guard assertLiveDbGuardSupportsReseed returned earlier.
function stopConstantUses(files: Src[]): Record<string, string[]> {
  const uses: Record<string, string[]> = Object.fromEntries(STOP_CONSTANTS.map((c) => [c, []]));
  for (const s of files) {
    visit(s.text, (n, anc, fnName) => {
      if (n.type !== 'Identifier' || !STOP_CONSTANTS.includes(n.name)) return;
      const parent = anc[anc.length - 1];
      if (parent?.type === 'VariableDeclarator' && parent.id === n) return; // the definition
      if (parent?.type === 'ExportSpecifier' || parent?.type === 'ImportSpecifier') return;
      uses[n.name].push(`${s.file} :: ${fnName ?? '<module>'}`);
    });
  }
  return uses;
}

function restartCallers(files: Src[]): string[] {
  const out: string[] = [];
  for (const s of files) {
    visit(s.text, (n, _anc, fnName) => {
      if (isCall(n, 'restartDbContainerInPlace')) out.push(`${s.file} :: ${fnName ?? '<module>'}`);
    });
  }
  return out;
}

/**
 * Inside reseedStandbyInPlace: the guard variable comes from
 * assertLiveDbGuardSupportsReseed(...), that call precedes the restart, and
 * the restart's `guard` property is that variable. Returns the problems.
 */
function guardedRestartProblems(s: Src): string[] {
  const problems: string[] = [];
  let guardVar: string | null = null;
  let guardAt = -1;
  let restart: Node = null;
  visit(s.text, (n, _anc, fnName) => {
    if (fnName !== 'reseedStandbyInPlace') return;
    if (
      n.type === 'VariableDeclarator' &&
      n.id?.type === 'Identifier' &&
      n.init?.type === 'AwaitExpression' &&
      isCall(n.init.argument, 'assertLiveDbGuardSupportsReseed')
    ) {
      guardVar = n.id.name;
      guardAt = n.start;
    }
    if (isCall(n, 'restartDbContainerInPlace')) restart = n;
  });
  if (!restart) return ['reseedStandbyInPlace never calls restartDbContainerInPlace'];
  if (guardVar === null) {
    return ['reseedStandbyInPlace takes no guard from await assertLiveDbGuardSupportsReseed(...)'];
  }
  if (guardAt > restart.start) problems.push('the guard is taken after the restart');
  const opts = restart.arguments?.[1];
  const guardProp = opts?.properties?.find((p: Node) => p.key?.name === 'guard');
  if (guardProp?.value?.type !== 'Identifier' || guardProp.value.name !== guardVar) {
    problems.push(`the restart's guard is not the guard variable (${guardVar})`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Rule 4: `requireRecovery: false` is written once, in setupReplication's
// reseedStandbyInPlace call; any other requireRecovery property is the
// pass-through shorthand inside the reseed module's own functions.
const PASS_THROUGH = new Set([
  'src/lib/deploy/replication.js :: reseedStandbyInPlace',
  'src/lib/deploy/replication.js :: assertLiveDbGuardSupportsReseed',
]);
function requireRecoveryWrites(files: Src[]): { unseeded: string[]; other: string[] } {
  const unseeded: string[] = [];
  const other: string[] = [];
  for (const s of files) {
    visit(s.text, (n, anc, fnName) => {
      if (n.type !== 'Property' || n.key?.name !== 'requireRecovery') return;
      const parent = anc[anc.length - 1];
      if (parent?.type === 'ObjectPattern') return; // a destructured parameter
      const where = `${s.file} :: ${fnName ?? '<module>'}`;
      if (n.value?.type === 'Literal' && n.value.value === false) {
        const call = anc[anc.length - 2];
        const inReseedCall = isCall(call, 'reseedStandbyInPlace') && call.arguments[0] === parent;
        unseeded.push(`${where}${inReseedCall ? '' : ' (not a reseedStandbyInPlace argument)'}`);
        return;
      }
      const shorthandPass =
        n.value?.type === 'Identifier' &&
        n.value.name === 'requireRecovery' &&
        PASS_THROUGH.has(where);
      if (!shorthandPass) other.push(`${at(s, n)} (${where})`);
    });
  }
  return { unseeded, other };
}

// ---------------------------------------------------------------------------
// Rule 5: every kubectl argv that crosses ssh is quoted.
const ARGV_NAME = /^(argv|args|kubectlArgv|cmdArgv)$/;
const QUOTERS = new Set(['shJoin', 'standbyKubectlCommand']);
const isLabel = (anc: Node[]) =>
  anc.some(
    (a) =>
      (a.type === 'Property' && /^(description|label|desc)$/.test(a.key?.name ?? '')) ||
      (a.type === 'VariableDeclarator' && /^(description|label|desc)$/.test(a.id?.name ?? '')),
  );

function unquotedRemoteKubectl(files: Src[]): string[] {
  const out: string[] = [];
  for (const s of files) {
    visit(s.text, (n, anc) => {
      // (a) a hand join of an array that carries the kubectl token.
      if (
        isJoinCall(n) &&
        n.callee.object?.type === 'ArrayExpression' &&
        n.callee.object.elements.some((e: Node) => e?.type === 'Literal' && e.value === 'kubectl')
      ) {
        out.push(`${at(s, n)} joins a kubectl argv by hand`);
      }
      // (b) `kubectl ${x.join(...)}` in a template, unless it is a log label.
      if (n.type === 'TemplateLiteral' && !isLabel(anc)) {
        n.expressions.forEach((e: Node, i: number) => {
          if (/kubectl\s*$/.test(n.quasis[i].value.raw) && contains(e, isJoinCall)) {
            out.push(`${at(s, n)} splices a joined argv after kubectl`);
          }
        });
      }
      // (c) an ssh argv literal: its remote command is never a join, and an
      // argv that reaches it goes through shJoin or standbyKubectlCommand.
      if (
        n.type === 'ArrayExpression' &&
        n.elements[0]?.type === 'Literal' &&
        n.elements[0].value === 'ssh'
      ) {
        const last = n.elements[n.elements.length - 1];
        if (!last || last.type === 'SpreadElement') return;
        if (
          contains(last, isJoinCall) &&
          !(last.type === 'CallExpression' && QUOTERS.has(last.callee?.name))
        ) {
          out.push(`${at(s, n)} sends a joined string as the ssh remote command`);
        } else if (
          contains(last, (x) => x.type === 'Identifier' && ARGV_NAME.test(x.name)) &&
          !(last.type === 'CallExpression' && QUOTERS.has(last.callee?.name))
        ) {
          out.push(`${at(s, n)} sends an argv to ssh without shJoin/standbyKubectlCommand`);
        }
      }
      // (d) a closure over an argv that reaches ssh never joins that argv.
      if (
        (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') &&
        contains(
          n.body,
          (x) =>
            (x.type === 'Identifier' && /ssh/i.test(x.name)) ||
            (x.type === 'Literal' && x.value === 'ssh'),
        )
      ) {
        const params = n.params
          .filter((p: Node) => p.type === 'Identifier' && ARGV_NAME.test(p.name))
          .map((p: Node) => p.name);
        if (params.length === 0) return;
        const rootName = (x: Node): string | null => {
          while (x?.type === 'MemberExpression' || x?.type === 'CallExpression') {
            x = x.type === 'CallExpression' ? x.callee : x.object;
          }
          return x?.type === 'Identifier' ? x.name : null;
        };
        const joined = contains(
          n.body,
          (x) =>
            isJoinCall(x) &&
            (params.includes(rootName(x.callee.object)) ||
              (x.callee.object?.type === 'ArrayExpression' &&
                x.callee.object.elements.some(
                  (e: Node) => e?.type === 'SpreadElement' && params.includes(e.argument?.name),
                ))),
        );
        if (joined) out.push(`${at(s, n)} joins its argv inside an ssh closure`);
      }
    });
  }
  return out;
}

/** The two sanctioned quoters really quote, and sshKubectl reaches one. */
function quoterProblems(files: Src[]): string[] {
  const get = (f: string) => files.find((s) => s.file === f)?.text ?? '';
  const problems: string[] = [];
  const ssh = get('src/lib/ssh.js');
  const fnBody = (text: string, name: string) =>
    text.match(new RegExp(`export (?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`))?.[0] ?? '';
  if (!/shJoin\(argv\),?\s*\]/.test(fnBody(ssh, 'sshArgv'))) {
    problems.push('sshArgv does not end its argv with shJoin(argv)');
  }
  if (!/sshArgv\(/.test(fnBody(ssh, 'sshRun')))
    problems.push('sshRun does not build through sshArgv');
  if (!/sshRun\(/.test(fnBody(ssh, 'sshKubectl')))
    problems.push('sshKubectl does not run through sshRun');
  const ha = get('src/lib/deploy/k8s/ha/index.js');
  if (!/return shJoin\(\['kubectl', \.\.\.argv\]\);/.test(fnBody(ha, 'standbyKubectlCommand'))) {
    problems.push("standbyKubectlCommand does not return shJoin(['kubectl', ...argv])");
  }
  return problems;
}

const planted = (text: string, file = 'src/planted.js'): Src[] => [{ file, text }];

/** A literal replica count that is not zero ('1', 2): anything else can be zero. */
const nonZeroCount = (n: Node) =>
  n?.type === 'Literal' && /^\d+$/.test(String(n.value)) && Number(n.value) !== 0;

/** A template literal that interpolates the count right after `--replicas=` or `--replicas `. */
const computedCount = (n: Node) =>
  n?.type === 'TemplateLiteral' &&
  n.expressions.length > 0 &&
  n.quasis.slice(0, -1).some((q: Node) => /--replicas[= ]$/.test(String(q.value.raw)));

/**
 * Every array element (an argv token or a remote command) that scales to zero,
 * or to a count the census cannot read: `--replicas=0` or `--replicas 0` in one
 * token, the split pair `'--replicas', '0'` (or a non-literal after the flag),
 * and an interpolated `--replicas=${n}`.
 */
function scaleToZeroArgv(files: Src[]): string[] {
  const out: string[] = [];
  for (const s of files) {
    visit(s.text, (n) => {
      if (n.type !== 'ArrayExpression') return;
      n.elements.forEach((e: Node, i: number) => {
        const text = stringText(e);
        const split = text === '--replicas' && !nonZeroCount(n.elements[i + 1]);
        if (/--replicas[= ]0\b/.test(text) || split || computedCount(e)) out.push(at(s, e));
      });
    });
  }
  return out;
}

describe('the db is stopped in-pod only behind the wrapper guard', () => {
  it('walks the whole src tree', () => {
    expect(SRC.length).toBeGreaterThan(100);
    expect(SRC.map((s) => s.file)).toContain('src/lib/deploy/replication.js');
  });

  it('pg_ctl stop appears nowhere in src (the RCA rule)', () => {
    expect(pgCtlStops(SRC)).toEqual([]);
  });

  it('bite: a planted pg_ctl stop is caught, a comment naming it is not', () => {
    expect(pgCtlStops(planted("run(['sh', '-c', 'pg_ctl -D $PGDATA stop -m fast']);"))).toEqual([
      'src/planted.js',
    ]);
    expect(pgCtlStops(planted('// never an in-pod pg_ctl stop\n * nor pg_ctl stop\n'))).toEqual([]);
  });

  it('the only in-pod stop of PID 1 is spelled in DB_IN_PLACE_STOP and DB_IN_PLACE_STOP_UNSEEDED', () => {
    expect(pid1Kills(SRC)).toEqual([]);
    const rep = srcFile('src/lib/deploy/replication.js');
    expect(noComments(rep.text).match(new RegExp(PID1_KILL.source, 'g'))).toHaveLength(2);
  });

  it('bite: a PID 1 kill outside the constants is caught, in any file', () => {
    expect(pid1Kills(planted("const s = ['sh', '-c', 'kill -TERM 1'];"))).toEqual([
      'src/planted.js:1 (s)',
    ]);
    expect(
      pid1Kills(planted("export const DB_IN_PLACE_STOP = ['sh', '-c', 'kill -QUIT 1'];")),
    ).toEqual(['src/planted.js:1 (DB_IN_PLACE_STOP)']);
    expect(
      pid1Kills(
        planted(
          "const OTHER = ['sh', '-c', `kill -9 1`];\nexport const DB_IN_PLACE_STOP = ['kill -QUIT 1'];",
          'src/lib/deploy/replication.js',
        ),
      ),
    ).toEqual(['src/lib/deploy/replication.js:1 (OTHER)']);
  });

  it('each stop constant is spent once, only by restartDbContainerInPlace', () => {
    expect(stopConstantUses(SRC)).toEqual({
      DB_IN_PLACE_STOP: ['src/lib/deploy/replication.js :: restartDbContainerInPlace'],
      DB_IN_PLACE_STOP_UNSEEDED: ['src/lib/deploy/replication.js :: restartDbContainerInPlace'],
    });
  });

  it('bite: a second spender of a stop constant is caught', () => {
    const text =
      'export const DB_IN_PLACE_STOP = [];\n' +
      'export async function restartDbContainerInPlace(k) { await k(DB_IN_PLACE_STOP); }\n' +
      'export async function quickStop(k) { await k(DB_IN_PLACE_STOP); }\n';
    expect(stopConstantUses(planted(text)).DB_IN_PLACE_STOP).toEqual([
      'src/planted.js :: restartDbContainerInPlace',
      'src/planted.js :: quickStop',
    ]);
  });

  it('restartDbContainerInPlace has one caller, reseedStandbyInPlace, after the guard and with it', () => {
    expect(restartCallers(SRC)).toEqual(['src/lib/deploy/replication.js :: reseedStandbyInPlace']);
    const rep = srcFile('src/lib/deploy/replication.js');
    expect(guardedRestartProblems(rep)).toEqual([]);
  });

  it('bite: another caller, a missing guard, a late guard and a forged guard are caught', () => {
    expect(
      restartCallers(
        planted(
          'export async function failoverFast(k) { await restartDbContainerInPlace(k, {}); }',
        ),
      ),
    ).toEqual(['src/planted.js :: failoverFast']);
    const fn = (body: string) =>
      planted(`export async function reseedStandbyInPlace({ kubectl }) {\n${body}\n}\n`);
    expect(
      guardedRestartProblems(fn('await restartDbContainerInPlace(kubectl, { guard: {} });')[0]),
    ).toEqual([
      'reseedStandbyInPlace takes no guard from await assertLiveDbGuardSupportsReseed(...)',
    ]);
    expect(
      guardedRestartProblems(
        fn(
          'await restartDbContainerInPlace(kubectl, { guard });\n' +
            'const guard = await assertLiveDbGuardSupportsReseed(kubectl, {});',
        )[0],
      ),
    ).toEqual(['the guard is taken after the restart']);
    expect(
      guardedRestartProblems(
        fn(
          'const guard = await assertLiveDbGuardSupportsReseed(kubectl, {});\n' +
            "await restartDbContainerInPlace(kubectl, { guard: { ok: true, uid: 'x' } });",
        )[0],
      ),
    ).toEqual(["the restart's guard is not the guard variable (guard)"]);
  });

  it("requireRecovery: false is written once, at setupReplication's reseedStandbyInPlace call", () => {
    expect(requireRecoveryWrites(SRC)).toEqual({
      unseeded: ['src/lib/deploy/k8s/ha/index.js :: setupReplication'],
      other: [],
    });
  });

  it('bite: a second unseeded caller, a computed flag and a stray pass-through are caught', () => {
    const r = requireRecoveryWrites(
      planted(
        'export async function failover(k) {\n' +
          '  await reseedStandbyInPlace({ kubectl: k, requireRecovery: false });\n' +
          '  await assertLiveDbGuardSupportsReseed(k, { requireRecovery: !planned });\n' +
          '  const o = { requireRecovery: false };\n' +
          '}\n' +
          'function relay({ requireRecovery }) { return go({ requireRecovery }); }\n',
      ),
    );
    expect(r.unseeded).toEqual([
      'src/planted.js :: failover',
      'src/planted.js :: failover (not a reseedStandbyInPlace argument)',
    ]);
    expect(r.other).toEqual([
      'src/planted.js:3 (src/planted.js :: failover)',
      'src/planted.js:6 (src/planted.js :: relay)',
    ]);
  });
});

describe('the reseed repair is gone', () => {
  // The whole tree is walked for these names by no-helper-pod-reseed-census;
  // here, the reseed paths themselves (the brief's set), comments excluded.
  const RESEED_PATHS = [
    'src/lib/deploy/replication.js',
    'src/lib/deploy/k8s/ha/index.js',
    'src/restore.js',
    'src/failover.js',
  ];
  const body = (f: string) => noComments(srcFile(f).text);

  it('no reseed path scales the db to zero or mounts its PVC in another pod', () => {
    for (const f of RESEED_PATHS) {
      const b = body(f);
      expect(b, f).not.toMatch(
        /PGDATA_SWAP_POD|swapPgdataViaHelperPod|waitForPvDetach|deleteStaleDbVolumeAttachments/,
      );
      expect(b, f).not.toMatch(/persistentVolumeClaim:\s*\{\s*claimName/);
    }
    // The only --replicas=0 left in src is the failover abort's stopStandbyDb
    // (failover.js), which is no reseed path. The stale-attachment diagnosis
    // in replication.js names a manual scale to zero in its message: words
    // for the operator, not an argv the CLI runs.
    const reseed = SRC.filter((s) => RESEED_PATHS.slice(0, 2).includes(s.file));
    expect(scaleToZeroArgv(reseed)).toEqual([]);
  });

  it('bite: a scale to zero is caught as an argv token or a remote command, not in a message', () => {
    expect(
      scaleToZeroArgv(planted("await k(['scale', 'statefulset', 'db', '--replicas=0']);")),
    ).toEqual(['src/planted.js:1']);
    expect(
      scaleToZeroArgv(
        planted("run(['ssh', h, 'kubectl scale statefulset db --replicas=0 -n vibecarbon']);"),
      ),
    ).toEqual(['src/planted.js:1']);
    expect(
      scaleToZeroArgv(planted("throw new Error('run `kubectl scale sts db --replicas=0`');")),
    ).toEqual([]);
  });

  it('bite: a split --replicas 0 pair or a computed replica count is caught too', () => {
    expect(
      scaleToZeroArgv(planted("await k(['scale', 'statefulset', 'db', '--replicas', '0']);")),
    ).toEqual(['src/planted.js:1']);
    expect(
      scaleToZeroArgv(planted("await k(['scale', 'statefulset', 'db', '--replicas', 0]);")),
    ).toEqual(['src/planted.js:1']);
    // A count the census cannot read can be zero: a variable after the flag,
    // or interpolated into it.
    expect(
      scaleToZeroArgv(planted("await k(['scale', 'statefulset', 'db', '--replicas', n]);")),
    ).toEqual(['src/planted.js:1']);
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: planted source text, not a template
      scaleToZeroArgv(planted('await k([`scale`, `statefulset`, `db`, `--replicas=${n}`]);')),
    ).toEqual(['src/planted.js:1']);
    expect(
      scaleToZeroArgv(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: planted source text, not a template
        planted("run(['ssh', h, `kubectl scale sts db --replicas ${n} -n vibecarbon`]);"),
      ),
    ).toEqual(['src/planted.js:1']);
    // A literal non-zero count stays legal, split or joined.
    expect(
      scaleToZeroArgv(
        planted(
          "await k(['scale', 'sts', 'db', '--replicas=1']); await k(['scale', 'sts', 'db', '--replicas', '1']);",
        ),
      ),
    ).toEqual([]);
    // A message naming a computed count is words, not an argv.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: planted source text, not a template
    expect(scaleToZeroArgv(planted('throw new Error(`scale with --replicas=${n}`);'))).toEqual([]);
  });

  it('the stale-attachment repair site left docs/mitigations.yml with its code', () => {
    const y = readFileSync(join(ROOT, 'docs/mitigations.yml'), 'utf-8');
    const cls = y.slice(y.indexOf('- class: do-csi-stale-volumeattachment'));
    const entry = cls.slice(0, cls.indexOf('\n  - class:', 1));
    expect(entry).toMatch(/\n {4}sites: \[\]\n/);
    expect(entry).not.toMatch(/waitForPvDetach|stale-attachment repair/);
  });
});

describe('every kubectl argv that crosses ssh is quoted', () => {
  it('no file in src joins a remote kubectl argv by hand', () => {
    expect(unquotedRemoteKubectl(SRC)).toEqual([]);
  });

  it('the sanctioned quoters quote: sshArgv, sshRun and sshKubectl; standbyKubectlCommand', () => {
    expect(quoterProblems(SRC)).toEqual([]);
  });

  it('bite: each unquoted shape is caught, and the quoted ones and log labels are not', () => {
    const bad = [
      "const c = ['kubectl', ...argv].join(' ');",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      'sshExec(ip, `kubectl ${argv.join(" ")}`);',
      "runCommandAsync(['ssh', ...o, host, argv.join(' ')]);",
      "runCommandAsync(['ssh', ...o, host, ['kubectl', ...argv].join(' ')]);",
      "runCommandAsync(['ssh', ...o, host, quote(argv)]);",
      "const k = (argv) => sshExec(ip, 'kubectl ' + argv.slice(1).join(' '));",
    ];
    const hits = bad.map((t) => unquotedRemoteKubectl(planted(t)));
    for (const [i, h] of hits.entries()) expect(h.length, bad[i]).toBeGreaterThan(0);

    const good = [
      "runCommandAsync(['ssh', ...o, host, standbyKubectlCommand(argv)]);",
      "runCommandAsync(['ssh', ...o, host, shJoin(['kubectl', ...argv])]);",
      'const k = (ip, argv, opts) => sshKubectl(ip, sshKeyPath, argv, opts);',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      'run({ description: `deploy: kubectl ${argv.slice(2, 5).join(" ")}` });',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      'const desc = description ?? `kubectl ${args.slice(0, 4).join(" ")}`;',
      "runCommandAsync(['kubectl', '--kubeconfig', p, ...argv]);",
    ];
    for (const t of good) expect(unquotedRemoteKubectl(planted(t)), t).toEqual([]);
  });

  it('bite: a quoter that stops quoting is caught', () => {
    const files = [
      {
        file: 'src/lib/ssh.js',
        text:
          "export function sshArgv(ip, k, argv) {\n  return ['ssh', host, argv.join(' ')];\n}\n" +
          'export async function sshRun(ip, k, argv) {\n  return run(sshArgv(ip, k, argv));\n}\n' +
          'export async function sshKubectl(ip, k, argv) {\n  return sshRun(ip, k, argv);\n}\n',
      },
      {
        file: 'src/lib/deploy/k8s/ha/index.js',
        text: "export function standbyKubectlCommand(argv) {\n  return ['kubectl', ...argv].join(' ');\n}\n",
      },
    ];
    expect(quoterProblems(files)).toEqual([
      'sshArgv does not end its argv with shJoin(argv)',
      "standbyKubectlCommand does not return shJoin(['kubectl', ...argv])",
    ]);
  });
});
