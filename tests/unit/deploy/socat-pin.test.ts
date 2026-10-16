import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReplicationOverlay, SOCAT_IMAGE } from '../../../src/lib/deploy/compose/ha.js';

/**
 * socat pin guard for the replication gateway.
 *
 * Both HA tiers relay Postgres replication over the WireGuard tunnel through
 * an `alpine/socat` container: compose via buildReplicationOverlay, k8s via
 * carbon/k8s/base/repl-gateway/repl-gateway.yaml. Both used to be untagged
 * (implicit :latest) with imagePullPolicy/pull behaviour that never re-pulls,
 * so each node froze on whatever :latest meant at its first pull and two nodes
 * in the same pair could run different socat builds. Both now pin the same
 * tag AND multi-arch index digest.
 */

const K8S_MANIFEST = fileURLToPath(
  new URL('../../../carbon/k8s/base/repl-gateway/repl-gateway.yaml', import.meta.url),
);

function k8sSocatRef(): string {
  const m = readFileSync(K8S_MANIFEST, 'utf8').match(/image:\s*(alpine\/socat:[^\s]+)/);
  if (!m) throw new Error('no pinned alpine/socat image found in repl-gateway.yaml');
  return m[1];
}

const PINNED_SOCAT = /^alpine\/socat:\d+\.\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/;

describe('replication gateway socat pin', () => {
  it('compose overlay pins an explicit socat tag and digest', () => {
    const yaml = buildReplicationOverlay('10.10.0.1');
    expect(SOCAT_IMAGE).toMatch(PINNED_SOCAT);
    expect(yaml).toContain(`image: ${SOCAT_IMAGE}`);
    // Never the bare/implicit-latest form that caused the drift.
    expect(yaml).not.toMatch(/image:\s*alpine\/socat\s*$/m);
  });

  it('k8s repl-gateway pins an explicit socat tag and digest', () => {
    expect(k8sSocatRef()).toMatch(PINNED_SOCAT);
  });

  it('compose and k8s tiers agree on one socat ref', () => {
    expect(k8sSocatRef()).toBe(SOCAT_IMAGE);
  });
});
