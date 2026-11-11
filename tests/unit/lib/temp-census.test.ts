/**
 * The temp-dir census (tests/setup/global-setup.ts, tests/_shared/temp-census.ts):
 * every test file runs with os.tmpdir() inside its own temp root, and a file
 * whose tests leave anything there the census does not allow fails.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  closeTempRoot,
  TEMP_CENSUS_EXEMPT,
  TEMP_CENSUS_KEPT_ROOTS,
  tempLeftovers,
} from '../../_shared/temp-census.js';
import { createTempDir } from '../../_shared/temp-dir.js';

/** A temp root as global-setup lays one out, with `names` made in its tmp dir. */
function fixtureRoot(names: Array<[string, 'dir' | 'file']>) {
  const root = createTempDir('vc-census-fixture-');
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  for (const [name, kind] of names) {
    if (kind === 'dir') mkdirSync(join(tmp, name), { recursive: true });
    else writeFileSync(join(tmp, name), '');
  }
  return { root, tmp };
}

describe('the temp-dir census', () => {
  it("points this file's os.tmpdir() inside its own temp root, which children inherit", () => {
    expect(tmpdir()).toMatch(/\/vc-test-[^/]+\/tmp$/);
    expect(process.env.TMPDIR).toBe(tmpdir());
  });

  it('flags what a test left, allows the exempt names, and looks inside a kept root', () => {
    const { tmp } = fixtureRoot([
      ['automation-a1b2', 'dir'],
      ['node-compile-cache', 'dir'],
      ['tsx-1000', 'dir'],
      ['vc-deploy-bundle-x1', 'dir'],
      ['vibecarbon-1000/delta-1', 'dir'],
      ['vibecarbon-1001', 'dir'],
      ['vibecarbon-1002', 'file'],
      ['vc-k8s-ha-dns-Ab12Cd', 'dir'],
      ['stray.pem', 'file'],
    ]);
    expect(tempLeftovers(tmp)).toEqual([
      'stray.pem',
      // A deploy bundle holds the app's .env: never allowed to stay.
      'vc-deploy-bundle-x1',
      'vc-k8s-ha-dns-Ab12Cd',
      'vibecarbon-1000/delta-1',
      'vibecarbon-1002',
    ]);
  });

  it('names the leftovers and removes the root; a clean root closes with nothing to say', () => {
    const leaky = fixtureRoot([['vc-k8s-ha-dns-Ab12Cd', 'dir']]);
    expect(closeTempRoot(leaky.root, leaky.tmp)).toMatch(
      /^this file's tests left vc-k8s-ha-dns-Ab12Cd in the temp dir \(removed now\): make temp dirs with createTempDir/,
    );
    expect(existsSync(leaky.root)).toBe(false);

    const clean = fixtureRoot([['automation-a1b2', 'dir']]);
    expect(closeTempRoot(clean.root, clean.tmp)).toBeNull();
    expect(existsSync(clean.root)).toBe(false);
  });

  it('says why for every name it allows', () => {
    for (const { why } of [...TEMP_CENSUS_EXEMPT, ...TEMP_CENSUS_KEPT_ROOTS]) {
      expect(why.length).toBeGreaterThan(20);
    }
  });
});
