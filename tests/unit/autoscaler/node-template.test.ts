import { join } from 'node:path';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { buildTemplateNode } from '../../../src/autoscaler/node-template.js';
// @ts-expect-error — JS module without types
import { PROTO_DIR } from '../../../src/autoscaler/proto.js';

type Quantity = { string: string };

function cpuMilli(q: Quantity): number {
  return q.string.endsWith('m') ? Number(q.string.slice(0, -1)) : Number(q.string) * 1000;
}

function memMi(q: Quantity): number {
  return Number(q.string.replace(/Mi$/, ''));
}

const baseGroup = {
  minSize: 0,
  maxSize: 5,
  serverType: 'cx23',
  region: 'nbg1',
  image: 'ubuntu-24.04',
  cloudInit: 'cloud-init-body',
  serverLabels: { 'cluster-autoscaler/node': 'worker-pool' },
  nodeLabels: { 'vibecarbon.io/pool': 'worker-pool' },
  taints: [{ key: 'dedicated', value: 'worker', effect: 'NoSchedule' }],
  podsPerNode: 110,
};

const baseSpecs = { cores: 2, memoryGb: 4, architecture: 'x86', disk: 40 };

describe('buildTemplateNode', () => {
  it('names the node <clusterName>-<groupId>-template', () => {
    const node = buildTemplateNode({
      groupId: 'worker-pool',
      group: baseGroup,
      specs: baseSpecs,
      clusterName: 'acme-prod',
    });
    expect(node.metadata.name).toBe('acme-prod-worker-pool-template');
  });

  it('pins Quantity nesting — {string: "..."} NEVER a bare number', () => {
    const node = buildTemplateNode({
      groupId: 'worker-pool',
      group: baseGroup,
      specs: baseSpecs,
      clusterName: 'acme-prod',
    });
    expect(node.status.capacity.cpu).toEqual({ string: '2' });
    expect(node.status.capacity.memory).toEqual({ string: '4096Mi' });
    expect(node.status.capacity.pods).toEqual({ string: '110' });
    expect(node.status.capacity['ephemeral-storage']).toBeDefined();
    expect(node.status.capacity['ephemeral-storage']).toEqual({ string: '30Gi' });
  });

  it('threads group.podsPerNode through verbatim (not hardcoded 110)', () => {
    const node = buildTemplateNode({
      groupId: 'worker-pool',
      group: { ...baseGroup, podsPerNode: 32 },
      specs: baseSpecs,
      clusterName: 'acme-prod',
    });
    expect(node.status.capacity.pods).toEqual({ string: '32' });
    expect(node.status.allocatable.pods).toEqual({ string: '32' });
  });

  it('pins millicpu formatting: whole cores format bare, sub-1000m reservation formats with an "m" suffix', () => {
    const node = buildTemplateNode({
      groupId: 'worker-pool',
      group: baseGroup,
      specs: baseSpecs,
      clusterName: 'acme-prod',
    });
    expect(node.status.capacity.cpu).toEqual({ string: '2' });
    expect(node.status.allocatable.cpu).toEqual({ string: '1900m' });
  });

  it('pins the exact reservation: -100m cpu, -768Mi memory, allocatable strictly < capacity', () => {
    const node = buildTemplateNode({
      groupId: 'worker-pool',
      group: baseGroup,
      specs: baseSpecs,
      clusterName: 'acme-prod',
    });
    const capCpu = cpuMilli(node.status.capacity.cpu);
    const allocCpu = cpuMilli(node.status.allocatable.cpu);
    const capMem = memMi(node.status.capacity.memory);
    const allocMem = memMi(node.status.allocatable.memory);

    expect(capCpu - allocCpu).toBe(100);
    expect(capMem - allocMem).toBe(768);
    expect(allocCpu).toBeLessThan(capCpu);
    expect(allocMem).toBeLessThan(capMem);
  });

  it('sets all six scheduling labels, merged with group.nodeLabels', () => {
    const node = buildTemplateNode({
      groupId: 'worker-pool',
      group: baseGroup,
      specs: baseSpecs,
      clusterName: 'acme-prod',
    });
    expect(node.metadata.labels).toEqual({
      'kubernetes.io/hostname': 'acme-prod-worker-pool-template',
      'kubernetes.io/arch': 'amd64',
      'kubernetes.io/os': 'linux',
      'node.kubernetes.io/instance-type': 'cx23',
      'topology.kubernetes.io/region': 'nbg1',
      'topology.kubernetes.io/zone': 'nbg1',
      'vibecarbon.io/pool': 'worker-pool',
    });
  });

  it('passes taints through verbatim', () => {
    const node = buildTemplateNode({
      groupId: 'worker-pool',
      group: baseGroup,
      specs: baseSpecs,
      clusterName: 'acme-prod',
    });
    expect(node.spec.taints).toEqual([{ key: 'dedicated', value: 'worker', effect: 'NoSchedule' }]);
    expect(node.spec.unschedulable).toBe(false);
  });

  it('defaults taints to [] when the group declares none', () => {
    const { taints, ...groupWithoutTaints } = baseGroup;
    const node = buildTemplateNode({
      groupId: 'worker-pool',
      group: groupWithoutTaints,
      specs: baseSpecs,
      clusterName: 'acme-prod',
    });
    expect(node.spec.taints).toEqual([]);
  });

  it('maps architecture "x86" -> "amd64" in both the label and nodeInfo', () => {
    const node = buildTemplateNode({
      groupId: 'worker-pool',
      group: baseGroup,
      specs: { ...baseSpecs, architecture: 'x86' },
      clusterName: 'acme-prod',
    });
    expect(node.metadata.labels['kubernetes.io/arch']).toBe('amd64');
    expect(node.status.nodeInfo.architecture).toBe('amd64');
  });

  it('maps architecture "arm" -> "arm64" in both the label and nodeInfo', () => {
    const node = buildTemplateNode({
      groupId: 'worker-pool',
      group: baseGroup,
      specs: { ...baseSpecs, architecture: 'arm' },
      clusterName: 'acme-prod',
    });
    expect(node.metadata.labels['kubernetes.io/arch']).toBe('arm64');
    expect(node.status.nodeInfo.architecture).toBe('arm64');
  });

  it('sets a True Ready condition so the template node looks schedulable', () => {
    const node = buildTemplateNode({
      groupId: 'worker-pool',
      group: baseGroup,
      specs: baseSpecs,
      clusterName: 'acme-prod',
    });
    expect(node.status.conditions).toEqual([
      { type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'template' },
    ]);
  });

  // ── THE ROUND-TRIP PIN — the wire-contract proof ──────────────────────
  // buildTemplateNode's output isn't just "shaped like" a k8s Node — it
  // MUST be a value the vendored k8s.io.api.core.v1.Node proto message can
  // actually verify/encode/decode, since CA calls apiv1.Node#Unmarshal on
  // the wire bytes (a real k8s-protobuf gogo unmarshal, not JSON). If
  // Type#verify() reports a shape problem here, the BUILDER is wrong —
  // never relax this test to work around a verify() failure.
  describe('round-trips through the vendored k8s.io.api.core.v1.Node proto', () => {
    function loadNodeType() {
      const root = new protobuf.Root();
      // generated.proto's import statements are all full `k8s.io/...`
      // paths (verified against every file in the vendored tree) —
      // resolve them against PROTO_DIR rather than protobufjs's default
      // origin-relative resolution, which would look for a nested
      // `k8s.io/api/core/v1/k8s.io/...` directory that doesn't exist.
      root.resolvePath = (origin: string, target: string) =>
        target.startsWith('k8s.io/')
          ? join(PROTO_DIR, target)
          : protobuf.util.path.resolve(origin, target);
      root.loadSync(join(PROTO_DIR, 'k8s.io/api/core/v1/generated.proto'), { keepCase: true });
      return root.lookupType('k8s.io.api.core.v1.Node');
    }

    it('verify() accepts the built node with no shape errors', () => {
      const NodeType = loadNodeType();
      const node = buildTemplateNode({
        groupId: 'worker-pool',
        group: baseGroup,
        specs: baseSpecs,
        clusterName: 'acme-prod',
      });
      expect(NodeType.verify(node)).toBeNull();
    });

    it('encode().finish() -> decode() preserves status.allocatable.pods.string and a label', () => {
      const NodeType = loadNodeType();
      const node = buildTemplateNode({
        groupId: 'worker-pool',
        group: baseGroup,
        specs: baseSpecs,
        clusterName: 'acme-prod',
      });
      expect(NodeType.verify(node)).toBeNull();

      const bytes = NodeType.encode(NodeType.create(node)).finish();
      const decoded = NodeType.decode(bytes);
      const roundTripped = NodeType.toObject(decoded, { longs: String }) as {
        status: { allocatable: { pods: Quantity } };
        metadata: { labels: Record<string, string> };
      };

      expect(roundTripped.status.allocatable.pods.string).toBe('110');
      expect(roundTripped.metadata.labels['node.kubernetes.io/instance-type']).toBe('cx23');
    });
  });
});
