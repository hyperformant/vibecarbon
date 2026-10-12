import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * Dev stacks must not auto-restart forever. A project folder deleted or
 * moved while its stack existed left `unless-stopped` containers that
 * Docker restarted at every boot, auto-created their bind-mount sources as
 * empty directories, and crash-looped for weeks (2026-10-12 incident).
 * `on-failure:5` caps retries and is not restarted by a daemon restart.
 * The override files are dev-only; prod keeps `unless-stopped`.
 */

const ROOT = join(__dirname, '..', '..', '..');
type Compose = { services?: Record<string, { restart?: string }> };
const load = (rel: string) => parseYaml(readFileSync(join(ROOT, rel), 'utf-8')) as Compose;

const PAIRS: Array<[string, string]> = [
  ['carbon/docker-compose.yml', 'carbon/docker-compose.override.yml'],
  ['carbon/docker-compose.n8n.yml', 'carbon/docker-compose.n8n.override.yml'],
  ['carbon/docker-compose.metabase.yml', 'carbon/docker-compose.metabase.override.yml'],
];

describe('dev restart policy', () => {
  it.each(PAIRS)('every unless-stopped service in %s is on-failure:5 in %s', (base, override) => {
    const baseServices = load(base).services ?? {};
    const overrideServices = load(override).services ?? {};
    const restarting = Object.entries(baseServices)
      .filter(([, svc]) => svc.restart === 'unless-stopped')
      .map(([name]) => name);
    expect(restarting.length).toBeGreaterThan(0);
    for (const name of restarting) {
      expect(overrideServices[name]?.restart, `${override} → ${name}`).toBe('on-failure:5');
    }
  });

  it.each(PAIRS)('%s override defines no service missing from the base', (base, override) => {
    const baseNames = new Set(Object.keys(load(base).services ?? {}));
    for (const name of Object.keys(load(override).services ?? {})) {
      expect(baseNames.has(name), `${override} defines ${name}`).toBe(true);
    }
  });

  it('one-shot services keep restart "no"', () => {
    const services = load('carbon/docker-compose.metabase.override.yml').services ?? {};
    for (const [name, svc] of Object.entries(
      load('carbon/docker-compose.metabase.yml').services ?? {},
    )) {
      if (svc.restart === 'no') expect(services[name]?.restart).toBeUndefined();
    }
  });
});
