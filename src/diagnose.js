/**
 * `vibecarbon diagnose [env] [section]`
 *
 * One-command full cluster state dump. Writes a timestamped report to
 * ~/.vibecarbon/diag-<env>-<ts>.txt and tees a summary to stdout. Companion
 * to `vibecarbon shell` — when something is wrong, this is the single
 * command that gathers every signal that's
 * helped diagnose past failures (node IPs, CoreDNS config, Flux state,
 * pod-level DNS probes, hcloud resource state).
 *
 * Sections:
 *   nodes    — kubectl get nodes -o wide + ssh systemctl status k3s
 *              + journalctl -u k3s + ip addr + dmesg via SSH
 *   pods     — kubectl get pods -A, describe non-Running pods, logs for
 *              crashlooping pods
 *   network  — CoreDNS configmap + logs, Flannel + kube-proxy logs,
 *              hcloud-ccm + hcloud-csi logs, in-cluster busybox DNS probe
 *   flux     — kubectl -n flux-system get gitrepository,kustomization,
 *              helmrelease + describe + controller logs
 *   hcloud   — server/network/firewall/floating-ip/PG/SSH-key list
 *   all      — every section (default)
 *
 * Each probe is wrapped so a failure in one section doesn't prevent the
 * others from running — partial output is far more useful than nothing.
 *
 * Deploy-mode dispatch: the sections above describe the KUBERNETES path.
 * A compose / compose-ha env has no nodes/pods/Flux to inspect, so it routes
 * to a separate SSH-based collector (diagnoseCompose) that dumps the
 * compose-relevant state instead — container states + health, recent
 * per-service logs, Traefik/ACME cert state, and host disk pressure. The
 * `section` positional is k8s-only; compose dumps its full fixed set.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { c } from './lib/colors.js';
import { loadProjectConfig } from './lib/config.js';
import { isComposeTier, resolveTier } from './lib/deploy/tier-registry.js';
import { ensureOperatorIpAccessWarn } from './lib/operator-ip.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { providerFor, providerIdFor, resolveProviderToken } from './lib/providers/index.js';
import { getSSHKeyPath, sshRun } from './lib/ssh.js';

/**
 * One-line note printed (and saved to the report) when `hcloud` is
 * requested but the environment's provider isn't Hetzner (R9 gate).
 * Takes the provider id, not the resolved Provider class — this note only
 * needs the id to read out, so reading it directly is simpler and more
 * robust than resolving a provider class it never uses.
 * @param {string} providerId
 * @returns {string}
 */
export function hcloudGateSkipNote(providerId) {
  return `Skipping hcloud section, provider is ${providerId}, not Hetzner.`;
}

// Sections that run as part of `diagnose all`. Egress is intentionally
// excluded — its netshoot image pull + multi-probe battery can take 30-60s,
// which is fine for an explicit `diagnose <env> egress` invocation but
// disproportionate for the default sweep.
const SECTIONS = ['nodes', 'pods', 'network', 'flux', 'hcloud'];
const OPTIONAL_SECTIONS = ['egress'];
const ALL_VALID_SECTIONS = [...SECTIONS, ...OPTIONAL_SECTIONS];

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'diagnose',
  summary: 'Dump full cluster state for an environment',
  description: [
    'Streams sections to stdout AND writes the full report to:',
    '  ~/.vibecarbon/diag-<env>-<timestamp>.txt',
  ].join('\n'),
  positional: [
    {
      name: 'env',
      optional: true,
      description: 'Environment to inspect (default: prod)',
    },
    {
      name: 'section',
      optional: true,
      description: `One of: ${ALL_VALID_SECTIONS.join(', ')}, all (default: all — excludes egress)`,
    },
  ],
  flags: [{ name: 'h', boolean: true, description: 'Show this help' }],
  examples: [
    { command: 'vibecarbon diagnose e3', description: 'full dump (excludes heavy egress probe)' },
    { command: 'vibecarbon diagnose e3 network', description: 'CoreDNS + CCM + DNS probe' },
    {
      command: 'vibecarbon diagnose e3 egress',
      description: 'netshoot DNS + MTU + route battery',
    },
    { command: 'vibecarbon diagnose e3 flux', description: 'just Flux state' },
  ],
};

/**
 * Run a command, returning { ok, stdout, stderr }. Never throws —
 * failures get captured into stderr/exitCode so a single broken command
 * doesn't break the whole report.
 */
function safeRun(cmd, args, env) {
  try {
    const out = execFileSync(cmd, args, {
      env,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { ok: true, stdout: out, stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err?.stdout?.toString() ?? '',
      stderr: err?.stderr?.toString() ?? err?.message ?? String(err),
    };
  }
}

class Report {
  constructor() {
    this.lines = [];
  }
  section(title) {
    const banner = `\n${'='.repeat(72)}\n  ${title}\n${'='.repeat(72)}\n`;
    this.lines.push(banner);
    console.log(banner);
  }
  subsection(title) {
    const banner = `\n--- ${title} ---`;
    this.lines.push(banner);
    console.log(banner);
  }
  command(label, cmd, args) {
    this.lines.push(`\n# $ ${cmd} ${args.join(' ')}  (${label})`);
    console.log(c.dim(`# $ ${cmd} ${args.join(' ')}`));
  }
  output(text) {
    if (!text) return;
    this.lines.push(text.trimEnd());
    process.stdout.write(text);
    if (!text.endsWith('\n')) process.stdout.write('\n');
  }
  warn(text) {
    const line = `${c.warning('!')} ${text}`;
    this.lines.push(`! ${text}`);
    console.log(line);
  }
  toString() {
    return this.lines.join('\n');
  }
}

/**
 * Run a command, push it to the report with a label, and dump output.
 */
function probe(report, label, cmd, args, env) {
  report.command(label, cmd, args);
  const r = safeRun(cmd, args, env);
  if (r.ok) {
    report.output(r.stdout);
  } else {
    report.output(r.stdout);
    report.warn(`${cmd} ${args.join(' ')} failed: ${r.stderr.split('\n')[0]}`);
  }
}

/**
 * Remote analogue of probe(): run an argv over SSH via sshRun and capture its
 * output into the report. sshRun throws on a non-zero remote exit (attaching
 * .stdout/.stderr), so a failed probe still records whatever the command
 * printed plus a one-line warning — the same "partial output beats nothing"
 * contract as probe(). Never throws.
 *
 * @param {Report} report
 * @param {string} label
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {string[]} argv - remote command argv (sshRun argv-escapes each token)
 * @param {object} [options] - sshRun options (env for host-key pinning, timeout)
 */
async function probeRemote(report, label, ip, sshKeyPath, argv, options = {}) {
  report.command(label, 'ssh', [ip, ...argv]);
  try {
    const out = await sshRun(ip, sshKeyPath, argv, options);
    report.output(typeof out === 'string' ? out : '');
  } catch (err) {
    if (err?.stdout) report.output(String(err.stdout));
    const detail = String(err?.stderr || err?.message || err)
      .split('\n')
      .find((l) => l.trim());
    report.warn(`${argv.join(' ')} failed: ${detail ?? 'unknown error'}`);
  }
}

function diagnoseHcloud(report, env) {
  report.section('HCLOUD RESOURCES');
  for (const kind of [
    'server',
    'network',
    'firewall',
    'floating-ip',
    'placement-group',
    'ssh-key',
  ]) {
    probe(report, kind, 'hcloud', [kind, 'list'], env);
  }
}

function diagnoseNodes(report, env, kubeconfig, sshKey, controlplaneIp) {
  report.section('NODES');
  probe(
    report,
    'nodes wide',
    'kubectl',
    ['--kubeconfig', kubeconfig, 'get', 'nodes', '-o', 'wide'],
    env,
  );
  probe(report, 'node describe', 'kubectl', ['--kubeconfig', kubeconfig, 'describe', 'nodes'], env);
  if (existsSync(sshKey) && controlplaneIp) {
    const sshArgs = (cmd) => [
      '-i',
      sshKey,
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      `root@${controlplaneIp}`,
      cmd,
    ];
    probe(report, 'k3s service status', 'ssh', sshArgs('systemctl status k3s --no-pager'), env);
    probe(
      report,
      'k3s journal (last 50)',
      'ssh',
      sshArgs('journalctl -u k3s --no-pager -n 50'),
      env,
    );
    probe(
      report,
      'containerd containers',
      'ssh',
      sshArgs('k3s ctr containers ls 2>&1 | head -20'),
      env,
    );
    probe(report, 'host addresses', 'ssh', sshArgs('ip addr show'), env);
    probe(report, 'host dmesg (tail)', 'ssh', sshArgs('dmesg | tail -30'), env);
  } else {
    report.warn(
      `ssh skipped — sshKey=${sshKey} (${existsSync(sshKey) ? 'found' : 'MISSING'}) controlplaneIp=${controlplaneIp ?? '(none)'}`,
    );
  }
}

function diagnosePods(report, env, kubeconfig) {
  report.section('PODS');
  probe(
    report,
    'pods all-ns wide',
    'kubectl',
    ['--kubeconfig', kubeconfig, 'get', 'pods', '-A', '-o', 'wide'],
    env,
  );
  probe(
    report,
    'non-running pods',
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      'get',
      'pods',
      '-A',
      '--field-selector=status.phase!=Running,status.phase!=Succeeded',
    ],
    env,
  );
  // Describe pods in non-running state
  const listResult = safeRun(
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      'get',
      'pods',
      '-A',
      '--field-selector=status.phase!=Running,status.phase!=Succeeded',
      '-o',
      'jsonpath={range .items[*]}{.metadata.namespace} {.metadata.name}{"\\n"}{end}',
    ],
    env,
  );
  if (listResult.ok) {
    const pairs = listResult.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' '));
    for (const [ns, name] of pairs) {
      if (!ns || !name) continue;
      report.subsection(`${ns}/${name}`);
      probe(
        report,
        'describe',
        'kubectl',
        ['--kubeconfig', kubeconfig, '-n', ns, 'describe', `pod/${name}`],
        env,
      );
      probe(
        report,
        'logs (current)',
        'kubectl',
        ['--kubeconfig', kubeconfig, '-n', ns, 'logs', name, '--tail=40'],
        env,
      );
      probe(
        report,
        'logs (previous)',
        'kubectl',
        ['--kubeconfig', kubeconfig, '-n', ns, 'logs', name, '--previous', '--tail=40'],
        env,
      );
    }
  }
}

function diagnoseNetwork(report, env, kubeconfig, Provider) {
  report.section('NETWORK');
  probe(
    report,
    'CoreDNS configmap',
    'kubectl',
    ['--kubeconfig', kubeconfig, '-n', 'kube-system', 'get', 'cm', 'coredns', '-o', 'yaml'],
    env,
  );
  probe(
    report,
    'kube-system pods',
    'kubectl',
    ['--kubeconfig', kubeconfig, '-n', 'kube-system', 'get', 'pods', '-o', 'wide'],
    env,
  );
  // Hetzner keeps its historical "hcloud-" labels byte-identical; any other
  // provider gets a `${Provider.NAME} ...` label instead of the Hetzner-only
  // literal (previously hardcoded here regardless of provider — mislabeled
  // these CCM/CSI log sections as "hcloud-*" even on DO).
  const ccmLabel = Provider.NAME === 'Hetzner Cloud' ? 'hcloud-CCM' : `${Provider.NAME} CCM`;
  const csiControllerLabel =
    Provider.NAME === 'Hetzner Cloud' ? 'hcloud-CSI controller' : `${Provider.NAME} CSI controller`;
  for (const labelSel of [
    { name: 'CoreDNS', sel: 'k8s-app=kube-dns' },
    { name: 'Flannel', sel: 'app=flannel' },
    { name: 'kube-proxy', sel: 'k8s-app=kube-proxy' },
    { name: ccmLabel, sel: Provider.K8S_ASSETS.ccmSelector },
    { name: csiControllerLabel, sel: Provider.K8S_ASSETS.csiControllerSelector },
  ]) {
    report.subsection(`${labelSel.name} logs`);
    const list = safeRun(
      'kubectl',
      [
        '--kubeconfig',
        kubeconfig,
        '-n',
        'kube-system',
        'get',
        'pods',
        '-l',
        labelSel.sel,
        '-o',
        'jsonpath={.items[*].metadata.name}',
      ],
      env,
    );
    if (list.ok && list.stdout.trim()) {
      for (const pod of list.stdout.trim().split(/\s+/)) {
        probe(
          report,
          pod,
          'kubectl',
          ['--kubeconfig', kubeconfig, '-n', 'kube-system', 'logs', pod, '--tail=30'],
          env,
        );
      }
    } else {
      report.warn(`No pods found matching ${labelSel.sel}`);
    }
  }
  // In-cluster DNS + egress probe
  report.subsection('busybox in-cluster probe (nslookup + wget)');
  const probeName = `vc-diag-${Math.random().toString(36).slice(2, 8)}`;
  probe(
    report,
    'pod probe',
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '-n',
      'kube-system',
      'run',
      probeName,
      '--image=busybox:1.36',
      '--restart=Never',
      '--rm',
      '--attach',
      // 45s: safeRun hard-kills every probe at 60s; keep kubectl's own budget
      // inside it so a slow pod start reports as a kubectl timeout, not a kill.
      '--timeout=45s',
      '--command',
      '--',
      'sh',
      '-c',
      'echo "--- /etc/resolv.conf ---"; cat /etc/resolv.conf; echo; echo "--- nslookup github.com (cluster DNS) ---"; nslookup github.com 2>&1 | head -10; echo; echo "--- nslookup github.com @1.1.1.1 ---"; nslookup github.com 1.1.1.1 2>&1 | head -10; echo; echo "--- wget https://github.com (5s) ---"; wget -qO- --timeout=5 https://github.com 2>&1 | head -3 || echo wget-failed',
    ],
    env,
  );
}

/**
 * Deep DNS + pod-network egress battery. Runs a netshoot pod with sleep,
 * execs a multi-layered probe script, then deletes the pod. Distinguishes
 * between "DNS broken", "pod-network broken", "MTU mismatch", and "external
 * egress broken" — the four classes of bug that masquerade as the same
 * "i/o timeout to github.com" symptom that bit us 2026-04-24.
 *
 * Heavy enough (~30s netshoot pull, ~60s battery) that it's excluded from
 * `diagnose all`. Run explicitly when network is suspect:
 *   vibecarbon diagnose <env> egress
 */
function diagnoseEgress(report, env, kubeconfig, sshKey, controlplaneIp, Provider) {
  report.section('EGRESS (DNS + pod-network battery)');

  // CCM env vars. For a provider whose CCM discovers network identity from an
  // injected env var (Hetzner's HCLOUD_NETWORK via secretKeyRef:hcloud/network
  // — if empty here the route-controller is silently disabled, see
  // hcloud-cloud-controller-manager #115/#630), the subsection label names
  // that var so its presence is easy to eyeball in the dump. A provider with
  // no such var (networkEnvVar === '' — e.g. DO, which discovers VPC
  // membership from droplet metadata instead) gets a generic label; the probe
  // itself is unconditional either way — dumping ALL of the CCM container's
  // env vars is useful regardless of provider.
  report.subsection(
    Provider.K8S_ASSETS.networkEnvVar
      ? `CCM env vars (${Provider.K8S_ASSETS.networkEnvVar} present?)`
      : 'CCM env vars',
  );
  probe(
    report,
    'CCM deploy env',
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '-n',
      'kube-system',
      'get',
      'deploy',
      Provider.K8S_ASSETS.ccmDeployment,
      '-o',
      'jsonpath={range .spec.template.spec.containers[*].env[*]}{.name}\t{.value}\t{.valueFrom.secretKeyRef.name}/{.valueFrom.secretKeyRef.key}{"\\n"}{end}',
    ],
    env,
  );

  // CoreDNS Corefile — forwarders are the upstream resolver pod-DNS depends on.
  report.subsection('CoreDNS Corefile');
  probe(
    report,
    'coredns Corefile',
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '-n',
      'kube-system',
      'get',
      'cm',
      'coredns',
      '-o',
      'jsonpath={.data.Corefile}',
    ],
    env,
  );

  // Node-level state: routes, addresses, links, resolv.conf. If the host
  // can't egress, no pod can either.
  if (existsSync(sshKey) && controlplaneIp) {
    report.subsection('node-level routes / addresses / links / resolv.conf');
    const sshArgs = (cmd) => [
      '-i',
      sshKey,
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      `root@${controlplaneIp}`,
      cmd,
    ];
    probe(report, 'host routes', 'ssh', sshArgs('ip route'), env);
    probe(report, 'host addresses', 'ssh', sshArgs('ip addr'), env);
    probe(report, 'host links', 'ssh', sshArgs('ip link'), env);
    probe(report, 'host /etc/resolv.conf', 'ssh', sshArgs('cat /etc/resolv.conf'), env);
  } else {
    report.warn(
      `host node probes skipped — sshKey=${existsSync(sshKey) ? 'found' : 'MISSING'} controlplaneIp=${controlplaneIp ?? '(none)'}`,
    );
  }

  // Pod-level battery — the part that actually distinguishes failure modes.
  // Each line is labeled so a failed step localizes the layer:
  //   A fails  → cluster DNS (CoreDNS) broken
  //   B fails  → external DNS reachability (node→1.1.1.1) broken
  //   C fails  → public-IP egress broken (CNI masquerade / default route)
  //   D fails  → github.com unreachable by IP (egress to that AS broken)
  //   E fails  → DNS-driven egress broken specifically (combo of A or B)
  //   I fails  → MTU clamp not applied (vxlan-on-Hetzner=1450); fragments dropped
  //
  // We can't use `kubectl run --rm --attach` with a one-shot script — it
  // truncates stdout when the container exits quickly (validated against a
  // live cluster). Use the create+wait+exec+delete pattern: create with a
  // long sleep, wait for Ready, exec the battery (stdout is captured cleanly),
  // delete in finally-ish fashion (probe() never throws so cleanup always runs).
  report.subsection('netshoot pod battery (DNS + curl + MTU)');
  const podName = `vc-egress-${Math.random().toString(36).slice(2, 8)}`;
  const battery = [
    'set +e',
    'echo "## /etc/resolv.conf"; cat /etc/resolv.conf; echo',
    'echo "## A. dig @cluster-DNS (10.96.0.10) github.com"; dig +time=3 +tries=1 @10.96.0.10 github.com +short; echo "exit=$?"; echo',
    'echo "## B. dig @1.1.1.1 github.com"; dig +time=3 +tries=1 @1.1.1.1 github.com +short; echo "exit=$?"; echo',
    'echo "## C. curl https://1.1.1.1 (public IP)"; curl -m5 -sI https://1.1.1.1 -o /dev/null -w "http=%{http_code} t=%{time_total}s\\n" || echo FAIL_PUBLIC; echo',
    'echo "## D. curl github.com via direct IP (bypass DNS)"; curl -m5 -skI --resolve github.com:443:140.82.121.4 https://github.com/ -o /dev/null -w "http=%{http_code} t=%{time_total}s\\n" || echo FAIL_GITHUB_IP; echo',
    'echo "## E. curl https://github.com (DNS-driven)"; curl -m5 -sI https://github.com -o /dev/null -w "http=%{http_code} t=%{time_total}s\\n" || echo FAIL_GITHUB_DNS; echo',
    'echo "## F. curl https://raw.githubusercontent.com (Flux source target)"; curl -m5 -sI https://raw.githubusercontent.com -o /dev/null -w "http=%{http_code} t=%{time_total}s\\n" || echo FAIL_RAWGH; echo',
    'echo "## G. ip route"; ip route; echo',
    'echo "## H. ip -br link (MTU on each iface)"; ip -br link; echo',
    'echo "## I. ping -M do -s 1372 1.1.1.1 (vxlan-MTU 1400 OK)"; ping -M do -s 1372 -c1 -W2 1.1.1.1 2>&1 | tail -2; echo',
    'echo "## J. ping -M do -s 1444 1.1.1.1 (full-MTU 1472; expect FAIL on Hetzner private)"; ping -M do -s 1444 -c1 -W2 1.1.1.1 2>&1 | tail -2; echo',
  ].join('; ');
  probe(
    report,
    'create pod',
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '-n',
      'default',
      'run',
      podName,
      '--image=nicolaka/netshoot',
      '--restart=Never',
      '--command',
      '--',
      'sleep',
      '300',
    ],
    env,
  );
  probe(
    report,
    'wait pod ready',
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '-n',
      'default',
      'wait',
      `pod/${podName}`,
      '--for=condition=Ready',
      // 50s: safeRun hard-kills at 60s, so the declared 180s never functioned;
      // keep kubectl's budget inside the kill so the wait error is legible.
      '--timeout=50s',
    ],
    env,
  );
  probe(
    report,
    'exec battery',
    'kubectl',
    ['--kubeconfig', kubeconfig, '-n', 'default', 'exec', podName, '--', 'sh', '-c', battery],
    env,
  );
  probe(
    report,
    'cleanup pod',
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '-n',
      'default',
      'delete',
      'pod',
      podName,
      '--wait=false',
      '--grace-period=1',
    ],
    env,
  );
}

function diagnoseFlux(report, env, kubeconfig) {
  report.section('FLUX');
  probe(
    report,
    'flux resources',
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '-n',
      'flux-system',
      'get',
      'gitrepository,kustomization,helmrelease',
    ],
    env,
  );
  probe(
    report,
    'flux events',
    'kubectl',
    ['--kubeconfig', kubeconfig, '-n', 'flux-system', 'get', 'events', '--sort-by=.lastTimestamp'],
    env,
  );
  for (const controller of [
    'source-controller',
    'kustomize-controller',
    'helm-controller',
    'notification-controller',
  ]) {
    report.subsection(`${controller} logs`);
    probe(
      report,
      controller,
      'kubectl',
      [
        '--kubeconfig',
        kubeconfig,
        '-n',
        'flux-system',
        'logs',
        `deployment/${controller}`,
        '--tail=40',
      ],
      env,
    );
  }
  // Describe the GitRepository — this is where stale-URL / auth errors appear
  probe(
    report,
    'GitRepository describe',
    'kubectl',
    ['--kubeconfig', kubeconfig, '-n', 'flux-system', 'describe', 'gitrepository'],
    env,
  );
}

/**
 * Compose / compose-ha state dump over SSH. A single-VPS Docker Compose box has
 * no nodes/pods/Flux/CoreDNS to inspect, so this gathers the compose-relevant
 * signals instead: container states + health, recent per-service logs,
 * Traefik/ACME cert state, and host disk pressure (the single most common
 * single-VPS outage — an unbounded log or volume filling the root disk).
 *
 * All remote work goes through sshRun (argv form, per-env host-key pinning) —
 * never a local shell. compose-ha records two servers; we dump every server in
 * the env so a degraded standby is visible too. Exported so run() and the
 * dispatch test can reach it.
 *
 * @param {{report: Report, envName: string, envConfig: object, projectName: string, sshKeyPath?: string}} ctx
 */
export async function diagnoseCompose(ctx) {
  const { report, envName, envConfig, projectName } = ctx;
  report.section('COMPOSE STATE');

  const sshKeyPath = ctx.sshKeyPath ?? getSSHKeyPath(envName);
  if (!existsSync(sshKeyPath)) {
    report.warn(
      `Skipping compose sections: SSH key not found at ${sshKeyPath}. Run a deploy first.`,
    );
    return;
  }
  const servers = Array.isArray(envConfig?.servers) ? envConfig.servers : [];
  if (servers.length === 0) {
    report.warn(`No servers recorded for environment '${envName}'. Run a deploy first.`);
    return;
  }

  // The compose project lives at /opt/<projectName> (setupServerFiles). Every
  // compose subcommand needs to cd there; `bash -lc` matches the login-shell
  // transport status/backup use for compose so docker is on PATH. sshRun
  // argv-escapes each token, so the whole script is one argv element the remote
  // shell parses exactly once.
  const remoteDir = `/opt/${projectName}`;
  const composeSh = (script) => ['bash', '-lc', `cd ${remoteDir} && ${script}`];
  // No `env` → sshRun derives the per-env known_hosts from the key path with
  // StrictHostKeyChecking=accept-new (buildHostKeyOpts), matching the
  // status/backup compose paths. accept-new is the forgiving-but-safe choice
  // for a best-effort diagnostic: it TOFUs a fresh/recycled IP yet still
  // rejects a changed key on an established host. Shorter than sshRun's 120s
  // default so a probe against a wedged box fails fast instead of hanging the
  // whole report.
  const sshOpts = { timeout: 45_000 };

  for (const server of servers) {
    const ip = server?.ip;
    if (!ip) continue;
    report.subsection(`server ${ip}${server?.role ? ` (${server.role})` : ''}`);

    // Container states + health. `ps -a` catches exited/crashed containers a
    // plain `ps` hides — and modern compose folds the health-check result into
    // the STATUS column (e.g. "Up 2 hours (healthy)"), so this is the health
    // dump too.
    await probeRemote(
      report,
      'compose ps -a',
      ip,
      sshKeyPath,
      composeSh('docker compose ps -a'),
      sshOpts,
    );

    // Recent per-service logs. --tail bounds output; --no-color keeps the report
    // legible; --timestamps localizes when things broke.
    await probeRemote(
      report,
      'compose logs (tail 60)',
      ip,
      sshKeyPath,
      composeSh('docker compose logs --no-color --timestamps --tail=60'),
      sshOpts,
    );

    // Traefik / ACME cert state. SECURITY: never cat acme.json — it holds the
    // ACME account + certificate PRIVATE KEYS. Its presence/size/mtime tell us
    // whether certs were ever issued; the actual issue/renewal errors surface
    // in traefik's own logs (tailed longer here). The `|| echo` keeps a
    // stopped-traefik case from failing the probe outright.
    await probeRemote(
      report,
      'acme.json stat (no contents: key material)',
      ip,
      sshKeyPath,
      composeSh(
        'docker compose exec -T traefik stat /letsencrypt/acme.json 2>&1 || echo "traefik/acme.json unavailable"',
      ),
      sshOpts,
    );
    await probeRemote(
      report,
      'traefik logs (tail 80)',
      ip,
      sshKeyPath,
      composeSh('docker compose logs --no-color --timestamps --tail=80 traefik'),
      sshOpts,
    );

    // Host disk pressure — the outage this whole audit item targets. df -h for
    // the filesystem, docker system df for reclaimable image/container/volume/
    // build-cache space.
    await probeRemote(report, 'disk usage (df -h)', ip, sshKeyPath, ['df', '-h'], sshOpts);
    await probeRemote(
      report,
      'docker disk usage',
      ip,
      sshKeyPath,
      ['docker', 'system', 'df'],
      sshOpts,
    );
  }
}

/**
 * Kubernetes state dump — the historical `diagnose` behavior, unchanged. Pulled
 * into its own function so run() can dispatch between this and diagnoseCompose
 * on the env's deploy mode. Exported for symmetry with diagnoseCompose (the
 * dispatch test injects a stub in its place).
 *
 * @param {{report: Report, cmdEnv: object, kubeconfig: string, sshKey: string, controlplaneIp: string|null, Provider: object, providerId: string, sectionsToRun: string[]}} ctx
 */
export async function diagnoseK8s(ctx) {
  const {
    report,
    cmdEnv,
    kubeconfig,
    sshKey,
    controlplaneIp,
    Provider,
    providerId,
    sectionsToRun,
  } = ctx;

  // hcloud section is Hetzner-only (R9 gate). requestedHcloud tracks the
  // user's ask so an explicit `diagnose <env> hcloud` on another provider
  // gets a one-line skip note instead of silently doing nothing.
  const requestedHcloud = sectionsToRun.includes('hcloud');
  const includesHcloud = requestedHcloud && providerId === 'hetzner';
  const needsKubectl = sectionsToRun.some((s) =>
    ['nodes', 'pods', 'network', 'flux', 'egress'].includes(s),
  );

  if (requestedHcloud && !includesHcloud) report.warn(hcloudGateSkipNote(providerId));
  if (includesHcloud) diagnoseHcloud(report, cmdEnv);
  if (needsKubectl) {
    if (!existsSync(kubeconfig)) {
      report.warn(
        `Skipping kubectl-based sections: kubeconfig not found at ${kubeconfig}. Run a deploy first.`,
      );
    } else {
      if (sectionsToRun.includes('nodes'))
        diagnoseNodes(report, cmdEnv, kubeconfig, sshKey, controlplaneIp);
      if (sectionsToRun.includes('pods')) diagnosePods(report, cmdEnv, kubeconfig);
      if (sectionsToRun.includes('network')) diagnoseNetwork(report, cmdEnv, kubeconfig, Provider);
      if (sectionsToRun.includes('egress'))
        diagnoseEgress(report, cmdEnv, kubeconfig, sshKey, controlplaneIp, Provider);
      if (sectionsToRun.includes('flux')) diagnoseFlux(report, cmdEnv, kubeconfig);
    }
  }
}

/**
 * Resolve the env's tier, defaulting to the historical k8s path for a legacy
 * env that never persisted a deployMode (resolveTier throws on unknown). Never
 * throws — an un-resolvable env falls back to 'k8s' so behavior only ever
 * gets MORE capable, never breaks an existing k8s diagnose.
 */
function tierOf(envConfig) {
  try {
    return resolveTier(envConfig ?? {});
  } catch {
    return 'k8s';
  }
}

/**
 * Route to the compose or k8s collector based on the env's deploy mode.
 * Collectors are injected (defaulting to the real ones) so a unit test can
 * assert the dispatch without any real SSH or kubectl. Returns the branch
 * taken ('compose' | 'k8s').
 *
 * @param {{envConfig: object}} ctx
 * @param {{collectCompose?: (ctx: any) => Promise<void>, collectK8s?: (ctx: any) => Promise<void>}} [deps]
 * @returns {Promise<'compose'|'k8s'>}
 */
export async function dispatchDiagnose(ctx, deps = {}) {
  const { collectCompose = diagnoseCompose, collectK8s = diagnoseK8s } = deps;
  if (isComposeTier(tierOf(ctx.envConfig))) {
    await collectCompose(ctx);
    return 'compose';
  }
  await collectK8s(ctx);
  return 'k8s';
}

function readControlplaneIp(envName) {
  const envCfg = loadProjectConfig()?.environments?.[envName];
  const masterServer = envCfg?.servers?.find((s) => s.name === 'master' || s.name === 'primary');
  return masterServer?.ip ?? null;
}

export async function run(args) {
  const { positional, handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  // Project guard runs first so an accidental `vibecarbon diagnose` from
  // a parent directory emits the canonical message instead of stumbling
  // through kubectl probes against a missing kubeconfig.
  assertInProjectDir();

  const envName = /** @type {string|undefined} */ (positional.env) ?? 'prod';
  const requested = /** @type {string|undefined} */ (positional.section) ?? 'all';
  if (!ALL_VALID_SECTIONS.includes(requested) && requested !== 'all') {
    console.error(
      c.error(`Unknown section "${requested}". Valid: ${ALL_VALID_SECTIONS.join(', ')}, all.`),
    );
    process.exit(1);
  }
  const sectionsToRun = requested === 'all' ? SECTIONS : [requested];

  const cwd = process.cwd();
  const kubeconfig = join(cwd, '.vibecarbon', `kubeconfig-${envName}`);
  const sshKey = join(cwd, '.vibecarbon', `ssh-${envName}`);
  const controlplaneIp = readControlplaneIp(envName);

  const envConfig = loadProjectConfig()?.environments?.[envName];
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);
  const providerToken = resolveProviderToken(providerIdFor(envConfig)) ?? null;
  const env = { ...process.env };
  // Provider-owned env bag — see BaseProvider.buildIacEnv (the census bans
  // hand-writing the CLI_TOKEN_ENV env assignment outside base.js).
  if (providerToken) Object.assign(env, Provider.buildIacEnv(providerToken));

  // Auto-detect operator IP and ensure firewall lets us in. Diagnose runs
  // many kubectl + ssh probes; if the firewall blocks our IP every probe
  // hangs to its timeout. Refresh lastUsedAt and apply on first miss.
  const projectConfig = loadProjectConfig();
  await ensureOperatorIpAccessWarn({
    projectConfig,
    environment: envName,
    apiToken: providerToken,
  });

  // Dispatch by deploy mode. Compose tiers have no kubeconfig/master/Flux, so
  // they route to the SSH-based compose collector; k8s tiers keep the existing
  // kubectl path. A legacy env with no deployMode falls back to k8s (tierOf).
  const tier = tierOf(envConfig);
  const isCompose = isComposeTier(tier);
  const providerId = providerIdFor(envConfig);
  const projectName = projectConfig?.projectName || 'project';
  const composeKey = getSSHKeyPath(envName);
  const serverIps = (Array.isArray(envConfig?.servers) ? envConfig.servers : [])
    .map((s) => s?.ip)
    .filter(Boolean);

  const report = new Report();

  // Header so the saved report is self-describing. Tier-aware: compose reports
  // its server IPs + compose SSH key; k8s reports kubeconfig + control-plane IP.
  const ts = new Date().toISOString();
  const header = [
    '# vibecarbon diagnose',
    `# env:        ${envName}`,
    `# tier:       ${tier}`,
    `# timestamp:  ${ts}`,
    `# cwd:        ${cwd}`,
    ...(isCompose
      ? [
          `# servers:    ${serverIps.length ? serverIps.join(', ') : '(none)'}`,
          `# sshKey:     ${composeKey} ${existsSync(composeKey) ? '(found)' : '(MISSING)'}`,
          `# project:    ${projectName}`,
        ]
      : [
          `# sections:   ${sectionsToRun.join(', ')}`,
          `# kubeconfig: ${kubeconfig} ${existsSync(kubeconfig) ? '(found)' : '(MISSING)'}`,
          `# sshKey:     ${sshKey} ${existsSync(sshKey) ? '(found)' : '(MISSING)'}`,
          `# masterIP:   ${controlplaneIp ?? '(unknown)'}`,
        ]),
    `# provider:   ${providerId}${providerToken ? ' (authenticated)' : ' (NOT AUTHENTICATED)'}`,
  ].join('\n');
  console.log(header);
  report.lines.push(header);

  await dispatchDiagnose({
    report,
    // compose collector fields
    envName,
    envConfig,
    projectName,
    sshKeyPath: composeKey,
    // k8s collector fields
    cmdEnv: env,
    kubeconfig,
    sshKey,
    controlplaneIp,
    Provider,
    providerId,
    sectionsToRun,
  });

  // Persist
  const diagDir = join(homedir(), '.vibecarbon');
  if (!existsSync(diagDir)) mkdirSync(diagDir, { recursive: true });
  const outFile = join(diagDir, `diag-${envName}-${ts.replace(/[:.]/g, '-')}.txt`);
  writeFileSync(outFile, report.toString());
  console.log(`\n${c.success('✓')} Report saved: ${outFile}`);
}
