/**
 * What each server says about its own size, read over ssh: its vCPU count
 * and its memory. verify-scale's proof that a resize happened when the
 * provider's API cannot answer. It asks the servers themselves, so a
 * provider outage between the scale and the check costs nothing.
 *
 * The type snapshots in ./server-types.ts stay the first proof, since they name
 * the exact target type. Before this, an API that answered 503 sent verify-scale
 * to a grep of the scale's own output, which could never pass on k8s (its
 * success line has no arrow) and only repeated what the CLI claimed.
 */
import { type SshExecOnceResult, sshExecOnce } from './ssh.js';

export interface Hardware {
  cpus: number;
  memKiB: number;
}

/** Two lines: the vCPU count, then MemTotal in KiB. */
export const HARDWARE_COMMAND = "nproc && awk '/^MemTotal:/{print $2}' /proc/meminfo";

const READ_TIMEOUT_MS = 30_000;

/**
 * Memory must grow by more than this share to count as a resize on its own:
 * MemTotal moves by a few MiB between boots of one size (kernel reservations),
 * and every rung of the scale ladder at least doubles a dimension.
 */
const MEMORY_GROWTH = 1.1;

export function parseHardware(out: string): Hardware | null {
  const [cpuLine = '', memLine = ''] = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const cpus = Number(cpuLine);
  const memKiB = Number(memLine);
  if (!/^\d+$/.test(cpuLine) || !/^\d+$/.test(memLine)) return null;
  if (cpus < 1 || memKiB < 1) return null;
  return { cpus, memKiB };
}

/**
 * Read every server that answers. A server that does not is left out, and the
 * verdict below then has fewer servers to judge; it fails when it has none.
 */
export function readHardware(
  ips: string[],
  sshKeyPath: string | null,
  run: (
    ip: string,
    key: string,
    remote: string,
    timeoutMs: number,
  ) => SshExecOnceResult = sshExecOnce,
): Record<string, Hardware> {
  const out: Record<string, Hardware> = {};
  if (!sshKeyPath) return out;
  for (const ip of ips) {
    const res = run(ip, sshKeyPath, HARDWARE_COMMAND, READ_TIMEOUT_MS);
    const hw = res.ok ? parseHardware(res.stdout) : null;
    if (hw) out[ip] = hw;
  }
  return out;
}

const show = (m: Record<string, Hardware>) =>
  Object.entries(m)
    .map(([ip, h]) => `${ip}=${h.cpus} vCPU/${Math.round(h.memKiB / 1024)} MiB`)
    .join(', ') || 'none';

/**
 * Null when every server read after the scale is bigger than every server read
 * before it: at least as many vCPUs and as much memory as the largest one
 * before, and more of one of them. Otherwise why not. Compared across the sets,
 * not per address, since a compose scale replaces its servers and their
 * addresses change. A partial scale (one server resized, another left) fails.
 */
export function hardwareVerdict(
  before: Record<string, Hardware>,
  after: Record<string, Hardware>,
): string | null {
  const pre = Object.values(before);
  const post = Object.entries(after);
  if (pre.length === 0 || post.length === 0) {
    return `could not read the servers' size over ssh (before: ${show(before)}; after: ${show(after)})`;
  }
  const maxCpus = Math.max(...pre.map((h) => h.cpus));
  const maxMem = Math.max(...pre.map((h) => h.memKiB));
  const notBigger = post.filter(
    ([, h]) =>
      h.cpus < maxCpus ||
      h.memKiB < maxMem / MEMORY_GROWTH ||
      !(h.cpus > maxCpus || h.memKiB > maxMem * MEMORY_GROWTH),
  );
  if (notBigger.length === 0) return null;
  return (
    `not resized: ${notBigger.map(([ip]) => ip).join(', ')} ` +
    `(before: ${show(before)}; after: ${show(after)})`
  );
}
