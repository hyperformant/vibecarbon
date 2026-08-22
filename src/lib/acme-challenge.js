/**
 * ACME DNS-01 challenge record identity — the one place the
 * `_acme-challenge.*` name is spelled, shared by every DNS backend's
 * teardown.
 *
 * WHY DESTROY HAS TO CLEAN THESE UP
 * ---------------------------------
 * We create the A records; we do NOT create the challenge records. Traefik's
 * embedded lego (compose) and cert-manager (k8s) write them during DNS-01
 * validation and are supposed to remove them afterwards. In practice they
 * accumulate: a killed run, a failed order, a server destroyed mid-issuance,
 * and the TXT stays. Nothing in the environment's lifecycle ever revisits it,
 * so it outlives the environment — and then outlives the destroy, because
 * destroy only ever deleted the records it had itself created.
 *
 * The 2026-08-10 orphan audit found `_acme-challenge.e1` on carbonstack.dev
 * carrying TWELVE tokens across multiple GREEN destroys, plus
 * `_acme-challenge.ci1`; and 11 stray `_acme-challenge.{e2,d2}` TXTs on
 * appcarbon.dev. That is not just clutter: a stale challenge record SHADOWS
 * the next DNS-01 wildcard validation for the same name
 * (docs: reference_dns01_wildcard_cert_gotchas), so one destroyed environment's
 * residue breaks certificate issuance for the next environment that reuses the
 * name.
 *
 * WHY EXACTLY ONE NAME, AND WHY WE DO NOT SWEEP THE SUBTREE
 * --------------------------------------------------------
 * RFC 8555 §8.4: the validation record for identifier X lives at
 * `_acme-challenge.X`. A wildcard order's identifier is the BASE domain — an
 * order for `*.e1.example.com` validates at `_acme-challenge.e1.example.com`,
 * the SAME name the apex order uses. One name serves both certificates, which
 * is precisely why several tokens pile up in it rather than spreading out.
 *
 * The tempting generalization — delete every `_acme-challenge.*` TXT under
 * `<domain>` — is deliberately NOT done. When an environment's domain is the
 * zone apex (a production deploy at the zone root), that subtree is the whole
 * zone, including sibling environments' live challenge names. Deleting a
 * neighbour's records out of a shared zone is the 2026-05-16 blast-radius bug
 * (one scenario's destroy zeroed another's `e1.carbonstack.dev`) that the
 * ownership filter on the A-record path exists to prevent; the exact-name rule
 * here is the same discipline.
 *
 * OWNERSHIP: BY NAME, NOT BY VALUE
 * --------------------------------
 * The A-record path filters on `ownedIps` — a record is ours if it points at
 * our server. That test cannot work here: a challenge record's value is an
 * opaque ACME token that matches nothing we know, so an `ownedIps` filter
 * would preserve every one of them (which is, mechanically, today's bug). The
 * NAME is the ownership proof instead: `_acme-challenge.<domain>` is derived
 * from the environment's own domain, and an environment's domain is its own.
 */

/**
 * The DNS-01 challenge record name(s) for an environment's domain.
 *
 * Returns an array (not a single string) because the shape of the ACME
 * challenge namespace is a protocol detail, and a caller that loops is
 * correct whether that stays one name or becomes several.
 *
 * @param {string|null|undefined} domain - the environment's FQDN; a trailing
 *   dot is tolerated (zone exports carry one).
 * @returns {string[]} fully-qualified challenge record names, possibly empty.
 */
export function challengeRecordNames(domain) {
  const clean = String(domain ?? '')
    .trim()
    .replace(/\.$/, '');
  if (!clean) return [];
  return [`_acme-challenge.${clean}`];
}

/**
 * Drive a DNS backend's challenge reap and normalize the outcome.
 *
 * Exists so the two registry-driven DNS teardowns — destroy.js's
 * `cleanupDnsRecords` and compose/ha.js's own copy, which cannot import
 * destroy.js (it registers process-level signal handlers at module load) —
 * share ONE call, and only their reporting differs. Hand-rolling the second
 * copy is how the wildcard-orphan class shipped, so it does not happen twice.
 *
 * Never throws: the caller decides how a failure is reported, but it must be
 * reported. A surviving challenge record shadows the NEXT deploy's DNS-01
 * wildcard validation for the same name, so "we tried" is not a clean
 * teardown.
 *
 * @param {object} args
 * @param {{deleteChallengeRecords: Function}} args.dns - a DNS backend module
 * @param {string} args.token
 * @param {string} args.zoneId
 * @param {string} args.domain
 * @returns {Promise<{deleted: number, names: string[], error: Error|null}>}
 */
export async function reapChallengeRecords({ dns, token, zoneId, domain }) {
  try {
    const { deleted = 0, names = [] } = await dns.deleteChallengeRecords(token, zoneId, domain);
    return { deleted, names, error: null };
  } catch (error) {
    return { deleted: 0, names: [], error };
  }
}
