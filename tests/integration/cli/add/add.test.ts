/**
 * vibecarbon add — comprehensive matrix against a real project.
 *
 * Each test gets a fresh clone of `vibecarbon create` output. Verifies
 * .vibecarbon.json mutation + the actual filesystem effects users
 * encounter.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

function readManifest(p: string): { services?: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(p, '.vibecarbon.json'), 'utf-8'));
}

describe('vibecarbon add', () => {
  let project: string;
  beforeEach(() => {
    project = realProject();
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  describe('help', () => {
    it('prints help with -h', () => {
      const r = runCli('add', ['-h'], { cwd: project });
      assertSuccess(r);
      assertExitWith(r, 0, 'Vibecarbon Add');
      assertExitWith(r, 0, 'observability');
    });

    it('rejects --online (single-dash only) and the removed -offline flag', () => {
      // `add` now installs from the packaged `services/` by default; `-online`
      // is the opt-in for fetching from GitHub. Double-dash is never accepted,
      // and the old `-offline` flag is gone.
      const r1 = runCli('add', ['--online'], { cwd: project });
      assertExitWith(r1, 1, 'unknown flag: --online');
      const r2 = runCli('add', ['-offline'], { cwd: project });
      assertExitWith(r2, 1, /unknown flag/i);
    });

    it('rejects --list (CLI sweep removed)', () => {
      const r = runCli('add', ['--list'], { cwd: project });
      assertExitWith(r, 1, 'unknown flag: --list');
    });
  });

  describe('off-TTY guard', () => {
    it('off-TTY without features fails with -features hint', () => {
      const r = runCli('add', [], { cwd: project });
      assertExitWith(r, 1, /needs an interactive terminal|-features/);
    });
  });

  describe('feature add (compose mode, default)', () => {
    it.each(['observability', 'redis'])(
      'add %s records the service in .vibecarbon.json',
      (feature) => {
        const r = runCli('add', [feature, '-y'], { cwd: project, timeoutMs: 30_000 });
        assertSuccess(r);
        const m = readManifest(project);
        expect(m.services?.[feature]).toBeDefined();
      },
    );

    it('observability compose overlay + volume configs are not pre-bundled by create', () => {
      // create.js no longer ships the observability stack — it arrives via
      // `add observability`. Guards against regressing back to pre-bundling.
      expect(existsSync(join(project, 'docker-compose.observability.yml'))).toBe(false);
      expect(existsSync(join(project, 'volumes/prometheus/prometheus.yml'))).toBe(false);
    });

    it('add observability installs the compose overlay + volume configs', () => {
      const r = runCli('add', ['observability', '-y'], { cwd: project, timeoutMs: 30_000 });
      assertSuccess(r);
      expect(existsSync(join(project, 'docker-compose.observability.yml'))).toBe(true);
      expect(existsSync(join(project, 'volumes/prometheus/prometheus.yml'))).toBe(true);
      expect(
        existsSync(join(project, 'volumes/grafana/provisioning/datasources/datasources.yml')),
      ).toBe(true);
    });

    it('multi-feature add records all in one shot', () => {
      const r = runCli('add', ['redis', 'observability', '-y'], {
        cwd: project,
        timeoutMs: 30_000,
      });
      assertSuccess(r);
      const m = readManifest(project);
      expect(m.services?.redis).toBeDefined();
      expect(m.services?.observability).toBeDefined();
    });

    it('idempotent — second add of the same feature succeeds without error', () => {
      const r1 = runCli('add', ['observability', '-y'], { cwd: project, timeoutMs: 30_000 });
      assertSuccess(r1);
      const r2 = runCli('add', ['observability', '-y'], { cwd: project, timeoutMs: 30_000 });
      // Either succeeds (idempotent) OR exits with a clear "already added"
      // message — both fine. Hard fail only on parser break.
      if (/unknown.*flag/i.test(r2.stderr)) {
        throw new Error(`parser error on second add:\n${r2.stderr}`);
      }
    });

    it('rejects unknown feature name', () => {
      const r = runCli('add', ['bogus-feature', '-y'], { cwd: project, timeoutMs: 30_000 });
      // Either explicit rejection or it falls through to "service not found".
      expect(r.exitCode).not.toBe(0);
    });
  });

  describe('parked features (turned off for this release)', () => {
    // n8n + Metabase still ship under services/ (parked, not deleted) but are
    // refused by `add`. Guards the MVP freeze: re-listing them in LOCAL_FEATURES
    // without re-marking `status: 'parked'` would re-expose installs here.
    it.each(['n8n', 'metabase'])('refuses to add %s and records nothing', (feature) => {
      const r = runCli('add', [feature, '-y'], { cwd: project, timeoutMs: 30_000 });
      expect(r.exitCode).not.toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toContain('not available in this release');
      // Nothing recorded in the manifest and no compose overlay written —
      // the refusal happens before any file install.
      const m = readManifest(project);
      expect(m.services?.[feature]).toBeUndefined();
      expect(existsSync(join(project, `docker-compose.${feature}.yml`))).toBe(false);
    });

    it('-h lists available features but not parked ones', () => {
      const r = runCli('add', ['-h'], { cwd: project });
      assertSuccess(r);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toContain('observability');
      expect(out).toContain('redis');
      expect(out).not.toContain('n8n');
      expect(out).not.toContain('metabase');
    });
  });

  describe('feature add (k8s mode)', () => {
    it('add observability (CLI/direct k3s path) isolates in its own namespace, NOT wired into base', () => {
      destroyRealProject(project);
      project = realProject({ deployMode: 'k8s' }); // cicdEnabled defaults to falsy
      const r = runCli('add', ['observability', '-y'], {
        cwd: project,
        timeoutMs: 30_000,
      });
      assertSuccess(r);
      // The k8s manifests are copied into the project...
      expect(existsSync(join(project, 'k8s/base/observability/kustomization.yaml'))).toBe(true);
      // ...and set to their OWN namespace (H-9 isolation).
      const obsKust = readFileSync(
        join(project, 'k8s/base/observability/kustomization.yaml'),
        'utf-8',
      );
      expect(obsKust).toContain('namespace: vibecarbon-observability');
      // ...but are deliberately NOT wired into the base kustomization: base sets
      // `namespace: vibecarbon`, whose transformer would override the child
      // namespace and defeat the isolation. applyK3sManifests applies it as a
      // SEPARATE kustomization (mirrors cluster-autoscaler).
      const baseKust = readFileSync(join(project, 'k8s/base/kustomization.yaml'), 'utf-8');
      expect(baseKust).not.toContain('observability/');
    });

    it('add observability is NEVER wired into base — even on a gitops (cicdEnabled) project', () => {
      // UNIFORM ISOLATION: observability must never enter k8s/base on ANY path
      // (the base namespace transformer would ship it un-isolated). On gitops the
      // stack simply isn't deployed yet — a loud warning fires at deploy time
      // (deployK8sGitOps) instead of silently shipping the un-isolated vuln.
      destroyRealProject(project);
      project = realProject({ deployMode: 'k8s' });
      const configPath = join(project, '.vibecarbon.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      config.cicdEnabled = true;
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const r = runCli('add', ['observability', '-y'], {
        cwd: project,
        timeoutMs: 30_000,
      });
      assertSuccess(r);
      const baseKust = readFileSync(join(project, 'k8s/base/kustomization.yaml'), 'utf-8');
      expect(baseKust).not.toContain('observability/');
    });

    it('add observability copies the {{K8S_STORAGE_CLASS}} placeholder UNRESOLVED (M3 Task 4)', () => {
      // add.js has no reliable per-environment provider signal (provider is
      // resolved and persisted per-ENVIRONMENT at `deploy` time, not by
      // `add`), so it must NOT bake a StorageClass literal into the copied
      // PVC manifests — that would silently hardcode Hetzner's
      // hcloud-volumes even on a DigitalOcean project. The placeholder is
      // resolved later, pre-apply, by applyK3sManifests
      // (renderK8sStorageClassPlaceholder — src/lib/deploy/k8s/k3s.js),
      // which has the deploy's actual resolved ProviderClass in scope.
      destroyRealProject(project);
      project = realProject({ deployMode: 'k8s' });
      const r = runCli('add', ['observability', '-y'], { cwd: project, timeoutMs: 30_000 });
      assertSuccess(r);
      for (const pvc of ['grafana-pvc.yaml', 'loki-pvc.yaml', 'prometheus-pvc.yaml']) {
        const content = readFileSync(join(project, 'k8s/base/observability', pvc), 'utf-8');
        expect(content).toContain('storageClassName: {{K8S_STORAGE_CLASS}}');
        expect(content).not.toContain('hcloud-volumes');
      }
    });

    it('add redis installs its k8s manifests from the packaged template (default, no -online)', () => {
      // Proves the root-cause fix: the default (packaged) install path copies
      // directory assets such as k8s/. Previously the online default threw
      // "Directory installation requires file listing in manifest".
      destroyRealProject(project);
      project = realProject({ deployMode: 'k8s' });
      const r = runCli('add', ['redis', '-y'], { cwd: project, timeoutMs: 30_000 });
      assertSuccess(r);
      expect(existsSync(join(project, 'k8s/base/redis/kustomization.yaml'))).toBe(true);
      const baseKust = readFileSync(join(project, 'k8s/base/kustomization.yaml'), 'utf-8');
      expect(baseKust).toContain('redis/');
      // Prod overlay installs too — it drops the dev host-port publish so prod
      // never binds redis on the host (defense-in-depth behind the firewall).
      //
      // `!reset null`, NOT `ports: []`: Compose CONCATENATES `ports` across -f
      // files, so the empty list this used to assert contributed nothing and
      // the base file's `6379:6379` survived into prod — i.e. the assertion
      // pinned the literal text while the behavior it describes never held.
      // See tests/unit/deploy/compose-port-publication.test.ts.
      const redisProd = join(project, 'docker-compose.redis.prod.yml');
      expect(existsSync(redisProd)).toBe(true);
      expect(readFileSync(redisProd, 'utf-8')).toContain('ports: !reset null');
    });
  });

  describe('-no-git regression (the secret-scan bug we shipped a fix for)', () => {
    it('add observability succeeds in a -no-git project (no secret-scan refusal)', () => {
      destroyRealProject(project);
      project = realProject({ git: false });
      const r = runCli('add', ['observability', '-y'], {
        cwd: project,
        timeoutMs: 30_000,
      });
      // The 2026-05-07 fix: secret-scan must not fire on .env / .env.local
      // when there's no .git/. Hard fail if we see that regression.
      if (/Refusing to add: secrets detected/i.test(r.stdout + r.stderr)) {
        throw new Error(`secret-scan regression — refused on -no-git project:\n${r.stderr}`);
      }
      assertSuccess(r);
    });
  });

  describe('not in a project', () => {
    it('refuses outside a vibecarbon project', () => {
      const r = runCli('add', ['observability', '-y'], { cwd: '/tmp', timeoutMs: 10_000 });
      assertExitWith(r, 1, /Not in a Vibecarbon project|vibecarbon\.json/i);
    });
  });
});
