/**
 * Census: every provider that tags resources either sweeps its empty run tags
 * or says why it has none to sweep. A provider tags resources when its module
 * exports encodeLabel (src/lib/providers/<name>.js). Its e2e sweep
 * (tests/e2e/utils/sweep-<name>.ts) must call sweepRunTags, or be listed in
 * NO_TAG_OBJECTS with the reason. A new provider that tags is drafted into
 * this check by the walk, not by someone remembering it (2026-11-13: DO and
 * Linode left one tag per run behind for months).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PROVIDERS = join(ROOT, 'src', 'lib', 'providers');
const SWEEPS = join(ROOT, 'tests', 'e2e', 'utils');

/** Providers whose API keeps no tag objects: a tag is a string on a resource. */
const NO_TAG_OBJECTS: Record<string, string> = {
  vultr: 'tags are strings on each instance; GET /v2/tags is 404 (checked 2026-11-13)',
  scaleway: 'tags are strings on each resource; the instance API has no tags endpoint (404)',
};

const taggingProviders = readdirSync(PROVIDERS)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => /export function encodeLabel\b/.test(readFileSync(join(PROVIDERS, f), 'utf8')))
  .map((f) => f.replace(/\.js$/, ''))
  .sort();

describe('empty run tag sweep census', () => {
  it('finds the tagging providers (guards against an empty walk)', () => {
    expect(taggingProviders).toEqual(
      expect.arrayContaining(['digitalocean', 'linode', 'scaleway', 'vultr']),
    );
  });

  it.each(taggingProviders)('%s sweeps its empty run tags or says why it has none', (name) => {
    const source = readFileSync(join(SWEEPS, `sweep-${name}.ts`), 'utf8');
    const sweeps = /\bsweepRunTags\(/.test(source);
    if (name in NO_TAG_OBJECTS) {
      // An exemption is a claim about the provider's API; if the sweep now
      // deletes tags, the claim is stale and should go.
      expect(sweeps, `${name} is exempt (${NO_TAG_OBJECTS[name]}) but calls sweepRunTags`).toBe(
        false,
      );
    } else {
      expect(sweeps, `tests/e2e/utils/sweep-${name}.ts never calls sweepRunTags`).toBe(true);
    }
  });

  it('every exemption names a provider that still tags', () => {
    for (const name of Object.keys(NO_TAG_OBJECTS)) expect(taggingProviders).toContain(name);
  });
});
