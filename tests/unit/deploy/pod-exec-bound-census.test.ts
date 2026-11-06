/**
 * Census: no kubectl call that reaches a pod can hang a deploy.
 *
 * `kubectl exec` into the db hung for 30 s on 2 of 11 first warm deploys, cause
 * unknown, so any call down the same path can hang the same way: apiserver to
 * kubelet to the container. `sshRun`'s default is 120 s and runCommandAsync has
 * none, so an omitted timeout means minutes or forever. Every call that reaches
 * a pod on the deploy, restore, failover and reseed paths therefore names its
 * own bound, chosen for what the call does (POD_EXEC_* in db-workload.js).
 *
 * The census keys on what reaches a pod, so `apply`, `get`, `patch` and
 * `rollout` never appear in it:
 *
 *   - an array element that is exactly a pod verb (`'exec'`, `'logs'`, ...);
 *   - a call of an argv builder that spells one (ARGV_BUILDERS);
 *   - `kubectl exec` in the command string of an `['ssh', ...]` argv.
 *
 * From each it finds the call that runs the argv and asks for a `timeout`
 * after the argv. An argv it cannot follow to a call fails: a new shape has to
 * be taught here, never skipped. `kubectl exec` in any other string is text for
 * an operator to read, and those are counted in OPERATOR_TEXT.
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
import { afterEach, describe, expect, it } from 'vitest';
import {
  enclosingBracket,
  enclosingFunctionName,
  findCalls,
  functionRanges,
  lex,
  STRING,
} from '../helpers/js-call-scan.js';

const ROOT = join(__dirname, '../../..');
const ROOTS = [
  'src/lib/deploy',
  'src/lib/iac',
  'src/failover.js',
  'src/restore.js',
  'src/backup.js',
];

/** The kubectl verbs that go through the kubelet to a pod. */
const POD_VERB = /^(exec|logs|attach|cp|port-forward)$/;

/** The functions that return a pod argv, whose callers the census reads instead. */
const ARGV_BUILDERS = ['dbExecArgv', 'k8sDbMarkerExec', 'k8sWalgAuditArgv', 'k8sWalgRoleExecArgv'];

/** A runner that binds what it runs: the census cannot see this from the call. */
const BOUND_BY_RUNNER: Record<string, string> = {
  'src/lib/deploy/orchestrator.js:safeRun':
    'the post-deploy diagnostics helper: its one runCommandAsync passes timeout: 30_000',
  'src/lib/deploy/k8s/k3s.js:clusterAutoscalerDiagnosticCommands':
    'returns argvs that only runDeployDiagnostic runs, at DIAGNOSTIC_TIMEOUT_MS',
};

/**
 * A remote script that runs a pod verb among other commands: the bound is on
 * the script's whole run, so the census trusts these by name. Checked below.
 */
const BOUND_BY_SCRIPT: Record<string, string> = {
  'src/backup.js:buildBackupJobWaitScript':
    'runs at the job deadline plus 120 s; its pod logs are failure diagnostics',
  'src/backup.js:triggerBackupJob': 'the failure diagnostics script runs at timeout: 90_000',
  'src/lib/deploy/k8s/ha/index.js:relayDiagnostics':
    'each lookup passes POD_EXEC_QUERY_MS to the runner',
};

/** A pod verb as text for an operator to read, counted per function. */
const OPERATOR_TEXT: Record<string, number> = {
  'src/failover.js:k8sFailoverAbortBackend': 1,
  'src/failover.js:unquiesce': 1,
  'src/lib/deploy/k8s/ha/index.js:assertStandbyNotPromotedOutside': 1,
  'src/lib/deploy/k8s/k3s.js:assertRestoreMarkerState': 1,
  'src/lib/deploy/k8s/k3s.js:finishDeployRestore': 1,
  'src/lib/deploy/k8s/readiness.js:awaitAppAdminReady': 1,
  'src/lib/deploy/k8s/readiness.js:watchAppMigrationFailure': 2,
  'src/lib/deploy/replication.js:reseedStandbyInPlace': 2,
  'src/lib/deploy/walg-audit.js:<module>': 1,
  'src/lib/deploy/walg-role.js:walgRoleDegradedMessage': 1,
  'src/restore.js:runK8sRestore': 2,
};

interface Site {
  file: string;
  fn: string;
  line: number;
  what: string;
}

function walk(root: string, rel: string): string[] {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(join(root, rel));
  } catch {
    return [];
  }
  if (!st.isDirectory()) return /\.(m|c)?js$/.test(rel) ? [rel] : [];
  return readdirSync(join(root, rel)).flatMap((n) => walk(root, join(rel, n)));
}

const NOT_A_CALL = /^(if|for|while|switch|catch|return|function)$/;

/**
 * The call around `at`, climbing out of array literals, and the source between
 * the end of the argv and the call's closing paren. Null when the argv is not
 * an argument of any call.
 */
function runnerOf(text: string, mask: Uint8Array, at: number, argvEnd: number) {
  let pos = at;
  let end = argvEnd;
  for (;;) {
    const bracket = enclosingBracket(text, mask, pos);
    if (!bracket) return null;
    const close = bracket.open + bracket.text.length;
    if (text[bracket.open] === '(') {
      const name = /([\w$.]+)\s*$/.exec(
        text.slice(Math.max(0, bracket.open - 80), bracket.open),
      )?.[1];
      if (name && !NOT_A_CALL.test(name)) {
        return { name: name.split('.').at(-1) as string, tail: text.slice(end, close - 1) };
      }
    }
    pos = bracket.open;
    end = close;
  }
}

/** A `timeout` after the argv, or a plain options variable that holds one. */
function hasBound(text: string, tail: string): boolean {
  if (/\btimeout\b/.test(tail)) return true;
  const name = /^\s*,\s*(\w+)\s*,?\s*$/.exec(tail)?.[1];
  if (!name) return false;
  return new RegExp(`\\bconst ${name} = \\{[^}]*\\btimeout\\b`).test(text);
}

/** The builder a top-level array literal is the return value of, if any. */
function builderOf(text: string, open: number): string | undefined {
  const before = text.slice(Math.max(0, open - 160), open);
  return /(?:const (\w+) = \([^)]*\) =>|function (\w+)\([^)]*\) \{\s*return)\s*$/
    .exec(before)
    ?.slice(1)
    .find(Boolean);
}

/** Every pod-reaching call in a source, split by what the census could prove. */
function scan(file: string, text: string) {
  const { mask } = lex(text);
  const ranges = functionRanges(text, mask);
  const lineOf = (at: number) => text.slice(0, at).split('\n').length;
  const fnOf = (at: number) => enclosingFunctionName(ranges, at);
  const unbounded: Site[] = [];
  const operatorText: Site[] = [];
  const bounded: Site[] = [];

  const judge = (at: number, argvEnd: number, what: string, fn = fnOf(at)) => {
    const site = { file, fn, line: lineOf(at), what };
    const runner = runnerOf(text, mask, at, argvEnd);
    if (runner && hasBound(text, runner.tail)) bounded.push(site);
    else if (BOUND_BY_RUNNER[`${file}:${runner?.name ?? fn}`]) bounded.push(site);
    else unbounded.push(site);
  };

  for (const m of text.matchAll(/(['"])([a-z-]+)\1/g)) {
    const at = m.index ?? 0;
    if (!POD_VERB.test(m[2]) || mask[at] !== STRING || mask[at - 1] === STRING) continue;
    const array = enclosingBracket(text, mask, at);
    if (!array || text[array.open] !== '[') continue;
    if (/^\[\s*['"]docker['"]/.test(array.text)) continue;
    // A listed builder's callers are judged below. An unlisted one has no
    // callers the census knows of, so it falls through and fails closed.
    if (ARGV_BUILDERS.includes(builderOf(text, array.open) ?? '')) continue;
    judge(at, array.open + array.text.length, m[2]);
  }

  for (const call of findCalls(text, ARGV_BUILDERS)) {
    judge(call.at, call.at + call.text.length, call.name);
  }

  for (const m of text.matchAll(/kubectl\b[^`'"\n]*?\b(?:exec|logs|attach|cp|port-forward)\b/g)) {
    const at = m.index ?? 0;
    if (mask[at] !== STRING) continue;
    const array = enclosingBracket(text, mask, at);
    if (array && text[array.open] === '[' && /^\[\s*['"]ssh['"]/.test(array.text)) {
      judge(at, array.open + array.text.length, 'ssh command string');
    } else if (BOUND_BY_SCRIPT[`${file}:${fnOf(at)}`]) {
      bounded.push({ file, fn: fnOf(at), line: lineOf(at), what: 'remote script' });
    } else {
      operatorText.push({ file, fn: fnOf(at), line: lineOf(at), what: 'operator text' });
    }
  }
  return { unbounded, operatorText, bounded };
}

function census(root: string) {
  const all = ROOTS.flatMap((r) => walk(root, r)).map((f) =>
    scan(f, readFileSync(join(root, f), 'utf-8')),
  );
  return {
    unbounded: all.flatMap((s) => s.unbounded),
    operatorText: all.flatMap((s) => s.operatorText),
    bounded: all.flatMap((s) => s.bounded),
  };
}

const label = (s: Site) => `${s.file}:${s.line} ${s.fn} (${s.what})`;

describe('census: every kubectl call that reaches a pod has a bound', () => {
  const found = census(ROOT);

  it('every pod call names a timeout', () => {
    expect(found.unbounded.map(label)).toEqual([]);
  });

  it('it found the family, so a scanner that stopped matching cannot pass quietly', () => {
    expect(found.bounded.length).toBeGreaterThan(40);
    const files = new Set(found.bounded.map((s) => s.file));
    for (const f of [
      'src/backup.js',
      'src/failover.js',
      'src/lib/deploy/backup-fence.js',
      'src/lib/deploy/k8s/ha/index.js',
      'src/lib/deploy/k8s/k3s.js',
      'src/lib/deploy/k8s/readiness.js',
      'src/lib/deploy/orchestrator.js',
      'src/lib/deploy/replication.js',
      'src/lib/deploy/retired-fence.js',
      'src/lib/deploy/walg-role.js',
      'src/restore.js',
    ]) {
      expect(files).toContain(f);
    }
  });

  it('kubectl exec anywhere else is text for an operator to read', () => {
    const counted: Record<string, number> = {};
    for (const s of found.operatorText) {
      const key = `${s.file}:${s.fn}`;
      counted[key] = (counted[key] ?? 0) + 1;
    }
    expect(counted).toEqual(OPERATOR_TEXT);
  });

  it('every remote script it trusts by name still exists', () => {
    const sites = found.bounded.filter((s) => s.what === 'remote script');
    expect(new Set(sites.map((s) => `${s.file}:${s.fn}`))).toEqual(
      new Set(Object.keys(BOUND_BY_SCRIPT)),
    );
    const backup = readFileSync(join(ROOT, 'src/backup.js'), 'utf-8');
    expect(backup).toMatch(/kubectl logs[\s\S]{0,200}\{ timeout: 90_000 \}/);
    expect(backup).toMatch(
      /buildBackupJobWaitScript\(jobName\), \{[\s\S]{0,120}BACKUP_JOB_ACTIVE_DEADLINE_S \+ JOB_DEADLINE_GRACE_S \+ 120/,
    );
    const ha = readFileSync(join(ROOT, 'src/lib/deploy/k8s/ha/index.js'), 'utf-8');
    expect(ha).toContain('exec(primaryIp, script, undefined, POD_EXEC_QUERY_MS)');
  });

  it('the runners it trusts really do bind what they run', () => {
    const orchestrator = readFileSync(join(ROOT, 'src/lib/deploy/orchestrator.js'), 'utf-8');
    expect(orchestrator).toMatch(/const safeRun = async[\s\S]{0,160}timeout: 30_000/);
    const k3s = readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const runner = k3s.slice(k3s.indexOf('export async function runDeployDiagnostic('));
    expect(runner.slice(0, runner.indexOf('catch (err)'))).toContain(
      'timeout: DIAGNOSTIC_TIMEOUT_MS',
    );
    expect(k3s.match(/clusterAutoscalerDiagnosticCommands\(/g)?.length).toBe(2);
  });
});

describe('the census bites', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plant = (body: string) => {
    dir = mkdtempSync(join(tmpdir(), 'vc-pod-exec-census-'));
    const f = join(dir, 'src/lib/deploy/x.js');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, body);
    return census(dir);
  };

  it.each([
    [
      'ssh kubectl with no options',
      "async function a() { await sshKubectl(ip, key, ['exec', pod, '--', 'ls']); }",
    ],
    [
      'options without a timeout',
      "async function a() { await run(['kubectl', 'exec', pod], { silent: true }); }",
    ],
    ['logs', "async function a() { await kubectl(ip, ['logs', pod]); }"],
    ['a builder call', 'async function a() { await kubectl(dbExecArgv(["ls"])); }'],
    [
      'an options variable with no timeout',
      "async function a() { const opts = { silent: true }; await kubectl(ip, ['exec', pod], opts); }",
    ],
    [
      'an argv it cannot follow',
      "const argv = ['exec', pod];\nasync function a() { await kubectl(ip, argv, { timeout: 1 }); }",
    ],
    [
      'a spread pod argv',
      "async function a() { await run(['kubectl', ...k8sWalgAuditArgv(p)], { silent: true }); }",
    ],
    [
      'an argv builder the census has not been told about',
      "function newPodArgv(p) { return ['-n', 'x', 'exec', p, '--', 'ls']; }",
    ],
    [
      'an ssh string with another pod verb',
      `async function a() { await run(['ssh', 'root@x', \`kubectl logs \${p}\`], { silent: true }); }`,
    ],
    [
      'an ssh command string',
      `async function a() { await run(['ssh', 'root@x', \`kubectl exec \${p} -- ls\`], { silent: true }); }`,
    ],
    [
      'a timeout before the argv only',
      "async function a() { await kubectl({ timeout: 1 }, ['exec', pod]); }",
    ],
  ])('flags %s', (_name, body) => {
    expect(plant(body).unbounded).toHaveLength(1);
  });

  it.each([
    ['apply', "async function a() { await kubectl(ip, ['apply', '-f', '-']); }"],
    ['get', "async function a() { await kubectl(ip, ['get', 'pods']); }"],
    ['rollout', "async function a() { await run(['kubectl', 'rollout', 'status', 'x'], {}); }"],
    ['patch', "async function a() { await kubectl(ip, ['patch', 'configmap', 'x']); }"],
    ['docker exec', "async function a() { await run(['docker', 'exec', 'c', 'ls'], {}); }"],
    ['a bounded exec', "async function a() { await kubectl(ip, ['exec', pod], { timeout: 1 }); }"],
    [
      'a bounded spread',
      "async function a() { await run(['kubectl', ...k8sWalgAuditArgv(p)], { timeout: 1 }); }",
    ],
    [
      'a bound in an options variable',
      "async function a() { const opts = { timeout: 1 }; await kubectl(ip, ['exec', pod], opts); }",
    ],
    [
      'a bounded ssh string',
      `async function a() { await run(['ssh', 'root@x', \`kubectl exec \${p}\`], { timeout: 1 }); }`,
    ],
    ['a word in a comment', "// await kubectl(ip, ['exec', pod]);\nfunction a() {}"],
    ['a word in a longer string', 'const s = "the \'exec\' verb";'],
    ['a verb tested, never run', "function a(argv) { return argv.includes('exec'); }"],
  ])('leaves %s alone', (_name, body) => {
    expect(plant(body).unbounded).toEqual([]);
  });

  it('counts a kubectl exec outside an ssh argv as operator text', () => {
    const { operatorText, unbounded } = plant(
      `function a() { throw new Error(\`run kubectl -n x exec \${p} -- ls\`); }`,
    );
    expect(operatorText).toHaveLength(1);
    expect(unbounded).toEqual([]);
  });
});
