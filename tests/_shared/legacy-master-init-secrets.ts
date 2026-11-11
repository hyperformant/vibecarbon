/**
 * The cloud Secrets a k8s master's boot script created before the CLI took
 * over handing the provider API token to the cluster: each provider's
 * `kubectl create secret generic ... | kubectl apply -f -` lines, verbatim
 * from carbon/cloud-init/k3s/ as of 94ae8656. Every cluster an earlier
 * vibecarbon made still holds what they created, so the cloud-secrets census
 * (tests/unit/deploy/k8s-cloud-secrets.test.ts) checks
 * K8S_RETIRED_CLOUD_SECRETS against them, and the Docker takeover test
 * (tests/integration/docker/k8s-cloud-secrets-takeover.test.ts) runs them to
 * make such a master. Read them with masterInitSecrets
 * (./master-init-secrets.ts). A record of the past: never edit it.
 */

export const LEGACY_MASTER_INIT_SECRETS: Record<string, string> = {
  hetzner: [
    'kubectl -n kube-system create secret generic hcloud \\',
    `  --from-literal=token="\${hcloud_token}" \\`,
    `  --from-literal=network="\${network_id}" \\`,
    '  --dry-run=client -o yaml | kubectl apply -f -',
    '',
    'kubectl -n kube-system create secret generic hcloud-csi \\',
    `  --from-literal=token="\${hcloud_token}" \\`,
    '  --dry-run=client -o yaml | kubectl apply -f -',
  ].join('\n'),
  digitalocean: [
    'kubectl -n kube-system create secret generic digitalocean \\',
    `  --from-literal=access-token="\${do_token}" \\`,
    '  --dry-run=client -o yaml | kubectl apply -f -',
  ].join('\n'),
  linode: [
    'kubectl -n kube-system create secret generic linode \\',
    `  --from-literal=token="\${linode_token}" \\`,
    '  --dry-run=client -o yaml | kubectl apply -f -',
  ].join('\n'),
};
