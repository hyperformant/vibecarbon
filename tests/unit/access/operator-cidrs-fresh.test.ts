/**
 * Allowlist changes apply to the list on disk now, not to the copy a command
 * loaded when it started: an entry another terminal added meanwhile is kept.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addCidr,
  pruneCidrs,
  removeCidr,
  updateOperatorCidrs,
} from '../../../src/lib/operator-ip.js';

let dir: string;
const entry = (cidr: string, lastUsedAt = new Date().toISOString()) => ({
  cidr,
  addedAt: lastUsedAt,
  lastUsedAt,
});
const onDisk = () =>
  JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')).operatorCidrs.map(
    (e: { cidr: string }) => e.cidr,
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-cidrs-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('updateOperatorCidrs', () => {
  it('adds onto the list as it is on disk, and returns it for the firewall push', () => {
    const loaded = { projectName: 'p', operatorCidrs: [entry('1.1.1.1/32')] };
    // Another terminal added 2.2.2.2 after this command loaded its copy.
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        projectName: 'p',
        operatorCidrs: [entry('1.1.1.1/32'), entry('2.2.2.2/32')],
      }),
    );
    const list = updateOperatorCidrs(loaded, (fresh) => addCidr(fresh, '3.3.3.3/32'), dir);
    expect(onDisk()).toEqual(['1.1.1.1/32', '2.2.2.2/32', '3.3.3.3/32']);
    expect(list.map((e) => e.cidr)).toEqual(onDisk());
    expect(loaded.operatorCidrs.map((e) => e.cidr)).toEqual(onDisk());
  });

  it('removes and prunes only the entries named, keeping a fresh one', () => {
    const old = '2020-01-01T00:00:00.000Z';
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        operatorCidrs: [entry('1.1.1.1/32'), entry('9.9.9.9/32', old), entry('2.2.2.2/32')],
      }),
    );
    updateOperatorCidrs({}, (fresh) => removeCidr(fresh, '1.1.1.1/32'), dir);
    expect(onDisk()).toEqual(['9.9.9.9/32', '2.2.2.2/32']);
    updateOperatorCidrs({}, (fresh) => pruneCidrs(fresh, new Date(), 90), dir);
    expect(onDisk()).toEqual(['2.2.2.2/32']);
  });

  it('refuses a change that would empty the list, and writes nothing', () => {
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ operatorCidrs: [entry('1.1.1.1/32')] }),
    );
    expect(() => updateOperatorCidrs({}, (fresh) => removeCidr(fresh, '1.1.1.1/32'), dir)).toThrow(
      /lock everyone out/,
    );
    expect(onDisk()).toEqual(['1.1.1.1/32']);
  });
});
