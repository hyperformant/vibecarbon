/**
 * Reads one server's pending updates and restart state over a single ssh
 * session. The script it sends changes apt state (apt-get update), so it only
 * ever runs on a server or inside a container.
 */
import {
  APT_DAILY_UNITS_WAIT_SECONDS,
  APT_LOCK_TIMEOUT_SECONDS,
  aptGet,
  aptQuietUpdate,
  aptWaitForDailyUnits,
  UNATTENDED_UPGRADE,
} from '../deploy/apt.js';
import { hostReporterScript } from '../host-reporter.js';
import { PACKAGE_PATTERN, parseHostState } from '../host-state.js';
import { DOCKER_PACKAGES, DOCKER_SOURCE_ONLY } from '../iac/docker-install.js';
import { sshKeyPathFor, sshRun } from '../ssh.js';
import { describeSshError } from '../status/cluster-snapshot.js';

const REPORTER_EOF = 'VC_INSPECT_REPORTER_EOF';
/** The reporter's path unit: on disk once the installer has run. */
const REPORTER_UNIT = '/etc/systemd/system/vibecarbon-host-reporter.path';
/**
 * The script first waits up to APT_DAILY_UNITS_WAIT_SECONDS for Ubuntu's daily
 * apt units to finish. Then each of its apt-get commands may wait up to
 * APT_LOCK_TIMEOUT_SECONDS for a dpkg lock: two on compose (Ubuntu's lists and
 * Docker's), one on k8s. The ssh call outlasts all of them by 120 s, so a
 * server whose daily job runs longer than that reads as a failed apt check
 * (with its "daily security updates may be running" hint), never as an ssh
 * timeout. tests/unit/deploy/apt-daily-wait-census.test.ts checks the sum.
 */
const INSPECT_TIMEOUT_MS =
  (APT_DAILY_UNITS_WAIT_SECONDS + 2 * APT_LOCK_TIMEOUT_SECONDS + 120) * 1000;

/**
 * @typedef {{ host: import('../host-state.js').HostState, bootId: string, ubuntu: string[], docker: { packages: Array<{ name: string, from: string, to: string }> } | null, reporter: boolean | null }} TargetState
 *   reporter: whether the reporter's path unit is installed (compose); null on
 *   k8s, where the node's host-state annotation says it.
 */

/**
 * Print a failed step's `@@error` line and end the script, so no later step
 * waits again. Exit 0, so the output is parsed and the error read as a failed
 * apt check. printf, not echo: dash's echo turns a backslash in the text (the
 * server's own output, in $why) into a newline or a control character.
 *
 * @param {string} message sh double-quoted text, may use $?/$rc/$why
 */
const stopWith = (message) => `{ printf '%s\\n' "@@error ${message}"; exit 0; }`;

/**
 * Sets $why to why a command failed, from its output in $out: ": " and the
 * last line that has text, or nothing when it printed none. The server wrote
 * it and the person running update reads it, so it keeps printable ASCII only
 * (tr in the C locale), without leading blanks, and at most 200 characters.
 * Control characters go before the lines are picked, so a line of nothing but
 * escapes counts as blank.
 */
const WHY_FROM_OUT =
  "why=$(export LC_ALL=C; printf '%s\\n' \"$out\" | tr -cd '[:print:]\\n' | sed -e 's/^[[:space:]]*//' -e '/^$/d' | tail -n 1 | cut -c1-200 | sed 's/^/: /')";

/**
 * @param {'compose' | 'k8s'} kind
 * @returns {string} POSIX sh
 */
export function INSPECT_SCRIPT(kind) {
  const lines = [
    'PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    // Ubuntu's daily apt job (apt-daily, then apt-daily-upgrade, which runs
    // unattended-upgrade) often runs in a server's first minutes. Neither
    // `apt-get update` (the lists lock) nor unattended-upgrade (its own lock)
    // waits for it: they exit 100 and 1 at once. So the whole read waits for
    // it first, which also gives a restart state that counts what it installed.
    // Bounded and fails open (apt.js); its output is the wait's, not the read's.
    `${aptWaitForDailyUnits()} >/dev/null 2>&1 </dev/null`,
    'echo @@host',
    `sh -s -- --print <<'${REPORTER_EOF}'`,
    hostReporterScript().trimEnd(),
    REPORTER_EOF,
    'echo @@boot-id',
    'cat /proc/sys/kernel/random/boot_id',
    'echo @@ubuntu',
    `${aptGet('update -qq')} >/dev/null 2>&1 </dev/null || ${stopWith('apt-get update exited $?')}`,
    'if command -v unattended-upgrade >/dev/null 2>&1 </dev/null; then',
    `  out=$(${UNATTENDED_UPGRADE} --dry-run --verbose 2>&1 </dev/null); rc=$?`,
    '  if [ "$rc" -ne 0 ]; then',
    `    ${WHY_FROM_OUT}`,
    `    ${stopWith('unattended-upgrade exited $rc$why')}`,
    '  fi',
    `  printf '%s\\n' "$out" | sed -n 's/^Packages that will be upgraded: *//p'`,
    'else',
    `  ${stopWith('unattended-upgrade not installed')}`,
    'fi',
  ];
  if (kind === 'compose') {
    lines.push(
      'echo @@reporter',
      `if [ -f ${REPORTER_UNIT} ]; then echo installed; else echo missing; fi`,
      'echo @@docker',
      `if [ -f /etc/apt/sources.list.d/docker.list ]; then { ${aptQuietUpdate(DOCKER_SOURCE_ONLY)}; } >/dev/null 2>&1 </dev/null || ${stopWith('docker apt-get update exited $?')}; fi`,
      `apt-cache policy ${DOCKER_PACKAGES.join(' ')} 2>/dev/null </dev/null`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** A Debian version as apt-cache prints it: epoch, upstream and revision. */
const VERSION_PATTERN = /^[0-9A-Za-z.+:~-]+$/;

/** @returns {Map<string, string>} section name to its text */
function sections(stdout) {
  const out = new Map();
  let name = null;
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^@@([a-z-]+)\s*$/);
    if (m) {
      name = m[1];
      out.set(name, '');
    } else if (name) {
      out.set(name, `${out.get(name)}${line}\n`);
    }
  }
  return out;
}

function parseDocker(text) {
  const packages = [];
  let seen = false;
  let name = null;
  let installed = null;
  for (const raw of text.split('\n')) {
    const head = raw.match(/^(\S+):\s*$/);
    if (head) {
      name = head[1];
      installed = null;
      continue;
    }
    const inst = raw.match(/^\s+Installed:\s*(\S+)/);
    if (inst) installed = inst[1];
    const cand = raw.match(/^\s+Candidate:\s*(\S+)/);
    if (cand && name) {
      if (cand[1] === '(none)') continue;
      seen = true;
      // The server wrote these, and they reach the plan: a name or version
      // that does not read as one is dropped, never shown.
      const valid =
        PACKAGE_PATTERN.test(name) &&
        VERSION_PATTERN.test(installed ?? '') &&
        VERSION_PATTERN.test(cand[1]);
      if (valid && installed !== '(none)' && installed !== cand[1]) {
        packages.push({ name, from: installed, to: cand[1] });
      }
    }
  }
  return seen ? { packages } : null;
}

/**
 * @param {string} stdout
 * @param {'compose' | 'k8s'} kind
 * @returns {TargetState}
 * @throws {Error} inspect output missing @@<section>
 */
export function parseInspectOutput(stdout, kind) {
  const s = sections(stdout);
  const failed = String(stdout).match(/^@@error (.+)$/m);
  if (failed) throw new Error(`could not check for updates: ${failed[1].trim()}`);
  const need = (n) => {
    if (!s.has(n)) throw new Error(`inspect output missing @@${n}`);
    return s.get(n);
  };
  const host = parseHostState(need('host').trim());
  if (!host) throw new Error('inspect output has an unreadable @@host');
  const bootId = need('boot-id').trim();
  const ubuntu = need('ubuntu')
    .split(/\s+/)
    .filter((n) => PACKAGE_PATTERN.test(n));
  const docker = kind === 'compose' ? parseDocker(need('docker')) : null;
  const reporter = kind === 'compose' ? need('reporter').trim() === 'installed' : null;
  return { host, bootId, ubuntu, docker, reporter };
}

/**
 * @param {import('./inventory.js').UpdateTarget} target
 * @param {{ sshRun?: Function, envName?: string }} [deps]
 * @returns {Promise<TargetState>}
 */
export async function inspectTarget(target, deps = { sshRun }) {
  const run = deps.sshRun ?? sshRun;
  const key = sshKeyPathFor(deps.envName ?? '');
  const out = await run(target.ip, key, ['sh', '-s'], {
    input: INSPECT_SCRIPT(target.kind),
    timeout: INSPECT_TIMEOUT_MS,
    transportRetry: false,
  });
  return parseInspectOutput(out, target.kind);
}

/**
 * The name the server at a k8s node's address gives, when it is not that
 * node's. A node writes its own ExternalIP, so a compromised node could point
 * the update's root commands at another server. k3s names a node after its
 * hostname, in lower case (no install passes --node-name), and the reporter
 * prints the same hostname.
 *
 * @param {import('./inventory.js').UpdateTarget} target
 * @param {TargetState} state
 * @returns {string | null}
 */
function otherHost(target, state) {
  if (target.kind !== 'k8s') return null;
  const node = target.nodeName ?? target.name;
  return state.host.host.toLowerCase() === node ? null : state.host.host;
}

/**
 * Compose servers come from the saved config. A k8s node whose server gives
 * another name is skipped, at plan time and at the re-check alike.
 *
 * @param {import('./inventory.js').UpdateTarget[]} targets
 * @param {{ sshRun?: Function, envName?: string }} [deps]
 */
export async function inspectAll(targets, deps = { sshRun }) {
  const results = await Promise.all(
    targets.map((target) =>
      inspectTarget(target, deps).then(
        (state) => ({ target, state }),
        (err) => ({ target, err }),
      ),
    ),
  );
  const inspected = [];
  const skipped = [];
  for (const r of results) {
    const { name, ip } = r.target;
    if (r.err) {
      skipped.push({ name, ip, reason: describeSshError(r.err) });
      continue;
    }
    const host = otherHost(r.target, r.state);
    if (host)
      skipped.push({
        name,
        ip,
        reason: `the server at ${ip} says it is ${host}, not ${r.target.nodeName ?? name}`,
      });
    else inspected.push(r);
  }
  return { inspected, skipped };
}
