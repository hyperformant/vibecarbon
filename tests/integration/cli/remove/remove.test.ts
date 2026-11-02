/**
 * vibecarbon remove — comprehensive matrix against a real project.
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

describe('vibecarbon remove', () => {
  let project: string;
  beforeEach(() => {
    project = realProject();
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  describe('help', () => {
    it('prints help', () => {
      const r = runCli('remove', ['-h'], { cwd: project });
      assertSuccess(r);
      assertExitWith(r, 0, 'Vibecarbon Remove');
    });

    it('rejects the double-dash --force form (single-dash -force remains as a -y alias)', () => {
      const r = runCli('remove', ['--force'], { cwd: project });
      assertExitWith(r, 1, 'unknown flag: --force');
    });
  });

  describe('off-TTY guard', () => {
    it('off-TTY without features fails', () => {
      const r = runCli('remove', [], { cwd: project });
      assertExitWith(r, 1, /needs an interactive terminal|-features/);
    });
  });

  describe('add → remove round-trips', () => {
    // Only currently-available features can be added; parked features (n8n,
    // Metabase) are covered by the asymmetry test below.
    it.each(['observability', 'redis'])(
      'add then remove %s clears the service entry',
      (feature) => {
        const add = runCli('add', [feature, '-y'], { cwd: project, timeoutMs: 30_000 });
        assertSuccess(add);
        expect(readManifest(project).services?.[feature]).toBeDefined();

        const rm = runCli('remove', [feature, '-y'], { cwd: project, timeoutMs: 30_000 });
        assertSuccess(rm);
        expect(readManifest(project).services?.[feature]).toBeUndefined();
      },
    );
  });

  describe('remove drops what add wrote, and only that', () => {
    it('drops the checksums of the files it removes', () => {
      assertSuccess(runCli('add', ['observability', '-y'], { cwd: project, timeoutMs: 30_000 }));
      assertSuccess(runCli('remove', ['observability', '-y'], { cwd: project, timeoutMs: 30_000 }));
      const sums = Object.keys(
        (readManifest(project) as { fileChecksums?: Record<string, string> }).fileChecksums ?? {},
      );
      expect(
        sums.filter(
          (k) =>
            k.startsWith('k8s/base/observability/') ||
            k.startsWith('docker-compose.observability') ||
            k.startsWith('volumes/prometheus/') ||
            k === 'observability-integration.md',
        ),
      ).toEqual([]);
      // The template's own checksums stay.
      expect(sums).toContain('docker-compose.prod.yml');
    });

    it("keeps the project's own files under a directory the add-on shares", () => {
      // The observability manifest maps `volumes/` to `volumes/`; removing
      // the add-on must not take the template's volumes (traefik, db) with it.
      const shared = ['volumes/traefik/middlewares.yml', 'volumes/db/db-guard.sh'];
      for (const rel of shared) expect(existsSync(join(project, rel)), rel).toBe(true);
      assertSuccess(runCli('add', ['observability', '-y'], { cwd: project, timeoutMs: 30_000 }));
      assertSuccess(runCli('remove', ['observability', '-y'], { cwd: project, timeoutMs: 30_000 }));
      for (const rel of shared) expect(existsSync(join(project, rel)), rel).toBe(true);
      expect(existsSync(join(project, 'volumes/prometheus/prometheus.yml'))).toBe(false);
      expect(existsSync(join(project, 'k8s/base/observability'))).toBe(false);
    });
  });

  describe('parked features can still be removed (add blocks, remove allows)', () => {
    it('removes a parked-but-installed service from the manifest', () => {
      // `add n8n` is refused now, but a project that installed n8n before the
      // freeze must still be able to remove it. Seed the manifest directly to
      // simulate that pre-existing install, then confirm remove clears it.
      const manifestPath = join(project, '.vibecarbon.json');
      const seeded = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      seeded.services = {
        ...(seeded.services ?? {}),
        n8n: { addedAt: new Date().toISOString(), version: '1.0.0' },
      };
      writeFileSync(manifestPath, JSON.stringify(seeded, null, 2));

      const rm = runCli('remove', ['n8n', '-y'], { cwd: project, timeoutMs: 30_000 });
      assertSuccess(rm);
      expect(readManifest(project).services?.n8n).toBeUndefined();
    });
  });

  describe('remove on a fresh project (no service added)', () => {
    it('graceful — no parser error, may be no-op or warn', () => {
      const r = runCli('remove', ['observability', '-y'], { cwd: project, timeoutMs: 30_000 });
      if (/unknown.*flag/i.test(r.stderr)) {
        throw new Error(`parser error:\n${r.stderr}`);
      }
    });
  });

  describe('not in a project', () => {
    it('refuses outside a vibecarbon project', () => {
      const r = runCli('remove', ['observability', '-y'], { cwd: '/tmp', timeoutMs: 10_000 });
      assertExitWith(r, 1, /Not in a Vibecarbon project/i);
    });
  });
});
