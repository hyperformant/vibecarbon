/**
 * `vibecarbon upgrade` refreshes the files of every add-on the project
 * installed, read from the CLI's bundled `services/<name>/` through that
 * add-on's manifest `files` map (the same map `vibecarbon add` copies by).
 * Before, upgrade walked carbon/ only, so an add-on's k8s and compose files
 * stayed as `add` wrote them forever: the observability add-on kept issuing
 * the grafana-tls certificate on every project that added it before the
 * one-certificate-per-name fix.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addonOwnedPaths,
  addonUpgradeEntries,
  installedAddonNames,
  isContainedRelPath,
} from '../../../src/lib/addon-upgrade-files.js';
import { getAddonFilePolicy, getFilePolicy } from '../../../src/lib/upgrade-policy.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const SERVICES = join(process.cwd(), 'services');
const ROOT = '/srv/project';

/** A throwaway services/ tree with one add-on. */
function fakeServices(): string {
  const dir = createTempDir('vc-addon-upgrade-');
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
    const entries = addonUpgradeEntries({
      installed: ['demo'],
      servicesDir: dir,
      projectRoot: ROOT,
    });
    expect(entries.map((e) => e.relPath).sort()).toEqual([
      'docker-compose.demo.prod.yml',
      'k8s/base/demo/kustomization.yaml',
      'k8s/base/demo/nested/a.yaml',
    ]);
    const kust = entries.find((e) => e.relPath === 'k8s/base/demo/kustomization.yaml');
    expect(kust?.sourcePath).toBe(join(dir, 'demo', 'k8s', 'kustomization.yaml'));
  });

  it('nothing for an add-on the project did not install', () => {
    expect(
      addonUpgradeEntries({ installed: [], servicesDir: fakeServices(), projectRoot: ROOT }),
    ).toEqual([]);
  });

  it('the real observability add-on: its k8s and compose files are shipped by upgrade', () => {
    const entries = addonUpgradeEntries({
      installed: ['observability'],
      servicesDir: SERVICES,
      projectRoot: ROOT,
    });
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
    const never = addonUpgradeEntries({
      installed: names,
      servicesDir: SERVICES,
      projectRoot: ROOT,
    })
      .filter((e) => getAddonFilePolicy(e.relPath, e.src) === 'never')
      .map((e) => e.relPath);
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

/**
 * Hardening: service names come from the project's .vibecarbon.json, which a
 * cloned project controls, and manifest paths are joined into file paths.
 * Nothing may read outside the add-on's own bundled directory or write
 * outside the project.
 */
describe('containment', () => {
  /** A services/ tree whose one add-on maps `files`. */
  function servicesWith(files: Record<string, string>): string {
    const dir = createTempDir('vc-addon-contain-');
    mkdirSync(join(dir, 'demo', 'k8s'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'manifest.json'), JSON.stringify({ name: 'demo', files }));
    writeFileSync(join(dir, 'demo', 'k8s', 'a.yaml'), 'kind: X\n');
    writeFileSync(join(dir, 'secret.txt'), 'outside the add-on\n');
    return dir;
  }

  it('accepts a service name only from the listing of the packaged services/ dir', () => {
    const dir = servicesWith({ 'k8s/': 'k8s/base/demo/' });
    const config = { services: { demo: {}, '../x': {}, 'demo/../demo': {}, '.': {}, '': {} } };
    expect(installedAddonNames(config, dir)).toEqual(['demo']);
  });

  it('a name not in the listing yields no entries even if passed straight in', () => {
    const dir = servicesWith({ 'k8s/': 'k8s/base/demo/' });
    const rejected: string[] = [];
    const entries = addonUpgradeEntries({
      installed: ['../x', 'demo/..'],
      servicesDir: join(dir, 'demo'),
      projectRoot: ROOT,
      onReject: (why: string) => rejected.push(why),
    });
    expect(entries).toEqual([]);
    expect(rejected.length).toBe(2);
  });

  it('rejects a manifest src that resolves outside the add-on directory', () => {
    const dir = servicesWith({ '../secret.txt': 'stolen.txt', 'k8s/': 'k8s/base/demo/' });
    const rejected: string[] = [];
    const entries = addonUpgradeEntries({
      installed: ['demo'],
      servicesDir: dir,
      projectRoot: ROOT,
      onReject: (why: string) => rejected.push(why),
    });
    expect(entries.map((e) => e.relPath)).toEqual(['k8s/base/demo/a.yaml']);
    expect(rejected.join('\n')).toContain('../secret.txt');
  });

  it.each([
    ['a .. segment', '../outside.yaml'],
    ['a .. segment mid-path', 'k8s/../../outside.yaml'],
    ['an absolute path', '/etc/cron.d/x'],
    ['a Windows absolute path', 'C:\\x.yaml'],
    ['the project root itself', '.'],
  ])('rejects a dest with %s', (_label, dest) => {
    const dir = servicesWith({ 'k8s/a.yaml': dest, 'k8s/': 'k8s/base/demo/' });
    const rejected: string[] = [];
    const entries = addonUpgradeEntries({
      installed: ['demo'],
      servicesDir: dir,
      projectRoot: ROOT,
      onReject: (why: string) => rejected.push(why),
    });
    expect(entries.map((e) => e.relPath)).toEqual(['k8s/base/demo/a.yaml']);
    expect(rejected).toHaveLength(1);
    expect(addonOwnedPaths(dir).has(dest)).toBe(false);
  });

  it('isContainedRelPath: only a relative path that stays inside the project', () => {
    for (const ok of ['docker-compose.prod.yml', 'k8s/base/a.yaml', 'a/./b.yaml']) {
      expect(isContainedRelPath(ok), ok).toBe(true);
    }
    for (const bad of ['', '.', '..', '../x', 'a/../../x', 'a/../b', '/abs', 'C:\\x', 'a\\..\\b']) {
      expect(isContainedRelPath(bad), bad).toBe(false);
    }
  });
});

describe('upgrade.js refuses an uncontained path before its policy check', () => {
  it('filters every upgrade entry through isContainedRelPath ahead of getFilePolicy', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'upgrade.js'), 'utf8');
    const start = src.indexOf('const shippedEntries = [');
    const loop = src.indexOf('of upgradeEntries) {', start);
    const build = src.slice(start, loop);
    const contain = build.indexOf('.filter(({ relPath }) => isContainedRelPath(relPath))');
    const policy = build.indexOf(".filter(({ policy }) => policy !== 'never')");
    expect(start).toBeGreaterThan(-1);
    expect(contain).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(contain);
    // Applied to the whole list (template and add-on entries), not one half.
    const whole = build.indexOf('const upgradeEntries = shippedEntries');
    expect(whole).toBeGreaterThan(build.indexOf('addonUpgradeEntries('));
    expect(contain).toBeGreaterThan(whole);
  });
});

describe('getAddonFilePolicy', () => {
  // An add-on's files follow one rule wherever they land: its own
  // infrastructure is safe (or merge where the template says so), its
  // integration doc is the operator's, and the project's own code and
  // secrets stay never even if a manifest pointed there.
  it('an add-on volume or init script is safe even where a template path would be never', () => {
    expect(getFilePolicy('volumes/newaddon/conf.yml')).toBe('never');
    expect(getAddonFilePolicy('volumes/newaddon/conf.yml', 'volumes/newaddon/conf.yml')).toBe(
      'safe',
    );
    expect(getAddonFilePolicy('volumes/db/newaddon-init.sh', 'db/init.sh')).toBe('safe');
    expect(getAddonFilePolicy('volumes/metabase/scripts/setup.sh', 'scripts/setup.sh')).toBe(
      'safe',
    );
  });

  it('the integration doc is never; the project code and secrets stay never', () => {
    expect(getAddonFilePolicy('demo-integration.md', 'docs/integration.md')).toBe('never');
    expect(getAddonFilePolicy('src/server/x.ts', 'x.ts')).toBe('never');
    expect(getAddonFilePolicy('.env.local', 'env')).toBe('never');
  });

  it('a merge path stays merge', () => {
    expect(getAddonFilePolicy('docker-compose.yml', 'compose/x.yml')).toBe('merge');
  });
});
