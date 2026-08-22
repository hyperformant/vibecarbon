/**
 * A5 retirement guard: `~/.vibecarbon/credentials.json` and the v2 profiles
 * system are gone — src/lib/config.js no longer hosts them (A3 swept every
 * RESOLUTION call site to env-only; A5 deleted the storage/profile-selection
 * functions themselves: loadCredentials, saveCredentials,
 * loadCredentialsFile, listCredentialProfiles, getActiveProfileName,
 * setActiveProfile, applyProfileFlag, isValidProfileName,
 * CREDENTIALS_VERSION). There is no longer an "allowed" file — the pattern
 * must match NOWHERE in src/, scripts/, or .github/workflows/.
 *
 * This is a static-source recall test, not a runtime one: it reads each
 * file as one string (not line-by-line), so a pattern split across a
 * line-wrap or reformatted whitespace still matches — same rationale as
 * no-hardcoded-provider-dispatch.test.ts's HARDCODE_PATTERN.
 *
 * .github/workflows/*.yml is walked too (plain text, same tokens): a
 * workflow can reintroduce the retired file/env-var by hand-writing a
 * heredoc, same as any .js source file — the e2e-us-perf.yml materialize
 * step did exactly that until 2026-07-25.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');
const SCRIPTS_ROOT = join(process.cwd(), 'scripts');
const WORKFLOWS_ROOT = join(process.cwd(), '.github', 'workflows');

const RETIRED_PATTERN =
  /credentials\.json|VIBECARBON_PROFILE|loadCredentials|saveCredentials|applyProfileFlag|credentialsProfile|CREDENTIALS_KEY|listCredentialProfiles|getActiveProfileName|setActiveProfile|isValidProfileName/;

function walkFiles(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkFiles(full, extensions));
    } else if (st.isFile() && extensions.some((ext) => full.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function walkJsFiles(dir: string): string[] {
  return walkFiles(dir, ['.js']);
}

describe('no src/, scripts/, or .github/workflows/ file references the retired credentials.json/profiles system', () => {
  it('zero matches anywhere in src/, scripts/, or .github/workflows/ (no exemptions)', () => {
    const srcFiles = walkJsFiles(SRC_ROOT);
    expect(srcFiles.length).toBeGreaterThan(50); // sanity: the walk actually found the tree

    const scriptsFiles = walkJsFiles(SCRIPTS_ROOT);
    const workflowFiles = walkFiles(WORKFLOWS_ROOT, ['.yml', '.yaml']);
    expect(workflowFiles.length).toBeGreaterThan(0); // sanity: the walk actually found workflows
    const allFiles = [...srcFiles, ...scriptsFiles, ...workflowFiles];

    const offenders: Array<{ file: string; match: string }> = [];
    for (const file of allFiles) {
      const content = readFileSync(file, 'utf-8');
      const match = content.match(RETIRED_PATTERN);
      if (match) {
        offenders.push({ file: file.replace(`${process.cwd()}${sep}`, ''), match: match[0] });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('pattern control: matches every retired identifier/string', () => {
    expect(RETIRED_PATTERN.test('~/.vibecarbon/credentials.json')).toBe(true);
    expect(RETIRED_PATTERN.test('process.env.VIBECARBON_PROFILE')).toBe(true);
    expect(RETIRED_PATTERN.test('const x = loadCredentials();')).toBe(true);
    expect(RETIRED_PATTERN.test('saveCredentials({ hetzner: {} });')).toBe(true);
    expect(RETIRED_PATTERN.test('applyProfileFlag(values.profile)')).toBe(true);
    expect(RETIRED_PATTERN.test('config.credentialsProfile = name;')).toBe(true);
    expect(RETIRED_PATTERN.test("static CREDENTIALS_KEY = 'hetzner';")).toBe(true);
    expect(RETIRED_PATTERN.test('listCredentialProfiles()')).toBe(true);
    expect(RETIRED_PATTERN.test('getActiveProfileName()')).toBe(true);
    expect(RETIRED_PATTERN.test('setActiveProfile(name)')).toBe(true);
    expect(RETIRED_PATTERN.test("isValidProfileName('x')")).toBe(true);
    // control: unrelated code doesn't false-positive
    expect(RETIRED_PATTERN.test('resolveProviderToken(providerId)')).toBe(false);
    expect(RETIRED_PATTERN.test('bootstrapOperatorEnv(cwd)')).toBe(false);
  });
});
