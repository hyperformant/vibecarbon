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
import { load as loadYaml } from 'js-yaml';
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
});
