import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll, load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

interface Probe {
  periodSeconds: number;
  failureThreshold: number;
  initialDelaySeconds?: number;
}

/**
 * Grafana runs its database migrations before /api/health answers. 13.3.0 on a
 * DigitalOcean s-2vcpu-4gb passed a minute of them, so compose called it
 * unhealthy and the add-on failed on a healthy deploy. The allowance has to
 * cover a slow first boot in every mode, and a pass ends it early either way.
 */
const FIRST_BOOT_S = 300;

describe('Grafana first boot', () => {
  it('compose allows the first boot before a failed check counts', () => {
    const compose = loadYaml(read('services/observability/compose/docker-compose.yml')) as {
      services: { grafana: { healthcheck: { start_period: string } } };
    };
    expect(
      Number.parseInt(compose.services.grafana.healthcheck.start_period, 10),
    ).toBeGreaterThanOrEqual(FIRST_BOOT_S);
  });

  it('k8s holds liveness behind a startup probe, so migrations are not killed', () => {
    const docs = loadAll(read('services/observability/k8s/grafana-deployment.yaml')) as {
      kind?: string;
      spec?: {
        template: {
          spec: {
            containers: {
              name: string;
              startupProbe?: Probe;
              livenessProbe?: Probe;
            }[];
          };
        };
      };
    }[];
    const deployment = docs.find((d) => d?.kind === 'Deployment');
    const grafana = deployment?.spec?.template.spec.containers.find((c) => c.name === 'grafana');
    const startup = grafana?.startupProbe;
    expect(startup, 'a startupProbe on the grafana container').toBeDefined();
    expect((startup?.periodSeconds ?? 0) * (startup?.failureThreshold ?? 0)).toBeGreaterThanOrEqual(
      FIRST_BOOT_S,
    );
    expect(grafana?.livenessProbe?.initialDelaySeconds).toBeUndefined();
  });
});
