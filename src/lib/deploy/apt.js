/**
 * The one apt lock-contention fix, shared by every apt-get invocation we emit.
 *
 * THE RACE
 * --------
 * Ubuntu cloud images run `unattended-upgrades` on first boot. It holds
 * /var/lib/dpkg/lock-frontend for anywhere from seconds to several minutes.
 * apt's DEFAULT behaviour when a lock is held is to try ONCE and exit 100:
 *
 *   E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by
 *      process 10401 (unattended-upgr)
 *
 * Every apt-get we run lands inside that window — cloud-init `runcmd` by
 * construction, and the post-boot SSH ones (wireguard.js) because the CLI
 * reaches them within a minute or two of boot. Whether a deploy survives is
 * a coin flip on how long unattended-upgrades happens to take.
 *
 * THE FIX
 * -------
 * `-o DPkg::Lock::Timeout=N` makes apt itself block on the lock instead of
 * dying: 0 (the default) tries once and fails; a positive value retries every
 * second for N seconds; negative waits forever. apt applies it to BOTH the
 * frontend and inner dpkg locks (apt-pkg/deb/debsystem.cc, GetLockMaybeWait).
 *
 * Verified live on a Vultr Ubuntu 24.04 / apt 2.8.3 node, 2026-08-20, with a
 * real fcntl holder on lock-frontend (`flock(1)` does NOT reproduce this —
 * dpkg uses fcntl record locks, which don't conflict with flock(2), so an
 * flock-based repro passes while the real race still fails):
 *
 *   install, no option           -> exit=100 in  0s  "Could not get lock"
 *   install, Lock::Timeout=60    -> exit=0   in 22s  (waited out a 15s hold)
 *   update,  Lock::Timeout=60    -> exit=0   in  3s  (no lock was held)
 *
 * `update` takes dpkg's lock-frontend too, but the list lock (lists/lock) is
 * apt's own: with it held, `apt-get -o DPkg::Lock::Timeout=30 update` exits
 * 100 in 0 s, because the option does not apply to it. The cloud-init
 * programs are covered anyway (apt-daily is ordered Before= cloud-init's
 * final stage); post-boot ssh refreshes call aptWaitForDailyUnits() first.
 *
 * WHY THIS REPLACED THREE SEPARATE DODGES
 * ---------------------------------------
 * The class had accumulated one ad-hoc mitigation per site and no root fix:
 *
 *   1. compose/index.js — stopped apt-getting `jq` at all and shelled to
 *      python3 instead. Sidesteps the lock; leaves every other site exposed.
 *   2. carbon/cloud-init/k3s/*-init.sh — a hand-rolled `fuser` poll loop that
 *      slept up to 300s waiting for locks to look free. Broken two ways: it
 *      polled /var/lib/dpkg/lock, lists/lock and archives/lock but NEVER
 *      lock-frontend (the one that actually fails us), and being a pre-check
 *      it is TOCTOU — unattended-upgrades can take the lock in the gap
 *      between the loop passing and apt-get starting.
 *   3. wireguard.js and the four cloud-init `runcmd` programs — nothing.
 *
 * Letting apt block on the correct locks atomically is strictly better than
 * any of them, so the fuser loops are deleted rather than left as belt-and-
 * braces: a timer that polls the wrong lock is not a safety net, it is a
 * second thing to keep in sync.
 *
 * Sites are enumerated and pinned by
 * tests/unit/deploy/apt-lock-timeout-census.test.ts — that test is what keeps
 * a new apt-get from shipping without this, since the shell templates under
 * carbon/ cannot import the constant.
 */

/**
 * Seconds apt will wait for a dpkg lock before giving up.
 *
 * 300s covers a first-boot unattended-upgrades run with margin (observed
 * 30-120s on the images we deploy). It is deliberately finite rather than
 * negative/infinite: a genuinely wedged dpkg should surface as a failed
 * deploy step with apt's own error, not as a step that hangs until the
 * caller's timeout fires with no explanation.
 */
export const APT_LOCK_TIMEOUT_SECONDS = 300;

/**
 * The literal option string to splice into an apt-get command line. Goes
 * before the subcommand: `apt-get -o DPkg::Lock::Timeout=300 install -y ...`.
 */
export const APT_LOCK_OPT = `-o DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}`;

/**
 * Build a lock-safe apt-get command line.
 *
 * @param {string} args - everything after `apt-get`, e.g. `install -y -qq curl`
 * @returns {string} the full command, with the lock timeout applied
 */
export function aptGet(args) {
  return `apt-get ${APT_LOCK_OPT} ${args}`;
}

/**
 * Where the boot refresh writes its hook-silencing apt config. /run is tmpfs:
 * a refresh killed mid-way leaves nothing in apt's config, and a reboot clears
 * the file. `apt-get -c` loads it after apt.conf.d, so its `#clear` lines win
 * over Ubuntu's own `99update-notifier` and friends.
 */
export const APT_QUIET_CONF = '/run/vibecarbon-boot.conf';

/**
 * Index targets a server never reads: translations, command-not-found data and
 * the desktop AppStream metadata. Measured on five providers, fetching these
 * dominates a full `apt-get update`.
 */
export const APT_TRIMMED_INDEXES = [
  '-o Acquire::Languages=none',
  '-o Acquire::IndexTargets::deb::CNF::DefaultEnabled=false',
  '-o Acquire::IndexTargets::deb::DEP-11::DefaultEnabled=false',
  '-o Acquire::IndexTargets::deb::DEP-11-icons-small::DefaultEnabled=false',
  '-o Acquire::IndexTargets::deb::DEP-11-icons-hidpi::DefaultEnabled=false',
].join(' ');

const APT_HOOKS_CLEARED = [
  'APT::Update::Post-Invoke-Success',
  'APT::Update::Post-Invoke',
  'APT::Update::Post-Invoke-Stats',
  'APT::Update::Pre-Invoke',
];

/**
 * An `apt-get update` with Ubuntu's post-update hooks silenced for this one
 * refresh (they cost more than the refresh on a fresh image). One line of POSIX
 * sh, double quotes only so it embeds in a single-quoted YAML scalar. The
 * config goes to `confPath` and is loaded with `apt-get -c`, never written into
 * apt.conf.d; the command's exit status is apt's own, also under `set -e`.
 *
 * @param {string} [opts] - extra apt options placed after `update -qq`
 * @param {string} [confPath] - where the config is written
 * @returns {string}
 */
export function aptQuietUpdate(opts = '', confPath = APT_QUIET_CONF) {
  const clears = APT_HOOKS_CLEARED.map((k) => `"#clear ${k};"`).join(' ');
  return `printf "%s\\n" ${clears} > ${confPath}; apt-get -c ${confPath} ${APT_LOCK_OPT} update -qq${opts ? ` ${opts}` : ''}`;
}

/**
 * Block until apt-daily.service and apt-daily-upgrade.service are not running,
 * for an apt refresh that runs after boot over ssh. `apt-get update` takes
 * lists/lock without waiting (DPkg::Lock::Timeout does not apply to it), so a
 * refresh that overlaps apt-daily exits 100. One blocking call, not a loop:
 * `systemd-run --wait` starts a no-op unit ordered After= both services, and
 * systemd runs it once they are done. Bounded by `timeout 300`, skipped where
 * systemd-run is missing, and it fails open: if the wait itself fails the
 * refresh runs as it would have without it.
 *
 * @returns {string} one line of POSIX sh, safe under `set -e`
 */
export function aptWaitForDailyUnits() {
  return '{ command -v systemd-run >/dev/null 2>&1 && timeout 300 systemd-run --quiet --wait --property=After=apt-daily.service --property=After=apt-daily-upgrade.service true || true; }';
}

/**
 * Install packages, refreshing the lists only if the install fails (a package
 * missing from the lists the image shipped with). The fallback update is plain,
 * hooks left in place: it is rare, and silencing is for the trimmed refresh.
 *
 * @param {string} pkgs - space-separated package specs
 * @returns {string}
 */
export function aptInstallOrRefresh(pkgs) {
  const install = aptGet(`install -y ${pkgs}`);
  return `${install} || { ${aptGet('update')} && ${install}; }`;
}
