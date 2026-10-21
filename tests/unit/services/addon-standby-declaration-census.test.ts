import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll, load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  composePromotionServices,
  composeStandbyScaledServices,
  composeWriterServices,
  enabledAddonNames,
  enabledK8sAddonNames,
  k8sFailoverAddonWorkloads,
  k8sPrimaryOnlyWorkloads,
  k8sStandbyZeroedWorkloads,
  loadAddonStandby,
} from '../../../src/lib/services/standby-policy.js';

/**
 * Add-on standby-declaration census. Every add-on under services/ declares
 * how it behaves on an HA standby (`standby` in its manifest), and the
 * declaration must match what the add-on actually ships, so consumers read
 * the declaration instead of hand lists.
 */

const ROOT = process.cwd();
const SERVICES = join(ROOT, 'services');
const SHARED_COMPOSE = new Set(['db', 'app', 'traefik']);
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

const addons = readdirSync(SERVICES, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const sorted = (xs: string[]) => [...xs].sort();

// Template placeholders ({{PROJECT_NAME}}) are not valid unquoted YAML.
const readYamlText = (path: string) => readFileSync(path, 'utf8').replace(/\{\{[^}]*\}\}/g, 'x');

function shippedComposeServices(name: string): string[] {
  const doc = loadYaml(readYamlText(join(SERVICES, name, 'compose', 'docker-compose.yml'))) as {
    services: Record<string, unknown>;
  };
  return Object.keys(doc.services).filter((s) => !SHARED_COMPOSE.has(s));
}

function shippedK8sWorkloads(name: string) {
  const dir = join(SERVICES, name, 'k8s');
  const kust = loadYaml(readYamlText(join(dir, 'kustomization.yaml'))) as { namespace?: string };
  const namespace = kust.namespace ?? 'vibecarbon';
  const out: { kind: string; name: string; namespace: string }[] = [];
  for (const f of readdirSync(dir).filter(
    (x) => x.endsWith('.yaml') && x !== 'kustomization.yaml',
  )) {
    for (const d of loadAll(readYamlText(join(dir, f))) as {
      kind?: string;
      metadata: { name: string };
    }[]) {
      if (d && WORKLOAD_KINDS.has(d.kind as string))
        out.push({ kind: d.kind as string, name: d.metadata.name, namespace });
    }
  }
  return out;
}

const key = (w: { kind: string; name: string; namespace: string }) =>
  `${w.namespace}/${w.kind}/${w.name}`;

describe('add-on standby declaration', () => {
  it('finds the add-ons', () => {
    expect(addons).toEqual(['metabase', 'n8n', 'observability', 'redis']);
  });

  for (const name of addons) {
    describe(name, () => {
      it('declares a valid policy', () => {
        expect(['primary-only', 'with-app-tier']).toContain(loadAddonStandby(name).policy);
      });

      it('composeServices + composeSetup equal the compose services it ships', () => {
        const s = loadAddonStandby(name);
        const declared = [...s.composeServices, ...s.composeSetup];
        expect(new Set(declared).size).toBe(declared.length);
        expect(sorted(declared)).toEqual(sorted(shippedComposeServices(name)));
      });

      it('k8s equals the workloads it ships', () => {
        expect(sorted(loadAddonStandby(name).k8s.map(key))).toEqual(
          sorted(shippedK8sWorkloads(name).map(key)),
        );
      });
    });
  }
});

describe('loadAddonStandby', () => {
  it('throws on a missing add-on or missing standby', () => {
    expect(() => loadAddonStandby('nope')).toThrow(/nope/);
  });
});

describe('standby-policy helpers', () => {
  it('composeStandbyScaledServices lists primary-only services and setups in order', () => {
    expect(composeStandbyScaledServices(['n8n', 'redis', 'metabase'])).toEqual([
      'n8n',
      'n8n-setup',
      'metabase',
      'metabase-setup',
    ]);
  });

  it('composePromotionServices omits the one-shot setup services', () => {
    expect(composePromotionServices(['n8n', 'redis', 'metabase'])).toEqual(['n8n', 'metabase']);
  });

  it('composeWriterServices is app plus the promotion services', () => {
    expect(composeWriterServices(['n8n', 'redis', 'metabase'])).toEqual(['app', 'n8n', 'metabase']);
    expect(composeWriterServices([])).toEqual(['app']);
  });

  it('k8sFailoverAddonWorkloads keeps only vibecarbon-namespace entries', () => {
    expect(k8sFailoverAddonWorkloads(['observability', 'redis'])).toEqual([
      { kind: 'Deployment', name: 'redis', namespace: 'vibecarbon' },
    ]);
  });

  it('k8sPrimaryOnlyWorkloads lists only primary-only add-on workloads', () => {
    expect(k8sPrimaryOnlyWorkloads(['observability', 'redis', 'n8n', 'metabase'])).toEqual([
      { kind: 'Deployment', name: 'n8n', namespace: 'vibecarbon' },
      { kind: 'Deployment', name: 'metabase', namespace: 'vibecarbon' },
    ]);
  });

  it('k8sStandbyZeroedWorkloads covers both policies', () => {
    const names = k8sStandbyZeroedWorkloads(['observability', 'redis', 'n8n']).map((w) => w.name);
    expect(names).toEqual(['grafana', 'prometheus', 'loki', 'redis', 'n8n']);
  });

  it('enabledAddonNames follows services/index.json order and both config shapes', () => {
    expect(enabledAddonNames({ n8n: true, services: { redis: true, metabase: false } })).toEqual([
      'n8n',
      'redis',
    ]);
    expect(enabledAddonNames({})).toEqual([]);
  });

  it('enabledK8sAddonNames reads k8s/base/<name>/kustomization.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-standby-'));
    mkdirSync(join(dir, 'k8s', 'base', 'redis'), { recursive: true });
    writeFileSync(join(dir, 'k8s', 'base', 'redis', 'kustomization.yaml'), 'kind: Kustomization\n');
    mkdirSync(join(dir, 'k8s', 'base', 'n8n'), { recursive: true });
    expect(enabledK8sAddonNames(dir)).toEqual(['redis']);
  });
});

/**
 * Source census: no hand-written add-on name lists in the deploy, failover
 * and scale code. Entries name the file, a line fragment and the reason.
 */
const SOURCE_ALLOWLIST: { file: string; contains: string; reason: string }[] = [
  {
    file: 'src/lib/deploy/bundle.js',
    contains: 'subs.push(',
    reason: 'HTTP-01 cert SAN subdomains per enabled feature, not a standby list',
  },
  {
    file: 'src/lib/deploy/k8s/k3s.js',
    contains: "Redis add-on's REDIS_URL",
    reason: 'comment naming the redis ClusterIP Service, not a standby list',
  },
];

function sourceFiles(): string[] {
  const out: string[] = ['src/failover.js', 'src/scale.js'];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk('src/lib/deploy');
  return out.filter((f) => existsSync(join(ROOT, f)));
}

const LITERAL = /['"`](n8n|metabase|redis)(-setup)?['"`]/;

describe('no hand-written add-on lists in deploy/failover/scale', () => {
  const hits: { file: string; line: string }[] = [];
  for (const file of sourceFiles()) {
    for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
      if (LITERAL.test(line)) hits.push({ file, line });
    }
  }
  const allowed = (h: { file: string; line: string }) =>
    SOURCE_ALLOWLIST.some((a) => a.file === h.file && h.line.includes(a.contains));

  it('every literal is allowlisted with a reason', () => {
    expect(hits.filter((h) => !allowed(h))).toEqual([]);
  });

  it('every allowlist entry still matches a line', () => {
    const stale = SOURCE_ALLOWLIST.filter(
      (a) => !hits.some((h) => h.file === a.file && h.line.includes(a.contains)),
    );
    expect(stale).toEqual([]);
  });
});
