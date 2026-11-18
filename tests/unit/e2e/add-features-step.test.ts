/**
 * The add-features step writes the run's ACME CA into a compose project's
 * `.env` whether or not the scenario has add-ons. It used to return on an
 * empty feature list before writing it, so a stock compose scenario (the e2e
 * baseline) would have issued from Let's Encrypt production.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import { createTempDir } from '../../_shared/temp-dir.js';
import { runAddFeaturesStep } from '../../e2e/scenarios/add-features-step.js';
import type { CliResult } from '../../e2e/scenarios/types.js';

const STAGING = 'https://acme-ca.invalid/directory';
const acme = { ca: 'staging', directory: STAGING };
const ok: CliResult = { exitCode: 0, stdout: '', stderr: '', durationMs: 0, perfLines: [] };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function project(): string {
  const dir = createTempDir('add-features-');
  dirs.push(dir);
  writeFileSync(join(dir, '.env'), 'DOMAIN=example.test\n');
  return dir;
}
const caOf = (dir: string) => parseDotenv(readFileSync(join(dir, '.env'), 'utf8')).ACME_CA_SERVER;

describe('runAddFeaturesStep', () => {
  it.each(['compose', 'compose-ha'])(
    'a stock %s scenario adds nothing and still writes the CA',
    async (mode) => {
      const dir = project();
      const add = vi.fn(async () => ok);
      await runAddFeaturesStep({ features: [], mode, projectDir: dir, acme, add, log: () => {} });
      expect(add).not.toHaveBeenCalled();
      expect(caOf(dir)).toBe(STAGING);
    },
  );

  it('a compose scenario with add-ons adds them, then writes the CA', async () => {
    const dir = project();
    const add = vi.fn(async () => ok);
    await runAddFeaturesStep({
      features: ['observability', 'redis'],
      mode: 'compose',
      projectDir: dir,
      acme,
      add,
      log: () => {},
    });
    expect(add).toHaveBeenCalledWith(['observability', 'redis']);
    expect(caOf(dir)).toBe(STAGING);
  });

  it.each(['k8s', 'k8s-ha'])(
    'a %s scenario leaves .env alone (k8s reads the CLI env)',
    async (mode) => {
      const dir = project();
      await runAddFeaturesStep({
        features: [],
        mode,
        projectDir: dir,
        acme,
        add: async () => ok,
        log: () => {},
      });
      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('DOMAIN=example.test\n');
    },
  );

  it('a failed add throws with its output and writes no CA', async () => {
    const dir = project();
    const add = async () => ({ ...ok, exitCode: 1, stderr: 'no such add-on' });
    await expect(
      runAddFeaturesStep({
        features: ['nope'],
        mode: 'compose',
        projectDir: dir,
        acme,
        add,
        log: () => {},
      }),
    ).rejects.toThrow(/exited with code 1[\s\S]*no such add-on/);
    expect(caOf(dir)).toBeUndefined();
    expect(existsSync(join(dir, '.env'))).toBe(true);
  });
});
