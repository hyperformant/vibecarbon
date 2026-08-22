/**
 * SSH-based server resource utilization collection for e2e tests.
 *
 * Connects to deployed servers, collects CPU/memory/disk metrics, and returns
 * typed results. All functions are designed to fail gracefully — metric
 * collection should never crash a test.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResourceMetrics } from '../scenarios/types.js';
import { sshUnreachableSince } from './ssh-reachability.js';

/**
 * Standard e2e SSH `-o` options: bounded connect, no host-key prompts, quiet.
 * Single source for every e2e SSH callsite (checks, lifecycle diagnostics).
 *
 * StrictHostKeyChecking=no + UserKnownHostsFile=/dev/null is DELIBERATE here,
 * unlike the CLI's pinned host-keys (src/lib/host-keys.js): these are
 * throwaway test servers on recycled Hetzner IPs, and pinning would hard-fail
 * every scenario after the first.
 *
 * BatchMode=yes — without this, a key-auth failure (e.g. between scenarios
 * when a server has been recycled and the host key changes) falls back to
 * password prompt. With DISPLAY set, ssh spawns ssh-askpass and the call
 * hangs for the timeout instead of failing fast. The runner-level env
 * guard in tests/e2e/runner.ts kills askpass globally, but we still
 * pass the flag here so an SSH-only invocation outside that env (a unit
 * test, an interactive `tsx` debug session) is also safe.
 */
export function e2eSshOpts(connectTimeoutSec = 5): string[] {
  return [
    '-o',
    `ConnectTimeout=${connectTimeoutSec}`,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'BatchMode=yes',
  ];
}

const SSH_OPTS = e2eSshOpts(5);

/**
 * Execute a command on a remote server via SSH.
 * Uses execFileSync (no shell) to avoid injection risks.
 * Returns the trimmed stdout or null on failure.
 */
function sshExec(serverIp: string, sshKeyPath: string, command: string): string | null {
  try {
    // SECURITY: execFileSync invokes ssh directly without a shell.
    // The remote command is passed as a single argument to ssh, which
    // forwards it to the remote shell. serverIp and sshKeyPath come
    // from our own config files, not from user input.
    const result = execFileSync(
      'ssh',
      [...SSH_OPTS, '-i', sshKeyPath, `root@${serverIp}`, command],
      { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return result.toString().trim();
  } catch {
    // Deliberately does NOT condemn the host. This is a single-shot probe on a
    // 5s connect timeout with no retry — far too weak an instrument to latch a
    // verdict that makes the continuity check give up on the promoted primary.
    // One unlucky 5s window (a transient uplink stall, sshd under MaxStartups
    // during the verify fan-out) would otherwise poison every later SSH-gated
    // check against a perfectly healthy node.
    //
    // Nothing is lost by staying read-only: the config canary runs earlier in
    // the same phase (_run-lifecycle.ts — canary before collectAll) with a 90s
    // budget and an explicit abort predicate, so a genuinely black-holed host
    // is already condemned by the time metrics are collected. The metrics path
    // consumes that verdict (see collectResourceMetrics) and reports it; it
    // never writes one.
    return null;
  }
}

/**
 * Parse /proc/stat CPU values.
 * Returns { idle, total } or null if the line cannot be parsed.
 *
 * /proc/stat first line format:
 *   cpu  user nice system idle iowait irq softirq steal guest guest_nice
 */
function parseCpuLine(line: string): { idle: number; total: number } | null {
  // Remove the "cpu" prefix and split on whitespace
  const parts = line
    .replace(/^cpu\s+/, '')
    .trim()
    .split(/\s+/)
    .map(Number);
  if (parts.length < 4 || parts.some(Number.isNaN)) return null;

  const idle = parts[3]; // 4th field is idle
  const total = parts.reduce((sum, v) => sum + v, 0);
  return { idle, total };
}

/**
 * Collect CPU usage by taking two /proc/stat snapshots 1 second apart.
 * Returns CPU usage percentage or null on failure.
 */
function collectCpu(serverIp: string, sshKeyPath: string): number | null {
  // Single SSH call: read /proc/stat, sleep 1s, read again.
  // This avoids two separate SSH connections.
  const output = sshExec(
    serverIp,
    sshKeyPath,
    'head -1 /proc/stat && sleep 1 && head -1 /proc/stat',
  );
  if (!output) return null;

  const lines = output.split('\n').filter((l) => l.startsWith('cpu '));
  if (lines.length < 2) return null;

  const sample1 = parseCpuLine(lines[0]);
  const sample2 = parseCpuLine(lines[1]);
  if (!sample1 || !sample2) return null;

  const idleDelta = sample2.idle - sample1.idle;
  const totalDelta = sample2.total - sample1.total;
  if (totalDelta === 0) return 0;

  return ((totalDelta - idleDelta) / totalDelta) * 100;
}

/**
 * Collect memory metrics from `free -m`.
 * Returns { usedMb, totalMb } or null on failure.
 *
 * Expected output:
 *               total        used        free      shared  buff/cache   available
 * Mem:           7951        1234        4567         123        2150        6234
 */
function collectMemory(
  serverIp: string,
  sshKeyPath: string,
): { usedMb: number; totalMb: number } | null {
  const output = sshExec(serverIp, sshKeyPath, 'free -m');
  if (!output) return null;

  const memLine = output.split('\n').find((l) => l.startsWith('Mem:'));
  if (!memLine) return null;

  const parts = memLine.split(/\s+/);
  // parts[0] = "Mem:", parts[1] = total, parts[2] = used
  const totalMb = Number(parts[1]);
  const usedMb = Number(parts[2]);
  if (Number.isNaN(totalMb) || Number.isNaN(usedMb)) return null;

  return { usedMb, totalMb };
}

/**
 * Collect disk metrics from `df -BG /`.
 * Returns { usedGb, totalGb } or null on failure.
 *
 * Expected output:
 * Filesystem     1G-blocks  Used Available Use% Mounted on
 * /dev/sda1            78G   12G       62G  16% /
 */
function collectDisk(
  serverIp: string,
  sshKeyPath: string,
): { usedGb: number; totalGb: number } | null {
  const output = sshExec(serverIp, sshKeyPath, 'df -BG /');
  if (!output) return null;

  const lines = output.split('\n');
  // The data is on the second line (first is header)
  if (lines.length < 2) return null;

  const parts = lines[1].split(/\s+/);
  // parts[0] = filesystem, parts[1] = size, parts[2] = used
  // Values end in 'G', e.g. "78G", "12G"
  const totalGb = Number.parseInt(parts[1], 10);
  const usedGb = Number.parseInt(parts[2], 10);
  if (Number.isNaN(totalGb) || Number.isNaN(usedGb)) return null;

  return { usedGb, totalGb };
}

/**
 * Collect resource utilization metrics from a server via SSH.
 * Returns null if the SSH connection fails or metrics cannot be parsed.
 */
export async function collectResourceMetrics(
  serverIp: string,
  sshKeyPath: string,
): Promise<ResourceMetrics | null> {
  // Already-condemned host: three SSH round-trips (one of them with a built-in
  // 1s sleep) against a black-holed :22 buy nothing but wall-clock.
  if (sshUnreachableSince(serverIp)) return null;
  try {
    // CPU requires a 1-second sleep between samples, so we run it first.
    // Memory and disk are instant but depend on the same SSH connection being reachable.
    const cpuPercent = collectCpu(serverIp, sshKeyPath);
    if (cpuPercent === null) return null;

    const memory = collectMemory(serverIp, sshKeyPath);
    if (!memory) return null;

    const disk = collectDisk(serverIp, sshKeyPath);
    if (!disk) return null;

    return {
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memoryUsedMb: memory.usedMb,
      memoryTotalMb: memory.totalMb,
      diskUsedGb: disk.usedGb,
      diskTotalGb: disk.totalGb,
    };
  } catch {
    return null;
  }
}

/**
 * Extract the k3s registry-mirror address from the contents of a node's
 * `/etc/rancher/k3s/registries.yaml`. That file is the one place both
 * providers' cloud-init actually write the mirror address, and it's the
 * SAME shape on both: `carbon/cloud-init/k3s/master-init.sh` (Hetzner)
 * hardcodes the mirror to the static private IP it pins at Pulumi
 * declare-time (`10.0.1.1`); `carbon/cloud-init/k3s/do-master-init.sh`
 * (DigitalOcean) has no static IP to pin — DO VPCs assign private IPs only
 * after the droplet exists — so it resolves its own address from DO's
 * metadata service at boot and writes that instead. Reading the address
 * back off the node's own registries.yaml is the one derivation that's
 * correct for both, without hardcoding either provider's shape or a second
 * copy of the address logic in test code.
 *
 * Expected shape (both providers, byte-identical apart from the address):
 *   mirrors:
 *     "<address>:5000":
 *       endpoint:
 *         - "http://<address>:5000"
 *
 * Returns null if the content doesn't contain that line (missing file,
 * ssh failure text piped in instead, or an unexpected k3s registries.yaml
 * shape).
 */
export function extractRegistryMirrorAddress(registriesYaml: string): string | null {
  const match = registriesYaml.match(/^ {2}"([^"]+)":$/m);
  return match ? match[1] : null;
}

/**
 * Configuration structure for a single environment within .vibecarbon.json.
 * Only the fields relevant to server IP extraction are typed here.
 *
 * For k8s deployments the orchestrator now persists ONE entry per role
 * (master + supabase + worker-N), so iterating `servers[].ip` already
 * fans out to every node. The `supabaseIp` field on the master entry is
 * kept for back-compat with failover.js's existing lookup; we read it
 * here too so older `.vibecarbon.json` files that pre-date the multi-
 * entry persistence still get supabase covered.
 */
interface EnvConfig {
  deployMode?: string;
  servers?: Array<{
    ip: string;
    name?: string;
    role?: string;
    supabaseIp?: string;
  }>;
  ha?: {
    enabled?: boolean;
    primary?: { masterIp: string; supabaseIp?: string; region?: string };
    standby?: { masterIp: string; supabaseIp?: string; region?: string };
  };
}

interface ProjectConfig {
  environments?: Record<string, EnvConfig>;
}

/**
 * Get the server IP(s) for an environment from the .vibecarbon.json config.
 *
 * Returns every node's public IP that the test could meaningfully resize
 * or probe — for k8s/k8s-HA that means master + supabase + each worker
 * (and on HA, the same triplet for the standby cluster). For
 * compose/compose-HA it's the one VPS (or two for HA primary/standby).
 *
 * Returns an empty array if the config cannot be read or the environment
 * is not found.
 */
export function getServerIps(projectDir: string, env: string): string[] {
  try {
    const configPath = join(projectDir, '.vibecarbon.json');
    if (!existsSync(configPath)) return [];

    const config: ProjectConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    const envConfig = config.environments?.[env];
    if (!envConfig) return [];

    const out: string[] = [];
    const seen = new Set<string>();
    const push = (ip?: string | null) => {
      if (!ip || seen.has(ip)) return;
      seen.add(ip);
      out.push(ip);
    };

    // HA deployments still persist a top-level `ha.primary` / `ha.standby`
    // block alongside the servers array. Pull master + supabase from each
    // — verify-scale needs every Hetzner-managed node, and the standby
    // cluster's supabase is otherwise invisible to the test.
    if (envConfig.ha?.enabled && envConfig.ha.primary && envConfig.ha.standby) {
      push(envConfig.ha.primary.masterIp);
      push(envConfig.ha.primary.supabaseIp);
      push(envConfig.ha.standby.masterIp);
      push(envConfig.ha.standby.supabaseIp);
    }

    // Non-HA deployments (and HA's per-cluster role entries): one entry per
    // node role on k8s (master + supabase + worker-N), one VPS on compose.
    // We also surface any `supabaseIp` carried on the master entry for
    // back-compat with older `.vibecarbon.json` files persisted before the
    // multi-entry shape landed.
    // Role-primary first. Callers treat serverIps[0] as "the master" (the node
    // to SSH for exec-based checks), and a compose-HA failover flips the `role`
    // field in place without reordering the array — so array order names the
    // OLD primary once a failover has happened. Only HA compose configs carry
    // primary/standby roles; k8s configs use master/supabase/worker and are
    // left in their existing, meaningful order.
    const servers = envConfig.servers ?? [];
    const rolePrimary = servers.find((s) => s.role === 'primary');
    for (const srv of rolePrimary
      ? [rolePrimary, ...servers.filter((s) => s !== rolePrimary)]
      : servers) {
      push(srv.ip);
      push(srv.supabaseIp);
    }

    return out;
  } catch {
    return [];
  }
}

/**
 * Get the SSH key path for a deployed environment.
 * Checks environment-specific key first, then falls back to a shared key.
 * Returns null if no key file is found.
 */
export function getSshKeyPath(projectDir: string, env: string): string | null {
  try {
    // Environment-specific key (matches deploy.js convention: deploy_key_{env})
    const envKeyPath = join(projectDir, '.vibecarbon', `deploy_key_${env}`);
    if (existsSync(envKeyPath)) return envKeyPath;

    // Fallback: shared key
    const sharedKeyPath = join(projectDir, '.vibecarbon', 'ssh_key');
    if (existsSync(sharedKeyPath)) return sharedKeyPath;

    return null;
  } catch {
    return null;
  }
}
