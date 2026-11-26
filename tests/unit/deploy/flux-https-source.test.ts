/**
 * Which url: lines in a project's Flux cluster file still clone over https.
 * `refuseHttpsFluxSource` and `upgrade`'s warning both read this, so an https
 * line it misses reaches the cluster and fails at Flux's first fetch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FLUX_CLUSTER_FILE,
  fluxHttpsSource,
} from '../../../src/lib/deploy/k8s/unrendered-placeholders.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectWith(urlLine: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-flux-https-'));
  dirs.push(dir);
  if (urlLine !== null) {
    const path = join(dir, FLUX_CLUSTER_FILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `spec:\n  interval: 1m\n${urlLine}\n  ref:\n    branch: main\n`);
  }
  return dir;
}

describe('fluxHttpsSource', () => {
  it.each([
    '  url: https://github.com/acme/shop',
    '  url: https://github.com/acme/shop.git',
    '  url: https://github.com/acme/shop/',
    '  url: "https://github.com/acme/shop"',
    "  url: 'https://github.com/acme/shop.git'",
    '  url: https://github.com/acme/shop # ours',
    '  url: https://github.com/acme/shop.git   # ours, cloned over https',
    '  url: "https://github.com/acme/shop" # ours',
  ])('finds %j, with the ssh form to change it to', (line) => {
    expect(fluxHttpsSource(projectWith(line))).toEqual({
      url: expect.stringMatching(/^https:\/\/github\.com\/acme\/shop/),
      ssh: 'ssh://git@github.com/acme/shop',
    });
  });

  it.each([
    '  url: ssh://git@github.com/acme/shop',
    '  url: ssh://git@github.com/acme/shop # https://github.com/acme/shop',
    '  # url: https://github.com/acme/shop',
  ])('passes %j', (line) => {
    expect(fluxHttpsSource(projectWith(line))).toBeNull();
  });

  it('a project with no cluster file has nothing to change', () => {
    expect(fluxHttpsSource(projectWith(null))).toBeNull();
  });
});
