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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveScaleUpList } from '../../../src/lib/deploy/k8s/standby-config.js';

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
});
