/**
 * Pulumi records each workspace's selected stack under PULUMI_HOME/workspaces.
 * Left at the default that is the developer's real ~/.pulumi, and every test
 * run added files there (one laptop held 8,700). tests/setup/global-setup.ts
 * gives every test file its own PULUMI_HOME; this proves it, on the real
 * Pulumi engine with a file:// backend.
 *
 * Skipped locally where no pulumi CLI is installed. Under CI the integration
 * job installs it, and a missing CLI fails the first test instead of skipping.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { __resetStateProbesForTests, getOrCreateStack } from '../../../src/lib/iac/index.js';
import { __resetStatePassphraseForTests } from '../../../src/lib/state-passphrase.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const PASSPHRASE = 'aG9tZWhvbWVob21laG9tZWhvbWVob21laG9tZWhvbWVo';
// Unique per run, so a file an older run left in the real home cannot decide
// the assertion either way.
const PROJECT = `homeiso${randomBytes(6).toString('hex')}`;
const root = createTempDir('vc-pulumi-home-');

/** The real Pulumi home, read from the real environment. Only ever read. */
function realWorkspaces(): string[] {
  const home = join(homedir(), '.pulumi');
  const dir = join(home, 'workspaces');
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('PULUMI_HOME in tests', () => {
  afterAll(() => {
    cleanupTempDir(root);
  });

  it("PULUMI_HOME is under the file's temp root", () => {
    const home = process.env.PULUMI_HOME ?? '';
    expect(home).not.toBe('');
    // os.tmpdir() is <file root>/tmp; the home is its sibling.
    const fileRoot = join(tmpdir(), '..');
    expect(relative(fileRoot, home).split(sep)).toEqual(['pulumi-home']);
    expect(existsSync(home)).toBe(true);
  });

  it.runIf(hasPulumi || process.env.CI)(
    "a Pulumi workspace lands in the test's own PULUMI_HOME, not ~/.pulumi",
    async () => {
      const backend = join(root, 'state');
      mkdirSync(backend, { recursive: true });
      const projectDir = join(root, 'proj');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, '.vibecarbon.json'), '{}\n');
      process.env.PULUMI_BACKEND_URL = `file://${backend}`;
      process.env.VIBECARBON_STATE_PASSPHRASE = PASSPHRASE;
      __resetStatePassphraseForTests();
      __resetStateProbesForTests();

      await getOrCreateStack('e1', async () => ({}), { projectName: PROJECT, projectDir });

      const own = join(process.env.PULUMI_HOME ?? '', 'workspaces');
      expect(existsSync(own)).toBe(true);
      expect(readdirSync(own).filter((f) => f.includes(PROJECT)).length).toBeGreaterThan(0);
      expect(realWorkspaces().filter((f) => f.includes(PROJECT))).toEqual([]);
    },
    60_000,
  );
});
