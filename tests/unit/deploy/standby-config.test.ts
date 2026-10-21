/**
 * Task 7: derive the pilot-light failover scale-up list from what deploy
 * ACTUALLY renders, replacing a former hardcoded failover deployment list.
 *
 * A pilot-light standby runs its db StatefulSet (streaming from the primary)
 * and nothing app-tier: the deploy zeroes the app Deployment and the
 * cluster-autoscaler waits at 0. So `vibecarbon failover` brings up exactly
 * those two, the app at the replica count its own manifest declares; the db
 * is already running and never belongs in the list.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deriveScaleUpList,
  failoverAddonManifests,
} from '../../../src/lib/deploy/k8s/standby-config.js';

const appManifestText = readFileSync(
  join(__dirname, '../../../carbon/k8s/base/app/deployment.yaml'),
  'utf-8',
);

describe('deriveScaleUpList', () => {
  it('brings up the app at its manifest replica count, then the autoscaler', () => {
    expect(deriveScaleUpList({ appManifestText })).toEqual([
      { name: 'app', namespace: 'vibecarbon', replicas: 2 },
      { name: 'cluster-autoscaler', namespace: 'kube-system', replicas: 1 },
    ]);
  });

  it('follows the manifest when its replica count changes', () => {
    const list = deriveScaleUpList({
      appManifestText: appManifestText.replace(/^(\s*)replicas:\s*\d+/m, '$1replicas: 4'),
    });
    expect(list[0]).toEqual({ name: 'app', namespace: 'vibecarbon', replicas: 4 });
  });

  it('never lists the db: it is a StatefulSet that is already running on the standby', () => {
    const names = deriveScaleUpList({ appManifestText }).map((e) => e.name);
    expect(names).not.toContain('db');
  });

  it('with no add-ons the list is unchanged (an empty add-on list is the same)', () => {
    expect(deriveScaleUpList({ appManifestText, addons: [] })).toEqual(
      deriveScaleUpList({ appManifestText }),
    );
  });

  it('lists each add-on after the app at its manifest replica count, the autoscaler last', () => {
    const manifest = (name: string) =>
      readFileSync(join(__dirname, `../../../services/${name}/k8s/deployment.yaml`), 'utf-8');
    const list = deriveScaleUpList({
      appManifestText,
      addons: [
        { name: 'redis', namespace: 'vibecarbon', manifestText: manifest('redis') },
        {
          name: 'n8n',
          namespace: 'vibecarbon',
          manifestText: manifest('n8n').replace(/^(\s*)replicas:\s*\d+/m, '$1replicas: 3'),
        },
        { name: 'metabase', namespace: 'vibecarbon', manifestText: 'kind: Deployment\n' },
      ],
    });
    expect(list).toEqual([
      { name: 'app', namespace: 'vibecarbon', replicas: 2 },
      { name: 'redis', namespace: 'vibecarbon', replicas: 1, addon: true },
      { name: 'n8n', namespace: 'vibecarbon', replicas: 3, addon: true },
      // No replicas line: one, the Deployment default.
      { name: 'metabase', namespace: 'vibecarbon', replicas: 1, addon: true },
      { name: 'cluster-autoscaler', namespace: 'kube-system', replicas: 1 },
    ]);
  });
});

describe('failoverAddonManifests', () => {
  const withProject = (addons: Record<string, string | null>, fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-scaleup-'));
    try {
      for (const [name, deployment] of Object.entries(addons)) {
        mkdirSync(join(dir, 'k8s', 'base', name), { recursive: true });
        writeFileSync(join(dir, 'k8s', 'base', name, 'kustomization.yaml'), 'kind: x\n');
        if (deployment !== null) {
          writeFileSync(join(dir, 'k8s', 'base', name, 'deployment.yaml'), deployment);
        }
      }
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('one entry per app-namespace add-on Deployment, observability left out', () => {
    withProject(
      {
        observability: null,
        n8n: 'spec:\n  replicas: 1\n',
        redis: 'spec:\n  replicas: 1\n',
      },
      (dir) => {
        const entries = failoverAddonManifests(dir);
        expect(entries.map((e) => [e.name, e.namespace])).toEqual([
          ['n8n', 'vibecarbon'],
          ['redis', 'vibecarbon'],
        ]);
        expect(deriveScaleUpList({ appManifestText, addons: entries }).map((e) => e.name)).toEqual([
          'app',
          'n8n',
          'redis',
          'cluster-autoscaler',
        ]);
      },
    );
  });

  it('a missing add-on manifest fails naming the add-on, not a raw ENOENT', () => {
    withProject({ metabase: null }, (dir) => {
      expect(() => failoverAddonManifests(dir)).toThrow(
        /the metabase add-on has no k8s\/base\/metabase\/deployment\.yaml/,
      );
    });
  });

  it('no add-on deployed: no entries', () => {
    withProject({}, (dir) => expect(failoverAddonManifests(dir)).toEqual([]));
  });
});
