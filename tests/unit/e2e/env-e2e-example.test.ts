/**
 * A6 drift guards for the operator e2e token file:
 *   1. root .gitignore covers tests/.env.e2e (so the real file, once
 *      populated with live tokens, can never be committed).
 *   2. tests/.env.e2e.example — the committed template — has every value
 *      empty. A real token accidentally left in the example would ship to
 *      every clone of this repo.
 *
 * No test needed for the secret-scan side of this: the pre-commit scan
 * (src/lib/secret-scan.js) walks `git ls-files`, so a gitignored
 * tests/.env.e2e is invisible to it by construction — there is nothing to
 * pin at the scan layer, only at the .gitignore/.example layer above.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../../../src/lib/project.js';

describe('root .gitignore covers tests/.env.e2e', () => {
  it('contains the tests/.env.e2e pattern', () => {
    const gitignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf-8');
    const lines = gitignore
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(lines).toContain('tests/.env.e2e');
  });
});

describe('tests/.env.e2e.example is value-free', () => {
  const examplePath = join(process.cwd(), 'tests', '.env.e2e.example');
  const parsed = parseDotenv(readFileSync(examplePath, 'utf-8'));

  it('defines at least one key (sanity: the parse actually found something)', () => {
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
  });

  it('every value is empty', () => {
    for (const [key, value] of Object.entries(parsed)) {
      expect(value, `${key} must be empty in the committed .example`).toBe('');
    }
  });

  it('covers the full operator token key list', () => {
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'HETZNER_API_TOKEN',
        'HETZNER_ACCESS_KEY',
        'HETZNER_SECRET_KEY',
        'CLOUDFLARE_API_TOKEN',
        'DIGITALOCEAN_API_TOKEN',
        'DIGITALOCEAN_ACCESS_KEY',
        'DIGITALOCEAN_SECRET_KEY',
        'DIGITALOCEAN_PROJECT_ID',
        'LINODE_API_TOKEN',
        'LINODE_ACCESS_KEY',
        'LINODE_SECRET_KEY',
        // Cluster overrides: Linode's is optional (accounts on a non-default
        // cluster pin it); Vultr's is effectively REQUIRED (keys are minted
        // per subscription and only work against its cluster).
        'LINODE_STORAGE_REGION',
        'VULTR_API_TOKEN',
        'VULTR_ACCESS_KEY',
        'VULTR_SECRET_KEY',
        'VULTR_STORAGE_REGION',
        // Scaleway is a credential TRIPLE (secret key + access key +
        // dedicated-Project id) with NO separate object-storage keys — the
        // same IAM pair signs S3 (expansion PR 4).
        'SCALEWAY_SECRET_KEY',
        'SCALEWAY_ACCESS_KEY',
        'SCALEWAY_DEFAULT_PROJECT_ID',
        'DOCKER_HUB_USERNAME',
        'DOCKER_HUB_TOKEN',
        // Not a provider credential: the real signed Fullerene key the test
        // harnesses activate, now that no dev bypass exists.
        'VIBECARBON_TEST_LICENSE_KEY',
      ].sort(),
    );
  });
});
