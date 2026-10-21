/**
 * Flux never applies an unrendered deploy-time placeholder (security plan
 * 2026-10-20, Task 6 review). Flux's `vibecarbon-base` Kustomization
 * reconciles the raw `./k8s/base`, while the CLI's deploy applies a rendered
 * copy (renderK8sBase). So every `{{PLACEHOLDER}}` in base that `vibecarbon
 * create` does not fill must sit in an object the Flux cluster file strips
 * with a `$patch: delete` (the db StatefulSet, the registry Deployment). A
 * new placeholder in base has to be either rendered at create time or
 * stripped for Flux; this census fails otherwise.
 *
 * The build mirrors what Flux sees: the base after `create`'s non-secret
 * substitutions, with the cluster file's `vibecarbon-base` patches applied.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { dump, loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDERS, SECRET_PLACEHOLDERS } from '../../../src/create.js';

const ROOT = join(__dirname, '../../..');
const BASE = join(ROOT, 'carbon/k8s/base');
const PLACEHOLDER = /\{\{[A-Z0-9_]+\}\}/g;

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;

function walkFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walkFiles(p) : [p];
  });
}

/** Copy base as `vibecarbon create` lays it down (non-secret placeholders filled). */
function createdBase(into: string) {
  const fill = Object.keys(PLACEHOLDERS).filter((k) => !SECRET_PLACEHOLDERS.has(k));
  for (const src of walkFiles(BASE)) {
    let text = readFileSync(src, 'utf-8');
    for (const key of fill) text = text.replaceAll(`{{${key}}}`, `created-${key.toLowerCase()}`);
    const dest = join(into, 'base', relative(BASE, src));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
}

function fluxBasePatches(cluster: string): Doc[] {
  const file = join(ROOT, `carbon/k8s/flux/clusters/${cluster}/vibecarbon.yaml`);
  const ks = (loadAll(readFileSync(file, 'utf-8')) as Doc[]).find(
    (d) => d?.kind === 'Kustomization' && d.metadata?.name === 'vibecarbon-base',
  );
  return ks?.spec?.patches ?? [];
}

/** `kubectl kustomize` of the created base with `patches` applied; returns stdout. */
function fluxBuild(patches: Doc[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-flux-census-'));
  try {
    createdBase(dir);
    writeFileSync(
      join(dir, 'kustomization.yaml'),
      dump({
        apiVersion: 'kustomize.config.k8s.io/v1beta1',
        kind: 'Kustomization',
        resources: ['base'],
        ...(patches.length ? { patches } : {}),
      }),
    );
    const res = spawnSync('kubectl', ['kustomize', dir], { encoding: 'utf-8' });
    if (res.status !== 0) throw new Error(`kustomize build failed:\n${res.stderr}`);
    return res.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Flux applies no unrendered placeholder from k8s/base', () => {
  it('arm-bite: without the Flux patches, the created base still carries deploy-time placeholders', () => {
    const left = new Set(fluxBuild([]).match(PLACEHOLDER));
    expect(left).toContain('{{MASTER_PRIVATE_IP}}');
    expect(left).toContain('{{DB_IMAGE}}');
  }, 60_000);

  for (const cluster of ['primary', 'standby']) {
    it(`${cluster}: the base Flux builds carries no {{...}} placeholder anywhere`, () => {
      const out = fluxBuild(fluxBasePatches(cluster));
      expect([...new Set(out.match(PLACEHOLDER) ?? [])]).toEqual([]);
      // Positive controls: the build is real, and only the CLI-owned
      // workloads are stripped.
      const docs = (loadAll(out) as Doc[]).filter(Boolean);
      const has = (kind: string, name: string) =>
        docs.some((d) => d.kind === kind && d.metadata?.name === name);
      expect(has('Deployment', 'app')).toBe(true);
      expect(has('Service', 'local-registry')).toBe(true);
      expect(has('NetworkPolicy', 'registry-policy')).toBe(true);
      expect(has('Deployment', 'local-registry')).toBe(false);
      expect(has('StatefulSet', 'db')).toBe(false);
      // The backup CronJob is deploy-owned (per environment): Flux never builds
      // it, and the shared base carries no retention setting for it either.
      expect(has('CronJob', 'backup')).toBe(false);
      const cfg = docs.find(
        (d) => d.kind === 'ConfigMap' && d.metadata?.name === 'vibecarbon-config',
      );
      expect(cfg?.data?.BACKUP_RETENTION_DAYS).toBeUndefined();
    }, 60_000);

    it(`${cluster}: every object stripped with $patch: delete carries prune: disabled`, () => {
      // Stripping an object from Flux's build makes it an orphan in Flux's
      // inventory; without the annotation Flux's garbage collection deletes
      // the live object the CLI applied (in either handoff order).
      const stripped = fluxBasePatches(cluster)
        .filter((p: Doc) => /\$patch: delete/.test(String(p.patch)))
        .map((p: Doc) => ({ kind: p.target?.kind, name: p.target?.name }));
      expect(stripped).toEqual(
        expect.arrayContaining([
          { kind: 'StatefulSet', name: 'db' },
          { kind: 'Deployment', name: 'local-registry' },
          { kind: 'CronJob', name: 'backup' },
        ]),
      );
      const docs = (loadAll(fluxBuild([])) as Doc[]).filter(Boolean);
      for (const { kind, name } of stripped) {
        const obj = docs.find((d) => d.kind === kind && d.metadata?.name === name);
        expect(obj, `${kind}/${name} is in base`).toBeDefined();
        expect(
          obj.metadata.annotations?.['kustomize.toolkit.fluxcd.io/prune'],
          `${kind}/${name}`,
        ).toBe('disabled');
      }
    }, 60_000);

    it(`${cluster}: still health-checks the CLI-owned registry Deployment`, () => {
      const file = join(ROOT, `carbon/k8s/flux/clusters/${cluster}/vibecarbon.yaml`);
      const ks = (loadAll(readFileSync(file, 'utf-8')) as Doc[]).find(
        (d) => d?.kind === 'Kustomization' && d.metadata?.name === 'vibecarbon-base',
      );
      expect(ks.spec.healthChecks).toContainEqual({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: 'local-registry',
        namespace: 'vibecarbon',
      });
    });
  }
});
