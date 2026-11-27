/**
 * A fake Scaleway host for running a boot script's identity code
 * (carbon/cloud-init/k3s/_scaleway-metadata.sh, and the lines around it)
 * under bash without touching this machine.
 *
 * - PATH is one temp directory: a fake metadata service (`curl`), a fake
 *   kernel (`ip`), a `sleep` that returns at once, and links to the real
 *   bash, python3, awk, grep, seq, mkdir, chmod and cat. Nothing else
 *   resolves, so no systemctl, hostnamectl or k3s on this machine can run.
 * - The script's system roots (/usr/local/sbin, /etc/rancher, /etc/systemd)
 *   and the /bin/bash it writes as a shebang are rewritten to the same paths
 *   under the temp directory before it runs. `sandbox` refuses a script that
 *   still names any other absolute path, /dev/null and a URL's path aside.
 * - Every run starts in the temp directory, so a relative path lands there.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

export const SCALEWAY_SYSTEM_ROOTS = ['/usr/local/sbin', '/etc/rancher', '/etc/systemd'] as const;
/** Moved under the root with the system roots: the shebang of a script the include writes. */
const SANDBOXED_INTERPRETER = '/bin/bash';
/** Absolute paths a script may name outside the sandbox: they hold nothing of this machine's. */
const OUTSIDE_PATHS_ALLOWED = new Set(['/dev/null']);
const REAL_TOOLS = ['bash', 'python3', 'awk', 'grep', 'seq', 'mkdir', 'chmod', 'cat'];

/** A network interface: its kernel name, MAC and IPv4 address (none yet when left out). */
export interface Nic {
  name: string;
  mac: string;
  cidr?: string;
  /** The default route leaves by this interface. */
  defaultRoute?: boolean;
  /** The read of its address, counted from 1, that prints nothing: a lease that flaps. */
  addressMissingOnRead?: number;
}

/** The public NIC every Scaleway instance boots with, carrying the default route. */
export const PUBLIC_NIC: Nic = {
  name: 'ens2',
  mac: 'de:00:00:11:22:33',
  cidr: '203.0.113.10/32',
  defaultRoute: true,
};

/** The first executable called `name` on this process's PATH. */
function realTool(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here; try the next directory
    }
  }
  throw new Error(`scaleway-host: no ${name} on PATH`);
}

const BASH = realTool('bash');

/**
 * The interpreter behind `python3`, not the first `python3` on PATH: that can
 * be a version manager's shim (mise, asdf), which refuses to run from a link
 * outside its own directory.
 */
function realPython(): string {
  const r = spawnSync(realTool('python3'), ['-I', '-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
  });
  const executable = r.stdout?.trim();
  if (r.status !== 0 || !executable) throw new Error('scaleway-host: python3 does not run');
  return executable;
}

/**
 * `ip -o link show`, `ip -o -4 addr show dev <name>` and
 * `ip -o route show default` lines for `nics`, as files.
 */
function kernelFiles(nics: Nic[]): Record<string, string> {
  const links = [
    '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00',
    ...nics.map(
      ({ name, mac }, i) =>
        `${i + 2}: ${name}: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000\\    link/ether ${mac} brd ff:ff:ff:ff:ff:ff`,
    ),
  ];
  const routes = nics
    .filter(({ defaultRoute }) => defaultRoute)
    .map(
      ({ name, cidr }) =>
        `default via 62.210.0.1 dev ${name} proto dhcp src ${cidr?.split('/')[0] ?? '0.0.0.0'} metric 100 `,
    );
  const files: Record<string, string> = {
    links: `${links.join('\n')}\n`,
    routes: routes.map((line) => `${line}\n`).join(''),
  };
  nics.forEach(({ name, cidr, addressMissingOnRead }, i) => {
    files[`addr-${name}`] = cidr
      ? `${i + 2}: ${name}    inet ${cidr} metric 100 brd + scope global dynamic ${name}\\       valid_lft 86185sec preferred_lft 86185sec\n`
      : '';
    files[`addr-${name}.reads`] = '0\n';
    if (addressMissingOnRead) files[`addr-${name}.missing-${addressMissingOnRead}`] = '';
  });
  return files;
}

export interface ScalewayHost {
  /** The temp directory everything lives under. */
  root: string;
  /** The /conf?format=json body (a string is sent as is), or null for a service that never answers. */
  setMetadata(body: object | string | null): void;
  /** The interfaces the fake kernel reports from now on. */
  setNics(nics: Nic[]): void;
  /** Interfaces the kernel reports once the first `sleep` has run: a NIC attached late. */
  attachAfterFirstSleep(nics: Nic[]): void;
  /** A fake command on the host's PATH. */
  shim(name: string, body: string): void;
  /** `script` with the system roots moved under `root`. */
  sandbox(script: string): string;
  /** A system path as the sandbox holds it. */
  path(systemPath: string): string;
  /** A file written in the sandbox, with `root` taken back out of its text. */
  read(systemPath: string): string;
  /** How many times `ip` was asked for the link list. */
  linkReads(): number;
  /** Run `script` under bash on this host. */
  run(script: string): { status: number | null; stdout: string; stderr: string };
  /** Run the executable the sandbox holds at `systemPath`, as systemd would. */
  runFile(systemPath: string): { status: number | null; stdout: string; stderr: string };
  cleanup(): void;
}

export function scalewayHost(prefix = 'vc-scaleway-host-'): ScalewayHost {
  const root = createTempDir(prefix);
  const bin = join(root, 'bin');
  const kernel = join(root, 'kernel');
  const late = join(root, 'late');
  for (const dir of [bin, kernel, late]) mkdirSync(dir);
  for (const tool of REAL_TOOLS) {
    symlinkSync(tool === 'python3' ? realPython() : realTool(tool), join(bin, tool));
  }

  const shim = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!${BASH}\n${body}\n`, { mode: 0o755 });
  };
  const writeKernel = (dir: string, nics: Nic[]) => {
    for (const [file, text] of Object.entries(kernelFiles(nics)))
      writeFileSync(join(dir, file), text);
  };

  const metadata = join(root, 'conf.json');
  const calls = join(root, 'ip-calls');
  writeFileSync(calls, '');
  shim(
    'ip',
    [
      `echo "$*" >> '${calls}'`,
      'case "$*" in',
      `  '-o link show') cat '${kernel}/links' ;;`,
      `  '-o route show default') cat '${kernel}/routes' ;;`,
      `  '-o -4 addr show dev '*) f='${kernel}'/addr-"\${!#}"`,
      `    [ -f "$f" ] || { echo "Device \\"\${!#}\\" does not exist." >&2; exit 1; }`,
      '    n=$(($(cat "$f.reads") + 1)); echo "$n" > "$f.reads"',
      '    if [ ! -f "$f.missing-$n" ]; then cat "$f"; fi ;;',
      '  *) echo "fake ip: unexpected: $*" >&2; exit 1 ;;',
      'esac',
    ].join('\n'),
  );
  // The waits sleep between passes; the test does not. A NIC queued by
  // attachAfterFirstSleep appears when the first one returns.
  shim(
    'sleep',
    `for f in '${late}'/*; do [ -f "$f" ] && cat "$f" > '${kernel}'/"\${f##*/}"; done; exit 0`,
  );

  // A word in place of the root, so a path under it reads as relative below.
  const masked = (text: string) => text.replaceAll(root, '__ROOT__');
  const run = (command: string, args: string[]) => {
    const r = spawnSync(command, args, {
      cwd: root,
      env: { PATH: bin, HOME: root },
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
  };

  return {
    root,
    setMetadata(body) {
      if (body === null) {
        shim('curl', 'exit 22');
        return;
      }
      writeFileSync(metadata, typeof body === 'string' ? body : JSON.stringify(body));
      shim('curl', `cat '${metadata}'`);
    },
    setNics: (nics) => writeKernel(kernel, nics),
    attachAfterFirstSleep: (nics) => writeKernel(late, nics),
    shim,
    sandbox(script) {
      let out = script;
      for (const moved of [...SCALEWAY_SYSTEM_ROOTS, SANDBOXED_INTERPRETER]) {
        out = out.replaceAll(moved, `${root}${moved}`);
      }
      // An absolute path: a slash that starts a word (no word character, dot,
      // colon or slash before it, so neither a URL's path nor a relative
      // path) with a path character after it.
      const stray = [...masked(out).matchAll(/(?<![\w.:/-])\/[\w.-][^\s'"`;|&()<>]*/g)]
        .map(([path]) => path)
        .filter((path) => !OUTSIDE_PATHS_ALLOWED.has(path));
      if (stray.length > 0) {
        throw new Error(
          `scaleway-host: the script still names ${stray.join(', ')} on this machine`,
        );
      }
      return out;
    },
    path: (systemPath) => `${root}${systemPath}`,
    read: (systemPath) => readFileSync(`${root}${systemPath}`, 'utf8').replaceAll(root, ''),
    linkReads: () =>
      readFileSync(calls, 'utf8')
        .split('\n')
        .filter((line) => line === '-o link show').length,
    run: (script) => run(BASH, ['-c', script]),
    // Executed itself, not handed to bash: its mode and shebang are under test.
    runFile: (systemPath) => run(`${root}${systemPath}`, []),
    cleanup: () => cleanupTempDir(root),
  };
}
