import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReplicationOverlay, SOCAT_IMAGE_TAG } from '../../../src/lib/deploy/compose/ha.js';

/**
 * socat pin guard for the replication gateway.
 *
 * Both HA tiers relay Postgres replication over the WireGuard tunnel through
 * an `alpine/socat` container: compose via buildReplicationOverlay, k8s via
 * carbon/k8s/base/repl-gateway/repl-gateway.yaml. Both used to be untagged
 * (implicit :latest) with imagePullPolicy/pull behaviour that never re-pulls,
 * so each node froze on whatever :latest meant at its first pull and two nodes
 * in the same pair could run different socat builds.
 */

const K8S_MANIFEST = fileURLToPath(
  new URL('../../../carbon/k8s/base/repl-gateway/repl-gateway.yaml', import.meta.url),
);

function k8sSocatTag(): string {
  const m = readFileSync(K8S_MANIFEST, 'utf8').match(/image:\s*alpine\/socat:([^\s]+)/);
  if (!m) throw new Error('no pinned alpine/socat image found in repl-gateway.yaml');
  return m[1];
}

describe('replication gateway socat pin', () => {
  it('compose overlay pins an explicit socat tag', () => {
    const yaml = buildReplicationOverlay('10.10.0.1');
    expect(yaml).toContain(`image: alpine/socat:${SOCAT_IMAGE_TAG}`);
    // Never the bare/implicit-latest form that caused the drift.
    expect(yaml).not.toMatch(/image:\s*alpine\/socat\s*$/m);
  });

  it('k8s repl-gateway pins an explicit socat tag', () => {
    expect(k8sSocatTag()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('compose and k8s tiers agree on one socat version', () => {
    expect(k8sSocatTag()).toBe(SOCAT_IMAGE_TAG);
  });
});
