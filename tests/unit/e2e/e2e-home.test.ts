/**
 * The real-infra e2e harness keeps its CLI state in one fixed home of its
 * own, ~/.vibecarbon-e2e, never the developer's ~/.vibecarbon
 * (tests/e2e/utils/e2e-home.js).
 *
 * Importing that module sets VIBECARBON_HOME. A few src modules build their
 * path when they load, and a module's imports all load before its first
 * statement runs, so the import has to come first in every e2e entry point.
 * A later import would leave the SSH mux dir, local Pulumi state and the
 * uplink lock in the real home, with nothing failing.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, readRepoFile } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';
import { E2E_HOME_DIRNAME, resolveE2EHome } from '../../e2e/utils/e2e-home.js';

const HOME_MODULE = 'tests/e2e/utils/e2e-home.js';

/** Every e2e entry point that reads or writes the CLI home. */
const ENTRY_POINTS = ['tests/e2e/runner.ts', 'scripts/iter-step.js', 'scripts/sweep-hetzner.js'];

/** Block and line comments out. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** Every import statement in a source text, in order. */
function imports(text: string): string[] {
  return code(text).match(/^import\b[\s\S]*?;/gm) ?? [];
}

const SIDE_EFFECT_HOME_IMPORT = /^import\s+['"][./\w-]*\/e2e-home\.js['"];$/;

const fakeHome = createTempDir('e2e-home-test-');

/** Run a module script in a fresh node whose home dir is `fakeHome`. */
function runWithFakeHome(script: string, preset?: string): string {
  const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome };
  delete env.VIBECARBON_HOME;
  if (preset) env.VIBECARBON_HOME = preset;
  return execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf-8',
    timeout: 60_000,
  }).trim();
}

const url = (rel: string) => JSON.stringify(pathToFileURL(join(REPO_ROOT, rel)).href);

describe('e2e harness CLI home', () => {
  it('is ~/.vibecarbon-e2e, and a preset VIBECARBON_HOME wins', () => {
    expect(E2E_HOME_DIRNAME).toBe('.vibecarbon-e2e');
    expect(resolveE2EHome({}, '/home/dev')).toBe('/home/dev/.vibecarbon-e2e');
    expect(resolveE2EHome({ VIBECARBON_HOME: '' }, '/home/dev')).toBe('/home/dev/.vibecarbon-e2e');
    expect(resolveE2EHome({ VIBECARBON_HOME: '/elsewhere' }, '/home/dev')).toBe('/elsewhere');
  });

  it.each(ENTRY_POINTS)('%s imports it before anything else', (file) => {
    const first = imports(readRepoFile(file))[0];
    expect(first).toMatch(SIDE_EFFECT_HOME_IMPORT);
  });

  it('imports node builtins only, so nothing loads before the home is set', () => {
    const own = imports(readRepoFile(HOME_MODULE));
    expect(own.length).toBeGreaterThan(0);
    for (const statement of own) expect(statement).toMatch(/from 'node:[\w/]+';$/);
  });

  it('recognises a late or missing import (not vacuous)', () => {
    const first = (s: string) => imports(s)[0] ?? '';
    expect(first("import './utils/e2e-home.js';\nimport x from 'y';")).toMatch(
      SIDE_EFFECT_HOME_IMPORT,
    );
    expect(first("// import './utils/e2e-home.js';\nimport x from 'y';")).not.toMatch(
      SIDE_EFFECT_HOME_IMPORT,
    );
    expect(first("import x from 'y';\nimport './utils/e2e-home.js';")).not.toMatch(
      SIDE_EFFECT_HOME_IMPORT,
    );
    expect(first("import {\n  a,\n} from 'y';\nimport './utils/e2e-home.js';")).not.toMatch(
      SIDE_EFFECT_HOME_IMPORT,
    );
  });

  it('puts load-time paths of src modules in the e2e home, created 0700', () => {
    const out = runWithFakeHome(
      `import ${url(HOME_MODULE)};
       import { SSH_MUX_DIR } from ${url('src/lib/host-keys.js')};
       import { UPLINK_LOCK_DIR } from ${url('src/lib/deploy/uplink-lock.js')};
       console.log(JSON.stringify([process.env.VIBECARBON_HOME, SSH_MUX_DIR, UPLINK_LOCK_DIR]));`,
    );
    const e2eHome = join(fakeHome, '.vibecarbon-e2e');
    expect(JSON.parse(out)).toEqual([
      e2eHome,
      join(e2eHome, 'ssh-mux'),
      join(e2eHome, 'locks', 'uplink-push.lock'),
    ]);
    expect(statSync(e2eHome).mode & 0o777).toBe(0o700);
  });

  it('leaves a preset home alone', () => {
    const preset = join(fakeHome, 'preset-home');
    const out = runWithFakeHome(
      `import ${url(HOME_MODULE)};
       import { SSH_MUX_DIR } from ${url('src/lib/host-keys.js')};
       console.log(JSON.stringify([process.env.VIBECARBON_HOME, SSH_MUX_DIR]));`,
      preset,
    );
    expect(JSON.parse(out)).toEqual([preset, join(preset, 'ssh-mux')]);
  });
});
