/**
 * The kube-system/carbon-autoscaler-config Secret the cluster autoscaler reads
 * its provider token and node-group config from, as YAML for `kubectl apply
 * -f -`. stringData with one JSON.stringify per key keeps each value on one
 * line, and stdin keeps the token and the config off argv. Deploy
 * (applyK3sManifests) and scale's bounds re-patch both write it, each with
 * the provider's `k8sAutoscalerEnv()`: both apply client-side, so a write
 * without one of those keys would delete it.
 *
 * @param {{ token: string, configJson: string, env?: Record<string, string> }} secret
 *   env: the operator variables the in-cluster provider reads besides the
 *   token, each written under its own name after config.json
 *   (BaseProvider.k8sAutoscalerEnv)
 * @returns {string}
 */
export function carbonAutoscalerSecretYaml({ token, configJson, env = {} }) {
  return [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    '  name: carbon-autoscaler-config',
    '  namespace: kube-system',
    'type: Opaque',
    'stringData:',
    `  token: ${JSON.stringify(token)}`,
    `  config.json: ${JSON.stringify(configJson)}`,
    ...Object.entries(env).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`),
    '',
  ].join('\n');
}
