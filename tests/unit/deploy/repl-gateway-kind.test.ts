/**
 * The k8s repl-gateway is a Deployment (HA-correctness Task 7, H5).
 *
 * It used to be a bare Pod. Nothing recreates a bare Pod: a node drain or an
 * eviction removed it for good and replication stopped until the next deploy,
 * and its immutable spec forced a delete-and-recreate on every role-swapped
 * redeploy. A one-replica Deployment is recreated by its controller and takes
 * a changed relay direction through a plain `kubectl apply`.
 *
 * What must not change with it: `hostNetwork: true` and the primary's relay to
 * 127.0.0.1:5433. Security #234 bound the db hostPort to loopback
 * (buildDbHostPortPatch), and this hostNetwork gateway is its only consumer.
 * `strategy: Recreate`, because two hostNetwork socat relays on one node cannot
 * both bind the gateway port, so a surge pod would crash-loop.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  REPL_GATEWAY_APPLY_SHELL,
  renderReplGatewayManifest,
} from '../../../src/lib/deploy/k8s/ha/index.js';

const ROOT = join(__dirname, '../../..');
const MANIFEST = readFileSync(
  join(ROOT, 'carbon/k8s/base/repl-gateway/repl-gateway.yaml'),
  'utf-8',
);
const SRC = readFileSync(join(ROOT, 'src/lib/deploy/k8s/ha/index.js'), 'utf-8');

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;
const docs = (text: string) => (loadAll(text) as Doc[]).filter(Boolean);
const gateway = (text: string) => docs(text).find((d) => d.metadata?.name === 'repl-gateway');

describe('repl-gateway manifest: a one-replica Deployment', () => {
  it('is a Deployment with one replica, never a bare Pod', () => {
    const gw = gateway(MANIFEST);
    expect(gw.kind).toBe('Deployment');
    expect(gw.spec.replicas).toBe(1);
    expect(docs(MANIFEST).some((d) => d.kind === 'Pod')).toBe(false);
  });

  it('recreates rather than surges: two relays on one node cannot share the port', () => {
    expect(gateway(MANIFEST).spec.strategy).toEqual({ type: 'Recreate' });
  });

  it('its selector matches its pod template', () => {
    const gw = gateway(MANIFEST);
    expect(gw.spec.selector.matchLabels).toEqual({ app: 'repl-gateway' });
    expect(gw.spec.template.metadata.labels).toMatchObject(gw.spec.selector.matchLabels);
  });

  it('keeps the pod spec: hostNetwork, pinned to the db node, socat relay', () => {
    const pod = gateway(MANIFEST).spec.template.spec;
    expect(pod.hostNetwork).toBe(true);
    expect(pod.nodeSelector).toEqual({ dedicated: 'db' });
    expect(pod.tolerations).toContainEqual(
      expect.objectContaining({ key: 'dedicated', value: 'db', effect: 'NoSchedule' }),
    );
    expect(pod.containers[0].args).toEqual(['__RELAY_LISTEN__', '__RELAY_TARGET__']);
  });

  it('the rendered primary relays to the loopback-bound db hostPort', () => {
    const out = gateway(
      renderReplGatewayManifest({ template: MANIFEST, role: 'primary', nodePrivateIp: '10.0.1.2' }),
    );
    expect(out.kind).toBe('Deployment');
    expect(out.spec.template.spec.containers[0].args[1]).toBe('TCP:127.0.0.1:5433');
  });
});

describe('repl-gateway apply: the controller replaces pods; the CLI deletes only the legacy bare Pod', () => {
  it('no immutability fallback is left in the apply path', () => {
    expect(SRC).not.toMatch(/Forbidden: pod updates may not change fields/);
  });

  // Final review M6: a cluster deployed before the Deployment shipped still
  // runs the bare hostNetwork Pod, which holds the gateway port, so the new
  // Deployment pod would crash-loop beside it. Deployment pods have hashed
  // names, so this delete only ever matches that Pod.
  it('every apply removes the legacy bare Pod first, by its exact name, ignoring not-found', () => {
    expect(REPL_GATEWAY_APPLY_SHELL).toBe(
      'kubectl delete pod repl-gateway -n vibecarbon --ignore-not-found >/dev/null && kubectl apply -f -',
    );
    // Both apply paths (deploy bring-up, post-resize re-establish) use it, and
    // no other gateway apply or delete is spelled anywhere.
    expect(SRC.match(/REPL_GATEWAY_APPLY_SHELL\]/g)).toHaveLength(2);
    expect(SRC.match(/delete pod repl-gateway/g)).toHaveLength(1);
    expect(SRC).not.toMatch(/'kubectl apply -f -'/);
  });

  it('the post-resize bounce restarts the Deployment', () => {
    expect(SRC).toContain('rollout restart deployment/repl-gateway -n vibecarbon');
  });
});
