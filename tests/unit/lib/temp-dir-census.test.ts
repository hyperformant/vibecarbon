/**
 * Every temp dir src/ makes comes from src/lib/temp-dir.js, so every one is
 * on the exit sweep: a Ctrl-C (cli.js exits at once, no finally runs), a
 * failure exit and a normal exit all remove whatever is still live. A bare
 * mkdtemp, or a file written straight into os.tmpdir() (the bundle tarball
 * once was), would leave its contents behind on those paths; deploys left
 * thousands of bundles, each with the app's .env, in operators' /tmp.
 *
 * The census over src/ (code only, never comments or strings):
 *   1. no mkdtemp or mkdtempSync outside temp-dir.js;
 *   2. no tmpdir() call outside temp-dir.js, except the allowed files below;
 *   3. a file that makes a temp dir (makeTempDir) also removes one
 *      (removeTempDir). Where in its own code is not checked: a lifetime can
 *      cross functions (renderBundle makes, withBundle removes), so the
 *      behaviour tests own that (tests/unit/deploy/deploy-bundle-lifetime.test.ts
 *      and the per-site tests), and the exit sweep is the backstop.
 * Each rule has a bite test below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODE, lexMask } from '../helpers/js-call-scan.js';

const HELPER = join('src', 'lib', 'temp-dir.js');

/** Files that may call tmpdir(), each with why. */
const TMPDIR_ALLOWED: Record<string, string> = {
  [join('src', 'lib', 'deploy', 'layer-delta.js')]:
    'the base of the private per-user root (deltaWorkRoot); the work dirs in it come from makeTempDir',
};

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Code offsets (not comment or string text) where `re` matches. */
function codeMatches(text: string, re: RegExp): number[] {
  const mask = lexMask(text);
  return [...text.matchAll(re)].map((m) => m.index ?? 0).filter((at) => mask[at] === CODE);
}

const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length;

/** What `file` (its source `text`) does that the census forbids. */
function tempViolations(text: string, file: string): string[] {
  if (file === HELPER) return [];
  const bad: string[] = [];
  for (const at of codeMatches(text, /\bmkdtemp(?:Sync)?\b/g)) {
    bad.push(
      `${file}:${lineOf(text, at)} mkdtemp outside temp-dir.js; use makeTempDir or withTempDir`,
    );
  }
  if (!(file in TMPDIR_ALLOWED)) {
    for (const at of codeMatches(text, /\btmpdir\s*\(/g)) {
      bad.push(
        `${file}:${lineOf(text, at)} tmpdir() outside temp-dir.js; make a temp dir with makeTempDir or withTempDir and write in it`,
      );
    }
  }
  const makes = codeMatches(text, /\bmakeTempDir\s*\(/g);
  if (makes.length > 0 && codeMatches(text, /\bremoveTempDir\s*\(/g).length === 0) {
    bad.push(`${file}:${lineOf(text, makes[0])} makes a temp dir and never calls removeTempDir`);
  }
  return bad;
}

describe('temp dir census (src/)', () => {
  it('every temp dir src/ makes comes from temp-dir.js', () => {
    const files = srcFiles('src');
    expect(files).toContain(HELPER);
    const bad = files.flatMap((f) => tempViolations(readFileSync(f, 'utf-8'), f));
    expect(bad).toEqual([]);
  });

  it('every allowed file still calls tmpdir(), and says why', () => {
    for (const [file, why] of Object.entries(TMPDIR_ALLOWED)) {
      expect(
        codeMatches(readFileSync(file, 'utf-8'), /\btmpdir\s*\(/g).length,
        file,
      ).toBeGreaterThan(0);
      expect(why.length).toBeGreaterThan(20);
    }
  });
});

describe('the census bites', () => {
  const f = join('src', 'lib', 'x.js');

  it('a bare mkdtemp, sync or not, in code', () => {
    expect(tempViolations("const d = mkdtempSync(join(tmpdirPath, 'x-'));\n", f)).toHaveLength(1);
    expect(tempViolations("await fsp.mkdtemp('x-');\n", f)).toHaveLength(1);
    expect(tempViolations("import { mkdtempSync } from 'node:fs';\n", f)).toHaveLength(1);
  });

  it('a file written straight into the OS temp dir', () => {
    expect(
      tempViolations("writeFileSync(join(tmpdir(), 'bundle.tar.gz'), data);\n", f),
    ).toHaveLength(1);
    expect(tempViolations('const t = os.tmpdir();\n', f)).toHaveLength(1);
  });

  it('a temp dir made and never removed', () => {
    expect(tempViolations("const d = makeTempDir('x-');\nreturn d;\n", f)).toHaveLength(1);
    expect(
      tempViolations(
        "const d = makeTempDir('x-');\ntry { a(d); } finally { removeTempDir(d); }\n",
        f,
      ),
    ).toEqual([]);
  });

  it('never a comment or a string', () => {
    expect(
      tempViolations("// mkdtempSync(join(tmpdir(), 'x'))\nconst s = 'mkdtemp tmpdir()';\n", f),
    ).toEqual([]);
  });

  it('the helper itself and an allowed file are exempt where stated', () => {
    expect(tempViolations("mkdtempSync(join(tmpdir(), 'x-'));\n", HELPER)).toEqual([]);
    const allowed = Object.keys(TMPDIR_ALLOWED)[0];
    expect(tempViolations('const base = tmpdir();\n', allowed)).toEqual([]);
    expect(tempViolations("mkdtempSync('x-');\n", allowed)).toHaveLength(1);
  });
});
