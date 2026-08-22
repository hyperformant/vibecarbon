import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  renderK8sStorageClassPlaceholder,
  renderK8sStorageClassPlaceholderIfPresent,
} from '../../../src/lib/deploy/k8s/k3s.js';

// Two coupled defects, both silent.
//
// 1. services/redis/k8s/pvc.yaml declared NO storageClassName at all. Our
//    clusters always carry TWO default-annotated StorageClasses (k3s'
//    node-local `local-path` and the provider CSI class), and with two
//    defaults the DefaultStorageClass admission plugin picks the newest by
//    creationTimestamp — so which storage redis' data landed on was decided by
//    a race the deploy never asserted. On the unlucky flip the PV's node
//    affinity pinned redis to that node and the data died with it. Redis comes
//    up Ready either way. Same defect #234 fixed for the Supabase PVCs; redis
//    is a LIVE addon (only n8n/metabase are parked).
//
// 2. Adding the placeholder alone would have introduced the OTHER half:
//    renderK8sStorageClassPlaceholder was flat (no recursion) and was called
//    on exactly one directory, observability. `add redis` / `add n8n` copy
//    their PVCs into k8s/base/<addon>/ — a SUBDIRECTORY of the tree applied by
//    `kubectl apply -k k8s/base`, which never went through the renderer at
//    all. kubectl ACCEPTS a literal `{{K8S_STORAGE_CLASS}}` (storageClassName
//    is a free-form reference, never DNS-1123-validated) and the PVC sits
//    Pending forever.
//
// The substitution cannot be a post-apply `kubectl patch`: storageClassName is
// IMMUTABLE once the object exists, which is why the renderer produces a temp
// copy consumed BEFORE the apply.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PLACEHOLDER = '{{K8S_STORAGE_CLASS}}';

/** Every PVC we ship, from both addon and bundled-manifest trees. */
function pvcFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.ya?ml$/.test(entry.name)) {
        const content = readFileSync(full, 'utf-8');
        // Column-0 `kind:` only — a kustomize overlay mentions the kind
        // INDENTED under `target:` when it patches a PVC it does not define
        // (carbon/k8s/overlays/local pins local-path that way, deliberately).
        if (/^kind:\s*PersistentVolumeClaim/m.test(content)) found.push(full);
      }
    }
  };
  walk(join(repoRoot, 'services'));
  walk(join(repoRoot, 'carbon/k8s'));
  return found.sort();
}

describe('every shipped PVC pins its StorageClass', () => {
  it('finds the PVCs (sanity: the walk is not vacuous)', () => {
    expect(pvcFiles().length).toBeGreaterThan(3);
  });

  it('no PVC omits storageClassName — two default classes make the binding a race', () => {
    const offenders = pvcFiles().filter(
      (f) => !/^\s*storageClassName:/m.test(readFileSync(f, 'utf-8')),
    );
    expect(
      offenders.map((f) => f.replace(`${repoRoot}/`, '')),
      'A PVC with no storageClassName is bound by the DefaultStorageClass admission ' +
        'plugin. Our clusters have TWO defaults, so the plugin picks by creationTimestamp ' +
        'and the DB/cache can land on node-local disk. Pin it to {{K8S_STORAGE_CLASS}}.',
    ).toEqual([]);
  });
});

describe('renderK8sStorageClassPlaceholder resolves nested addon trees', () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-sc-fixture-'));
    mkdirSync(join(root, 'redis'), { recursive: true });
    writeFileSync(join(root, 'kustomization.yaml'), 'resources:\n  - redis/\n');
    writeFileSync(join(root, 'redis', 'pvc.yaml'), `spec:\n  storageClassName: ${PLACEHOLDER}\n`);
    return root;
  };

  it('substitutes inside SUBDIRECTORIES (the addon layout `add` produces)', () => {
    const rendered = renderK8sStorageClassPlaceholder(fixture(), 'provider-csi');
    const pvc = readFileSync(join(rendered, 'redis', 'pvc.yaml'), 'utf-8');
    expect(pvc).toContain('storageClassName: provider-csi');
    expect(pvc).not.toContain(PLACEHOLDER);
    // The kustomize root must come along or `apply -k` has nothing to read.
    expect(readFileSync(join(rendered, 'kustomization.yaml'), 'utf-8')).toContain('redis/');
  });

  it('leaves the source tree untouched (never dirties the operator git tree)', () => {
    const src = fixture();
    renderK8sStorageClassPlaceholder(src, 'provider-csi');
    expect(readFileSync(join(src, 'redis', 'pvc.yaml'), 'utf-8')).toContain(PLACEHOLDER);
  });

  it('refuses an empty storage class rather than binding the cluster default', () => {
    expect(() => renderK8sStorageClassPlaceholder(fixture(), '')).toThrow(/unresolved placeholder/);
  });
});

describe('renderK8sStorageClassPlaceholderIfPresent is a no-op without a placeholder', () => {
  it('returns the ORIGINAL path when nothing needs substituting', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-sc-clean-'));
    writeFileSync(join(root, 'kustomization.yaml'), 'resources: []\n');
    // Byte-identical argv for the common case — the temp-copy path is entered
    // only when it is load-bearing.
    expect(renderK8sStorageClassPlaceholderIfPresent(root, 'provider-csi')).toBe(root);
  });

  it('renders when a nested file DOES carry the placeholder', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-sc-dirty-'));
    mkdirSync(join(root, 'n8n'), { recursive: true });
    writeFileSync(join(root, 'n8n', 'pvc.yaml'), `storageClassName: ${PLACEHOLDER}\n`);
    const out = renderK8sStorageClassPlaceholderIfPresent(root, 'provider-csi');
    expect(out).not.toBe(root);
    expect(readFileSync(join(out, 'n8n', 'pvc.yaml'), 'utf-8')).toContain('provider-csi');
  });
});
