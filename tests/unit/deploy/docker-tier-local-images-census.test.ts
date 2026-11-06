import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Testing this project must not need an image we have to publish first. A
 * Docker test that names a production ref fails with `manifest unknown` on every
 * image change until that image is published, so the tier resolves mirrors to
 * upstream and builds our own images from docker/.
 *
 * k3s-recorded-flags is the one exception: it checks the published mirror
 * itself, so it runs only when the version channel names a version to check.
 */
const DIR = 'tests/integration/docker';
const MIRROR_CHECK = 'k3s-recorded-flags.test.ts';
const PUBLISHED = /ghcr\.io\/hyperformant|\b(traefik|dockerSocketProxy|alpine|db)(Image)?Ref\(\)/;

describe('the Docker tier needs nothing published', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.test.ts'));

  it('walks the tier', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(MIRROR_CHECK);
  });

  it.each(files.filter((f) => f !== MIRROR_CHECK))('%s names no published image', (file) => {
    expect(readFileSync(join(DIR, file), 'utf-8')).not.toMatch(PUBLISHED);
  });

  it('the mirror check stays out of a local run', () => {
    expect(readFileSync(join(DIR, MIRROR_CHECK), 'utf-8')).toMatch(
      /DOCKER_INTEGRATION === 'true' && process\.env\.VC_K3S_VERSION\s*\? describe\s*: describe\.skip/,
    );
  });

  it('the tier builds our db image before any test runs', () => {
    expect(readFileSync('vitest.config.ts', 'utf-8')).toContain('tests/setup/docker-tier-setup.ts');
  });
});
