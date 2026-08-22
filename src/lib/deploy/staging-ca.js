/**
 * Let's Encrypt STAGING root trust for the deploy CLI.
 *
 * When ACME_CA_SERVER points at LE staging (e2e runs, dev envs avoiding
 * prod rate limits), cert-manager/Traefik serve chains signed by the LE
 * staging CA, which no default trust store includes. The public health
 * probe used to respond by disabling TLS verification entirely
 * (`rejectUnauthorized: false`) — which also let a rig serving a
 * self-signed, expired, or wrong-host certificate pass silently, the exact
 * class of misconfiguration the probe exists to catch (same rationale as
 * the e2e-harness conversion in a566006).
 *
 * Instead: pin the four vendored staging ROOTS on top of the system store.
 * Staging chains validate; everything genuinely bad still fails. Only roots
 * are vendored — staging intermediates ("Pseudo Plum E5", "Counterfeit
 * Cashew R10") are documented as subject to change and arrive in the
 * handshake, so trusting the roots is sufficient to build a chain.
 *
 * Two copies of the bundle exist on purpose:
 *   - tests/e2e/certs/letsencrypt-staging-roots.pem — feeds the e2e
 *     harness's NODE_EXTRA_CA_CERTS (tests/e2e/utils/e2e-env.js).
 *   - src/lib/deploy/certs/letsencrypt-staging-roots.pem — ships in the
 *     npm package (package.json `files` includes src/) for this module.
 * Refresh both together (procedure in the PEM header); the lockstep is
 * pinned by tests/unit/deploy/staging-probe-ca.test.ts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const PEM_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'certs',
  'letsencrypt-staging-roots.pem',
);

/** The vendored staging-roots bundle, verbatim. */
export function stagingRootsPem() {
  return readFileSync(PEM_PATH, 'utf8');
}

/**
 * CA set for the staging-mode health probe: the system roots PLUS the
 * staging roots. Passing `ca` to a TLS connection replaces the default
 * store, so the system roots are included explicitly — an iter-step probe
 * against a rig that already holds a production certificate must keep
 * validating too.
 *
 * @returns {string[]}
 */
export function stagingProbeCa() {
  return [...tls.rootCertificates, stagingRootsPem()];
}
