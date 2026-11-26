/**
 * The volume size floor (ProviderClass.K8S_MIN_VOLUME_GI).
 *
 * vultr-csi passes a claim's request to Vultr's block storage API unrounded
 * (getStorageBytes, SizeGB = size / GiB), and the API refuses an NVMe volume
 * under 10 GB, so a 1Gi or 5Gi claim never binds. Hetzner's and Linode's
 * drivers round a small request up themselves. So every place that renders
 * `{{K8S_STORAGE_CLASS}}` also raises each `storage: <n>Gi` request in that
 * file below the provider's floor to the floor, and changes nothing else.
 * A floor of 0, the base class's, leaves every request as it was.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDbManifestValues,
  renderK8sBase,
  renderK8sStorageClassPlaceholder,
} from '../../../src/lib/deploy/k8s/k3s.js';
import { BaseProvider } from '../../../src/lib/providers/base.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { REPO_ROOT, readRepoFile, sourceFiles } from '../../_shared/source-files.js';
import { adoptTempDir, createTempDir } from '../../_shared/temp-dir.js';

const PLACEHOLDER = '{{K8S_STORAGE_CLASS}}';
const CLASS = 'provider-csi';

/** A PVC naming the placeholder, with `storage` as its request, written as given. */
const pvc = (storage: string) =>
  [
    'apiVersion: v1',
    'kind: PersistentVolumeClaim',
    'metadata:',
    '  name: data',
    'spec:',
    '  accessModes:',
    '    - ReadWriteOnce',
    `  storageClassName: "${PLACEHOLDER}"`,
    '  resources:',
    '    requests:',
    `      storage: ${storage}`,
    '',
  ].join('\n');

/** `files` (name to text) rendered with `minVolumeGi`, read back. */
function render(files: Record<string, string>, opts?: { minVolumeGi?: number }) {
  const dir = createTempDir('vc-volume-floor-');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const out = adoptTempDir(renderK8sStorageClassPlaceholder(dir, CLASS, opts));
  return Object.fromEntries(
    Object.keys(files).map((name) => [name, readFileSync(join(out, name), 'utf-8')]),
  );
}

/** Each `storage:` request in `text`, as written after the key. */
const requests = (text: string) =>
  [...text.matchAll(/^\s*storage:[ \t]*(\S.*)$/gm)].map(([, value]) => value.trim());

describe('the volume floor raises a small request at render time', () => {
  it('raises a 1Gi request to the floor', () => {
    const { 'pvc.yaml': out } = render({ 'pvc.yaml': pvc('1Gi') }, { minVolumeGi: 10 });
    expect(requests(out)).toEqual(['10Gi']);
    expect(out).toBe(pvc('10Gi').replace(PLACEHOLDER, CLASS));
  });

  it.each(['10Gi', '20Gi'])('keeps a request at or above the floor (%s)', (storage) => {
    const { 'pvc.yaml': out } = render({ 'pvc.yaml': pvc(storage) }, { minVolumeGi: 10 });
    expect(out).toBe(pvc(storage).replace(PLACEHOLDER, CLASS));
  });

  it('raises a quoted "5Gi"', () => {
    const { 'pvc.yaml': out } = render({ 'pvc.yaml': pvc('"5Gi"') }, { minVolumeGi: 10 });
    expect(requests(out)).toEqual(['"10Gi"']);
  });

  it('floor 0 changes nothing', () => {
    for (const opts of [undefined, { minVolumeGi: 0 }]) {
      const { 'pvc.yaml': out } = render({ 'pvc.yaml': pvc('1Gi') }, opts);
      expect(out).toBe(pvc('1Gi').replace(PLACEHOLDER, CLASS));
    }
  });

  it('leaves a file that names no StorageClass alone, and a comment', () => {
    const other = '# storage: 1Gi\nkind: ConfigMap\ndata:\n  storage: 1Gi\n';
    const out = render(
      { 'pvc.yaml': `# storage: 1Gi\n${pvc('1Gi')}`, 'configmap.yaml': other },
      { minVolumeGi: 10 },
    );
    expect(out['configmap.yaml']).toBe(other);
    expect(out['pvc.yaml'].startsWith('# storage: 1Gi\n')).toBe(true);
    expect(requests(out['pvc.yaml'])).toEqual(['10Gi']);
  });

  it('every PVC under carbon/k8s and services that names {{K8S_STORAGE_CLASS}} requests storage in Gi', () => {
    // The floor reads `storage: <n>Gi`, bare or double-quoted. A claim
    // written another way (Mi, Ti, a bare number) would pass it by, and on
    // Vultr never bind.
    const names = /^\s*storageClassName:\s*"?\{\{K8S_STORAGE_CLASS\}\}"?\s*$/m;
    const files = sourceFiles(
      [join(REPO_ROOT, 'carbon/k8s'), join(REPO_ROOT, 'services')].filter((r) => existsSync(r)),
      { exts: ['.yaml', '.yml'], skip: ['node_modules'] },
    ).filter((f) => names.test(readFileSync(f, 'utf-8')));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      const shown = file.replace(`${REPO_ROOT}/`, '');
      expect(requests(text).length, `${shown} requests no storage`).toBeGreaterThan(0);
      for (const value of requests(text)) expect(value, shown).toMatch(/^("?)\d+Gi\1$/);
      // And the floor reaches each one.
      const { [basename(file)]: out } = render({ [basename(file)]: text }, { minVolumeGi: 10 });
      for (const value of requests(out)) {
        expect(Number(value.replace(/\D/g, '')), shown).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('VultrProvider.K8S_MIN_VOLUME_GI is 10 and the base is 0', () => {
    expect(VultrProvider.K8S_MIN_VOLUME_GI).toBe(10);
    expect(BaseProvider.K8S_MIN_VOLUME_GI).toBe(0);
  });
});

describe('renderK8sBase raises the db and the add-on claims under k8s/base', () => {
  const TLS = {
    dnsNames: ['app.example.test'],
    issuerName: 'letsencrypt-prod',
    effectiveIssuer: 'letsencrypt-prod',
  };
  const base = () => {
    const root = createTempDir('vc-volume-floor-base-');
    mkdirSync(join(root, 'db'), { recursive: true });
    mkdirSync(join(root, 'redis'), { recursive: true });
    writeFileSync(
      join(root, 'db', 'statefulset.yaml'),
      readRepoFile('carbon/k8s/base/db/statefulset.yaml'),
    );
    writeFileSync(join(root, 'redis', 'pvc.yaml'), readRepoFile('services/redis/k8s/pvc.yaml'));
    return root;
  };
  const values = () =>
    buildDbManifestValues({
      dbImageTag: 'ghcr.io/org/postgres:17-walg1',
      storageClass: CLASS,
      walArchiveSha: 'abc',
    });

  it.each([
    [0, ['1Gi']],
    [10, ['10Gi']],
  ] as const)('floor %i', (minVolumeGi, redis) => {
    const out = adoptTempDir(
      renderK8sBase(base(), values(), undefined, TLS, { minVolumeGi: minVolumeGi }),
    );
    expect(requests(readFileSync(join(out, 'redis', 'pvc.yaml'), 'utf-8'))).toEqual(redis);
    expect(requests(readFileSync(join(out, 'db', 'statefulset.yaml'), 'utf-8'))).toEqual(['10Gi']);
  });
});

describe('applyK3sManifests passes the provider floor to every StorageClass render', () => {
  const whole = readRepoFile('src/lib/deploy/k8s/k3s.js');
  const body = whole.slice(whole.indexOf('export async function applyK3sManifests({'));
  /** The call, through the parenthesis that closes it. */
  const call = (name: string) => {
    const at = body.indexOf(`${name}(`);
    expect(at, name).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = at + name.length; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')' && --depth === 0) return body.slice(at, i + 1);
    }
    throw new Error(`${name}( is never closed`);
  };

  it.each(['renderK8sBase', 'renderK8sStorageClassPlaceholder'])('%s', (name) => {
    expect(call(name)).toContain('minVolumeGi: ProviderClass.K8S_MIN_VOLUME_GI');
  });
});
