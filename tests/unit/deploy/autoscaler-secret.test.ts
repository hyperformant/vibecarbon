import { describe, expect, it } from 'vitest';
import { carbonAutoscalerSecretYaml } from '../../../src/lib/deploy/k8s/autoscaler-secret.js';
import { readRepoFile } from '../../_shared/source-files.js';

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

  it("writes each of the provider's autoscaler env entries as its own key, one line each, after config.json", () => {
    const configJson = '{"nodeGroups":{}}';
    const yaml = carbonAutoscalerSecretYaml({
      token: 'tok',
      configJson,
      env: { SCALEWAY_DEFAULT_PROJECT_ID: '11111111-2222-3333-4444-555555555555', OTHER_ID: 'a"b' },
    });
    expect(yaml).toBe(
      [
        'apiVersion: v1',
        'kind: Secret',
        'metadata:',
        '  name: carbon-autoscaler-config',
        '  namespace: kube-system',
        'type: Opaque',
        'stringData:',
        '  token: "tok"',
        `  config.json: ${JSON.stringify(configJson)}`,
        '  SCALEWAY_DEFAULT_PROJECT_ID: "11111111-2222-3333-4444-555555555555"',
        '  OTHER_ID: "a\\"b"',
        '',
      ].join('\n'),
    );
  });

  it('with no env, or an empty one, is byte-identical to the two-key Secret', () => {
    const args = { token: 'tok', configJson: '{"a":1}' };
    const twoKeys = [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      '  name: carbon-autoscaler-config',
      '  namespace: kube-system',
      'type: Opaque',
      'stringData:',
      '  token: "tok"',
      `  config.json: ${JSON.stringify('{"a":1}')}`,
      '',
    ].join('\n');
    expect(carbonAutoscalerSecretYaml(args)).toBe(twoKeys);
    expect(carbonAutoscalerSecretYaml({ ...args, env: {} })).toBe(twoKeys);
  });

  it('both writers build it here: deploy and the scale re-patch', async () => {
    for (const f of ['src/lib/deploy/k8s/k3s.js', 'src/scale.js']) {
      const src = readRepoFile(`${f}`);
      expect(src, f).toContain('carbonAutoscalerSecretYaml({');
      expect(src, f).not.toContain("'  name: carbon-autoscaler-config',");
    }
  });
});
