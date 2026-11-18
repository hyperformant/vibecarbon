/**
 * Census: every path into the CLI's per-user state directory goes through
 * vibecarbonHome() (src/lib/vibecarbon-home.js), never a home dir joined to
 * '.vibecarbon' by hand.
 *
 * The test tiers give each test file its own VIBECARBON_HOME, and CLI
 * children inherit it. A path built from homedir() or $HOME ignores it, so
 * tests write the developer's real ~/.vibecarbon again: one laptop had 751
 * deploy logs and 614 registry entries from test runs before the override.
 *
 * Walks the CLI's sources, the e2e harness and scripts/. The project-local
 * `<project>/.vibecarbon/` (deploy keys, kubeconfigs, deploy state) is a
 * different directory and is not flagged: it is never built from a home dir.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { vibecarbonHome } from '../../../src/lib/vibecarbon-home.js';
import { REPO_ROOT, readRepoFile } from '../../_shared/source-files.js';

const HELPER = 'src/lib/vibecarbon-home.js';

const files = execFileSync(
  'git',
  ['ls-files', 'src/*.js', 'src/**/*.js', 'scripts/*.js', 'scripts/**/*.js', 'tests/e2e/**/*.ts'],
  { cwd: REPO_ROOT, encoding: 'utf-8' },
)
  .split('\n')
  .filter(Boolean);

/** Block and line comments out, so prose naming ~/.vibecarbon is not flagged. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

// A home dir, then within one expression a '.vibecarbon' path segment (not
// '.vibecarbon.json', the project config file).
const HOME_THEN_DIR =
  /(?:homedir\(\)|env\.HOME\b|env\.USERPROFILE\b)[^;]{0,160}?['"`/]\.vibecarbon(?![.\w-])/;

function offenders(): string[] {
  return files.filter((f) => f !== HELPER).filter((f) => HOME_THEN_DIR.test(code(readRepoFile(f))));
}

describe('vibecarbon home census', () => {
  it('builds no path into ~/.vibecarbon outside vibecarbonHome()', () => {
    expect(offenders()).toEqual([]);
  });

  it('walks the sources that write there (not vacuous)', () => {
    const users = files.filter((f) => readRepoFile(f).includes('vibecarbonHome('));
    // deploy logs, registry, Pulumi state, ssh mux, uplink lock, fingerprint
    // key, telemetry, update check, volume ledger, diagnose, e2e logs.
    expect(users.length).toBeGreaterThanOrEqual(12);
    expect(files.length).toBeGreaterThan(300);
  });

  it('flags the shapes it exists for', () => {
    const flagged = (s: string) => HOME_THEN_DIR.test(code(s));
    expect(flagged("join(homedir(), '.vibecarbon', 'logs')")).toBe(true);
    expect(flagged("join(\n  homedir(),\n  '.vibecarbon',\n)")).toBe(true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source text fed to the regex, the shape deploy.js had
    expect(flagged('`${process.env.HOME}/.vibecarbon/logs/`')).toBe(true);
    expect(flagged("join(homedir(), '.cache', 'puppeteer')")).toBe(false);
    expect(flagged("join(cwd, '.vibecarbon', 'known_hosts')")).toBe(false);
    expect(flagged("join(homedir(), '.vibecarbon.json')")).toBe(false);
    expect(flagged("// state lives in join(homedir(), '.vibecarbon')")).toBe(false);
  });

  it('follows VIBECARBON_HOME, and is ~/.vibecarbon without it', () => {
    const saved = process.env.VIBECARBON_HOME;
    try {
      process.env.VIBECARBON_HOME = '/somewhere/else';
      expect(vibecarbonHome()).toBe('/somewhere/else');
      delete process.env.VIBECARBON_HOME;
      expect(vibecarbonHome()).toBe(join(homedir(), '.vibecarbon'));
    } finally {
      process.env.VIBECARBON_HOME = saved;
    }
  });

  it('is set per test file, so nothing here reaches the real one', () => {
    expect(process.env.VIBECARBON_HOME).toBeTruthy();
    expect(vibecarbonHome()).not.toBe(join(homedir(), '.vibecarbon'));
  });
});
