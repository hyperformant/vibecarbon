import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runCommandAsync } from './command.js';

/**
 * Absolute path to the per-environment known_hosts file for SSH strict-checking.
 *
 * NOTE: Permission enforcement below relies on POSIX modes and is a no-op on
 * Windows. This CLI targets Linux/macOS developer machines and Linux servers.
 *
 * @param {string} env - environment name
 * @param {string} [cwd=process.cwd()] - project root
 * @returns {string}
 */
export function knownHostsPath(env, cwd = process.cwd()) {
  return join(cwd, '.vibecarbon', `known_hosts_${env}`);
}

/**
 * Overwrite the per-environment known_hosts file with the given host-key lines.
 *
 * Enforces `.vibecarbon/` mode 0o700 and file mode 0o600 unconditionally —
 * `mkdirSync`/`writeFileSync` only apply `mode` on initial creation, so we
 * follow each with `chmodSync` to guarantee the mode even when the target
 * already exists (which it will on every re-pin after first deploy).
 *
 * @param {string} env
 * @param {string[]} hostKeyLines - one host-key entry per element
 * @param {string} [cwd=process.cwd()]
 */
export function pinHostKey(env, hostKeyLines, cwd = process.cwd()) {
  const path = knownHostsPath(env, cwd);
  writeKnownHosts(path, hostKeyLines);
}

/**
 * Low-level writer shared by pinHostKey / seedKnownHosts: overwrite `khPath`
 * with the given lines, enforcing `.vibecarbon/` 0o700 and file 0o600 even
 * when the targets already exist (mkdir/writeFile only apply `mode` on create).
 *
 * @param {string} khPath
 * @param {string[]} hostKeyLines
 */
function writeKnownHosts(khPath, hostKeyLines) {
  const dir = dirname(khPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(khPath, `${hostKeyLines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(khPath, 0o600);
}

/**
 * Derive the per-environment known_hosts path from an SSH key path.
 *
 * Every SSH/SCP caller in the codebase already threads the deploy key path
 * (`.vibecarbon/deploy_key_<env>` or `.vibecarbon/ssh-<env>`). Placing
 * `known_hosts_<env>` beside it lets every caller pin host keys per-env
 * WITHOUT having to thread a separate `env` argument through helpers that
 * only receive `(ip, sshKeyPath)`. Self-consistent: the same key path always
 * derives the same known_hosts file, so seeding and verification agree.
 *
 * @param {string} sshKeyPath
 * @returns {string}
 */
export function knownHostsPathForKey(sshKeyPath) {
  const dir = dirname(sshKeyPath);
  const env = basename(sshKeyPath)
    .replace(/^deploy_key_/, '')
    .replace(/^ssh-/, '');
  return join(dir, `known_hosts_${env}`);
}

/**
 * Where multiplexing master sockets live. Created at module load (ssh will
 * not mkdir the ControlPath parent) with owner-only permissions — a
 * world-readable socket dir would hand live sessions to any local user.
 */
export const SSH_MUX_DIR = join(homedir(), '.vibecarbon', 'ssh-mux');
mkdirSync(SSH_MUX_DIR, { recursive: true, mode: 0o700 });

/**
 * Common ssh/scp `-o` tokens appended to every host-key-pinned invocation.
 *
 * BatchMode=yes: never fall back to an interactive password/askpass prompt —
 * a single missed callsite hangs deploys for hours (see cli.js env hardening).
 *
 * ConnectTimeout only covers TCP connect — once the socket is open, ssh
 * will wait indefinitely for the SSH banner / protocol traffic. RCA from
 * iter-confirm 2026-05-02: a freshly-created Hetzner VPS accepted TCP on
 * port 22 but never sent the SSH banner, so a scale.ha.fan SSH hung for
 * ~600s ("Connection timed out during banner exchange") until the test
 * runner SIGKILLed it. ServerAliveInterval+CountMax force ssh to give up
 * after 60s of no protocol-level traffic, surfacing the failure cleanly
 * so the existing waitForSSH/runCommandAsync retry layers can recover.
 * Keepalives are protocol-level — long-running remote commands (tar, pg
 * dumps) won't false-trigger because sshd acks keepalives independently
 * of the command's stdout.
 */
export const SSH_CONNECTION_OPTS = Object.freeze([
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=4',
  // Connection MULTIPLEXING — the root fix for the "ssh transport blip"
  // mitigation class (audit 2026-08-16). Two of its seven members were proven
  // to be our own fan-out: MaxStartups drops under the verify fan-out, and
  // sshd missing the banner while CPU-starved by our concurrent reconcile
  // (7d045250). MaxStartups counts CONNECTIONS, not channels — with a master
  // per host, every subsequent ssh/scp rides the existing socket: one TCP
  // handshake and one key exchange per host instead of one per call, so the
  // pressure the retry ladders absorb stops being generated. `auto` degrades
  // gracefully: if the socket is stale or the master is gone, ssh falls back
  // to a plain connection and becomes the new master. `%C` hashes
  // local host + remote host + port + user, keeping the socket path unique
  // and under the unix-socket length limit. ControlPersist keeps the master
  // alive 90s past the last session so a deploy step's bursts share it, and
  // reaps it on idle — nothing to clean up on destroy (a socket to a deleted
  // server is stale; `auto` bypasses it). Platform-safe: native Windows is
  // unsupported (cli.js checkPlatform); macOS/Linux/WSL all ship
  // ControlMaster.
  '-o',
  'ControlMaster=auto',
  '-o',
  `ControlPath=${SSH_MUX_DIR}/%C`,
  '-o',
  'ControlPersist=90s',
]);

/**
 * Build the full ssh/scp `-o` option list for host-key pinning keyed off the
 * deploy key path: pin against the per-env known_hosts DERIVED from the key
 * path (knownHostsPathForKey), ignore the system/global file, and accept-new —
 * which TOFU's a fresh/recycled IP but REJECTS a changed key for an
 * already-pinned host, so a MITM against an established env fails.
 *
 * Single source of truth shared by lib/ssh.js#sshHostKeyOpts (backup/restore/
 * scale/failover/walg) and the compose deploy path (composeSshOpts in
 * lib/deploy/compose/index.js) — host-key/MITM hardening changed here reaches
 * both halves of the product and cannot drift.
 *
 * @param {string} sshKeyPath
 * @returns {string[]} argv `-o` tokens
 */
export function buildHostKeyOpts(sshKeyPath) {
  return buildHostKeyOptsForPath(knownHostsPathForKey(sshKeyPath));
}

/**
 * Same option list keyed off an already-derived known_hosts path, for callers
 * that thread `khPath` directly (the k3s deploy path, k8s-ha repair flows).
 *
 * @param {string} khPath - absolute path to .vibecarbon/known_hosts_<env>
 * @returns {string[]} argv `-o` tokens
 */
export function buildHostKeyOptsForPath(khPath) {
  return [
    '-o',
    `UserKnownHostsFile=${khPath}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'StrictHostKeyChecking=accept-new',
    ...SSH_CONNECTION_OPTS,
  ];
}

/**
 * Does a known_hosts line's host field reference `ip`? The first
 * whitespace-delimited field is `host[,host2,...]` (we scan un-hashed, so it
 * is the literal IP, not a `|1|…` hash).
 */
function hostLineMatchesIp(line, ip) {
  const host = line.split(/\s+/)[0] || '';
  return host.split(',').includes(ip);
}

async function defaultKeyscan(ip) {
  // argv form via runCommandAsync (spawn, no shell). `-T 10` bounds the
  // connect; un-hashed output (no `-H`) so seedKnownHosts can strip a stale
  // line for a recycled IP by exact-match. Best-effort: a freshly-booted VPS
  // may not answer yet, so we ignore errors and let the retry loop poll.
  const out = await runCommandAsync(['ssh-keyscan', '-T', '10', ip], {
    silent: true,
    returnOutput: true,
    timeout: 30_000,
    ignoreError: true,
  });
  return typeof out === 'string' ? out : '';
}

/**
 * Seed (or re-seed) the per-env known_hosts file at `khPath` with the target
 * server's real host keys, captured via `ssh-keyscan`. This is the "trusted
 * source" for the pin, run once per env on fresh (re)provision.
 *
 * SECURITY — chosen semantics (documented so the trade-off is auditable):
 *   - Merge, don't clobber: existing lines for OTHER hosts are preserved (HA
 *     keeps primary + standby in one per-env file), but any stale line for
 *     THIS ip is dropped before the fresh scan is appended. That re-pin is why
 *     a Hetzner-recycled IP (destroy → redeploy, same IP, new host key) does
 *     NOT spuriously hard-fail: provisioning replaces the stale pin.
 *   - Only provisioning re-seeds. Every non-provision command (backup, restore,
 *     scale, status, warm deploy) strict-checks against the pinned file and
 *     NEVER re-seeds, so a MITM against an already-established env fails.
 *   - ssh-keyscan itself is trust-on-first-provision (it accepts whatever key
 *     the freshly-created VPS presents). This is the pragmatic trust anchor for
 *     ephemeral cloud VMs with no out-of-band key channel.
 *
 * Returns true if a scan landed and the file was written; false if the scan
 * came back empty (caller's SSH opts still `accept-new`-TOFU on first connect).
 *
 * @param {string} khPath - per-env known_hosts path (see knownHostsPathForKey)
 * @param {string} ip
 * @param {object} [opts]
 * @param {number} [opts.attempts=5]
 * @param {number} [opts.delayMs=2000]
 * @param {(ip: string) => Promise<string>} [opts.keyscan] - injectable for tests
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<boolean>}
 */
export async function seedKnownHosts(khPath, ip, opts = {}) {
  const {
    attempts = 5,
    delayMs = 2000,
    keyscan = defaultKeyscan,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  let scanned = '';
  for (let i = 0; i < attempts; i++) {
    scanned = (await keyscan(ip)).trim();
    if (scanned) break;
    if (i < attempts - 1) await sleep(delayMs);
  }
  if (!scanned) return false;

  let kept = [];
  if (existsSync(khPath)) {
    kept = readFileSync(khPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() && !hostLineMatchesIp(line, ip));
  }
  const merged = [...kept, ...scanned.split('\n').filter((l) => l.trim())];
  writeKnownHosts(khPath, merged);
  return true;
}

/**
 * Opt-OUT of connection multiplexing, for PORT-FORWARD tunnels only.
 *
 * ControlMaster multiplexing (SSH_CONNECTION_OPTS above) is the root fix for
 * per-call connection pressure — but it broke `ssh -f -N -L` tunnels: run
 * 31921730114 showed EVERY compose admin tunnel's first attempt ECONNREFUSED
 * through its full 7.5s reach poll (`ssh: exited 0` — the -f client had
 * backgrounded), where the pre-mux baseline run had zero such failures. A
 * `-f` mux CLIENT registers its forward with the shared master and returns
 * before the listener is usable, and the forward's lifecycle is tied to mux
 * session bookkeeping rather than to the process the caller supervises. The
 * outer retry ladder was silently absorbing that regression — the exact
 * pattern the 2026-08-16 band-aid removal exists to surface.
 *
 * Tunnels gain nothing from multiplexing anyway: they are ONE long-lived
 * connection each, not the per-call churn that caused MaxStartups pressure.
 *
 * ORDER IS LOAD-BEARING, AND IT IS FIRST-WINS: OpenSSH uses the FIRST value
 * obtained for each option (ssh_config(5): "the first obtained value for
 * each parameter is used" — command-line -o included; verified on OpenSSH
 * 9.6: `ssh -o ControlMaster=auto -o ControlMaster=no -G host` resolves
 * `controlmaster auto`). So every `-L`/`-R`/`-D` invocation must place these
 * BEFORE any spread that carries SSH_CONNECTION_OPTS. The first version of
 * this opt-out appended them after — inert, and run 31927810430 failed both
 * compose scenarios on it. The tunnel-census test in tests/unit/lib/ssh.test.ts
 * pins the order at every call site.
 */
export const SSH_TUNNEL_NO_MUX_OPTS = Object.freeze([
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
]);
