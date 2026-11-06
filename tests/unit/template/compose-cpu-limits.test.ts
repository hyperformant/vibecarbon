/**
 * No compose file a server runs asks for more than one CPU.
 *
 * The Docker daemon refuses a container whose NanoCPUs exceed the host's CPU
 * count ("Range of CPUs is from 0.01 to 1.00, as there are only 1 CPUs
 * available"), so a single `cpus: '2.0'` stops `docker compose up` on every
 * 1-vCPU server (DO s-1vcpu-1gb/s-1vcpu-2gb, Vultr and Linode 1-vCPU plans),
 * which is exactly where the lean stack runs. A limit or reservation of at
 * most 1.0 starts on any server.
 *
 * Scope: every compose file deploy ships (the base, the prod overlays and the
 * add-ons' files), so not the dev-only docker-compose*.override.yml.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll, load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

// Compose's merge tags (`!reset`, `!override`) are not YAML core; drop them.
const load = (text: string) => loadYaml(text.replace(/!(reset|override)\b/g, ''));

const FILES = [
  ...readdirSync(join(ROOT, 'carbon'))
    .filter((f) => /^docker-compose.*\.yml$/.test(f))
    .map((f) => `carbon/${f}`),
  ...readdirSync(join(ROOT, 'services')).flatMap((svc) => {
    try {
      return readdirSync(join(ROOT, 'services', svc, 'compose'))
        .filter((f) => f.endsWith('.yml'))
        .map((f) => `services/${svc}/compose/${f}`);
    } catch {
      return [];
    }
  }),
].filter((f) => !f.endsWith('.override.yml'));

type Service = {
  cpus?: number | string;
  deploy?: { resources?: Record<string, { cpus?: number | string } | undefined> };
};

type K8sDoc = {
  kind?: string;
  spec?: {
    template?: {
      spec?: {
        containers?: {
          env?: { name: string; value?: string }[];
          resources?: { limits?: { cpu?: string; memory?: string }; requests?: { cpu?: string } };
        }[];
      };
    };
  };
};

/** Every CPU figure a service sets: `cpus:` and deploy.resources.{limits,reservations}.cpus. */
function cpuFigures(file: string): { where: string; cpus: number }[] {
  // Template placeholders ({{PROJECT_NAME}}) are not YAML-safe in some keys.
  const text = readFileSync(join(ROOT, file), 'utf8').replace(/\{\{(\w+)\}\}/g, '$1');
  const doc = load(text) as { services?: Record<string, Service> } | undefined;
  const out: { where: string; cpus: number }[] = [];
  for (const [name, svc] of Object.entries(doc?.services ?? {})) {
    if (svc?.cpus !== undefined) out.push({ where: `${name}.cpus`, cpus: Number(svc.cpus) });
    for (const [kind, res] of Object.entries(svc?.deploy?.resources ?? {})) {
      if (res?.cpus !== undefined) {
        out.push({ where: `${name}.deploy.resources.${kind}.cpus`, cpus: Number(res.cpus) });
      }
    }
  }
  return out;
}

describe('compose CPU limits fit a 1-vCPU server', () => {
  it('covers the prod overlays and the add-ons', () => {
    expect(FILES).toEqual(
      expect.arrayContaining([
        'carbon/docker-compose.yml',
        'carbon/docker-compose.prod.yml',
        'services/metabase/compose/docker-compose.prod.yml',
      ]),
    );
  });

  for (const file of FILES) {
    it(`${file}: no cpus limit or reservation above 1.0`, () => {
      for (const { where, cpus } of cpuFigures(file)) {
        expect(Number.isFinite(cpus), `${where} is not a number`).toBe(true);
        expect(cpus, `${file} ${where}`).toBeLessThanOrEqual(1);
      }
    });
  }

  it('the prod db sets no CPU or memory figures (postgresql.conf bounds its memory)', () => {
    const doc = load(readFileSync(join(ROOT, 'carbon/docker-compose.prod.yml'), 'utf8')) as {
      services: Record<string, Service>;
    };
    expect(doc.services.db.deploy).toBeUndefined();
  });

  // All traffic passes through Traefik, so a CPU limit there is an outage
  // waiting for one noisy client: 0.5 CPU hung all HTTPS on a real server at
  // about 220 new TLS connections a second.
  it('no compose file sets a CPU figure on Traefik', () => {
    const onTraefik = FILES.flatMap((file) =>
      cpuFigures(file)
        .filter(({ where }) => where.startsWith('traefik.'))
        .map(({ where }) => `${file} ${where}`),
    );
    expect(onTraefik).toEqual([]);
  });

  it('the k8s Traefik has no CPU limit and keeps its request', () => {
    const docs = loadAll(
      readFileSync(join(ROOT, 'carbon/k8s/base/traefik/deployment.yaml'), 'utf8').replace(
        /\{\{(\w+)\}\}/g,
        '$1',
      ),
    ) as K8sDoc[];
    const deployment = docs.find((d) => d?.kind === 'Deployment');
    const containers = deployment?.spec?.template?.spec?.containers ?? [];
    expect(containers.length).toBeGreaterThan(0);
    for (const { resources } of containers) {
      expect(resources?.limits?.cpu).toBeUndefined();
      expect(resources?.requests?.cpu).toBeDefined();
    }
  });
});

// Traefik's memory limit is room for a connection flood, not for traffic: its
// normal peak is about 56 MB. Go only collects harder near that limit if
// GOMEMLIMIT tells it the limit exists, so the two move together or the kernel
// kills Traefik with garbage still on the heap. Measured held connections
// before the kill: 4,600 at 256 MB, 5,800 with GOMEMLIMIT, 8,900 at 512 MB,
// 11,900 with GOMEMLIMIT.
describe('Traefik keeps Go under its memory limit', () => {
  const mebibytes = (value: unknown) => {
    const match = /^(\d+)(M|Mi|MiB)$/.exec(String(value));
    expect(match, `unreadable memory figure: ${value}`).not.toBeNull();
    return Number(match?.[1]);
  };

  const compose = load(readFileSync(join(ROOT, 'carbon/docker-compose.prod.yml'), 'utf8')) as {
    services: Record<
      string,
      {
        environment?: Record<string, string>;
        deploy?: { resources?: { limits?: { memory?: string } } };
      }
    >;
  };
  const k8s = (
    loadAll(
      readFileSync(join(ROOT, 'carbon/k8s/base/traefik/deployment.yaml'), 'utf8').replace(
        /\{\{(\w+)\}\}/g,
        '$1',
      ),
    ) as K8sDoc[]
  ).find((d) => d?.kind === 'Deployment')?.spec?.template?.spec?.containers?.[0];

  const modes = {
    compose: {
      limit: compose.services.traefik?.deploy?.resources?.limits?.memory,
      soft: compose.services.traefik?.environment?.GOMEMLIMIT,
    },
    k8s: {
      limit: k8s?.resources?.limits?.memory,
      soft: k8s?.env?.find(({ name }) => name === 'GOMEMLIMIT')?.value,
    },
  };

  it.each(Object.entries(modes))('%s sets the soft limit about 10%% under the limit', (_, m) => {
    const ratio = mebibytes(m.soft) / mebibytes(m.limit);
    expect(ratio).toBeGreaterThanOrEqual(0.85);
    expect(ratio).toBeLessThan(0.95);
  });

  it('every mode survives the same flood', () => {
    expect(mebibytes(modes.compose.limit)).toBe(mebibytes(modes.k8s.limit));
    expect(mebibytes(modes.compose.soft)).toBe(mebibytes(modes.k8s.soft));
  });
});
