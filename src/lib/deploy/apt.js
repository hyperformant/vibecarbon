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
 *   update,  Lock::Timeout=60    -> exit=0   in  3s
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
