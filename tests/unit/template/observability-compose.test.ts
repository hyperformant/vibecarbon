/**
 * The observability overlay's log pipeline: Alloy ships, Loki receives.
 *
 * Why. Promtail reached end of life on 2026-03-02 and Alloy replaced it. Loki
 * dropped its shell and wget in 3.5.8, so a wget healthcheck leaves the
 * container unhealthy forever, and `compose up --wait` fails on a healthy Loki.
 * Nothing but a real run would show either, and the add-on's standby list names
 * services by hand.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const MODULE = join(__dirname, '../../../services/observability');
const compose = load(readFileSync(join(MODULE, 'compose/docker-compose.yml'), 'utf-8')) as {
  services: Record<string, { healthcheck?: { test: string[] }; volumes?: string[] }>;
};
const manifest = JSON.parse(readFileSync(join(MODULE, 'manifest.json'), 'utf-8')) as {
  standby: { compose: { services: string[] } };
};

describe('observability compose overlay', () => {
  it('health-checks Loki with its own binary, because the image has no wget', () => {
    expect(compose.services.loki.healthcheck?.test).toEqual(['CMD', '/usr/bin/loki', '-health']);
  });

  it('ships logs with Alloy, through the read-only socket and nothing else on the host', () => {
    expect(compose.services).not.toHaveProperty('promtail');
    expect(compose.services.alloy.volumes).toEqual([
      './volumes/alloy/config.alloy:/etc/alloy/config.alloy:ro',
      '/var/run/docker.sock:/var/run/docker.sock:ro',
    ]);
    expect(existsSync(join(MODULE, 'volumes/alloy/config.alloy'))).toBe(true);
  });

  it('keeps the labels the log dashboards query', () => {
    const config = readFileSync(join(MODULE, 'volumes/alloy/config.alloy'), 'utf-8');
    for (const label of ['container', 'service', 'project', 'container_id', 'environment']) {
      expect(config).toContain(`target_label  = "${label}"`);
    }
    expect(config).toContain('level = null');
  });

  it('every service the standby list names exists in the overlay', () => {
    const missing = manifest.standby.compose.services.filter((s) => !(s in compose.services));
    expect(missing).toEqual([]);
  });
});
