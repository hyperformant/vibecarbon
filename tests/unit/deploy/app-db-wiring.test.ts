/**
 * The app reaches Postgres directly, on every deploy path.
 *
 * The template's API server queries the database through its own pg pool
 * (carbon/src/server/db/client.ts) with discrete DB_* vars; nothing else sits
 * on its data path. The server refuses to boot without DB_HOST and
 * DB_PASSWORD, and the generated .env carries DB_HOST=localhost for local dev,
 * so each deploy must override the host and supply the password:
 *
 *   - compose (+ compose-ha): docker-compose.yml's app `environment:`
 *     (wins over env_file .env) and `depends_on: db: service_healthy`.
 *     Deploys ship docker-compose.yml + docker-compose.prod.yml only
 *     (src/lib/deploy/bundle.js), so the base file must carry it.
 *   - k8s (+ k8s-ha): the Deployment names DB_HOST/DB_PORT/DB_NAME from the
 *     vibecarbon-config ConfigMap and DB_PASSWORD from vibecarbon-infra-secrets,
 *     and the app NetworkPolicy admits egress to the db StatefulSet's pod on 5432.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load, loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { INFRA_SECRET_KEYS } from '../../../src/lib/deploy/k8s/k3s.js';

const carbon = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../carbon/${rel}`, import.meta.url)), 'utf8');

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;

/** Compose list-form environment (`- KEY=value`) as a map. */
function envMap(env: string[] | Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  if (!Array.isArray(env)) return env;
  return Object.fromEntries(
    env.map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }),
  );
}

describe('compose: app → db', () => {
  const base: Doc = load(carbon('docker-compose.yml'));
  // Compose's merge tags (`!reset`, `!override`) are not YAML core; drop
  // them so the plain parser reads the values they decorate.
  const prod: Doc = load(carbon('docker-compose.prod.yml').replace(/!(reset|override)\b/g, ''));
  const app = base.services.app;

  it('sets DB_HOST to the db service and the password from POSTGRES_PASSWORD', () => {
    const env = envMap(app.environment);
    expect(env.DB_HOST).toBe('db');
    expect(env.DB_PORT).toBe('5432');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolation, literally
    expect(env.DB_PASSWORD).toBe('${POSTGRES_PASSWORD}');
  });

  it('waits for a healthy db before starting', () => {
    expect(app.depends_on.db).toEqual({ condition: 'service_healthy' });
    // The db service has the healthcheck service_healthy relies on.
    expect(base.services.db.healthcheck?.test).toBeTruthy();
  });

  it('the prod overlay does not repoint the app at another database', () => {
    const env = envMap(prod.services.app.environment);
    for (const key of ['DB_HOST', 'DB_PORT', 'DB_PASSWORD', 'DB_USER', 'DB_NAME']) {
      expect(env[key], key).toBeUndefined();
    }
  });
});

describe('k8s: app → db', () => {
  const docs = (rel: string): Doc[] => {
    const out: Doc[] = [];
    loadAll(carbon(rel), (d) => {
      if (d) out.push(d);
    });
    return out;
  };
  const deployment = docs('k8s/base/app/deployment.yaml').find((d) => d.kind === 'Deployment');
  const container = deployment.spec.template.spec.containers.find((c: Doc) => c.name === 'app');
  const env = Object.fromEntries(container.env.map((e: Doc) => [e.name, e]));

  it('names DB_HOST/DB_PORT/DB_NAME from vibecarbon-config', () => {
    for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME']) {
      expect(env[key]?.valueFrom?.configMapKeyRef, key).toEqual({
        name: 'vibecarbon-config',
        key,
      });
    }
  });

  it('names DB_PASSWORD from vibecarbon-infra-secrets, a key the deploy writes', () => {
    expect(env.DB_PASSWORD?.valueFrom?.secretKeyRef).toEqual({
      name: 'vibecarbon-infra-secrets',
      key: 'DB_PASSWORD',
    });
    expect(INFRA_SECRET_KEYS).toContain('DB_PASSWORD');
  });

  it("DB_HOST is the db StatefulSet's Service in base and the production overlay", () => {
    const config = docs('k8s/base/config/configmap.yaml').find((d) => d.kind === 'ConfigMap');
    expect(config.data.DB_HOST).toBe('db');
    expect(config.data.DB_PORT).toBe('5432');
    expect(carbon('k8s/overlays/production/kustomization.yaml')).toContain('- DB_HOST=db');
    const service = docs('k8s/base/db/service.yaml').find((d) => d.metadata.name === 'db');
    expect(service.spec.ports[0].port).toBe(5432);
  });

  it('the app NetworkPolicy admits egress to the db pod on 5432', () => {
    const policy = docs('k8s/base/app/network-policy.yaml').find(
      (d) => d.kind === 'NetworkPolicy' && d.metadata.name === 'app-policy',
    );
    // The db pod's own labels, as the StatefulSet stamps them.
    const sts = docs('k8s/base/db/statefulset.yaml').find((d) => d.kind === 'StatefulSet');
    const dbLabels = { app: sts.spec.template.metadata.labels.app };
    expect(dbLabels).toEqual({ app: 'vibecarbon-db' });
    const toDb = policy.spec.egress.filter((rule: Doc) =>
      (rule.to ?? []).some(
        (peer: Doc) => JSON.stringify(peer.podSelector?.matchLabels) === JSON.stringify(dbLabels),
      ),
    );
    expect(toDb).toHaveLength(1);
    expect(toDb[0].ports).toEqual([{ protocol: 'TCP', port: 5432 }]);
  });
});
