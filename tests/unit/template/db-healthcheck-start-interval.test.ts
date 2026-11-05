import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface Compose {
  services: { db: { healthcheck: Record<string, unknown> } };
}

describe('carbon/docker-compose.yml db healthcheck', () => {
  const compose = loadYaml(
    readFileSync(join(process.cwd(), 'carbon', 'docker-compose.yml'), 'utf8'),
  ) as Compose;
  const healthcheck = compose.services.db.healthcheck;

  it('checks every second during the start period, so dependents start as soon as the db is ready', () => {
    expect(healthcheck.start_interval).toBe('1s');
  });

  it('keeps the steady-state cadence and the 180s start period', () => {
    expect(healthcheck.start_period).toBe('180s');
    expect(healthcheck.interval).toBe('5s');
  });
});
