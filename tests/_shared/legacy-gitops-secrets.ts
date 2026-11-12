/**
 * The cloud Secret the GitOps layer's deploy.yml wrote into every cluster
 * before the CLI took over handing the provider API token to it: the step
 * carbon/.github/workflows/deploy.yml carried, verbatim as of 9c32d9ce. It
 * had no provider condition, and `configure cicd` seeded the repo secret it
 * reads from the operator's HETZNER_API_TOKEN whatever the environment's
 * provider, so a DigitalOcean or Linode cluster a project layered GitOps
 * onto holds it too. The cloud-secrets census
 * (tests/unit/deploy/k8s-cloud-secrets.test.ts) checks
 * K8S_RETIRED_CLOUD_SECRETS against it beside the boot scripts' record
 * (./legacy-master-init-secrets.ts), the GitOps refusal's test
 * (tests/unit/deploy/gitops-provider-token.test.ts) puts it back into a
 * deploy.yml, and the Docker takeover test
 * (tests/integration/docker/k8s-cloud-secrets-takeover.test.ts) runs it. A
 * record of the past: never edit it.
 */

export const LEGACY_GITOPS_STEP = [
  '      - name: Apply kube-system/hcloud Secret (CCM + CSI)',
  '        env:',
  `          HETZNER_API_TOKEN: \${{ secrets.HETZNER_API_TOKEN }}`,
  `          HCLOUD_NETWORK_ID: \${{ vars.HCLOUD_NETWORK_ID }}`,
  '        run: |',
  '          kubectl create secret generic hcloud \\',
  '            --namespace=kube-system \\',
  '            --from-literal=token="$HETZNER_API_TOKEN" \\',
  '            --from-literal=network="$HCLOUD_NETWORK_ID" \\',
  '            --dry-run=client -o yaml \\',
  '          | kubectl apply --server-side --force-conflicts \\',
  '              --field-manager=github-actions-deploy -f -',
].join('\n');

export type LegacyGitopsSecret = {
  namespace: string;
  name: string;
  /** Each key and the GitHub expression its value came from, `secrets.X` or `vars.Y`. */
  keys: Record<string, string>;
  /** The step's `env:`, each variable to its GitHub expression. */
  env: Record<string, string>;
  /** The step's shell, as the runner ran it with `env` set. */
  run: string;
};

const ENV_LINE = /^ {10}(\w+): \$\{\{ ((?:secrets|vars)\.\w+) \}\}$/;
const CREATE =
  /kubectl create secret generic (\S+) --namespace=(\S+) ((?:--from-literal=\S+ )+)--dry-run=client -o yaml \| kubectl apply --server-side --force-conflicts --field-manager=github-actions-deploy -f -/;
const LITERAL = /--from-literal=([^=\s]+)="\$(\w+)"/g;

/**
 * The Secret the step writes, read out of it. A step this parser can't read
 * throws, so a reworded record fails loudly instead of vanishing from the
 * tests that read it.
 */
export function legacyGitopsSecrets(step: string = LEGACY_GITOPS_STEP): LegacyGitopsSecret[] {
  const lines = step.split('\n');
  const env: Record<string, string> = {};
  for (const line of lines.slice(lines.indexOf('        env:') + 1)) {
    const m = line.match(ENV_LINE);
    if (!m) break;
    env[m[1]] = m[2];
  }
  const runAt = lines.indexOf('        run: |');
  if (runAt < 0) throw new Error('the step has no `run: |` block');
  const run = lines
    .slice(runAt + 1)
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
  const flat = run.replace(/\s*\\\n\s*/g, ' ').trim();
  const m = flat.match(CREATE);
  if (!m || (run.match(/\bcreate secret\b/g)?.length ?? 0) !== 1) {
    throw new Error(`the step's shell is not one create secret | apply: ${flat}`);
  }
  const keys: Record<string, string> = {};
  for (const [, key, variable] of m[3].matchAll(LITERAL)) {
    if (!env[variable]) throw new Error(`--from-literal=${key} reads $${variable}, not in env:`);
    keys[key] = env[variable];
  }
  if (Object.keys(keys).length !== m[3].trim().split(' ').length) {
    throw new Error(`a --from-literal is not key="$VAR": ${m[3]}`);
  }
  return [{ namespace: m[2], name: m[1], keys, env, run }];
}
