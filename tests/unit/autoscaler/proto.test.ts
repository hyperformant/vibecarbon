import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { loadExternalGrpcDefinition } from '../../../src/autoscaler/proto.js';

describe('externalgrpc proto vendoring', () => {
  it('loads and exposes all 15 CloudProvider RPCs', () => {
    const { CloudProvider } = loadExternalGrpcDefinition();
    const methods = Object.keys(CloudProvider.service);
    for (const rpc of [
      'NodeGroups',
      'NodeGroupForNode',
      'PricingNodePrice',
      'PricingPodPrice',
      'GPULabel',
      'GetAvailableGPUTypes',
      'Cleanup',
      'Refresh',
      'NodeGroupTargetSize',
      'NodeGroupIncreaseSize',
      'NodeGroupDeleteNodes',
      'NodeGroupDecreaseTargetSize',
      'NodeGroupNodes',
      'NodeGroupTemplateNodeInfo',
      'NodeGroupGetOptions',
    ])
      expect(methods).toContain(rpc);
    expect(methods).toHaveLength(15);
  });

  it('is the <=1.34 contract: TemplateNodeInfo response embeds nodeInfo (no nodeBytes)', () => {
    const { CloudProvider } = loadExternalGrpcDefinition();
    const respType = CloudProvider.service.NodeGroupTemplateNodeInfo.responseType.type;
    const fieldNames = respType.field.map((f: { name: string }) => f.name);
    expect(fieldNames).toContain('nodeInfo');
    expect(fieldNames).not.toContain('nodeBytes');
  });
});
