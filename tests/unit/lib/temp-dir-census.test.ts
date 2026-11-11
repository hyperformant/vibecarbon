/**
 * Every temp dir src/ makes comes from src/lib/temp-dir.js, so every one is
 * on the exit sweep: a Ctrl-C (cli.js exits at once, no finally runs), a
 * failure exit and a normal exit all remove whatever is still live. A bare
 * mkdtemp, or a file written straight into os.tmpdir() (the bundle tarball
 * once was), would leave its contents behind on those paths; deploys left
 * thousands of bundles, each with the app's .env, in operators' /tmp.
 *
 * The census over src/ (code only, never comments or strings):
 *   1. no mkdtemp in any form (mkdtempSync, fs.promises.mkdtemp,
 *      mkdtempDisposableSync, mkdtempDisposable) outside temp-dir.js;
 *   2. no tmpdir() call outside temp-dir.js, except the allowed files below;
 *   3. every temp dir made is removed by the function that holds it. A maker
 *      is makeTempDir, or a function that returns a dir one made (renderBundle,
 *      the k8s renders): found from the code, not listed, by following
 *      `return <maker>(...)` and `const x = <maker>(...) ... return x`. Each
 *      call of a maker is held in a variable, and the top-level function it
 *      sits in calls removeTempDir on that variable. A maker that returns its
 *      dir must still remove it when it throws (removeTempDir on that
 *      variable), and then each of its callers is held to the same rule.
 *      Where in the function the removal sits (a finally, a catch) is not
 *      checked; the behaviour tests own that
 *      (tests/unit/deploy/deploy-bundle-lifetime.test.ts and the per-site
 *      tests), and the exit sweep is the backstop.
 *   4. every temp-dir prefix src/ makes is either one the stale sweep removes
 *      (STALE_SECRET_PREFIXES: it held secrets, so a leftover from an earlier
 *      version or a killed run must go) or listed below with why it never
 *      holds one.
 * Each rule has a bite test below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STALE_SECRET_PREFIXES } from '../../../src/lib/temp-dir.js';
import { CODE, lexMask } from '../helpers/js-call-scan.js';

const HELPER = join('src', 'lib', 'temp-dir.js');

/** Files that may call tmpdir(), each with why. */
const TMPDIR_ALLOWED: Record<string, string> = {
  [join('src', 'lib', 'deploy', 'layer-delta.js')]:
    'the base of the private per-user root (deltaWorkRoot); the work dirs in it come from makeTempDir',
};

/**
 * Temp-dir prefixes in src/ that never hold a secret, each with why. Every
 * other prefix is in STALE_SECRET_PREFIXES.
 */
const NO_SECRET_PREFIXES: Record<string, string> = {
  'vibecarbon-shell-': "the shell's rc file, which names the provider token only as <set>",
  'vc-bin-':
    "docker's ssh wrapper and its mux socket: no key material, and the socket closes 60 s after its last use",
  'vibecarbon-k8s-':
    'rendered k8s manifests: bucket, endpoint and region; the Secrets go to kubectl on stdin',
  'vibecarbon-cert-manager-': "cert-manager's kustomization",
  DELTA_DIR_PREFIX:
    "the app image's layers, under the private per-user root that sweepStaleDeltaDirs clears",
  'vibecarbon-script-': 'runShellScript, which nothing in src/ calls',
};

/**
 * The prefix each temp dir src/ makes is named by: the string (or the
 * template's text before its first `${`) or the constant passed first to
 * makeTempDir, withTempDir or withTempDirSync.
 */
function tempDirPrefixes(files: Record<string, string>): Map<string, string> {
  const found = new Map<string, string>();
  for (const [file, text] of Object.entries(files)) {
    if (file === HELPER) continue;
    const mask = lexMask(text);
    const calls =
      /\b(?:makeTempDir|withTempDirSync|withTempDir)\s*\(\s*(?:(['"`])((?:(?!\1|\$\{).)*)|([A-Za-z_$][\w$]*))/g;
    for (const m of codeMatchesOf(text, mask, calls)) {
      found.set(m[2] ?? m[3], `${file}:${lineOf(text, m.index ?? 0)}`);
    }
  }
  return found;
}

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Code matches of `re` (never comment or string text). */
function codeMatchesOf(text: string, mask: Uint8Array, re: RegExp): RegExpExecArray[] {
  return [...text.matchAll(re)].filter((m) => mask[m.index ?? 0] === CODE);
}

const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length;
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Fn = { name: string; start: number; end: number };

/**
 * The file's top-level functions: a declaration (`function f(`, exported or
 * async) or an arrow/function `const` at column 0, up to the first line that
 * is only `}` (or `};`) at column 0. Biome formats every file, so that line
 * is the function's own closing brace.
 */
function topLevelFunctions(text: string, mask: Uint8Array): Fn[] {
  const header =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(|^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|\(|\w+\s*=>)/gm;
  const fns: Fn[] = [];
  for (const m of codeMatchesOf(text, mask, header)) {
    const start = m.index ?? 0;
    // A line that is only the closing brace: `}) {` at column 0 closes a
    // destructured parameter list, not the function.
    const close = /^};?$/gm;
    close.lastIndex = start;
    let end = text.length;
    for (let c = close.exec(text); c; c = close.exec(text)) {
      if (mask[c.index] === CODE) {
        end = c.index;
        break;
      }
    }
    fns.push({ name: m[1] ?? m[2], start, end });
  }
  return fns;
}

type Source = { file: string; text: string; mask: Uint8Array; fns: Fn[] };

function source(file: string, text: string): Source {
  const mask = lexMask(text);
  return { file, text, mask, fns: topLevelFunctions(text, mask) };
}

const has = (src: Source, fn: Fn, re: RegExp) =>
  codeMatchesOf(src.text.slice(fn.start, fn.end), src.mask.subarray(fn.start, fn.end), re).length >
  0;

/** Calls of `name` in code, never its own declaration. */
const callsOf = (src: Source, name: string) =>
  codeMatchesOf(src.text, src.mask, new RegExp(`\\b${reEscape(name)}\\s*\\(`, 'g')).filter(
    (m) => !/function\s*\*?\s*$/.test(src.text.slice(Math.max(0, (m.index ?? 0) - 12), m.index)),
  );

/** The variable a call at `at` is assigned to (`x = call(`), or null. */
function heldIn(text: string, at: number): string | null {
  const before = text.slice(Math.max(0, at - 80), at);
  return before.match(/(?:^|[^\w.$])(\w+)\s*=\s*(?:await\s+)?$/)?.[1] ?? null;
}

const returnsDirectly = (text: string, at: number) =>
  /\breturn\s+(?:await\s+)?$/.test(text.slice(Math.max(0, at - 20), at));

/**
 * Every function that returns a temp dir it (or a maker it called) made:
 * makeTempDir, then a fixpoint over `return maker(` and `x = maker(` + `return x`.
 */
function returningMakers(sources: Source[]): Set<string> {
  const makers = new Set(['makeTempDir']);
  for (let grew = true; grew; ) {
    grew = false;
    for (const src of sources) {
      for (const maker of [...makers]) {
        for (const m of callsOf(src, maker)) {
          const at = m.index ?? 0;
          const fn = src.fns.find((f) => at >= f.start && at < f.end);
          if (!fn || makers.has(fn.name)) continue;
          const v = returnsDirectly(src.text, at) ? null : heldIn(src.text, at);
          const returned =
            returnsDirectly(src.text, at) ||
            (v !== null && has(src, fn, new RegExp(`\\breturn\\s+${reEscape(v)}\\b`, 'g')));
          if (returned) {
            makers.add(fn.name);
            grew = true;
          }
        }
      }
    }
  }
  return makers;
}

/** What `files` (path to source) do that the census forbids. */
function tempViolations(files: Record<string, string>): string[] {
  const sources = Object.entries(files).map(([file, text]) => source(file, text));
  const bad: string[] = [];
  for (const { file, text, mask } of sources) {
    if (file === HELPER) continue;
    for (const m of codeMatchesOf(text, mask, /\bmkdtemp\w*/g)) {
      bad.push(
        `${file}:${lineOf(text, m.index ?? 0)} ${m[0]} outside temp-dir.js; use makeTempDir or withTempDir`,
      );
    }
    if (!(file in TMPDIR_ALLOWED)) {
      for (const m of codeMatchesOf(text, mask, /\btmpdir\s*\(/g)) {
        bad.push(
          `${file}:${lineOf(text, m.index ?? 0)} tmpdir() outside temp-dir.js; make a temp dir with makeTempDir or withTempDir and write in it`,
        );
      }
    }
  }
  const makers = returningMakers(sources);
  for (const src of sources) {
    if (src.file === HELPER) continue;
    for (const maker of makers) {
      for (const m of callsOf(src, maker)) {
        const at = m.index ?? 0;
        const where = `${src.file}:${lineOf(src.text, at)} ${maker}()`;
        const fn = src.fns.find((f) => at >= f.start && at < f.end);
        if (!fn) {
          bad.push(`${where} is outside any top-level function, so nothing is seen to remove it`);
          continue;
        }
        // `return maker(...)`: this function hands the dir on, and its callers
        // are held to the rule (it is a maker itself).
        if (returnsDirectly(src.text, at)) continue;
        const v = heldIn(src.text, at);
        if (!v) {
          bad.push(`${where} in ${fn.name} is not held in a variable, so it cannot be removed`);
          continue;
        }
        if (!has(src, fn, new RegExp(`\\bremoveTempDir\\s*\\(\\s*${reEscape(v)}\\s*\\)`, 'g'))) {
          bad.push(
            makers.has(fn.name)
              ? `${where} in ${fn.name}: returns ${v} but never removes it when it throws`
              : `${where} in ${fn.name}: ${v} is never removed (removeTempDir(${v}))`,
          );
        }
      }
    }
  }
  return bad;
}

const one = (text: string, file = join('src', 'lib', 'x.js')) => tempViolations({ [file]: text });

describe('temp dir census (src/)', () => {
  const files = Object.fromEntries(srcFiles('src').map((f) => [f, readFileSync(f, 'utf-8')]));

  it('every temp dir src/ makes comes from temp-dir.js and is removed by its holder', () => {
    expect(Object.keys(files)).toContain(HELPER);
    expect(tempViolations(files)).toEqual([]);
  });

  it('finds the makers that hand a live dir to their callers', () => {
    const sources = Object.entries(files).map(([file, text]) => source(file, text));
    // The census follows these to their callers; a walk that found none
    // would check nothing past the function that made the dir.
    expect([...returningMakers(sources)]).toEqual(
      expect.arrayContaining([
        'makeTempDir',
        'renderBundle',
        'renderK8sBase',
        'renderK8sPlaceholders',
        'renderK8sStorageClassPlaceholder',
        'renderTraefikCrds',
      ]),
    );
  });

  it('every temp-dir prefix is swept as secret-bearing or says why it holds no secret', () => {
    const found = tempDirPrefixes(files);
    const unclassified = [...found]
      .filter(
        ([prefix]) => !STALE_SECRET_PREFIXES.includes(prefix) && !(prefix in NO_SECRET_PREFIXES),
      )
      .map(([prefix, at]) => `${at} ${prefix}`);
    expect(unclassified).toEqual([]);
    // No entry outlives its temp dir, and none sits in both lists.
    for (const prefix of [...STALE_SECRET_PREFIXES, ...Object.keys(NO_SECRET_PREFIXES)]) {
      expect(found.has(prefix), prefix).toBe(true);
    }
    for (const prefix of STALE_SECRET_PREFIXES) expect(prefix in NO_SECRET_PREFIXES).toBe(false);
    for (const why of Object.values(NO_SECRET_PREFIXES)) expect(why.length).toBeGreaterThan(20);
  });

  it('every allowed file still calls tmpdir(), and says why', () => {
    for (const [file, why] of Object.entries(TMPDIR_ALLOWED)) {
      const text = readFileSync(file, 'utf-8');
      expect(codeMatchesOf(text, lexMask(text), /\btmpdir\s*\(/g).length, file).toBeGreaterThan(0);
      expect(why.length).toBeGreaterThan(20);
    }
  });
});

describe('the census bites', () => {
  it('a bare mkdtemp in any form, in code', () => {
    expect(one("const d = mkdtempSync(join(tmpdirPath, 'x-'));\n")).toHaveLength(1);
    expect(one("await fsp.mkdtemp('x-');\n")).toHaveLength(1);
    expect(one("import { mkdtempSync } from 'node:fs';\n")).toHaveLength(1);
    expect(one("using d = mkdtempDisposableSync('/var/x-');\n")).toHaveLength(1);
    expect(one("await using d = await fsp.mkdtempDisposable('/var/x-');\n")).toHaveLength(1);
  });

  it('a file written straight into the OS temp dir', () => {
    expect(one("writeFileSync(join(tmpdir(), 'bundle.tar.gz'), data);\n")).toHaveLength(1);
    expect(one('const t = os.tmpdir();\n')).toHaveLength(1);
  });

  it('a temp dir made and never removed', () => {
    expect(one("function f() {\n  const d = makeTempDir('x-');\n  use(d);\n}\n")).toHaveLength(1);
    expect(
      one(
        "function f() {\n  const d = makeTempDir('x-');\n  try {\n    a(d);\n  } finally {\n    removeTempDir(d);\n  }\n}\n",
      ),
    ).toEqual([]);
  });

  it('a second dir in a function that removes another', () => {
    expect(
      one(
        "function f() {\n  const a = makeTempDir('a-');\n  const b = makeTempDir('b-');\n  removeTempDir(a);\n}\n",
      ),
    ).toEqual([expect.stringMatching(/makeTempDir\(\) in f: b is never removed/)]);
  });

  it('a temp dir in a file whose other functions remove theirs', () => {
    expect(
      one(
        "function f() {\n  const a = makeTempDir('a-');\n  removeTempDir(a);\n}\nfunction g() {\n  const b = makeTempDir('b-');\n  use(b);\n}\n",
      ),
    ).toEqual([expect.stringMatching(/in g: b is never removed/)]);
  });

  it('a dir a maker returns, kept by its caller in another file', () => {
    const maker =
      "export function render() {\n  const d = makeTempDir('r-');\n  try {\n    w(d);\n  } catch (e) {\n    removeTempDir(d);\n    throw e;\n  }\n  return d;\n}\n";
    const handOn = 'export function renderMore() {\n  return render();\n}\n';
    const caller = (name: string) =>
      `export function deploy() {\n  const out = ${name}();\n  use(out);\n}\n`;
    const remover =
      'export function deploy() {\n  const out = render();\n  try {\n    use(out);\n  } finally {\n    removeTempDir(out);\n  }\n}\n';
    expect(tempViolations({ 'src/a.js': maker, 'src/b.js': caller('render') })).toEqual([
      expect.stringMatching(/src\/b\.js:2 render\(\) in deploy: out is never removed/),
    ]);
    // Through a second maker that hands it on.
    expect(
      tempViolations({ 'src/a.js': maker + handOn, 'src/b.js': caller('renderMore') }),
    ).toEqual([expect.stringMatching(/renderMore\(\) in deploy: out is never removed/)]);
    expect(tempViolations({ 'src/a.js': maker, 'src/b.js': remover })).toEqual([]);
  });

  it('a maker that returns its dir must remove it when it throws', () => {
    expect(
      one("export function render() {\n  const d = makeTempDir('r-');\n  w(d);\n  return d;\n}\n"),
    ).toEqual([expect.stringMatching(/in render: returns d but never removes it when it throws/)]);
  });

  it('a dir not held in a variable, or made outside any function', () => {
    expect(one("function f() {\n  use(makeTempDir('x-'));\n}\n")).toEqual([
      expect.stringMatching(/not held in a variable/),
    ]);
    expect(one("const d = makeTempDir('x-');\n")).toEqual([
      expect.stringMatching(/outside any top-level function/),
    ]);
  });

  it('never a comment or a string', () => {
    expect(
      one(
        "// mkdtempSync(join(tmpdir(), 'x'))\nconst s = 'mkdtemp tmpdir() makeTempDir(';\nfunction f() {\n  // const d = makeTempDir('x-');\n}\n",
      ),
    ).toEqual([]);
  });

  it('reads each prefix the way it is written', () => {
    const found = tempDirPrefixes({
      'src/a.js':
        "makeTempDir('a-');\nwithTempDir(`b-" +
        '$' +
        '{x}-`, f);\nwithTempDirSync("c-", f);\nmakeTempDir(D_PREFIX, { parent });\n// makeTempDir(\'comment-\');\n',
    });
    expect([...found.keys()]).toEqual(['a-', 'b-', 'c-', 'D_PREFIX']);
  });

  it('the helper itself and an allowed file are exempt where stated', () => {
    expect(one("mkdtempSync(join(tmpdir(), 'x-'));\n", HELPER)).toEqual([]);
    const allowed = Object.keys(TMPDIR_ALLOWED)[0];
    expect(one('const base = tmpdir();\n', allowed)).toEqual([]);
    expect(one("mkdtempSync('x-');\n", allowed)).toHaveLength(1);
  });
});
