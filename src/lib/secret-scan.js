/**
 * Secret-leak detector for vibecarbon-managed projects.
 *
 * Two layers of defense feed off this module:
 *   1. The pre-commit hook scaffolded into every `vibecarbon create` project
 *      (.git/hooks/pre-commit calls scripts/secret-scan.mjs over staged files).
 *      Catches secrets before they enter git history.
 *   2. The CLI deploy/add path. Runs against the working tree (filtered
 *      through `git ls-files`, so .gitignore is respected and the scan
 *      mirrors what `git push` would actually upload) and refuses the
 *      operation on any finding. Belt-and-suspenders against
 *      `git commit --no-verify`.
 *
 * No `--allow-secrets` bypass exists by design. If a finding is a true
 * false positive, add the substring (or `regex:<pat>`) to .vibecarbonignore
 * at the repo root. If the finding is real, rotate the credential and
 * remove it from history before retrying.
 *
 * What counts as a secret (the rules, the allowlist match, the files never
 * opened) lives in ./secret-scan-rules.js, which the generated project's
 * scanner runs from a byte-identical copy. This file adds what only the CLI
 * does: walking the tree and refusing the command.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { c } from './colors.js';
import { gitSafeEnv } from './command.js';
import {
  MAX_FILE_BYTES,
  parseAllowlist,
  SECRET_RULES,
  scanContent,
  skipsPath,
} from './secret-scan-rules.js';

export { SECRET_RULES, scanContent };

/**
 * Load the allowlist from `.vibecarbonignore` at the given repo root.
 * Returns an empty array if the file is missing.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
function loadAllowlist(cwd = process.cwd()) {
  const path = join(cwd, '.vibecarbonignore');
  try {
    return parseAllowlist(readFileSync(path, 'utf-8'));
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
    throw err;
  }
}

// Directories we never want to descend into during a tree-walk scan.
// node_modules / build outputs / vendor stuff would slow us down (many
// of these contain test fixtures or minified blobs that trip the
// generic-secret rule). Each entry matches a basename.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  '.vercel',
  '.turbo',
  '.pnpm-store',
  'dist',
  'build',
  'out',
  'coverage',
  '.nyc_output',
  '.pulumi',
  '.terraform',
  '.vibecarbon', // local CLI state — generated, not source
  '.venv',
  'venv',
  '__pycache__',
]);

/**
 * Basenames that are universally gitignored across vibecarbon-generated
 * projects (and ~all node/12-factor apps): runtime secret holders that
 * are NEVER intended to be pushed. Only honored in the no-git fallback
 * walk — when we have a real git tree, we trust `git ls-files
 * --exclude-standard`, which already filters via the project's actual
 * .gitignore (and would correctly fire if the user ever made the mistake
 * of `git add .env`).
 *
 * Mirrors the .env stanza scaffolded by `vibecarbon create` into
 * carbon/_gitignore (shipped as .gitignore; npm drops the dotted name from
 * tarballs, see src/lib/template-paths.js): `.env`, `.env.local`,
 * `.env.*.local`, `!.env.example`.
 *
 * @param {string} basename
 * @returns {boolean}
 */
function isUniversalLocalEnv(basename) {
  if (basename === '.env' || basename === '.env.local') return true;
  // .env.<anything>.local — production.local, development.local, etc.
  if (/^\.env\..+\.local$/.test(basename)) return true;
  return false;
}

/**
 * @typedef {object} FileFinding
 * @property {string} file - relative path from cwd
 * @property {string} ruleId
 * @property {string} description
 * @property {string} match - truncated for display
 * @property {number} line
 * @property {number} column
 */

/**
 * Walk a directory tree and scan every text-like file under `cwd`.
 *
 * Mirrors what `git push` would actually upload by preferring
 * `git ls-files --cached --others --exclude-standard` when `cwd` is a
 * git working tree. This both (a) skips gitignored files like
 * `.env.local` that may legitimately contain secrets and (b) matches
 * exactly what the deploy step would push to GitHub. Falls back to a
 * plain directory walk (with a built-in skip list) when git isn't
 * available — useful for the standalone `carbon/` template, scanning
 * unrelated directories, or pre-init projects.
 *
 * @param {string} cwd
 * @param {{allowlist?: string[], extraSkipDirs?: Set<string>}} [options]
 * @returns {FileFinding[]}
 */
export function scanTree(cwd, options = {}) {
  const allowlist = options.allowlist ?? loadAllowlist(cwd);
  const skipDirs = new Set([...SKIP_DIRS, ...(options.extraSkipDirs ?? [])]);
  /** @type {FileFinding[]} */
  const findings = [];

  /** @param {string} relPath */
  const scanFile = (relPath) => {
    const full = join(cwd, relPath);
    if (skipsPath(relPath)) return;
    let content;
    try {
      const stat = statSync(full);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
      content = readFileSync(full, 'utf-8');
    } catch {
      return;
    }
    const fileFindings = scanContent(content, { allowlist });
    if (fileFindings.length === 0) return;
    const display = relPath.split(sep).join('/');
    for (const f of fileFindings) {
      findings.push({
        file: display,
        ruleId: f.ruleId,
        description: f.description,
        match: f.match,
        line: f.line,
        column: f.column,
      });
    }
  };

  // Prefer git's view of the tree when available — the most accurate
  // proxy for "what `git push` would actually upload". `--cached`
  // covers tracked files; `--others --exclude-standard` adds untracked
  // files that aren't gitignored. Hidden behind a feature check so
  // tests + non-git directories still work.
  const gitFiles = listGitTrackedFiles(cwd);
  if (gitFiles) {
    for (const rel of gitFiles) scanFile(rel);
    return findings;
  }

  /** @param {string} dir */
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      // Universal local-only env files: the project may have no
      // .gitignore (e.g. created with -no-git), but these files would
      // never reach a remote. Scanning them only produces guaranteed
      // false positives that block legitimate `vibecarbon add`/`deploy`
      // operations. The git-tracked path above (which we prefer when
      // available) still surfaces the genuine "user accidentally
      // committed .env" mistake.
      if (isUniversalLocalEnv(ent.name)) continue;
      const rel = relative(cwd, full);
      scanFile(rel);
    }
  }
  walk(cwd);
  return findings;
}

/**
 * Ask git for the list of files it would push. Returns null if `cwd`
 * isn't a git working tree, git isn't on PATH, or the call fails for
 * any other reason — the caller should fall back to a plain directory
 * walk in that case.
 *
 * @param {string} cwd
 * @returns {string[] | null}
 */
function listGitTrackedFiles(cwd) {
  if (!existsSync(join(cwd, '.git'))) return null;
  try {
    const stdout = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd,
      // SECURITY: without this, an injected GIT_DIR makes the pre-deploy secret
      // scan enumerate the HOST repo and report the project clean. See gitSafeEnv.
      env: gitSafeEnv(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Format an array of findings for terminal output. Returns a multi-line
 * human-readable string ending in a newline.
 *
 * @param {FileFinding[]} findings
 * @returns {string}
 */
export function formatFindings(findings) {
  if (!findings || findings.length === 0) return '';
  const lines = [];
  lines.push(`Detected ${findings.length} potential secret${findings.length === 1 ? '' : 's'}:`);
  for (const f of findings) {
    lines.push(`  ${f.file}:${f.line}:${f.column}  [${f.ruleId}] ${f.description}`);
    lines.push(`    → ${f.match}`);
  }
  lines.push('');
  lines.push('If a finding is a false positive, add it to .vibecarbonignore at the repo root:');
  lines.push('  - one entry per line');
  lines.push('  - literal substring match, OR `regex:<pattern>` for a regex');
  lines.push('  - `#` comments are ignored');
  return `${lines.join('\n')}\n`;
}

/**
 * Shared pre-flight gate: walk the working tree, scan for secrets, exit
 * non-zero with a formatted finding list if anything turns up. `action`
 * names the refused command in the error ("deploy", "add", ...).
 *
 * One definition here — deploy.js and add.js previously carried private
 * copies that only differed in the verb.
 */
export async function refuseIfSecretsPresent(action, cwd = process.cwd()) {
  const findings = scanTree(cwd);
  if (findings.length === 0) return;
  process.stderr.write(`\n${c.error('✗')} Refusing to ${action}: secrets detected.\n\n`);
  process.stderr.write(formatFindings(findings));
  process.exit(1);
}
