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
import { addKustomizationEntry } from '../../../src/lib/template-edits.js';

const ROOT = join(__dirname, '../../..');
const BASE = join(ROOT, 'carbon/k8s/base');
const SERVICES = join(ROOT, 'services');
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

/**
 * Every add-on `vibecarbon add` wires into k8s/base (it declares a
 * kustomization entry), with the directory it lands in under base/.
 */
const BASE_ADDONS = readdirSync(SERVICES).flatMap((name) => {
  const manifest = join(SERVICES, name, 'manifest.json');
  let parsed: Doc;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf-8'));
  } catch {
    return [];
  }
  const into: string | undefined = parsed.files?.['k8s/'];
  const entry: string | undefined = parsed.kustomization?.entry;
  return into && entry ? [{ name, entry, into: relative('k8s/base', into) }] : [];
});

/**
 * Install those add-ons into a created base the way `add` does: their k8s
 * files copied (add fills none of the k8s tokens, the claims keep
 * {{K8S_STORAGE_CLASS}} for the deploy) and each entry listed.
 */
function addBaseAddons(into: string) {
  const kustomization = join(into, 'base', 'kustomization.yaml');
  for (const { name, entry, into: sub } of BASE_ADDONS) {
    const from = join(SERVICES, name, 'k8s');
    for (const src of walkFiles(from)) {
      const dest = join(into, 'base', sub, relative(from, src));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(src, 'utf-8'));
    }
    writeFileSync(
      kustomization,
      addKustomizationEntry(readFileSync(kustomization, 'utf-8'), entry),
    );
  }
}

function fluxBasePatches(cluster: string): Doc[] {
  const file = join(ROOT, `carbon/k8s/flux/clusters/${cluster}/vibecarbon.yaml`);
  const ks = (loadAll(readFileSync(file, 'utf-8')) as Doc[]).find(
    (d) => d?.kind === 'Kustomization' && d.metadata?.name === 'vibecarbon-base',
  );
  return ks?.spec?.patches ?? [];
}

/**
 * `kubectl kustomize` of the created base (with every base add-on when
 * `addons`) with `patches` applied; returns stdout.
 */
function fluxBuild(patches: Doc[], { addons = false } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-flux-census-'));
  try {
    createdBase(dir);
    if (addons) addBaseAddons(dir);
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
      // The TLS Certificate is deploy-owned too: the CLI renders it with the
      // environment's names and issuer (renderK8sBase). Flux applying the
      // base's app.example.com placeholder would reset it on every reconcile.
      expect(has('Certificate', 'vibecarbon-tls')).toBe(false);
      const cfg = docs.find(
        (d) => d.kind === 'ConfigMap' && d.metadata?.name === 'vibecarbon-config',
      );
      expect(cfg?.data?.BACKUP_RETENTION_DAYS).toBeUndefined();
    }, 60_000);

    it(`${cluster}: with every add-on that joins k8s/base, the build still carries no placeholder`, () => {
      // An add-on's claim names the provider's StorageClass, rendered per
      // cluster by the CLI's deploy and immutable once the claim exists: the
      // cluster file leaves every claim to the deploy.
      expect(BASE_ADDONS.length).toBeGreaterThan(2);
      const out = fluxBuild(fluxBasePatches(cluster), { addons: true });
      expect([...new Set(out.match(PLACEHOLDER) ?? [])]).toEqual([]);
      const docs = (loadAll(out) as Doc[]).filter(Boolean);
      expect(docs.filter((d) => d.kind === 'PersistentVolumeClaim')).toEqual([]);
      // Positive controls: the add-ons are in the build, and so are their
      // claims before the cluster file's patches.
      for (const { name } of BASE_ADDONS) {
        expect(
          docs.some((d) => d.kind === 'Service' && d.metadata?.name === name),
          `${name} Service`,
        ).toBe(true);
      }
      const unpatched = (loadAll(fluxBuild([], { addons: true })) as Doc[]).filter(Boolean);
      expect(unpatched.some((d) => d.kind === 'PersistentVolumeClaim')).toBe(true);
    }, 60_000);

    it(`${cluster}: every object stripped with $patch: delete carries prune: disabled`, () => {
      // Stripping an object from Flux's build makes it an orphan in Flux's
      // inventory; without the annotation Flux's garbage collection deletes
      // the live object the CLI applied (in either handoff order). A target
      // with no name strips every object of its kind.
      const stripped = fluxBasePatches(cluster)
        .filter((p: Doc) => /\$patch: delete/.test(String(p.patch)))
        .map((p: Doc) => ({ kind: p.target?.kind, name: p.target?.name }));
      expect(stripped).toEqual(
        expect.arrayContaining([
          { kind: 'StatefulSet', name: 'db' },
          { kind: 'Deployment', name: 'local-registry' },
          { kind: 'CronJob', name: 'backup' },
          { kind: 'Certificate', name: 'vibecarbon-tls' },
          { kind: 'PersistentVolumeClaim', name: undefined },
        ]),
      );
      const docs = (loadAll(fluxBuild([], { addons: true })) as Doc[]).filter(Boolean);
      for (const { kind, name } of stripped) {
        const objs = docs.filter(
          (d) => d.kind === kind && (name === undefined || d.metadata?.name === name),
        );
        expect(objs.length, `${kind}/${name ?? '*'} is in base`).toBeGreaterThan(0);
        for (const obj of objs) {
          expect(
            obj.metadata.annotations?.['kustomize.toolkit.fluxcd.io/prune'],
            `${kind}/${obj.metadata.name}`,
          ).toBe('disabled');
        }
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
