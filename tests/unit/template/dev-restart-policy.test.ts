import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
// Service templates carry {{PLACEHOLDER}} tokens that are not valid YAML.
const load = (rel: string) =>
  parseYaml(readFileSync(join(ROOT, rel), 'utf-8').replace(/\{\{[A-Z_]+\}\}/g, 'x')) as Compose;

const PAIRS: Array<[string, string]> = [
  ['carbon/docker-compose.yml', 'carbon/docker-compose.override.yml'],
  ['carbon/docker-compose.n8n.yml', 'carbon/docker-compose.n8n.override.yml'],
  ['carbon/docker-compose.metabase.yml', 'carbon/docker-compose.metabase.override.yml'],
];

// Add-ons ship from services/<svc>/compose/, not carbon/. Discover them so a
// future add-on without the cap fails here.
for (const svc of readdirSync(join(ROOT, 'services'))) {
  const base = `services/${svc}/compose/docker-compose.yml`;
  const override = `services/${svc}/compose/docker-compose.override.yml`;
  if (!existsSync(join(ROOT, base))) continue;
  // A missing override file is a failure too: load() throws ENOENT.
  PAIRS.push([base, override]);
}

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
    // Dev-only services live ONLY in the override (it is never deployed), so
    // they cannot exist in the base: the local S3 stand-in for uploads.
    const devOnly = new Set(base === 'carbon/docker-compose.yml' ? ['s3'] : []);
    for (const name of Object.keys(load(override).services ?? {})) {
      if (devOnly.has(name)) continue;
      expect(baseNames.has(name), `${override} defines ${name}`).toBe(true);
    }
  });

  it('dev-only s3 publishes its port on loopback only (fixed dev credentials)', () => {
    const s3 = (
      load('carbon/docker-compose.override.yml') as {
        services?: Record<string, { ports?: string[] }>;
      }
    ).services?.s3;
    expect(s3?.ports?.length).toBeGreaterThan(0);
    for (const port of s3?.ports ?? []) expect(port.startsWith('127.0.0.1:')).toBe(true);
  });

  it('one-shot services keep restart "no"', () => {
    for (const [base, override] of PAIRS) {
      const services = load(override).services ?? {};
      for (const [name, svc] of Object.entries(load(base).services ?? {})) {
        if (svc.restart === 'no') expect(services[name]?.restart).toBeUndefined();
      }
    }
  });
});
