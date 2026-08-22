/**
 * carbon-autoscaler TemplateNodeInfo builder — synthesizes the
 * `v1.Node` object CA's `NodeGroupTemplateNodeInfo` RPC returns for a
 * node group at 0 nodes (scale-from-zero) and "upcoming node" scheduling
 * simulation. The proto-loader vendored contract at CA v1.32.7 (see
 * proto.js) embeds this as the response's `nodeInfo` field and serializes
 * it as k8s-protobuf on the wire — we hand back a plain JS object shaped
 * to the vendored `k8s.io.api.core.v1.Node` message and let proto-loader
 * do the encoding; we never hand-encode bytes ourselves (that's only
 * required at CA >=1.35's `nodeBytes` contract, which this repo doesn't
 * target — see m2-dossier-externalgrpc.md §3).
 *
 * Getting this wrong is the highest-risk failure mode in the whole
 * effort: a missing `pods` resource, wrong labels, or capacity that
 * doesn't net out kubelet/system reservation makes CA conclude nothing
 * can ever schedule on a fresh node in the group, so scale-up silently
 * never fires (see m2-dossier-externalgrpc.md §4, §8).
 */

/**
 * Build the TemplateNodeInfo `v1.Node` payload for one node group.
 *
 * @param {object} args
 * @param {string} args.groupId - Node group name (config.js's `nodeGroups` key).
 * @param {object} args.group - The group's config document (config.js's
 *   `validateNodeGroup` shape: serverType, region, podsPerNode, nodeLabels,
 *   taints, ...).
 * @param {{cores: number, memoryGb: number, architecture: string, disk?: number}} args.specs
 *   - Live server-type specs, as returned by `provider.getServerType(group.serverType)`.
 * @param {string} args.clusterName
 * @returns {object} A plain object matching the vendored
 *   `k8s.io.api.core.v1.Node` proto shape.
 */
export function buildTemplateNode({ groupId, group, specs, clusterName }) {
  const name = `${clusterName}-${groupId}-template`;
  // Allocatable heuristic: reserve 100m CPU + 768Mi memory for kubelet/system/eviction.
  // Documented tradeoff: conservative enough that scheduled-on-template pods always fit reality.
  const memMi = Math.round(specs.memoryGb * 1024);
  const quantity = (s) => ({ string: String(s) }); // resource.Quantity is {string: "..."} — NEVER a bare number
  const resources = (cpuMilli, mi) => ({
    cpu: quantity(cpuMilli % 1000 === 0 ? cpuMilli / 1000 : `${cpuMilli}m`),
    memory: quantity(`${mi}Mi`),
    pods: quantity(String(group.podsPerNode)), // MISSING pods == scale-up never fires
    'ephemeral-storage': quantity(`${Math.max(10, (specs.disk ?? 40) - 10)}Gi`),
  });
  return {
    metadata: {
      name,
      labels: {
        'kubernetes.io/hostname': name,
        'kubernetes.io/arch': specs.architecture === 'arm' ? 'arm64' : 'amd64',
        'kubernetes.io/os': 'linux',
        'node.kubernetes.io/instance-type': group.serverType,
        'topology.kubernetes.io/region': group.region,
        'topology.kubernetes.io/zone': group.region,
        ...group.nodeLabels,
      },
    },
    spec: { taints: group.taints ?? [], unschedulable: false },
    status: {
      capacity: resources(specs.cores * 1000, memMi),
      allocatable: resources(specs.cores * 1000 - 100, memMi - 768),
      conditions: [{ type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'template' }],
      nodeInfo: {
        architecture: specs.architecture === 'arm' ? 'arm64' : 'amd64',
        operatingSystem: 'linux',
        kubeletVersion: '',
        kubeProxyVersion: '',
        machineID: '',
        systemUUID: '',
        bootID: '',
        kernelVersion: '',
        osImage: '',
        containerRuntimeVersion: '',
      },
    },
  };
}
