/**
 * Task 7: derive the pilot-light failover scale-up list from what deploy
 * ACTUALLY renders — the standby zero overlay (Task 2) is the authoritative
 * zero-set; its inverse (target replicas from the shared values, default 1)
 * is exactly what `vibecarbon failover` must bring up. Replaces a former
 * hardcoded failover deployment list, which would silently drift from the pin.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveScaleUpList } from '../../../src/lib/deploy/k8s/standby-config.js';

const carbon = join(__dirname, '../../../carbon/k8s');
const real = () => ({
  overlayText: readFileSync(join(carbon, 'values/supabase.standby.values.yaml'), 'utf-8'),
  sharedValuesText: readFileSync(join(carbon, 'values/supabase.values.yaml'), 'utf-8'),
  appManifestText: readFileSync(join(carbon, 'base/app/deployment.yaml'), 'utf-8'),
});

describe('deriveScaleUpList', () => {
  it('inverts the zero overlay: one entry per zeroed component + app + CA', () => {
    const list = deriveScaleUpList(real());
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '../../fixtures/supabase-chart-workloads.json'), 'utf-8'),
    );
    for (const comp of fixture.deployments) {
      expect(list).toContainEqual({
        name: `supabase-supabase-${comp}`,
        namespace: 'vibecarbon',
        replicas: 1,
      });
    }
    expect(list).toContainEqual({ name: 'app', namespace: 'vibecarbon', replicas: 2 }); // base manifest replicas: 2
    expect(list).toContainEqual({
      name: 'cluster-autoscaler',
      namespace: 'kube-system',
      replicas: 1,
    });
  });

  it('honors a replicaCount override in the shared values', () => {
    const args = real();
    // Insert (not append) the override right after the `deployment:` root
    // key so it genuinely lands inside the map deriveScaleUpList reads —
    // appending at end-of-file would nest it under whatever top-level key
    // happens to be last (`persistence:`), which isn't what a real
    // operator-authored override would look like.
    args.sharedValuesText = args.sharedValuesText.replace(
      /^deployment:\n/m,
      'deployment:\n  auth:\n    replicaCount: 3\n',
    );
    const list = deriveScaleUpList(args);
    expect(list.find((e) => e.name === 'supabase-supabase-auth')?.replicas).toBe(3);
  });

  it('never derives a replicaCount from a same-named block under another top-level map', () => {
    const args = real();
    // Adversarial: `environment:` legitimately has its own `auth:` key
    // (an env-var LIST, chart shape environment.<comp>), never deployment
    // config. Plant a 4-space-indented `replicaCount: 9` line inside it,
    // with NO override under `deployment:`. If the parse isn't scoped
    // structurally to the `deployment:` block, this same-named sibling
    // leaks in and auth "derives" 9 instead of the correct default of 1.
    args.sharedValuesText = args.sharedValuesText.replace(
      /^environment:\n {2}auth:\n/m,
      'environment:\n  auth:\n    replicaCount: 9\n',
    );
    const list = deriveScaleUpList(args);
    expect(list.find((e) => e.name === 'supabase-supabase-auth')?.replicas).toBe(1);
  });

  it('finds a replicaCount override buried behind several preceding lines in the deployment: block', () => {
    const args = real();
    args.sharedValuesText = args.sharedValuesText.replace(
      /^deployment:\n/m,
      'deployment:\n' +
        '  auth:\n' +
        '    # first a comment\n' +
        '    enabled: true\n' +
        '    # then another comment\n' +
        '    nodeSelector:\n' +
        '      dedicated: supabase\n' +
        '    replicaCount: 3\n',
    );
    const list = deriveScaleUpList(args);
    expect(list.find((e) => e.name === 'supabase-supabase-auth')?.replicas).toBe(3);
  });
});

describe('deriveScaleUpList persistence-block isolation', () => {
  it('persistence keys never leak into the scale-up list (no dupes, no false comps)', () => {
    // The overlay now carries a `persistence:` map whose child keys (storage,
    // imgproxy, snippets) collide with deployment component names — the comp
    // scan must stay scoped to the overlay's `deployment:` block.
    const list = deriveScaleUpList(real());
    const names = list.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => n === 'supabase-supabase-storage')).toHaveLength(1);
    // `snippets` is a persistence key, NOT a deployment component
    expect(names).not.toContain('supabase-supabase-snippets');
  });
});
