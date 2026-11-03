/**
 * Host-level failure diagnostics for k8s scenarios, over ssh.
 *
 * Bought by a DO k8s-ha deploy failure: while the standby's pgdata swap pod
 * ran, the standby master's k3s API began refusing :6443 and never came back
 * within 5 minutes. Every kubectl section of the bundle for that cluster said
 * only "connection refused", so whether k3s was OOM-killed on the
 * s-2vcpu-4gb master, ran out of disk, or crash-looped was unrecoverable.
 * The host answers that while the API cannot, so for each cluster's master
 * and db node this collects, in one ssh call per host:
 *
 *  - `systemctl status` and the last 30 minutes of `journalctl` for k3s
 *    (k3s-agent on the db node, an agent);
 *  - the kernel's OOM lines from `dmesg -T`;
 *  - `free -m`, `df -h` of the k3s and kubelet data dirs and `/`, `uptime`;
 *  - the top processes by RSS.
 *
 * Collected on every step failure for both clusters, and so whenever a
 * cluster's API is unreachable: nothing here goes through the API.
 *
 * Node addresses come from the deploy state each cluster's deploy writes as
 * soon as its infra is up (.vibecarbon/deploy-state-<stack>.json, the
 * `k3s-infra` step's Pulumi outputs), since a deploy that fails has not
 * written .vibecarbon.json yet; then .vibecarbon.json; then the server
 * address in each kubeconfig, for the master.
 *
 * Bounds: every remote command runs under `timeout`, each host gets one ssh
 * call with a wall-clock cap and no transport retry, hosts run in parallel,
 * and each section is capped (its tail kept: the newest lines). Output is
 * redacted before it is returned: k3s journal lines and process lists can
 * carry join tokens.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactCredentials } from '../../../src/lib/redact-credentials.js';
import { sshRun } from '../../../src/lib/ssh.js';

export type K3sUnit = 'k3s' | 'k3s-agent';

export interface ClusterHost {
  label: string;
  ip: string;
  unit: K3sUnit;
}

/** One ssh call's wall-clock cap, per host. */
export const HOST_DIAG_SSH_TIMEOUT_MS = 60_000;

const MARK = '@@vc-section';

/**
 * The sections, in order: name (`{unit}` becomes the k3s unit), the remote
 * command (already bounded) and the characters kept.
 */
export const HOST_DIAG_SECTIONS: ReadonlyArray<{ name: string; cmd: string; maxChars: number }> = [
  {
    name: '{unit} status',
    cmd: 'timeout 10 systemctl status {unit} --no-pager -l 2>&1 | head -60',
    maxChars: 4000,
  },
  {
    name: '{unit} journal',
    cmd: 'timeout 20 journalctl -u {unit} --since=-30min --no-pager 2>&1 | tail -200',
    maxChars: 24_000,
  },
  {
    name: 'kernel OOM',
    cmd: "timeout 10 dmesg -T 2>&1 | grep -i -E 'oom|killed process|out of memory' | tail -40",
    maxChars: 6000,
  },
  {
    name: 'memory, disk, uptime',
    cmd:
      'timeout 5 free -m 2>&1; ' +
      'timeout 10 df -h /var/lib/rancher /var/lib/kubelet / 2>&1; ' +
      'timeout 5 uptime 2>&1',
    maxChars: 3000,
  },
  {
    name: 'top processes by RSS',
    cmd: 'timeout 10 ps -eo pid,rss,etime,cmd --sort=-rss 2>&1 | head -15',
    maxChars: 6000,
  },
];

const sectionName = (name: string, unit: K3sUnit) => name.replace('{unit}', unit);

/**
 * The remote bash script for one node. Each section starts with a marker
 * line; the script always exits 0, so a failed probe is output, never an
 * ssh error.
 */
export function buildHostDiagnosticScript(unit: K3sUnit): string {
  if (unit !== 'k3s' && unit !== 'k3s-agent') throw new Error(`unknown k3s unit: ${unit}`);
  const parts = HOST_DIAG_SECTIONS.map(
    (s) =>
      `echo '${MARK} ${sectionName(s.name, unit)}'; ${s.cmd.replaceAll('{unit}', unit)} || true`,
  );
  return `${parts.join('\n')}\ntrue`;
}

/** The argv for sshRun, which POSIX-quotes each element. */
export function hostDiagnosticArgv(unit: K3sUnit): string[] {
  return ['bash', '-c', buildHostDiagnosticScript(unit)];
}

/**
 * Cap at maxChars, keeping the tail (the newest lines) from a line boundary:
 * the partial line the cut leaves first is dropped. Callers pass redacted
 * text only: a cut made before redaction can split a token so that its
 * surviving half no longer matches any pattern.
 */
function capTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.length - maxChars;
  const kept = text.slice(cut);
  const onBoundary = text[cut - 1] === '\n';
  const nl = kept.indexOf('\n');
  const body = onBoundary ? kept : nl === -1 ? '' : kept.slice(nl + 1);
  return `(truncated to the last ${maxChars} chars, from a line boundary)\n${body}`;
}

const capFor = (name: string): number =>
  HOST_DIAG_SECTIONS.find(
    (s) => sectionName(s.name, 'k3s') === name || sectionName(s.name, 'k3s-agent') === name,
  )?.maxChars ?? 4000;

/**
 * Split a node's output at the section markers; each section capped. The
 * whole output is redacted first, before anything is split or cut.
 */
export function splitHostDiagnosticOutput(out: string): Array<[string, string]> {
  const redacted = redactHostDiagnostics(String(out ?? ''));
  const sections: Array<[string, string]> = [];
  let current: { name: string; lines: string[] } | null = null;
  const flush = () => {
    if (current) {
      sections.push([current.name, capTail(current.lines.join('\n').trim(), capFor(current.name))]);
    }
  };
  for (const line of redacted.split('\n')) {
    if (line.startsWith(`${MARK} `)) {
      flush();
      current = { name: line.slice(MARK.length + 1).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return sections.length > 0 ? sections : [['output', '(no output)']];
}

/** k3s join tokens: K10<ca hash>::<user>:<secret>. */
const K3S_JOIN_TOKEN = /\bK10[0-9a-f]{16,}::[^\s'"]+/gi;
/** Token flags on a k3s command line, with `=` or a space. */
const TOKEN_FLAG = /(--[a-z-]*token[a-z-]*)(=|\s+)(?!-)\S+/gi;
/** JWTs (service-account tokens). */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
/** kubeadm-style bootstrap tokens. */
const BOOTSTRAP_TOKEN = /\b[a-z0-9]{6}\.[a-z0-9]{16}\b/g;

/**
 * Mask anything token-shaped in host output: redactCredentials (KEY/SECRET/
 * TOKEN/PASSWORD assignments, Bearer/Basic, URL userinfo) plus the shapes a
 * k3s journal or process list can carry.
 */
export function redactHostDiagnostics(text: string): string {
  return String(text ?? '')
    .split('\n')
    .map((line) =>
      redactCredentials(
        line
          .replace(K3S_JOIN_TOKEN, '<redacted>')
          .replace(JWT, '<redacted>')
          .replace(BOOTSTRAP_TOKEN, '<redacted>')
          .replace(TOKEN_FLAG, '$1$2<redacted>'),
      ),
    )
    .join('\n');
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const ipv4 = (v: unknown): string | null =>
  typeof v === 'string' && IPV4.test(v.trim()) ? v.trim() : null;

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Every cluster's master and db node for this scenario env, deduplicated by
 * address, from the deploy state, then .vibecarbon.json, then the
 * kubeconfigs' server addresses. Only IPv4 literals are returned. Never
 * throws.
 */
export function findClusterHosts(projectDir: string, envPrefix: string): ClusterHost[] {
  const hosts: ClusterHost[] = [];
  const seen = new Set<string>();
  const push = (label: string, ip: unknown, unit: K3sUnit) => {
    const addr = ipv4(ip);
    if (!addr || seen.has(addr)) return;
    seen.add(addr);
    hosts.push({ label, ip: addr, unit });
  };
  try {
    const vc = join(projectDir, '.vibecarbon');
    // biome-ignore lint/suspicious/noExplicitAny: free-form persisted config
    const config = readJson(join(projectDir, '.vibecarbon.json')) as any;
    const envConfig = config?.environments?.[envPrefix];
    const stacks = [
      envPrefix,
      `${envPrefix}-primary`,
      `${envPrefix}-standby`,
      envConfig?.ha?.primary?.stack,
      envConfig?.ha?.standby?.stack,
    ].filter((s, i, all): s is string => typeof s === 'string' && s !== '' && all.indexOf(s) === i);

    for (const stack of stacks) {
      // biome-ignore lint/suspicious/noExplicitAny: free-form deploy state
      const result = (readJson(join(vc, `deploy-state-${stack}.json`)) as any)?.steps?.['k3s-infra']
        ?.result;
      if (!result) continue;
      push(`${stack} master`, result.masterIp, 'k3s');
      push(`${stack} db`, result.dbIp, 'k3s-agent');
    }

    if (envConfig) {
      for (const role of ['primary', 'standby'] as const) {
        const side = envConfig.ha?.[role];
        if (!side) continue;
        push(`${role} master`, side.masterIp, 'k3s');
        push(`${role} db`, side.dbIp, 'k3s-agent');
      }
      for (const srv of Array.isArray(envConfig.servers) ? envConfig.servers : []) {
        if (srv?.role === 'master') {
          push('master', srv.ip, 'k3s');
          push('db', srv.dbIp, 'k3s-agent');
        } else if (srv?.role === 'db') {
          push('db', srv.ip, 'k3s-agent');
        }
      }
    }

    for (const name of [
      `kubeconfig-${envPrefix}`,
      `kubeconfig-${envPrefix}-primary`,
      `kubeconfig-${envPrefix}-standby`,
    ]) {
      const path = join(vc, name);
      if (!existsSync(path)) continue;
      const m = readFileSync(path, 'utf8').match(/server:\s*https:\/\/([0-9.]+):\d+/);
      if (m) push(`${name} master`, m[1], 'k3s');
    }
  } catch {
    // Best effort: whatever was found so far.
  }
  return hosts;
}

type SshRunner = (
  ip: string,
  sshKeyPath: string,
  argv: string[],
  options: { timeout: number; transportRetry: boolean },
) => Promise<string>;

/**
 * Collect the host sections for every host, in parallel: one bounded ssh
 * call each through `run` (sshRun by default: argv form, the scenario's key,
 * known_hosts pinned beside it). Section labels name the host and its
 * address; every text is redacted. A host whose ssh fails is one section
 * saying so. Never throws.
 */
export async function collectHostDiagnostics({
  hosts,
  sshKeyPath,
  run = sshRun as SshRunner,
}: {
  hosts: ClusterHost[];
  sshKeyPath: string | null;
  run?: SshRunner;
}): Promise<Array<[string, string]>> {
  if (!sshKeyPath) return [['host diagnostics', '(skipped: no ssh key for this scenario)']];
  if (hosts.length === 0) {
    return [['host diagnostics', '(skipped: no cluster node addresses in deploy state or config)']];
  }
  const perHost = await Promise.all(
    hosts.map(async (h): Promise<Array<[string, string]>> => {
      const prefix = `host ${h.label} (${h.ip})`;
      try {
        const out = await run(h.ip, sshKeyPath, hostDiagnosticArgv(h.unit), {
          timeout: HOST_DIAG_SSH_TIMEOUT_MS,
          transportRetry: false,
        });
        // splitHostDiagnosticOutput redacts the whole output before it cuts.
        return splitHostDiagnosticOutput(out).map(([name, text]) => [`${prefix}: ${name}`, text]);
      } catch (err) {
        const e = err as { message?: string; stdout?: unknown; stderr?: unknown };
        // Redact everything first, then cut: never the other way round.
        const first = redactHostDiagnostics(String(e?.message ?? err).split('\n')[0]);
        const output = redactHostDiagnostics(
          [e?.stdout, e?.stderr]
            .map((v) => String(v ?? '').trim())
            .filter(Boolean)
            .join('\n'),
        );
        const tail = output ? `\n${capTail(output, 2000)}` : '';
        return [[prefix, `(ssh failed: ${first.slice(0, 300)})${tail}`]];
      }
    }),
  );
  return perHost.flat();
}
