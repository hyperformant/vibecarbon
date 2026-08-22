/**
 * buildIacEnv source-sweep census (2026-08 provider expansion, PR 3).
 *
 * BaseProvider.buildIacEnv is THE seam every IaC/provider-CLI subprocess
 * env bag must go through: single-credential providers contribute
 * `{ [CLI_TOKEN_ENV]: token }`, Scaleway contributes its SCW_* triple with
 * an actionable missing-var throw at deploy start. Before this seam,
 * four call sites (buildEnv in src/lib/iac/index.js, console.js's hcloud
 * invocation, shell.js's env export, diagnose.js's probe env) each
 * hand-wrote `env[Provider.CLI_TOKEN_ENV] = token` — a shape that writes
 * exactly ONE env var, which is silently wrong for any multi-credential
 * provider (the Pulumi Scaleway provider would run with a secret key but
 * no access key/project id and fail mid-`up` with an opaque auth error).
 *
 * This census bans the direct construction outside base.js so the seam
 * can't erode: a new call site that hand-writes the single-var shape
 * fails here, naming the file. READING `Provider.CLI_TOKEN_ENV` (banner
 * text, docs, error messages) stays legal — only the
 * `[<expr>.CLI_TOKEN_ENV]` computed-key/index construction is the
 * env-building idiom this bans.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');
const EXEMPT_FILE = join(SRC_ROOT, 'lib', 'providers', 'base.js');

// The env-construction idiom: a computed member access used as an object
// key or assignment target — `env[Provider.CLI_TOKEN_ENV] =` or
// `{ [Provider.CLI_TOKEN_ENV]: token }`. Plain reads
// (`Provider.CLI_TOKEN_ENV` in template strings/comparisons) don't match.
const CONSTRUCTION_PATTERN = /\[\s*[\w.]+\.CLI_TOKEN_ENV\s*\]/;

function walkJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkJsFiles(full));
    } else if (st.isFile() && full.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

describe('no direct [X.CLI_TOKEN_ENV] env construction outside base.js', () => {
  it('every src/ file routes provider subprocess env through Provider.buildIacEnv', () => {
    const files = walkJsFiles(SRC_ROOT).filter((f) => f !== EXEMPT_FILE);
    expect(files.length).toBeGreaterThan(50); // sanity: the walk found the tree

    const offenders: Array<{ file: string; match: string }> = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const match = content.match(CONSTRUCTION_PATTERN);
      if (match) {
        offenders.push({ file: file.split(sep).join('/'), match: match[0] });
      }
    }

    expect(
      offenders,
      'Direct `[X.CLI_TOKEN_ENV]` env construction found — merge ' +
        '`Provider.buildIacEnv(token)` instead (see BaseProvider.buildIacEnv).',
    ).toEqual([]);
  });

  it('base.js itself still carries the sanctioned construction (census not vacuous)', () => {
    const base = readFileSync(EXEMPT_FILE, 'utf-8');
    expect(CONSTRUCTION_PATTERN.test(base)).toBe(true);
  });

  // Positive controls: the pattern catches both construction shapes and
  // ignores plain reads.
  it('pattern control: matches computed-key and index-assignment shapes, not reads', () => {
    expect(CONSTRUCTION_PATTERN.test('env[Provider.CLI_TOKEN_ENV] = token;')).toBe(true);
    expect(CONSTRUCTION_PATTERN.test('{ [this.CLI_TOKEN_ENV]: token }')).toBe(true);
    expect(CONSTRUCTION_PATTERN.test('{ [ProviderClass.CLI_TOKEN_ENV]: t }')).toBe(true);
    expect(CONSTRUCTION_PATTERN.test('`${Provider.CLI_TOKEN_ENV}=<set>`')).toBe(false);
    expect(CONSTRUCTION_PATTERN.test('Provider.CLI_TOKEN_ENV === name')).toBe(false);
  });
});
