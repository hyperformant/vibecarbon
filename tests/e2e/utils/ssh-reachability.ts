/**
 * Per-run memo of hosts whose SSH port is provably unreachable, so a verify
 * step stops paying full retry budgets against a host that is not going to
 * answer.
 *
 * Why this exists: on 2026-08-11 the d2/compose-ha verify-failover step burned
 * 1034s. The operator's public IP rotated mid-scenario, and every provider
 * scopes inbound :22 to the operator CIDR captured at deploy
 * (digitalocean-compose.js: `{ portRange: '22', sourceAddresses: allowedSshIps }`).
 * A cloud firewall DROPs — it does not reject — so every SSH attempt paid a
 * full connect timeout, serially, across three checks, while all 18 HTTP checks
 * against the same deployment passed. That combination (HTTP green, TCP :22
 * black-holed) has exactly one common cause worth naming up front, and this
 * module names it once and then fails fast.
 *
 * The distinction that makes this safe: a CONNECT timeout means the TCP
 * handshake never completed — nothing is listening for us at :22. That is a
 * property of the host/firewall, not of the moment, so it is worth memoizing. A
 * *banner exchange* timeout is the opposite: sshd is listening and answering,
 * it just dropped this session under a MaxStartups penalty during the verify
 * fan-out. Those must keep their retries, so they never enter the memo.
 *
 * BLAST RADIUS — the memo has no TTL, deliberately, and that is a real
 * trade-off worth knowing before you extend it. An entry is latched for the
 * whole scenario: once a host is condemned, every later SSH-gated check against
 * it fails fast, even if access is restored mid-run (the operator's IP comes
 * back, or `vibecarbon access add` is run by hand in another terminal). We
 * accept that because the alternative — re-probing on a timer — is what burned
 * 1034s in the first place, and because within one scenario a black-holed :22
 * effectively never comes back on its own. `resetSshReachability()` is called
 * per scenario in _run-lifecycle.ts so the latch cannot leak across scenarios
 * on recycled IPs. If a future caller needs recovery WITHIN a scenario, add an
 * explicit un-condemn (e.g. after re-asserting the operator CIDR) rather than a
 * TTL — a timer would silently reintroduce the serial-timeout burn.
 */

/** host -> the connect-timeout error text that first proved it unreachable. */
const unreachable = new Map<string, string>();

/**
 * Whether the current verify phase's HTTP checks are green. Recorded centrally
 * rather than threaded through every check signature, because the diagnosis is
 * built four layers down (inside the replication retry loop) and the evidence
 * is gathered at the top. Defaults to false — absent evidence, the diagnosis
 * stays neutral rather than blaming the firewall.
 */
let httpEvidenceHealthy = false;

/**
 * Record whether the HTTP surface is serving, for use as evidence in
 * `sshUnreachableDiagnosis`. Call once per verify phase, after the health
 * checks and before any SSH-gated check.
 */
export function noteHttpEvidence(healthy: boolean): void {
  httpEvidenceHealthy = healthy;
}

/**
 * True only for a TCP CONNECT timeout to the SSH port — "ssh: connect to host
 * H port 22: Connection timed out", or a raw ETIMEDOUT/EHOSTUNREACH from the
 * connect syscall.
 *
 * Deliberately NOT true for "Connection timed out during banner exchange"
 * (sshd is up and answering; that is a MaxStartups penalty worth retrying) or
 * for "Connection refused" (something answered — the host is reachable and the
 * firewall is not the story).
 */
export function isSshConnectTimeout(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  if (t.includes('banner exchange')) return false;
  if (/connect to host \S+ port \d+: connection timed out/.test(t)) return true;
  if (t.includes('etimedout') && t.includes('connect')) return true;
  return t.includes('no route to host') || t.includes('ehostunreach');
}

/** Record that `host` proved its SSH port unreachable. */
export function noteSshConnectTimeout(host: string, errorText: string): void {
  if (!unreachable.has(host)) unreachable.set(host, errorText.trim());
}

/** The recorded error text if `host` is known-unreachable, else null. */
export function sshUnreachableSince(host: string): string | null {
  return unreachable.get(host) ?? null;
}

/**
 * The diagnosis to attach to every short-circuited check.
 *
 * The operator-CIDR headline is only justified when there is EVIDENCE the node
 * itself is alive — a node that is merely down also black-holes :22, and
 * leading with "your SSH grant is stale" would send triage chasing a firewall
 * while the box is off. Passing HTTP checks against the same deployment are
 * that evidence: serving traffic while :22 is dark is the signature of an
 * access-scoping problem, not an outage. Without it, stay neutral and let the
 * reader weigh both.
 */
export function sshUnreachableDiagnosis(
  host: string,
  httpHealthy: boolean = httpEvidenceHealthy,
): string {
  const head =
    `SSH to ${host}:22 is black-holed (TCP connect timeout) — skipping the remaining ` +
    `SSH-gated checks against it rather than paying another full retry budget. `;
  if (!httpHealthy) {
    return (
      `${head}The node is unreachable on :22. That is either the node being down/rebooting, ` +
      `or inbound :22 no longer matching the operator CIDRs captured at deploy time ` +
      `(a cloud firewall DROPs, which is why this times out instead of refusing). ` +
      `Check the node is running first, then compare \`curl -s https://api.ipify.org\` ` +
      `against \`operatorCidrs\` in .vibecarbon.json.`
    );
  }
  return (
    `${head}The HTTP checks against this deployment PASSED at the start of this phase, so the ` +
    `app was serving and the node was up — only operator ACCESS is broken. Inbound :22 is scoped to the operator ` +
    `CIDRs captured at deploy time, so the cause is almost certainly the operator's public ` +
    `IP changing mid-run (a cloud firewall DROPs, which is why this times out instead of ` +
    `refusing). Confirm with \`curl -s https://api.ipify.org\` against \`operatorCidrs\` in ` +
    `.vibecarbon.json, and repair with \`vibecarbon access add\`.`
  );
}

/** Clear the memo and the HTTP evidence — call between scenarios, and in unit tests. */
export function resetSshReachability(): void {
  unreachable.clear();
  httpEvidenceHealthy = false;
}
