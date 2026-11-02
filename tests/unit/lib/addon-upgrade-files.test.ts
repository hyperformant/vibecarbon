/**
 * `vibecarbon upgrade` refreshes the files of every add-on the project
 * installed, read from the CLI's bundled `services/<name>/` through that
 * add-on's manifest `files` map (the same map `vibecarbon add` copies by).
 * Before, upgrade walked carbon/ only, so an add-on's k8s and compose files
 * stayed as `add` wrote them forever: the observability add-on kept issuing
 * the grafana-tls certificate on every project that added it before the
 * one-certificate-per-name fix.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addonOwnedPaths,
  addonUpgradeEntries,
  installedAddonNames,
} from '../../../src/lib/addon-upgrade-files.js';
import { getFilePolicy } from '../../../src/lib/upgrade-policy.js';

const SERVICES = join(process.cwd(), 'services');

/** A throwaway services/ tree with one add-on. */
function fakeServices(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-addon-upgrade-'));
  const svc = join(dir, 'demo');
  mkdirSync(join(svc, 'compose'), { recursive: true });
  mkdirSync(join(svc, 'k8s', 'nested'), { recursive: true });
  writeFileSync(
    join(svc, 'manifest.json'),
    JSON.stringify({
      name: 'demo',
      files: {
        'compose/docker-compose.prod.yml': 'docker-compose.demo.prod.yml',
        'k8s/': 'k8s/base/demo/',
        'docs/missing.md': 'demo-integration.md',
      },
    }),
  );
  writeFileSync(join(svc, 'compose', 'docker-compose.prod.yml'), 'services: {}\n');
  writeFileSync(join(svc, 'k8s', 'kustomization.yaml'), 'resources: []\n');
  writeFileSync(join(svc, 'k8s', 'nested', 'a.yaml'), 'kind: X\n');
  return dir;
}

describe('installedAddonNames', () => {
  it('lists the services in .vibecarbon.json that ship a manifest, sorted', () => {
    const config = { services: { redis: {}, observability: {}, cicd: { owner: 'o' } } };
    expect(installedAddonNames(config, SERVICES)).toEqual(['observability', 'redis']);
    expect(installedAddonNames({}, SERVICES)).toEqual([]);
  });
});

describe('addonUpgradeEntries', () => {
  it('maps files and walks directories, project path to bundled source', () => {
    const dir = fakeServices();
    const entries = addonUpgradeEntries({ installed: ['demo'], servicesDir: dir });
    expect(entries.map((e) => e.relPath).sort()).toEqual([
      'docker-compose.demo.prod.yml',
      'k8s/base/demo/kustomization.yaml',
      'k8s/base/demo/nested/a.yaml',
    ]);
    const kust = entries.find((e) => e.relPath === 'k8s/base/demo/kustomization.yaml');
    expect(kust?.sourcePath).toBe(join(dir, 'demo', 'k8s', 'kustomization.yaml'));
  });

  it('nothing for an add-on the project did not install', () => {
    expect(addonUpgradeEntries({ installed: [], servicesDir: fakeServices() })).toEqual([]);
  });

  it('the real observability add-on: its k8s and compose files are shipped by upgrade', () => {
    const entries = addonUpgradeEntries({ installed: ['observability'], servicesDir: SERVICES });
    const paths = entries.map((e) => e.relPath);
    for (const p of [
      'k8s/base/observability/ingressroute.yaml',
      'k8s/base/observability/kustomization.yaml',
      'docker-compose.observability.prod.yml',
      'docker-compose.observability.yml',
    ]) {
      expect(paths).toContain(p);
      expect(getFilePolicy(p), p).toBe('safe');
    }
    expect(paths).not.toContain('k8s/base/observability/grafana-tls-certificate.yaml');
  });
});

describe('every add-on file upgrade can reach has a live policy', () => {
  // The add-on's infrastructure (compose, k8s, mounted volumes, init
  // scripts) must be safe or merge, or upgrade still strands it. Only its
  // integration doc is the operator's to keep.
  const names = installedAddonNames(
    { services: { observability: {}, n8n: {}, metabase: {}, redis: {} } },
    SERVICES,
  );

  it('finds all four add-ons', () => {
    expect(names).toEqual(['metabase', 'n8n', 'observability', 'redis']);
  });

  it('nothing but the integration docs is classified never', () => {
    const never = addonUpgradeEntries({ installed: names, servicesDir: SERVICES })
      .map((e) => e.relPath)
      .filter((p) => getFilePolicy(p) === 'never');
    expect(never.sort()).toEqual([
      'metabase-integration.md',
      'n8n-integration.md',
      'observability-integration.md',
      'redis-integration.md',
    ]);
  });
});

describe('addonOwnedPaths', () => {
  it('every path any add-on maps, installed or not', () => {
    const owned = addonOwnedPaths(SERVICES);
    expect(owned.has('docker-compose.n8n.prod.yml')).toBe(true);
    expect(owned.has('k8s/base/observability/ingressroute.yaml')).toBe(true);
    expect(owned.has('docker-compose.prod.yml')).toBe(false);
  });
});
