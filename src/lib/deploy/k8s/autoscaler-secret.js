/**
 * The kube-system/carbon-autoscaler-config Secret the cluster autoscaler reads
 * its provider token and node-group config from, as YAML for `kubectl apply
 * -f -`. stringData with one JSON.stringify per key keeps each value on one
 * line, and stdin keeps the token and the config off argv. Deploy
 * (applyK3sManifests) and scale's bounds re-patch both write it.
 *
 * @param {{ token: string, configJson: string }} secret
 * @returns {string}
 */
export function carbonAutoscalerSecretYaml({ token, configJson }) {
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
    '',
  ].join('\n');
}
