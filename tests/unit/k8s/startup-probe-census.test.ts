/**
 * Census: every long-running container in carbon/k8s/base that has a
 * readinessProbe also has a startupProbe, so a rollout waits for the
 * container to be ready, not for the next slow probe tick.
 *
 * The kubelet runs the readiness probe as soon as the startup probe
 * succeeds (once readiness initialDelaySeconds has passed), and liveness
 * is off until then. So initial delays are 0 and the startup probe is
 * the only thing gating the early period.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll as loadYamlAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const BASE = join(process.cwd(), 'carbon', 'k8s', 'base');

interface Probe {
  exec?: { command?: string[] };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  failureThreshold?: number;
}
interface Container {
  name: string;
  startupProbe?: Probe;
  readinessProbe?: Probe;
  livenessProbe?: Probe;
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string };
  spec?: { template?: { spec?: { containers?: Container[] } } };
}
interface Found {
  where: string;
  container: Container;
}

function yamlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(entry) ? [path] : [];
  });
}

function collect(): Found[] {
  const found: Found[] = [];
  for (const file of yamlFiles(BASE)) {
    // {{TOKEN}} placeholders break a plain YAML parse; swap in a plain string.
    const text = readFileSync(file, 'utf8').replace(/\{\{[A-Z0-9_]+\}\}/g, 'x');
    for (const doc of loadYamlAll(text) as Manifest[]) {
      if (!doc || (doc.kind !== 'Deployment' && doc.kind !== 'StatefulSet')) continue;
      for (const container of doc.spec?.template?.spec?.containers ?? []) {
        if (container.readinessProbe) {
          found.push({
            where: `${doc.kind}/${doc.metadata?.name} container ${container.name}`,
            container,
          });
        }
      }
    }
  }
  return found;
}

const found = collect();

describe('k8s base startup-probe census', () => {
  it('finds the containers it is meant to police', () => {
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  for (const { where, container } of found) {
    const isApp = container.name === 'app';
    const isDb = container.name === 'db';

    describe(where, () => {
      it('has a startupProbe polled at least every 2s', () => {
        expect(container.startupProbe, `${where}: startupProbe missing`).toBeDefined();
        expect(container.startupProbe?.periodSeconds ?? Infinity).toBeLessThanOrEqual(2);
      });

      it('readiness and liveness have no initial delay', () => {
        expect(
          container.readinessProbe?.initialDelaySeconds ?? 0,
          `${where}: readiness initialDelaySeconds`,
        ).toBe(0);
        if (!isApp) {
          expect(
            container.livenessProbe?.initialDelaySeconds ?? 0,
            `${where}: liveness initialDelaySeconds`,
          ).toBe(0);
        }
      });

      if (!isApp) {
        it('startupProbe budget is at least 60s', () => {
          const s = container.startupProbe;
          expect(
            (s?.failureThreshold ?? 0) * (s?.periodSeconds ?? 0),
            `${where}: startup budget`,
          ).toBeGreaterThanOrEqual(60);
        });
      }

      if (container.name === 'carbon-autoscaler') {
        // The startup probe kills the container on failure. Readiness here
        // needs SERVING, which depends on the other container's first Refresh,
        // so a startup probe gated on it would restart a healthy sidecar.
        it('startupProbe is not gated on SERVING', () => {
          const cmd = container.startupProbe?.exec?.command ?? [];
          expect(cmd, `${where}: startup must not run --readiness`).not.toContain('--readiness');
          expect(cmd).toContain('--liveness');
        });
      }

      if (isDb) {
        it('db startup budget is 30 days and there is no liveness probe', () => {
          const s = container.startupProbe;
          expect((s?.failureThreshold ?? 0) * (s?.periodSeconds ?? 0)).toBeGreaterThanOrEqual(
            2592000,
          );
          expect(container.livenessProbe).toBeUndefined();
        });
      }
    });
  }
});
