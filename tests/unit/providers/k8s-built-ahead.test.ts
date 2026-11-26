/**
 * K8S_BUILT_AHEAD names providers whose k8s code lands before their k8s tier
 * is sold, part by part (boot scripts, program, CSI, destroy), so each census
 * walks a provider's code the day the part it checks lands. This guard keeps
 * the table from rotting: an entry must be a registered provider that does
 * not sell k8s yet and name only known parts, and every census must say
 * which part it checks.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import {
  K8S_BUILT_AHEAD,
  K8S_PARTS,
  type K8sPart,
  k8sCensusProviders,
} from '../../_shared/k8s-built-ahead.js';
import { REPO_ROOT, readRepoFile, sourceFiles } from '../../_shared/source-files.js';
import { findCalls } from '../helpers/js-call-scan.js';

const sellers = Object.entries(PROVIDERS)
  .filter(([, P]) => P.SUPPORTED_TIERS.includes('k8s'))
  .map(([id]) => id);
const ahead = (part: K8sPart) =>
  Object.keys(PROVIDERS).filter((id) => (K8S_BUILT_AHEAD[id] ?? []).includes(part));
const ids = (part: K8sPart) => k8sCensusProviders(part).map(([id]) => id);

describe('K8S_BUILT_AHEAD', () => {
  it('every entry is a registered provider that does not sell k8s yet', () => {
    for (const id of Object.keys(K8S_BUILT_AHEAD)) {
      expect(Object.keys(PROVIDERS), id).toContain(id);
      expect(PROVIDERS[id as keyof typeof PROVIDERS].SUPPORTED_TIERS, id).not.toContain('k8s');
    }
  });

  it('every part named is a K8sPart, once', () => {
    for (const [id, parts] of Object.entries(K8S_BUILT_AHEAD)) {
      expect(parts.length, id).toBeGreaterThan(0);
      expect(new Set(parts).size, id).toBe(parts.length);
      for (const part of parts) expect(K8S_PARTS, `${id}: ${part}`).toContain(part);
    }
  });

  it.each(K8S_PARTS)(
    "k8sCensusProviders('%s') is the k8s sellers, then the providers built ahead for it",
    (part) => {
      expect(ids(part)).toEqual([...sellers, ...ahead(part)]);
      for (const [id, P] of k8sCensusProviders(part)) {
        expect(P).toBe(PROVIDERS[id as keyof typeof PROVIDERS]);
      }
    },
  );

  it("k8sCensusProviders('boot') is the k8s sellers then scaleway; 'program' has no scaleway", () => {
    // Scaleway's boot scripts have landed; its program, CSI and destroy code
    // land after them, each adding its part.
    expect(sellers).toEqual(['hetzner', 'digitalocean', 'linode', 'vultr']);
    expect(ids('boot')).toEqual([...sellers, 'scaleway']);
    expect(ids('program')).not.toContain('scaleway');
    expect(ids('program')).toEqual(sellers);
  });

  it("k8sCensusProviders() and k8sCensusProviders('nope') throw", () => {
    // vitest does not type-check: a census left without a part must fail
    // loudly, never quietly walk the sellers alone.
    const call = k8sCensusProviders as (part?: unknown) => unknown;
    expect(() => call()).toThrow(/boot, program, csi, destroy/);
    expect(() => call('nope')).toThrow(/"nope"/);
  });

  it('no consumer calls k8sCensusProviders without a part', () => {
    const consumers = sourceFiles(
      ['tests', 'src', 'scripts'].map((dir) => join(REPO_ROOT, dir)),
      {
        exts: ['.ts', '.js', '.mjs'],
        skip: ['node_modules', 'fixtures'],
        skipDotDirs: true,
        relativeTo: REPO_ROOT,
      },
    )
      // This guard calls it with a variable part, and with none on purpose.
      .filter((file) => file !== 'tests/unit/providers/k8s-built-ahead.test.ts')
      .filter((file) => readRepoFile(file).includes('k8sCensusProviders'));
    const calls = consumers.flatMap((file) =>
      findCalls(readRepoFile(file), ['k8sCensusProviders']).map((call) => ({ file, call })),
    );
    // The twelve call sites of the staging table, at least.
    expect(calls.length).toBeGreaterThanOrEqual(12);
    const bare = calls
      .filter(({ call }) => call.args.length !== 1 || !/^'[a-z]+'$/.test(call.args[0]))
      .map(({ file, call }) => `${file}:${call.line} ${call.text}`);
    expect(bare).toEqual([]);
    for (const { file, call } of calls) {
      expect(K8S_PARTS, `${file}:${call.line}`).toContain(call.args[0].slice(1, -1));
    }
  });
});
