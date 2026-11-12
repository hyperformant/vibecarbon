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
 *      tests), and the exit sweep is the backstop. A maker whose dir an
 *      object it hands out keeps using until the process ends is listed in
 *      EXIT_OWNED_MAKERS with its file and why: the exit sweep owns that dir,
 *      so neither the maker nor its callers are held to this rule, unless
 *      another file defines a function of the same name.
 *   4. every temp-dir prefix src/ makes is either one the stale sweep removes
 *      (STALE_SECRET_PREFIXES: it held secrets, so a leftover from an earlier
 *      version or a killed run must go) or listed below with why it never
 *      holds one. A secret-bearing name src/ no longer makes is swept only as
 *      a legacy entry (LEGACY_SECRET_TEMP), which must name the versions that
 *      made it and its shape.
 *   5. the temp-dir.js functions are called by their own names: never
 *      imported under another name or passed by reference, which rules 3 and
 *      4 could not follow.
 * A call is credited to the innermost top-level function holding it (an
 * expression-bodied arrow has no closing brace of its own, so its range is
 * cut at the next function). Each rule has a bite test below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_SECRET_TEMP, STALE_SECRET_PREFIXES } from '../../../src/lib/temp-dir.js';
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
  'vibecarbon-pulumi-':
    "a Pulumi workspace: Pulumi.yaml with the state backend URL (the credentials go in the engine's env) and the stack's encryption salt, which the state backend holds too",
};

/**
 * Makers whose dir the exit sweep owns, each in the one file that may define
 * it, with why: an object they hand out runs in the dir until the process
 * ends, so no function that holds it can remove it. Rule 3 follows neither
 * the maker's own makeTempDir (in that file) nor its callers; rule 4 still
 * classifies the dir's prefix.
 */
const EXIT_OWNED_MAKERS: Record<string, { file: string; why: string }> = {
  makeWorkspaceDir: {
    file: join('src', 'lib', 'iac', 'workspace-dir.js'),
    why:
      'a Pulumi workspace dir: the Stack handed out runs every later command in it (the ' +
      'passphrase probe, the migration, refresh, up, destroy), and a caller can hold that ' +
      'Stack until the command ends',
  },
};

/**
 * Whether the exit sweep owns the dirs `maker`'s calls return: it is listed
 * (an own key, never an Object.prototype name like `toString`), and no file
 * but its listed one defines a top-level function of that name. Calls are
 * followed by name alone, so a second definition anywhere holds every call to
 * the rule again.
 */
function exitOwned(maker: string, sources: Source[]): boolean {
  if (!Object.hasOwn(EXIT_OWNED_MAKERS, maker)) return false;
  const { file } = EXIT_OWNED_MAKERS[maker];
  const definers = sources
    .filter((src) => src.fns.some((fn) => fn.name === maker))
    .map((src) => src.file);
  return definers.length > 0 && definers.every((f) => f === file);
}

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
 * is only `}` (or `};`) at column 0, or the next function's header if that
 * comes first. Biome formats every file, so that line is the function's own
 * closing brace; an expression-bodied arrow (`const f = (s) => s.trim();`)
 * has none, and without the cut its range would run over the functions
 * after it.
 */
function topLevelFunctions(text: string, mask: Uint8Array): Fn[] {
  const header =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(|^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|\(|\w+\s*=>)/gm;
  const headers = codeMatchesOf(text, mask, header);
  const fns: Fn[] = [];
  headers.forEach((m, i) => {
    const start = m.index ?? 0;
    const next = headers[i + 1]?.index ?? text.length;
    // A line that is only the closing brace: `}) {` at column 0 closes a
    // destructured parameter list, not the function.
    const close = /^};?$/gm;
    close.lastIndex = start;
    let end = next;
    for (let c = close.exec(text); c && c.index < next; c = close.exec(text)) {
      if (mask[c.index] === CODE) {
        end = c.index;
        break;
      }
    }
    fns.push({ name: m[1] ?? m[2], start, end });
  });
  return fns;
}

/**
 * The top-level function holding `at`, if any. The ranges never overlap
 * (each ends by the next header), so this is the innermost one.
 */
const fnAt = (src: { fns: Fn[] }, at: number) => src.fns.find((f) => at >= f.start && at < f.end);

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
          const fn = fnAt(src, at);
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

/** The temp-dir.js functions src/ calls; rule 5 holds them to their own names. */
const TEMP_DIR_FNS = ['makeTempDir', 'removeTempDir', 'withTempDir', 'withTempDirSync'];

/**
 * Rule 5: every code mention of a temp-dir.js function is a call by its own
 * name, or a plain name in a static `import { ... } from '.../temp-dir.js'`.
 */
function aliasViolations(file: string, text: string, mask: Uint8Array): string[] {
  const imports = codeMatchesOf(
    text,
    mask,
    /^import\s*\{[^}]*\}\s*from\s*['"][^'"]*\btemp-dir\.js['"]/gm,
  ).map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const bad: string[] = [];
  const mention = new RegExp(`\\b(${TEMP_DIR_FNS.join('|')})\\b`, 'g');
  for (const m of codeMatchesOf(text, mask, mention)) {
    const at = m.index ?? 0;
    const after = text.slice(at + m[0].length);
    const where = `${file}:${lineOf(text, at)} ${m[0]}`;
    if (/^\s*\(/.test(after)) continue;
    if (imports.some((r) => at >= r.start && at < r.end)) {
      if (/^\s+as\b/.test(after)) {
        bad.push(
          `${where} is imported under another name; import it by its own name so the census can follow its calls`,
        );
      }
      continue;
    }
    bad.push(
      `${where} is used without being called (aliased or passed on); call it by its own name so the census can follow it`,
    );
  }
  return bad;
}

/**
 * Rule 4's legacy half: each LEGACY_SECRET_TEMP entry names the versions that
 * made it (the only reason a name src/ no longer makes may be swept) and an
 * exact shape: a dir prefix src/ no longer makes, or an anchored file name.
 */
function legacyViolations(
  entries: ReadonlyArray<Record<string, unknown>>,
  found: Map<string, string>,
): string[] {
  const bad: string[] = [];
  for (const entry of entries) {
    const id = String(entry.prefix ?? entry.name);
    if (!/\bv\d+\.\d+\.\d+\b/.test(String(entry.versions ?? ''))) {
      bad.push(`${id}: no version range; a legacy entry names the versions that made it`);
    }
    if (String(entry.held ?? '').length <= 20)
      bad.push(`${id}: says too little about what it held`);
    if (entry.shape === 'dir') {
      if (typeof entry.prefix !== 'string' || entry.prefix.length === 0) {
        bad.push(`${id}: a dir entry needs its prefix`);
      } else if (found.has(entry.prefix)) {
        bad.push(
          `${id}: src/ still makes it (${found.get(entry.prefix)}), so it belongs in STALE_SECRET_PREFIXES`,
        );
      }
    } else if (entry.shape === 'file') {
      const name = entry.name;
      if (!(name instanceof RegExp) || !name.source.startsWith('^') || !name.source.endsWith('$')) {
        bad.push(`${id}: a file entry needs an exact name pattern (^...$)`);
      }
    } else {
      bad.push(`${id}: shape must be 'dir' or 'file'`);
    }
  }
  return bad;
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
  for (const { file, text, mask } of sources) {
    if (file === HELPER) continue;
    bad.push(...aliasViolations(file, text, mask));
  }
  const makers = returningMakers(sources);
  for (const src of sources) {
    if (src.file === HELPER) continue;
    for (const maker of makers) {
      // The exit sweep owns an exit-owned maker's dir, at every caller.
      if (exitOwned(maker, sources)) continue;
      for (const m of callsOf(src, maker)) {
        const at = m.index ?? 0;
        const where = `${src.file}:${lineOf(src.text, at)} ${maker}()`;
        const fn = fnAt(src, at);
        if (!fn) {
          bad.push(`${where} is outside any top-level function, so nothing is seen to remove it`);
          continue;
        }
        // And in the exit-owned maker itself, in its own file only.
        if (
          Object.hasOwn(EXIT_OWNED_MAKERS, fn.name) &&
          EXIT_OWNED_MAKERS[fn.name].file === src.file
        ) {
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
    // A name src/ no longer makes is swept only with the versions that made it.
    expect(LEGACY_SECRET_TEMP.length).toBeGreaterThan(0);
    expect(legacyViolations(LEGACY_SECRET_TEMP, found)).toEqual([]);
  });

  it('every exit-owned maker is one the census finds, and says why', () => {
    const sources = Object.entries(files).map(([file, text]) => source(file, text));
    const makers = returningMakers(sources);
    for (const [name, { file, why }] of Object.entries(EXIT_OWNED_MAKERS)) {
      // A name that no longer returns a dir it made would excuse nothing,
      // or would excuse a function that no longer needs it; and it is
      // defined in its listed file, and nowhere else.
      expect(makers.has(name), name).toBe(true);
      const definers = sources.filter((src) => src.fns.some((fn) => fn.name === name));
      expect(
        definers.map((src) => src.file),
        name,
      ).toEqual([file]);
      expect(exitOwned(name, sources), name).toBe(true);
      expect(why.length).toBeGreaterThan(20);
    }
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

  it('an exit-owned maker and its callers keep their dirs; any other maker is held to the rule', () => {
    const maker = (name: string) =>
      `export function ${name}() {\n  const d = makeTempDir('w-');\n  dirs.add(d);\n  return d;\n}\n`;
    const caller = (name: string) =>
      `export function open() {\n  return sdk({ workDir: ${name}() });\n}\n`;
    const own = join('src', 'lib', 'iac', 'workspace-dir.js');
    expect(
      tempViolations({ [own]: maker('makeWorkspaceDir'), 'src/b.js': caller('makeWorkspaceDir') }),
    ).toEqual([]);
    expect(
      tempViolations({ 'src/a.js': maker('makeScratchDir'), 'src/b.js': caller('makeScratchDir') }),
    ).toEqual([
      expect.stringMatching(/in makeScratchDir: returns d but never removes it when it throws/),
      expect.stringMatching(/src\/b\.js:2 makeScratchDir\(\) in open is not held in a variable/),
    ]);
  });

  it("the exemption is the listed file's: the same name anywhere else is held to the rule", () => {
    const maker = (name: string) =>
      `export function ${name}() {\n  const d = makeTempDir('w-');\n  dirs.add(d);\n  return d;\n}\n`;
    const caller = 'export function open() {\n  return sdk({ workDir: makeWorkspaceDir() });\n}\n';
    const own = join('src', 'lib', 'iac', 'workspace-dir.js');
    // Only in another file: held there, and at its callers.
    expect(tempViolations({ 'src/a.js': maker('makeWorkspaceDir'), 'src/b.js': caller })).toEqual([
      expect.stringMatching(/src\/a\.js:2 makeTempDir\(\) in makeWorkspaceDir: returns d/),
      expect.stringMatching(/src\/b\.js:2 makeWorkspaceDir\(\) in open is not held/),
    ]);
    // In its own file and a second one: the second is held, and so is every
    // call, which the census cannot tell apart by name.
    expect(
      tempViolations({
        [own]: maker('makeWorkspaceDir'),
        'src/a.js': maker('makeWorkspaceDir'),
        'src/b.js': caller,
      }),
    ).toEqual([
      expect.stringMatching(/src\/a\.js:2 makeTempDir\(\) in makeWorkspaceDir: returns d/),
      expect.stringMatching(/src\/b\.js:2 makeWorkspaceDir\(\) in open is not held/),
    ]);
    // An Object.prototype name is never listed: held in itself and at its callers.
    expect(
      tempViolations({
        'src/a.js': maker('toString'),
        'src/b.js': 'export function open() {\n  return sdk({ workDir: toString() });\n}\n',
      }),
    ).toEqual([
      expect.stringMatching(/in toString: returns d but never removes it when it throws/),
      expect.stringMatching(/src\/b\.js:2 toString\(\) in open is not held/),
    ]);
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

  // An expression-bodied arrow has no closing brace of its own: credited to
  // the outermost range, the maker below was the arrow's, so `render` was
  // never a maker and its caller was never checked.
  it('a one-line arrow before a maker does not take its calls', () => {
    const maker =
      "const first = (s) => s.trim();\nexport function render() {\n  const d = makeTempDir('r-');\n  try {\n    w(d);\n  } catch (e) {\n    removeTempDir(d);\n    throw e;\n  }\n  return d;\n}\n";
    const caller = 'export function deploy() {\n  const out = render();\n  use(out);\n}\n';
    expect(tempViolations({ 'src/a.js': maker, 'src/b.js': caller })).toEqual([
      expect.stringMatching(/src\/b\.js:2 render\(\) in deploy: out is never removed/),
    ]);
    const sources = [source('src/a.js', maker)];
    expect([...returningMakers(sources)]).toEqual(['makeTempDir', 'render']);
    // And a dir a function keeps is named against that function.
    expect(
      one(
        "const first = (s) => s.trim();\nfunction g() {\n  const d = makeTempDir('x-');\n  use(d);\n}\n",
      ),
    ).toEqual([expect.stringMatching(/makeTempDir\(\) in g: d is never removed/)]);
  });

  // A multi-line expression-bodied arrow closes on an indented line, so
  // uncut, its range ran into the next function and that function's removal
  // counted for the arrow's dir.
  it("a removal in the next function never counts for an arrow's dir", () => {
    expect(
      one(
        "const f = async () =>\n  withLock(async () => {\n    const d = makeTempDir('x-');\n    use(d);\n  });\nfunction g(d) {\n  removeTempDir(d);\n}\n",
      ),
    ).toEqual([expect.stringMatching(/makeTempDir\(\) in f: d is never removed/)]);
  });

  it('a temp-dir.js function under another name, or passed on uncalled', () => {
    expect(
      one(
        "import { makeTempDir as mk } from './temp-dir.js';\nfunction f() {\n  const d = mk('x-');\n  use(d);\n}\n",
      ),
    ).toEqual([expect.stringMatching(/:1 makeTempDir is imported under another name/)]);
    expect(one("import { makeTempDir } from './temp-dir.js';\nconst mk = makeTempDir;\n")).toEqual([
      expect.stringMatching(/:2 makeTempDir is used without being called/),
    ]);
    expect(one("const { removeTempDir: rm } = await import('./temp-dir.js');\n")).toEqual([
      expect.stringMatching(/:1 removeTempDir is used without being called/),
    ]);
    expect(one('dirs.forEach(removeTempDir);\n')).toEqual([
      expect.stringMatching(/removeTempDir is used without being called/),
    ]);
    // The plain import, and calls by name, are fine.
    expect(
      one(
        "import { makeTempDir, removeTempDir } from '../temp-dir.js';\nfunction f() {\n  const d = makeTempDir('x-');\n  removeTempDir(d);\n}\n",
      ),
    ).toEqual([]);
  });

  it('a legacy entry without its versions, still made, or without an exact shape', () => {
    const found = new Map([['vc-made-', 'src/a.js:1']]);
    const held = 'a secret that a released version wrote here';
    expect(
      legacyViolations(
        [
          { shape: 'dir', prefix: 'vc-old-', versions: 'up to v0.50.1', held },
          { shape: 'file', name: /^vc-old-\d+\.yaml$/, versions: 'up to v0.49.0', held },
        ],
        found,
      ),
    ).toEqual([]);
    expect(
      legacyViolations([{ shape: 'dir', prefix: 'vc-old-', versions: 'old ones', held }], found),
    ).toEqual([expect.stringMatching(/vc-old-: no version range/)]);
    expect(
      legacyViolations(
        [{ shape: 'dir', prefix: 'vc-made-', versions: 'up to v0.50.1', held }],
        found,
      ),
    ).toEqual([expect.stringMatching(/src\/ still makes it \(src\/a\.js:1\)/)]);
    expect(
      legacyViolations(
        [{ shape: 'file', name: /vc-old-\d+\.yaml/, versions: 'up to v0.49.0', held }],
        found,
      ),
    ).toEqual([expect.stringMatching(/exact name pattern/)]);
  });

  it('the helper itself and an allowed file are exempt where stated', () => {
    expect(one("mkdtempSync(join(tmpdir(), 'x-'));\n", HELPER)).toEqual([]);
    const allowed = Object.keys(TMPDIR_ALLOWED)[0];
    expect(one('const base = tmpdir();\n', allowed)).toEqual([]);
    expect(one("mkdtempSync('x-');\n", allowed)).toHaveLength(1);
  });
});
