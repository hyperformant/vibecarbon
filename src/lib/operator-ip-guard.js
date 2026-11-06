/**
 * Fail fast when the operator's public IP changes mid-command.
 *
 * ensureOperatorIpAccess lets the IP it detects at the start of a deploy
 * through the servers' firewalls (SSH and the k3s API on :6443). If that IP
 * changes afterwards (a VPN toggled, a laptop moved networks) every later
 * connection is dropped silently, and the only symptom used to be "Unable to
 * connect" with exit 255 after the retries and waits ran out: 11 minutes on a
 * two-cluster deploy. When a connection fails, the transport layers call
 * assertOperatorIpUnchanged, which compares the current IP with the armed one
 * and, if they differ, throws a message that says what happened and what to
 * do. It never re-allows the new IP on its own: a changed address is the
 * operator's call.
 */

const RECHECK_MS = 10_000;

/** @type {{ ip: string } | null} */
let armed = null;
let lastCheck = { at: 0, error: /** @type {Error | null} */ (null) };

/** Remember the IP this command was let in under. */
export function armOperatorIpGuard({ ip }) {
  armed = { ip };
  lastCheck = { at: 0, error: null };
}

/** Forget the armed IP (tests, and commands that finish). */
export function disarmOperatorIpGuard() {
  armed = null;
  lastCheck = { at: 0, error: null };
}

/**
 * Throw a plain error when the public IP is no longer the armed one. Quiet
 * when nothing is armed, when the IP cannot be read (the connection failure
 * stays the caller's to report), or when it is unchanged. A verdict is kept
 * for a few seconds so a burst of failing calls asks the detector once.
 *
 * @param {{ detect?: () => Promise<{ip: string}>, now?: () => number }} [seams]
 */
export async function assertOperatorIpUnchanged({ detect, now = Date.now } = {}) {
  if (!armed) return;
  const t = now();
  if (t - lastCheck.at < RECHECK_MS && lastCheck.at !== 0) {
    if (lastCheck.error) throw lastCheck.error;
    return;
  }
  let current;
  try {
    const detector = detect ?? (await import('./operator-ip.js')).detectOperatorIp;
    current = await detector();
  } catch {
    return;
  }
  lastCheck = { at: t, error: null };
  if (current.ip === armed.ip) return;
  const error = new Error(
    `Your public IP changed during this command (${armed.ip} when it started, ${current.ip} now), ` +
      `so the servers' firewalls no longer let you in. A VPN or network switch is the usual cause. ` +
      `Switch back to the original network, or run the command again to allow the new address.`,
  );
  error.code = 'OPERATOR_IP_CHANGED';
  lastCheck = { at: t, error };
  throw error;
}
