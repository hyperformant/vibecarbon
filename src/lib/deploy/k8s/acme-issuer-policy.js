/**
 * Single-ACME-issuer policy constants (d4 runs 3/5 RCA, 2026-08-28; HTTP-01
 * rationale 2026-11-04).
 *
 * THE PROBLEM: a k8s-ha environment is two clusters applying the SAME
 * Certificate manifests for the SAME dns name. Every certificate validates
 * with HTTP-01, and Let's Encrypt fetches the challenge from whichever
 * cluster DNS points at, so an ACME-issuing standby can never pass: its
 * orders fail, and each failure counts against Let's Encrypt's limit of 5
 * failed validations per hostname per hour, which the promoted cluster then
 * shares. One active ACME issuer per environment is the right shape on every
 * provider.
 *
 * THE POLICY: only the cluster currently in the PRIMARY role holds an
 * ACME-issued Certificate.
 *
 *   - Deploy half (applyK3sManifests): a pilot-standby deploy renders the
 *     Certificate's issuerRef as STANDBY_SELFSIGNED_ISSUER — issues locally
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

import { STANDBY_SELFSIGNED_ISSUER } from '../tls-issuer-names.js';

// The local, contention-free issuer a pilot-standby's Certificates use.
export { STANDBY_SELFSIGNED_ISSUER };

/**
 * Annotation carrying the environment's real ACME ClusterIssuer name
 * (pickIssuerName's output) — what the failover promote patches issuerRef
 * back to.
 */
export const PROMOTE_ISSUER_ANNOTATION = 'vibecarbon.dev/promote-issuer';

/**
 * The deploy-owned Certificates the promote half may touch, as
 * `{namespace, name}`: the same blast-radius doctrine as the ACME
 * watchdog's DEPLOY_OWNED_CERTIFICATES (a user's own cert-manager resources
 * are none of our business). One, since one certificate per name
 * (./one-certificate.js); the promote half still skips not-found quietly.
 */
export const PROMOTABLE_CERTIFICATES = Object.freeze([
  { namespace: 'vibecarbon', name: 'vibecarbon-tls' },
]);
