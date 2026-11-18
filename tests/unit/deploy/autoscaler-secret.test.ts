import { describe, expect, it } from 'vitest';
import { carbonAutoscalerSecretYaml } from '../../../src/lib/deploy/k8s/autoscaler-secret.js';

describe('carbonAutoscalerSecretYaml', () => {
  it('is the kube-system Secret with each value JSON-quoted on its own line', () => {
    const configJson = JSON.stringify({ nodeGroups: [{ name: 'worker-pool' }] }, null, 2);
    expect(carbonAutoscalerSecretYaml({ token: 't"k', configJson })).toBe(
      [
        'apiVersion: v1',
        'kind: Secret',
        'metadata:',
        '  name: carbon-autoscaler-config',
        '  namespace: kube-system',
        'type: Opaque',
        'stringData:',
        '  token: "t\\"k"',
        `  config.json: ${JSON.stringify(configJson)}`,
        '',
      ].join('\n'),
    );
  });

  it('both writers build it here: deploy and the scale re-patch', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['src/lib/deploy/k8s/k3s.js', 'src/scale.js']) {
      const src = readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8');
      expect(src, f).toContain('carbonAutoscalerSecretYaml({');
      expect(src, f).not.toContain("'  name: carbon-autoscaler-config',");
    }
  });
});
