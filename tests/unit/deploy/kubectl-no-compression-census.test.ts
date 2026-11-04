/**
 * Census: every kubectl and helm the operator runs reads a kubeconfig that
 * carries `disable-compression: true` (src/lib/kubeconfig.js says
 * why: gzip on the API's large responses cost the tor1 standby tens of
 * seconds per deploy).
 *
 * ONE mechanism, the kubeconfig field, never a `--disable-compression` flag:
 * the field reaches every client that reads the file (kubectl, helm, the
 * operator's own kubectl inside `vibecarbon shell`, the GitOps runner), where
 * a flag reaches only the call sites that remember it, and helm has none.
 *
 * Why the arms below prove it for every spawn, present and future:
 *   (a) the cluster's credentials leave the master in exactly one place,
 *       fetchKubeconfig, which stores them through storeOperatorKubeconfig
 *       (the field is written there);
 *   (b) the file they land in is named only by kubeconfig.js, whose
 *       localKubeconfigPath upgrades a kubeconfig an older CLI wrote before
 *       returning its path; a resumed deploy's stored path goes through
 *       upgradeKubeconfig; nothing reads an ambient KUBECONFIG;
 *   so an operator-side kubectl has no kubeconfig to read but one that
 *   carries the field. (c) is the inventory: every file that spawns kubectl or
 *   helm is listed with the side it runs on and where its kubeconfig comes
 *   from, so a new spawner is reviewed against the rule the day it appears.
 *   Master-side kubectl (ssh, the master's own loopback k3s.yaml) never
 *   crosses the operator's network path, so it needs nothing.
 *   (d) the GitOps workflow sets the field on the kubeconfig every job
 *   decodes, which also covers a secret an older CLI uploaded.
 * Each detector is bitten by a synthetic source below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MODULE = 'src/lib/kubeconfig.js';
const K3S = 'src/lib/deploy/k8s/k3s.js';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js') || full.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const SRC = walk(join(ROOT, 'src')).map((f) => ({
  file: relative(ROOT, f),
  text: readFileSync(f, 'utf-8'),
}));

/** Source text containing template placeholders, written as `#{...}`. */
const tpl = (s: string) => s.replaceAll('#{', '$' + '{');

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
const codeLines = (text: string) =>
  text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !isComment(line));

/** The body of `export async function <name>(` up to the next top-level `}`. */
function fnBody(text: string, name: string): string {
  const start = text.indexOf(`export async function ${name}(`);
  if (start < 0) return '';
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end < 0 ? undefined : end);
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

const K3S_YAML = '/etc/rancher/k3s/k3s.yaml';
/** Master-side use: `KUBECONFIG=/etc/rancher/k3s/k3s.yaml` in a remote shell, or the ssh.js const. */
const MASTER_SIDE_K3S_YAML = /KUBECONFIG\s*=\s*['"]?\/etc\/rancher\/k3s\/k3s\.yaml/;

/** (a) Lines that move the master's k3s.yaml anywhere but fetchKubeconfig's scp. */
function credentialCopies(file: string, text: string): string[] {
  const fetchBody = file === K3S ? fnBody(text, 'fetchKubeconfig') : '';
  return codeLines(text)
    .filter(({ line }) => line.includes(K3S_YAML) && !MASTER_SIDE_K3S_YAML.test(line))
    .filter(({ line }) => !(fetchBody.includes(line) && line.includes(`:${K3S_YAML}`)))
    .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
}

/** (b) A string or template that starts the `kubeconfig-<stack>` file name. */
const KUBECONFIG_NAME = /[`'"]kubeconfig-/;
function kubeconfigNames(file: string, text: string): string[] {
  if (file === MODULE) return [];
  return codeLines(text)
    .filter(({ line }) => KUBECONFIG_NAME.test(line))
    .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
}

/** (b) A stored kubeconfig path read back without the upgrade, or an ambient KUBECONFIG. */
function unUpgradedReads(file: string, text: string): string[] {
  return codeLines(text)
    .filter(
      ({ line }) =>
        (line.includes("getStepResult('k3s-kubeconfig')") &&
          !line.includes('upgradeKubeconfig(')) ||
        /process\.env\.KUBECONFIG\b|process\.env\[['"]KUBECONFIG['"]\]/.test(line),
    )
    .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
}

/** (c) An argv element or spawn target `kubectl`/`helm`, or a local shell's `kubectl --kubeconfig`. */
const SPAWN = /(['"`])(kubectl|helm)\1\s*[,)\]]|kubectl\s+--kubeconfig\b/;
function spawnsKubeClient(text: string): boolean {
  return codeLines(text).some(({ line }) => SPAWN.test(line));
}

/** (d) Workflow `run:` blocks that decode the kubeconfig secret without setting the field. */
function workflowGaps(text: string): string[] {
  const blocks = text.split(/\n(?=\s*- name: )/);
  return blocks
    .filter((b) => /base64 -d > "\$KUBECONFIG"/.test(b))
    .filter(
      (b) => !/kubectl config set "clusters\.\$\{cluster\}\.disable-compression" true/.test(b),
    )
    .map((b) => b.trim().split('\n')[0]);
}

// ---------------------------------------------------------------------------
// (c) The inventory
// ---------------------------------------------------------------------------

type Spawner = { side: 'operator' | 'master'; resolves?: true; kubeconfig: string };

const SPAWNERS: Record<string, Spawner> = {
  'src/lib/deploy/k8s/k3s.js': {
    side: 'operator',
    resolves: true,
    kubeconfig:
      "KUBECONFIG is the kubeconfig fetchKubeconfig wrote, or a resumed run's stored path " +
      'through upgradeKubeconfig; helm (the DNS-01 webhook) runs with the same env; ' +
      '`kubectl version --client` contacts no cluster',
  },
  'src/lib/deploy/orchestrator.js': {
    side: 'operator',
    resolves: true,
    kubeconfig: 'resolveKubeconfigPath, built on localKubeconfigPath',
  },
  'src/scale.js': { side: 'operator', resolves: true, kubeconfig: 'localKubeconfigPath' },
  'src/destroy.js': { side: 'operator', resolves: true, kubeconfig: 'localKubeconfigPath' },
  'src/diagnose.js': { side: 'operator', resolves: true, kubeconfig: 'localKubeconfigPath' },
  'src/lib/csi-volumes.js': {
    side: 'operator',
    kubeconfig: 'the path destroy.js resolved through localKubeconfigPath',
  },
  'src/lib/deploy/k8s/readiness.js': {
    side: 'operator',
    kubeconfig: "its caller's env (k3s.js); failover passes an exec that runs over ssh",
  },
  'src/lib/deploy/k8s/tls-restore.js': {
    side: 'operator',
    kubeconfig: "its caller's env (k3s.js, orchestrator.js); failover uses its ssh runner",
  },
  'src/lib/deploy/k8s/mirror-pull-diagnosis.js': {
    side: 'operator',
    kubeconfig: 'an argv k3s.js runs with its own env',
  },
  'src/lib/deploy/k8s/ha/index.js': {
    side: 'master',
    kubeconfig: 'argv joined into an ssh command: runs on the master against its loopback k3s.yaml',
  },
  'src/lib/ssh.js': {
    side: 'master',
    kubeconfig:
      'sshKubectl and the k3s ssh runner: KUBECONFIG=/etc/rancher/k3s/k3s.yaml on the master',
  },
};

// ---------------------------------------------------------------------------

describe('kubectl/helm read a kubeconfig with compression off', () => {
  it('sanity: the walk sees src/', () => {
    expect(SRC.length).toBeGreaterThan(100);
    expect(SRC.some((s) => s.file === MODULE)).toBe(true);
  });

  it('(a) the master k3s.yaml leaves the server only through fetchKubeconfig, which stores the field', () => {
    const offenders = SRC.flatMap(({ file, text }) => credentialCopies(file, text));
    expect(
      offenders,
      'copy the cluster credentials only through fetchKubeconfig (it writes disable-compression)',
    ).toEqual([]);
    const k3s = SRC.find((s) => s.file === K3S)?.text ?? '';
    const body = fnBody(k3s, 'fetchKubeconfig');
    expect(body).toContain(`root@\${masterIp}:${K3S_YAML}`);
    expect(body).toContain('storeOperatorKubeconfig(localPath, masterIp)');
    expect(body).not.toMatch(/writeFileSync\(/);
  });

  it('(b) only kubeconfig.js names the kubeconfig file; stored paths are upgraded; no ambient KUBECONFIG', () => {
    const named = SRC.flatMap(({ file, text }) => kubeconfigNames(file, text));
    expect(named, 'resolve the kubeconfig path through localKubeconfigPath').toEqual([]);
    const reads = SRC.flatMap(({ file, text }) => unUpgradedReads(file, text));
    expect(reads, 'a stored kubeconfig path goes through upgradeKubeconfig').toEqual([]);
    const mod = SRC.find((s) => s.file === MODULE)?.text ?? '';
    expect(mod).toMatch(
      /export function localKubeconfigPath\([^)]*\) \{\n\s*return upgradeKubeconfig\(join\(/,
    );
  });

  it('(c) every file that spawns kubectl or helm is in the inventory, and nothing stale is', () => {
    const spawners = SRC.filter(({ text }) => spawnsKubeClient(text)).map((s) => s.file);
    const unlisted = spawners.filter((f) => !(f in SPAWNERS));
    expect(
      unlisted,
      'a new kubectl/helm spawner: run it against a kubeconfig from localKubeconfigPath ' +
        '(or over ssh on the master), then list it in SPAWNERS with where its kubeconfig comes from',
    ).toEqual([]);
    expect(Object.keys(SPAWNERS).filter((f) => !spawners.includes(f))).toEqual([]);
  });

  it('(c) an operator file that finds its own kubeconfig imports it from kubeconfig.js', () => {
    for (const [file, spawner] of Object.entries(SPAWNERS)) {
      if (!spawner.resolves) continue;
      const text = SRC.find((s) => s.file === file)?.text ?? '';
      expect(text, file).toMatch(
        /import \{[^}]*\b(localKubeconfigPath|upgradeKubeconfig)\b[^}]*\} from '[./a-z0-9-]*kubeconfig\.js'/,
      );
    }
  });

  it('(d) every GitOps job that decodes the kubeconfig secret sets the field', () => {
    const wf = readFileSync(join(ROOT, 'carbon/.github/workflows/deploy.yml'), 'utf-8');
    expect(wf.match(/base64 -d > "\$KUBECONFIG"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(workflowGaps(wf)).toEqual([]);
  });
});

describe('the census detectors bite', () => {
  it('(a) flags a second copy of the master k3s.yaml', () => {
    const src = [
      "await runCommandAsync(['ssh', host, 'cat /etc/rancher/k3s/k3s.yaml']);",
      tpl('await scpWithRetry([`root@#{ip}:/etc/rancher/k3s/k3s.yaml`, out]);'),
      'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml',
      "const K3S_KUBECONFIG = '/etc/rancher/k3s/k3s.yaml';",
    ].join('\n');
    expect(credentialCopies('src/lib/other.js', src)).toHaveLength(2);
    // The same scp line outside fetchKubeconfig, in k3s.js, is flagged too.
    const k3s = `export async function other() {\n  scp(\`root@\${ip}:${K3S_YAML}\`);\n}\n`;
    expect(credentialCopies(K3S, k3s)).toHaveLength(1);
  });

  it('(b) flags a hand-built kubeconfig path, a raw stored path and an ambient KUBECONFIG', () => {
    const src = [
      tpl("const kc = join(cwd, '.vibecarbon', `kubeconfig-#{env}`);"),
      "const kc2 = 'kubeconfig-' + env;",
      tpl('// join(cwd, `kubeconfig-#{env}`) in a comment is fine'),
    ].join('\n');
    expect(kubeconfigNames('src/x.js', src)).toHaveLength(2);
    expect(kubeconfigNames(MODULE, src)).toEqual([]);
    const reads = [
      "kubeconfig = state.getStepResult('k3s-kubeconfig').kubeconfig;",
      "kubeconfig = upgradeKubeconfig(state.getStepResult('k3s-kubeconfig').kubeconfig);",
      'const kc = process.env.KUBECONFIG;',
    ].join('\n');
    expect(unUpgradedReads('src/x.js', reads)).toHaveLength(2);
  });

  it('(c) recognises every spawn shape', () => {
    for (const line of [
      "await runCommandAsync(['kubectl', 'get', 'pods']);",
      "spawn('kubectl', args, { env });",
      "probe(report, 'nodes', 'kubectl', ['get', 'nodes'], env);",
      "await runCommandAsync(['helm', 'repo', 'add', name, url]);",
      '`KCFG=x; kubectl --kubeconfig "$KCFG" get pods`',
    ]) {
      expect(spawnsKubeClient(line), line).toBe(true);
    }
    expect(spawnsKubeClient('// kubectl apply in a comment')).toBe(false);
    expect(spawnsKubeClient('const hint = `kubectl -n vibecarbon get pods`;')).toBe(false);
  });

  it('(d) flags a job that decodes the kubeconfig and leaves compression on', () => {
    const wf = [
      '      - name: Write kubeconfig from env secret',
      '        run: |',
      '          printf \'%s\' "$KUBECONFIG_B64" | base64 -d > "$KUBECONFIG"',
      '          chmod 600 "$KUBECONFIG"',
      '      - name: Next',
      '        run: kubectl get pods',
    ].join('\n');
    expect(workflowGaps(wf)).toEqual(['- name: Write kubeconfig from env secret']);
  });
});
