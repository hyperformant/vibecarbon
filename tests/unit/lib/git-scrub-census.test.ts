/**
 * Git-context scrub census.
 *
 * GIT_DIR (and GIT_WORK_TREE, GIT_INDEX_FILE, ...) override cwd. git exports
 * them while running hooks, and users run the CLI from husky/lefthook hooks
 * while this repo's own pre-push runs the integration suite. A git command
 * spawned with the inherited env therefore acts on the HOST repo instead of
 * the project: `git init` re-initialises the host, `rev-parse HEAD` answers
 * about the wrong tree, and `core.bare` was flipped once this way.
 *
 * So every git invocation must scrub: `runCommand(..., { cleanEnv: true })`
 * or `env: gitSafeEnv()` for direct execFileSync/spawn callers (tests use
 * gitScrubbedEnv() from tests/_shared/git-env.ts).
 *
 * The walk finds invocations by CALL SHAPE (a balanced-paren scan over every
 * .js/.ts file), not by a hand list, so a new call site is covered the moment it is
 * written:
 *   - gh counts too: it resolves the repo by running git internally (`gh repo
 *     view`, `gh run list`, `gh secret set`, `gh repo create --source=.`), so
 *     an inherited GIT_DIR makes it answer about, or push to, the host repo.
 *     Every gh call is scrubbed, including API-only ones: it is free, and a
 *     list of "which gh calls touch the local repo" would drift.
 *   - a spawner (runCommand, runCommandAsync, execFileSync, execSync, spawn,
 *     spawnSync, execFile, exec, execa...) whose first argument is the string
 *     'git', a string/template starting with "git ", an array starting with
 *     'git', or a buildGitAddArgv(...) call.
 *
 * Scope: all of src/ and bin/; in tests/ every git run in a TEMP repo. A test
 * git call that is read-only against THIS checkout (no cwd, or cwd is the repo
 * root constant) is deliberately out of scope: the host repo is exactly the
 * repo it means to read.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const SPAWNERS = new Set([
  'runCommand',
  'runCommandAsync',
  'execFileSync',
  'execFile',
  'execSync',
  'exec',
  'spawn',
  'spawnSync',
  'nodeSpawn',
  'execa',
  'execaSync',
]);

/** Test-only cwd expressions that mean "this checkout" (a read-only host-repo probe). */
const HOST_REPO_CWD = new Set([
  'ROOT',
  'REPO',
  'REPO_ROOT',
  'PROJECT_ROOT',
  'CARBON',
  'repoRoot',
  'process.cwd()',
]);

/**
 * Exempt invocations, `relative/path.ext:needle` -> reason. The needle is a
 * substring of the call's source text, so the entry survives line drift.
 */
const ALLOWLIST: Record<string, string> = {};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'results' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile() && /\.(js|mjs|ts)$/.test(full) && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Text of the balanced `( ... )` starting at `open` (index of the paren),
 * skipping strings, template literals (with `${}` nesting) and comments, so a
 * `)` inside a message never ends the call early. No AST parser is a direct
 * dependency (typescript 7 ships no JS API), and this shape needs none.
 */
function balancedCall(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else if (c === "'" || c === '"') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '`') {
      let tdepth = 0;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === '$' && src[i + 1] === '{') {
          tdepth++;
          i++;
        } else if (src[i] === '}' && tdepth > 0) tdepth--;
        else if (src[i] === '`' && tdepth === 0) break;
      }
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Text begins with a git command: a string, template or array naming git or gh. */
function startsWithGitCommand(text: string): boolean {
  return (
    /^(['"`])(?:git|gh)(\s|\1)/.test(text) || // 'git' / 'git init' / `git ${x}` / 'gh repo view'
    /^\[\s*['"](?:git|gh)['"]/.test(text) || // ['git', ...] / ['gh', ...]
    /^buildGitAddArgv\(/.test(text)
  );
}

/**
 * First argument is a git command (see the file header): written in the call,
 * or a name the same file assigns one to (`const args = ['gh', 'secret',
 * 'set', key]; runCommandAsync(args, ...)`), so building the argv first never
 * hides a call from the census.
 */
function isGitInvocation(callText: string, fileSrc = ''): boolean {
  const args = callText.slice(1).trimStart();
  if (startsWithGitCommand(args)) return true;
  const name = args.match(/^([\w$]+)\s*[,)]/)?.[1];
  if (!name) return false;
  const escaped = name.replace(/[$]/g, '\\$&');
  for (const m of fileSrc.matchAll(new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*`, 'g'))) {
    if (startsWithGitCommand(fileSrc.slice((m.index ?? 0) + m[0].length))) return true;
  }
  return false;
}

const SCRUB_FNS = 'gitSafeEnv|gitScrubbedEnv';

/**
 * Scrubbed when the call passes `cleanEnv: true` (runCommand), or an `env`
 * built by gitSafeEnv() (src) / gitScrubbedEnv() (tests/_shared/git-env.ts):
 * directly, or via a name the same file assigns from one of them (including
 * `{ ...thatName, EXTRA: 1 }`).
 */
function scrubs(callText: string, fileSrc: string): boolean {
  if (/\bcleanEnv:\s*true\b/.test(callText)) return true;
  const m = callText.match(/\benv:\s*(?:\{\s*\.\.\.)?([\w$]+)/);
  if (!m) return false;
  if (new RegExp(`^(?:${SCRUB_FNS})$`).test(m[1])) return true;
  const name = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${name}\\s*=[^;]*?\\b(?:${SCRUB_FNS})\\(`).test(fileSrc);
}

/** tests/: only calls with a cwd that is not this checkout are temp-repo work. */
function targetsTempRepo(callText: string): boolean {
  // `-C <dir>` points git at another directory whatever the cwd is.
  if (/['"`]-C['"`]/.test(callText)) return true;
  const m = callText.match(/\bcwd(?::\s*([^,}\n]+)|\s*(?=[,}]))/);
  if (!m) return false;
  // Shorthand `{ cwd, ... }` carries a variable named cwd: a temp dir, not a host-repo constant.
  return !HOST_REPO_CWD.has((m[1] ?? 'cwd').trim());
}

interface Site {
  file: string;
  line: number;
  text: string;
  scrubbed: boolean;
}

const CALL_RE = new RegExp(`(?<![\\w$.])(?:[\\w$]+\\.)?(${[...SPAWNERS].join('|')})\\s*\\(`, 'g');

function collectFromSource(rel: string, src: string, inTests: boolean): Site[] {
  const sites: Site[] = [];
  for (const m of src.matchAll(CALL_RE)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const lineStart = src.lastIndexOf('\n', m.index ?? 0) + 1;
    if (/^\s*(\/\/|\*|\/\*)/.test(src.slice(lineStart, m.index))) continue; // prose, not a call
    const callText = balancedCall(src, open);
    if (!isGitInvocation(callText, src)) continue;
    if (inTests && !targetsTempRepo(callText)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    const reason = Object.keys(ALLOWLIST).find(
      (k) => k.startsWith(`${rel}:`) && callText.includes(k.slice(rel.length + 1)),
    );
    sites.push({
      file: rel,
      line,
      text: `${m[1]}${callText}`,
      scrubbed: scrubs(callText, src) || !!reason,
    });
  }
  return sites;
}

function collect(files: string[], inTests: boolean): Site[] {
  return files.flatMap((file) =>
    collectFromSource(
      relative(ROOT, file).split(sep).join('/'),
      readFileSync(file, 'utf-8'),
      inTests,
    ),
  );
}

function report(sites: Site[]): string[] {
  return sites
    .filter((s) => !s.scrubbed)
    .map((s) => `${s.file}:${s.line}  ${s.text.split('\n')[0].slice(0, 90)}`);
}

const FIX =
  'Each git invocation below runs with the inherited GIT_DIR/GIT_WORK_TREE/... In a git hook that makes it act on the HOST repo. ' +
  'Pass `cleanEnv: true` to runCommand, or `env: gitSafeEnv()` (tests: gitScrubbedEnv()) to execFileSync/spawn. Or add an ALLOWLIST entry with a reason.';

describe('every git invocation scrubs the inherited git context', () => {
  it('src/ and bin/', () => {
    const files = [
      ...walk(join(ROOT, 'src')),
      ...(statSync(join(ROOT, 'bin'), { throwIfNoEntry: false })?.isDirectory()
        ? walk(join(ROOT, 'bin'))
        : []),
    ];
    expect(files.length).toBeGreaterThan(50);
    const sites = collect(files, false);
    expect(
      sites.length,
      'census found no git invocations: the shape walk is broken',
    ).toBeGreaterThan(30);
    expect(report(sites), FIX).toEqual([]);
  });

  it('tests/ helpers that run git in a temp repo', () => {
    const sites = collect(
      walk(join(ROOT, 'tests')).filter((f) => !f.endsWith('git-scrub-census.test.ts')),
      true,
    );
    expect(
      sites.length,
      'census found no temp-repo git invocations: the shape walk is broken',
    ).toBeGreaterThan(3);
    expect(report(sites), FIX).toEqual([]);
  });

  it('detects an unscrubbed call and accepts both scrub forms (census not vacuous)', () => {
    const check = (code: string) => collectFromSource('x.js', code, false).map((x) => x.scrubbed);
    expect(check("runCommand('git init', { silent: true })")).toEqual([false]);
    expect(check("runCommand(['git', 'init'], { cleanEnv: true })")).toEqual([true]);
    expect(check("execFileSync('git', ['status'], { env: gitSafeEnv() })")).toEqual([true]);
    expect(
      check("const e = gitScrubbedEnv();\nspawnSync('git', ['add'], { cwd: d, env: e })"),
    ).toEqual([true]);
    expect(check("spawnSync('git', ['add'], { cwd: d, env: process.env })")).toEqual([false]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string IS source text under test
    expect(check('runCommand(`git commit -m ${msg}`, { cleanEnv: false })')).toEqual([false]);
    expect(check('runCommand(buildGitAddArgv(), { silent: true })')).toEqual([false]);
    expect(check("spawnSync('git', ['ls-files'], { cwd: dir })")).toEqual([false]);
    expect(check("runCommand('gh repo view')")).toEqual([false]);
    expect(check("runCommand(['gh', 'repo', 'view'], { cleanEnv: true })")).toEqual([true]);
    expect(check("// runCommand('git init')\nfoo()")).toEqual([]);
    // an argv built first is still a git call
    expect(
      check("const args = ['gh', 'secret', 'set', key];\nrunCommandAsync(args, { silent: true })"),
    ).toEqual([false]);
    expect(
      check("const args = ['gh', 'variable', 'set'];\nrunCommandAsync(args, { cleanEnv: true })"),
    ).toEqual([true]);
    expect(check("const cmd = 'git status';\nrunCommand(cmd)")).toEqual([false]);
    expect(check("const args = ['docker', 'ps'];\nrunCommand(args)")).toEqual([]);
  });

  it('in tests/, a temp repo is recognised by cwd (any spelling) or -C, a host-repo constant is not', () => {
    const check = (code: string) => collectFromSource('t.ts', code, true).map((x) => x.scrubbed);
    expect(check("spawnSync('git', ['add'], { cwd: dir })")).toEqual([false]);
    expect(check("spawnSync('git', ['add'], { cwd, stdio: 'pipe' })")).toEqual([false]);
    expect(check("spawnSync('git', ['add'], { stdio: 'pipe', cwd })")).toEqual([false]);
    expect(check("execFileSync('git', ['-C', dir, 'add', '-A'])")).toEqual([false]);
    expect(check("execFileSync('git', ['-C', dir, 'add'], { env: gitScrubbedEnv() })")).toEqual([
      true,
    ]);
    expect(check("spawnSync('git', ['add'], { cwd, env: gitScrubbedEnv() })")).toEqual([true]);
    // a read-only probe of this checkout is out of scope
    expect(check("spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT })")).toEqual([]);
    expect(check("spawnSync('git', ['rev-parse', 'HEAD'])")).toEqual([]);
  });
});
