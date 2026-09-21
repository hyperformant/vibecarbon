/**
 * Reader/writer census for the single dotenv dialect (spec
 * docs/superpowers/specs/2026-09-20-dotenv-dialect-design.md, "Enumerable
 * invariants" 3; replaces the old dotenv-parsers-parity test).
 *
 * Invariant: no file parses `.env*` text except through `src/lib/dotenv.js`
 * (or its byte-identical template copy), and no production writer emits an
 * env line except through `formatDotenvLine` / `encodeDotenvValue`.
 *
 * The predicates are structural, not name-based, and every leg on its own is
 * legitimate somewhere in this repo: an `existsSync('.env')` gate, a test
 * that WRITES a fixture `.env`, a test that reads a written file back to
 * assert on its text, a `.split('\n')` over compose output. Only the
 * conjunction marks a hand-rolled parser:
 *
 *   READER  = names a `.env*` path in argument position (`(`, `,` or `[`
 *             before the literal; a comment or `basename === '.env'` does not
 *             count) AND calls a file-read API AND separates KEY from VALUE
 *             (`.split('=')`, `indexOf('=')`, a `KEY=` regex, or a regex
 *             that captures what follows `=`).
 *   WRITER  = a production file (`src/**`, `carbon/scripts/**`; tests writing
 *             fixtures are exempt by root, not by name) whose writeFileSync /
 *             appendFileSync target is a `.env*` path: inline, through a
 *             variable assigned from one, or through a local helper whose
 *             parameter reaches the write and which is called with one.
 *
 * Known false-negative surface (accepted, documented): a parser or writer
 * whose `.env*` literal lives in a DIFFERENT file (the path arrives as a
 * parameter and this file never spells `.env`); a parser with none of the
 * listed shapes (a char-by-char state machine). The `parseEnv`/dotenv-library
 * check and review cover those.
 * A further false negative: a file that imports the module and STILL
 * hand-parses env text is forgiven by the reader test on the strength of the
 * import. The KEY-locator, value-capture and split('=') checks below stay
 * strict regardless of the import (they exempt only the modules, the healer
 * and the rewriters); what remains forgiven is a parser built from
 * `indexOf('=')` + `slice` or from a bare line split (`indexOf('=')` is kept
 * out of the strict check because k3s.js applies it to kubectl output while
 * also reading `.env.local` through the module).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const ROOTS = ['src', 'carbon/scripts', 'carbon/vite.config.ts', 'scripts', 'tests'];
const PRODUCTION_ROOTS = ['src/', 'carbon/scripts/'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'results', 'fixtures']);
const MODULES = new Set(['src/lib/dotenv.js', 'carbon/scripts/lib/dotenv.js']);
// The heal module re-encodes pre-2026-09-20 single-quoted lines: it is the
// one place outside the module that may capture a value out of env text,
// and it hands every capture to formatDotenvLine.
const HEALER = 'src/lib/dotenv-heal.js';
const SELF = 'tests/unit/lib/dotenv-dialect-census.test.ts';
// The oracle test imports `dotenv` and `dotenv-expand` on purpose: it proves
// the writer's output reads back identically through them.
const ORACLE = 'tests/unit/lib/dotenv-oracle.test.ts';
// In-place REWRITERS, allow-listed by exact path. Each locates an existing
// `KEY=` line so comments, blanks and key order ship verbatim (a
// parse-then-serialize cannot promise that), reads no value out of the file,
// and emits every line it changes with formatDotenvLine.
const REWRITERS = new Set([
  // bundle.js: merges deploy-time overrides into the staged server .env.
  'src/lib/deploy/bundle.js',
  // deploy/utils.js mergeRemoteDotenv: pulls the server .env over scp, merges
  // updates, pushes it back.
  'src/lib/deploy/utils.js',
  // project.js setEnvVar: replaces the one `^KEY=` line in .env/.env.local
  // (or appends) — the CLI's canonical single-key writer.
  'src/lib/project.js',
  // up.js setPortOffset/setSubnetPrefix replace one literal-key line and emit
  // it with formatDotenvLine.
  'src/up.js',
]);

function walk(p: string, out: string[] = []) {
  const st = statSync(p);
  if (st.isFile()) {
    if (/\.(js|ts|mjs|cjs)$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
    return out;
  }
  for (const n of readdirSync(p)) if (!SKIP_DIRS.has(n)) walk(join(p, n), out);
  return out;
}

const files = ROOTS.flatMap((r) => walk(join(root, r))).map((f) => relative(root, f));
const read = (f: string) => readFileSync(join(root, f), 'utf-8');
const isProduction = (f: string) => PRODUCTION_ROOTS.some((r) => f.startsWith(r));

/** `.env`, `.env.local`, `.env.e2e` or `.env.example`, quoted, in argument or array position. */
const ENV_PATH_ARG = /[(,[]\s*['"`](?:[^'"`\n]*\/)?\.env(?:\.local|\.e2e|\.example)?['"`]/;
/** A file read by any API this repo uses. */
const READS_A_FILE = /\b(?:readFileSync|readFile|loadEnvFile|createReadStream)\(/;
/** Splitting a line at `=` by hand. */
const SPLITS_AT_EQUALS = /\.split\(['"]=['"]|\.split\(\/=\/|\.indexOf\(['"]=['"]\)/;
/** The `.split('=')` forms alone: never legitimate in a file that reads a `.env*` path. */
const SPLITS_AT_EQUALS_STRICT = /\.split\(['"]=['"]|\.split\(\/=\//;
/**
 * A regex that locates a `KEY=` line: a generic key shape or a `^…=` anchor
 * followed by `=`. This is what the rewriters legitimately do.
 */
const KEY_LOCATOR = new RegExp(
  [
    String.raw`\[A-Za-z_\]\[A-Za-z0-9_\]\*\)?=`, // /^([A-Za-z_][A-Za-z0-9_]*)=/
    String.raw`\[A-Z_\]\[A-Z0-9_\]\*\)?=`, // /^([A-Z_][A-Z0-9_]*)=/
    String.raw`\^\(\[\^=\]\+\)=`, // /^([^=]+)=/
    String.raw`\^\(?\\w\+\)?=`, // /^\w+=/ or /^(\w+)=/
    String.raw`\^\$\{[a-zA-Z_]+\}=`, // new RegExp(`^${key}=`)
  ].join('|'),
);
/**
 * A regex that captures what follows `=`: the hand-rolled value read. Never
 * legitimate over env text outside the module and the healer. In biome-
 * formatted source `=(` and `=\s*(` only occur inside regex literals or
 * strings (assignments get spaces), so the plain-source false-positive rate
 * is: URL-query regexes like `/[?&]name=([^&]+)/` in a file that also reads
 * a `.env*` path — none today.
 */
const VALUE_CAPTURE = /=\\s\*\(|=\(|=\["']\?\(|=\\s\*\["']\?\(|=['"]\(/;
const PARSES_ENV_TEXT = (src: string) =>
  SPLITS_AT_EQUALS.test(src) || KEY_LOCATOR.test(src) || VALUE_CAPTURE.test(src);
const importsModule = (src: string) => /from '(?:[^'\n]*\/)?dotenv(?:-heal)?\.js'/.test(src);
const readsEnvFile = (src: string) => ENV_PATH_ARG.test(src) && READS_A_FILE.test(src);

/** Identifiers assigned a `.env*` path (`const envPath = join(cwd, '.env.local')`). */
function envPathNames(src: string): string[] {
  const re =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:join|resolve|path\.join|path\.resolve)\([^)\n]*['"`]\.env(?:\.local|\.e2e|\.example)?['"`]\s*\)/g;
  return [...src.matchAll(re)].map((m) => m[1]);
}
/** Body of the function declaration whose `{` opens at `open`, by brace matching. */
function bodyAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}
/**
 * Names of local helpers whose FIRST parameter reaches writeFileSync /
 * appendFileSync (`function writeEnv(filename) { … writeFileSync(filename, …) }`).
 */
function fileWriterHelpers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(
    /function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{/g,
  )) {
    const [whole, name, param] = m;
    const body = bodyAt(src, (m.index ?? 0) + whole.length - 1);
    if (
      new RegExp(String.raw`\b(?:writeFileSync|appendFileSync|writeFile)\(\s*${param}\b`).test(body)
    ) {
      out.push(name);
    }
  }
  return out;
}
const ENV_LITERAL_ARG = String.raw`(?:(?:join|resolve|path\.join|path\.resolve)\([^)\n]*)?['"\x60]\.env(?:\.local|\.e2e|\.example)?['"\x60]`;
/**
 * Does this file write to a `.env*` path: inline, through a variable assigned
 * from one, or through a local helper called with one?
 */
function writesEnvFile(src: string): boolean {
  const sinks = ['writeFileSync', 'appendFileSync', 'writeFile', ...fileWriterHelpers(src)];
  const inline = new RegExp(String.raw`\b(?:${sinks.join('|')})\(\s*${ENV_LITERAL_ARG}`);
  if (inline.test(src)) return true;
  const names = envPathNames(src);
  if (names.length === 0) return false;
  return new RegExp(String.raw`\b(?:${sinks.join('|')})\(\s*(?:${names.join('|')})\b`).test(src);
}
/**
 * An env line built by hand: at the start of a template literal, or on its
 * own line inside one (multi-line templates), `UPPER_KEY=` or `${key}=`
 * followed by an interpolation that is not the encoder. A `KEY=${v}` embedded
 * in the same template literal as its flag (`\`--build-arg KEY=${v}\``) does
 * not start a line, so it does not match; a standalone `\`${k}=${v}\`` pushed
 * after the flag does match on shape alone, and the writer set (files whose
 * write sink is a `.env*` path) is what keeps build-arg builders out.
 */
const HAND_BUILT_ENV_LINE =
  /(?:^|`|\\n)\s*(?:[A-Z][A-Z0-9_]*|\$\{[\w.]+\})=(?:["']?\$\{(?!encodeDotenvValue\(|formatDotenvLine\()|["']?\$\{(?!encodeDotenvValue\(|formatDotenvLine\())/m;
/** Hand-rolled quoting/escaping of a value in or out of an env line. */
const HAND_ROLLED_QUOTING = /\^\$\{key\}=|\^\(\?:VITE_|=\["'\]\?|\[\^"'\\n\]/;

/**
 * Node's parser called directly, the dotenv / dotenv-expand libraries by any
 * import form (`from`, side-effect `import 'dotenv/config'`, `require`,
 * dynamic `import()`), or Vite's `loadEnv`. `loadEnv` is caught as Vite's
 * named import, not as a bare call: state.js takes a `loadEnv` parameter that
 * defaults to project.js's module-backed reader.
 */
const DOTENV_LIBRARY =
  /\bparseEnv\(|\bfrom\s+['"]dotenv|\bimport\s*\(?\s*['"]dotenv|\brequire\(\s*['"]dotenv|import\s*\{[^}]*\bloadEnv\b[^}]*\}\s*from\s*['"]vite['"]/;

describe('dotenv dialect census', () => {
  it('walks the expected roots', () => {
    expect(files).toContain('src/lib/dotenv.js');
    expect(files).toContain('carbon/scripts/lib/dotenv.js');
    expect(files).toContain('carbon/vite.config.ts');
    expect(files).toContain(SELF);
    for (const f of [...REWRITERS, HEALER, ORACLE]) expect(files).toContain(f);
    expect(files.some((f) => f.startsWith('tests/fixtures/'))).toBe(false);
  });

  it('the predicates recognise the shapes they claim to', () => {
    // READER conjunction: the hand-rolled loader the docker tests used to carry.
    const hand = `const c = readFileSync(join(dir, '.env.local'), 'utf-8');\nfor (const l of c.split('\\n')) { const [k, ...v] = l.split('='); }`;
    expect(readsEnvFile(hand) && PARSES_ENV_TEXT(hand)).toBe(true);
    // Legitimate single legs.
    expect(readsEnvFile("if (existsSync(join(cwd, '.env'))) run();")).toBe(false);
    expect(
      PARSES_ENV_TEXT(
        "const envContent = readFileSync(join(d, '.env.local'), 'utf-8');\nexpect(envContent).toContain('JWT_SECRET=');",
      ),
    ).toBe(false);
    expect(ENV_PATH_ARG.test("// `where: '.env'` keys ship in the bundle")).toBe(false);
    expect(ENV_PATH_ARG.test("if (basename === '.env') return true;")).toBe(false);
    // Value captures, including the healer's legacy form and the sitemap mirror's old regex.
    expect(VALUE_CAPTURE.test("/^([A-Za-z_][A-Za-z0-9_]*)='(.*)'\\s*$/")).toBe(true);
    expect(VALUE_CAPTURE.test('/^SITE_URL=["\']?(.+?)["\']?\\s*$/m')).toBe(true);
    expect(VALUE_CAPTURE.test('const x = (a + b);\nconst y = f(z);')).toBe(false);
    expect(VALUE_CAPTURE.test(String.raw`/^KEY=\s*["']?([^"'\n]+)/`)).toBe(true);
    // The old template regex shape `[^"'\n]+` as it appears in a regex literal.
    expect(HAND_ROLLED_QUOTING.test(String.raw`/^KEY=([^"'\n]+)/`)).toBe(true);
    expect(HAND_ROLLED_QUOTING.test('/^KEY=(.*)$/m')).toBe(false);
    // Every way to pull the dotenv library (or dotenv-expand) into a process.
    for (const form of [
      "import dotenv from 'dotenv';",
      "import 'dotenv/config';",
      "import { expand } from 'dotenv-expand';",
      "const dotenv = require('dotenv');",
      "const m = await import('dotenv');",
      "import { loadEnv } from 'vite';",
    ]) {
      expect(DOTENV_LIBRARY.test(form), form).toBe(true);
    }
    expect(DOTENV_LIBRARY.test('const env = loadEnv(cwd) ?? {};')).toBe(false);
    // WRITER: inline target, tracked variable, and a non-env target.
    expect(writesEnvFile("writeFileSync(join(projectDir, '.env'), envLocal);")).toBe(true);
    expect(
      writesEnvFile("const envPath = join(cwd, '.env.local');\nwriteFileSync(envPath, text);"),
    ).toBe(true);
    expect(
      writesEnvFile(
        "const envPath = join(cwd, '.env.local');\nconst e = parseDotenv(readFileSync(envPath));\nwriteFileSync(overlayPath, yaml);",
      ),
    ).toBe(false);
    expect(
      writesEnvFile(
        "function writeEnv(filename) {\n  if (skip) { return false; }\n  writeFileSync(filename, envContent);\n}\nwriteEnv('.env');",
      ),
    ).toBe(true);
    expect(
      writesEnvFile(
        "function writeEnv(filename) {\n  writeFileSync(filename, envContent);\n}\nwriteEnv('compose.yml');",
      ),
    ).toBe(false);
    // Hand-built lines vs. the encoder. Samples spell the interpolation as
    // `@{` so they stay plain strings (biome noTemplateCurlyInString); `js`
    // turns them back into the source shape under test.
    const js = (sample: string) => sample.replaceAll('@{', '${');
    expect(HAND_BUILT_ENV_LINE.test(js('lines.push(`@{k}=@{v}`);'))).toBe(true);
    expect(HAND_BUILT_ENV_LINE.test(js('const t = `\nDB_PASSWORD="@{pw}"\n`;'))).toBe(true);
    expect(
      HAND_BUILT_ENV_LINE.test(js('const t = `# header\nPROJECT_NAME=@{projectName}\n`;')),
    ).toBe(true);
    expect(
      HAND_BUILT_ENV_LINE.test(
        js('const t = `@{formatDotenvLine("A", a)}\n@{formatDotenvLine("B", b)}`;'),
      ),
    ).toBe(false);
    expect(
      HAND_BUILT_ENV_LINE.test(
        js('const t = `PROJECT_NAME=@{encodeDotenvValue("PROJECT_NAME", n)}`;'),
      ),
    ).toBe(false);
    // The shape alone matches a build-arg; the writer set scopes it to .env* writers.
    expect(HAND_BUILT_ENV_LINE.test(js("args.push('--build-arg', `@{k}=@{v}`);"))).toBe(true);
  });

  it('only the two dotenv modules call util.parseEnv or a dotenv library', () => {
    for (const f of files) {
      if (MODULES.has(f) || f === SELF || f === ORACLE) continue;
      expect(read(f), f).not.toMatch(DOTENV_LIBRARY);
    }
  });

  it('parseDotenv and readEnvFiles are imported from a dotenv.js, never re-exported', () => {
    const offenders = files.filter((f) => {
      if (MODULES.has(f) || f === SELF) return false;
      const src = read(f);
      const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)];
      return imports.some(
        ([, names, spec]) =>
          /\b(?:parseDotenv|readEnvFiles|formatDotenvLine|encodeDotenvValue|dotenvValueProblem)\b/.test(
            names,
          ) && !/(?:^|\/)dotenv\.js$/.test(spec),
      );
    });
    expect(offenders).toEqual([]);
    for (const f of files) {
      if (MODULES.has(f)) continue;
      expect(read(f), f).not.toMatch(/export\s*\{[^}]*\b(?:parseDotenv|readEnvFiles)\b/);
    }
  });

  it('every file that reads and parses a .env* path imports the dotenv module', () => {
    const offenders = files.filter((f) => {
      if (MODULES.has(f) || f === SELF) return false;
      const src = read(f);
      return readsEnvFile(src) && PARSES_ENV_TEXT(src) && !importsModule(src);
    });
    expect(offenders).toEqual([]);
  });

  it('no file that reads a .env* path captures a value out of the text, even alongside the module', () => {
    const offenders = files.filter((f) => {
      if (MODULES.has(f) || f === SELF || f === HEALER) return false;
      const src = read(f);
      return readsEnvFile(src) && VALUE_CAPTURE.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("no file that reads a .env* path splits a line at '=' by hand, even alongside the module", () => {
    const offenders = files.filter((f) => {
      if (MODULES.has(f) || f === SELF) return false;
      const src = read(f);
      return readsEnvFile(src) && SPLITS_AT_EQUALS_STRICT.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('no file matches KEY= against env text except the modules, the healer and the rewriters', () => {
    const offenders = files.filter((f) => {
      if (MODULES.has(f) || f === SELF || f === HEALER || REWRITERS.has(f)) return false;
      const src = read(f);
      return HAND_ROLLED_QUOTING.test(src) || (readsEnvFile(src) && KEY_LOCATOR.test(src));
    });
    expect(offenders).toEqual([]);
  });

  it('every production .env* writer imports the module and builds no line by hand', () => {
    const writers = files.filter(
      (f) => isProduction(f) && !MODULES.has(f) && writesEnvFile(read(f)),
    );
    // Sanity: the writer predicate must see the writers we know about.
    for (const known of [
      'src/create.js',
      'src/lib/project.js',
      'carbon/scripts/dev-init.js',
      ...REWRITERS,
    ]) {
      expect(writers, `writer predicate lost ${known}`).toContain(known);
    }
    const noImport = writers.filter((f) => !importsModule(read(f)));
    expect(noImport).toEqual([]);
    const handBuilt = writers.filter((f) => HAND_BUILT_ENV_LINE.test(read(f)));
    expect(handBuilt).toEqual([]);
  });

  for (const rewriter of REWRITERS) {
    it(`${rewriter} emits changed lines with formatDotenvLine and reads no value`, () => {
      const src = read(rewriter);
      expect(src).toContain('formatDotenvLine(');
      expect(src).toContain('tests/unit/lib/dotenv-dialect-census.test.ts');
      // Every KEY= locator in the file is followed by an emission through the encoder.
      if (rewriter === 'src/lib/project.js') {
        expect(src).toMatch(/const replacement = formatDotenvLine\(key, value\);/);
        expect(src).toMatch(/content\.replace\(regex, \(\) => replacement\)/);
      } else if (rewriter === 'src/up.js') {
        // Three literal keys, each: line built by the encoder, whole existing
        // line replaced by it (or appended) — never a hand-built `KEY=${…}`.
        for (const [key, name] of [
          ['DEV_PORT_OFFSET', 'line'],
          ['VITE_DEV_PORT_OFFSET', 'viteLine'],
          ['DEV_SUBNET_PREFIX', 'line'],
        ]) {
          expect(src).toMatch(
            new RegExp(String.raw`const ${name} = formatDotenvLine\('${key}', String\(\w+\)\);`),
          );
          expect(src).toMatch(new RegExp(String.raw`/\^${key}=\.\*\$/m`));
        }
        expect(src).toMatch(/content\.replace\(regex, \(\) => line\)/);
        expect(src).toMatch(/content\.replace\(viteRegex, \(\) => viteLine\)/);
      } else {
        expect(src).toMatch(/\.map\(\(line\) =>[\s\S]*?return formatDotenvLine\(/);
        expect(src).toMatch(/merged\.push\(formatDotenvLine\(/);
      }
      expect(src).not.toMatch(/`\$\{[a-zA-Z.[\]0-9]+\}=\$\{(?!formatDotenvLine)/);
      expect(VALUE_CAPTURE.test(src)).toBe(false);
    });
  }

  it('the retired identifiers are gone', () => {
    for (const f of files) {
      if (f === SELF) continue;
      expect(read(f), f).not.toMatch(/\b(escapeDotenv|decodeDotenvValue|unescapeDotenv)\b/);
    }
  });

  it('the CLI and template modules are byte-identical', () => {
    expect(read('carbon/scripts/lib/dotenv.js')).toBe(read('src/lib/dotenv.js'));
  });
});
