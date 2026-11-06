import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface Compose {
  services: { db: { healthcheck?: Record<string, unknown> } };
}

// Compose's `!reset` and `!override` tags are not plain YAML; drop them to parse.
const read = (name: string) =>
  loadYaml(
    readFileSync(join(process.cwd(), 'carbon', name), 'utf8').replace(
      / !(?:reset|override)\b/g,
      '',
    ),
  ) as Compose;

// `start_interval` needs Docker Engine 25 or newer. Compose 2.18 rejects the
// key by schema and Compose 2.24-2.29 on Engine 24 refuse to start, so the base
// file (used by local `vibecarbon up`) must not carry it. Every server loads the
// prod file (src/lib/deploy/bundle.js), which sets it.
describe('db healthcheck start_interval', () => {
  const base = read('docker-compose.yml').services.db.healthcheck ?? {};
  const prod = read('docker-compose.prod.yml').services.db.healthcheck ?? {};

  it('is set in the prod file, so servers check every second during the start period', () => {
    expect(prod.start_interval).toBe('1s');
  });

  it('is absent from the base file, so local up works on older Docker', () => {
    expect(base).not.toHaveProperty('start_interval');
  });

  it('the base file keeps the test, the steady-state cadence, retries and the 180s start period', () => {
    expect(base.test).toBeDefined();
    expect(base.start_period).toBe('180s');
    expect(base.interval).toBe('5s');
    expect(base.retries).toBe(10);
  });

  it('the prod file adds only start_interval, so the merge keeps the base values', () => {
    expect(Object.keys(prod)).toEqual(['start_interval']);
  });
});
