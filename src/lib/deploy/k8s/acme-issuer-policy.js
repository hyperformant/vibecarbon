/**
 * Single-ACME-issuer policy constants (d4 runs 3/5 RCA, 2026-08-28).
 *
 * THE PROBLEM: a k8s-ha environment is two clusters applying the SAME
 * Certificate manifests for the SAME dns names on one shared zone.
 * cert-manager's core DigitalOcean solver keys `_acme-challenge` TXT records
 * by NAME, so two clusters solving concurrently clobber each other's records
 * — observed live as the standby-role cluster's issuance parking on
 * "pending, presented" forever, and a promoted cluster serving the Traefik
 * default cert. (Hetzner's webhook solver coexists — e4's reconverge is
 * green — but the policy is applied uniformly: one active ACME issuer per
 * environment is the right shape on every provider.)
 *
 * THE POLICY: only the cluster currently in the PRIMARY role holds an
 * ACME-issued Certificate.
 *
 *   - Deploy half (applyK3sManifests): a pilot-standby deploy patches the
 *     Certificate's issuerRef to STANDBY_SELFSIGNED_ISSUER — issues locally
 *     in seconds, zero ACME traffic — and stamps the REAL issuer name into
 *     PROMOTE_ISSUER_ANNOTATION (on the primary too, where it is simply a
 *     record of the current ref).
 *   - Promote half (failover.js promoteAcmeIssuer): right after the promoted
 *     app tier scales up, read the annotation and patch issuerRef back — the
 *     promoted cluster becomes the sole ACME solver and issues cleanly while
 *     the readiness gate runs.
 *   - Convergence: the reconverge redeploy re-runs the deploy half per the
 *     swapped roles, so issuer ownership always follows the primary role.
 *
 * The ClusterIssuer itself ships in
 * carbon/k8s/infra/cert-manager-resources/cluster-issuer-standby-selfsigned.yaml
 * (applied on every cluster alongside the ACME issuers; inert unless
 * referenced).
 */

/** The local, contention-free issuer a pilot-standby's Certificates use. */
export const STANDBY_SELFSIGNED_ISSUER = 'vibecarbon-standby-selfsigned';

/**
 * Annotation carrying the environment's real ACME ClusterIssuer name
 * (pickIssuerName's output) — what the failover promote patches issuerRef
 * back to.
 */
export const PROMOTE_ISSUER_ANNOTATION = 'vibecarbon.dev/promote-issuer';

/**
 * The deploy-owned Certificates the promote half may touch, as
 * `{namespace, name}` — the same blast-radius doctrine as the ACME
 * watchdog's DEPLOY_OWNED_CERTIFICATES (a user's own cert-manager resources
 * are none of our business). grafana-tls is listed for completeness: a
 * pilot-standby skips the observability apply entirely, so on the promoted
 * cluster it usually does not exist until the reconverge redeploy installs
 * it — the promote half must skip not-found quietly.
 */
export const PROMOTABLE_CERTIFICATES = Object.freeze([
  { namespace: 'vibecarbon', name: 'vibecarbon-tls' },
  { namespace: 'vibecarbon-observability', name: 'grafana-tls' },
]);
