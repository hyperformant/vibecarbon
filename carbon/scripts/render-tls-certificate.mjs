/**
 * The vibecarbon-tls Certificate a k8s cluster runs with. The vibecarbon CLI
 * imports this module when it applies a cluster (renderK8sBase writes it into
 * the rendered k8s/base copy); on a GitOps cluster too, where
 * `vibecarbon deploy <env>` applies it.
 *
 * The names and issuer are per environment, but the committed `k8s/base` is
 * shared by every environment Flux reconciles from the same branch, so they
 * cannot live there. The Certificate is therefore DEPLOY-owned: Flux's
 * vibecarbon-base Kustomization drops it (`$patch: delete`,
 * k8s/flux/clusters/*), and the live object carries
 * kustomize.toolkit.fluxcd.io/prune: disabled.
 *
 * `effectiveIssuer` is what cert-manager issues from: the ACME issuer, or on
 * a pilot standby the local self-signed one. The real ACME issuer always
 * rides the vibecarbon.dev/promote-issuer annotation, which a failover
 * promotion re-points issuerRef from.
 */

/** Annotation carrying the env's real ACME ClusterIssuer (acme-issuer-policy.js). */
const PROMOTE_ISSUER_ANNOTATION = 'vibecarbon.dev/promote-issuer';

/** The pilot standby's local issuer (src/lib/deploy/tls-issuer-names.js). */
const STANDBY_SELFSIGNED_ISSUER = 'vibecarbon-standby-selfsigned';

const NAME = 'vibecarbon-tls';
const NAMESPACE = 'vibecarbon';

/** letsencrypt-{prod,staging}, as pickIssuerName names them. */
const ACME_ISSUER = /^letsencrypt-(prod|staging)$/;

/** A DNS name. HTTP-01 cannot issue wildcards, so `*` is refused. */
const DNS_NAME = /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * Validate the Certificate settings; returns a clean copy or throws.
 *
 * @param {{ dnsNames: string[], issuerName: string, effectiveIssuer: string }} tls
 */
export function validateTlsCertificate({ dnsNames, issuerName, effectiveIssuer }) {
  if (!Array.isArray(dnsNames) || dnsNames.length === 0) {
    throw new Error('the TLS Certificate dnsNames is empty');
  }
  for (const name of dnsNames) {
    if (typeof name !== 'string' || name.length > 253 || !DNS_NAME.test(name)) {
      throw new Error(`the TLS Certificate DNS name ${JSON.stringify(name)} is not a DNS name`);
    }
  }
  if (!ACME_ISSUER.test(String(issuerName ?? ''))) {
    throw new Error(
      `the TLS Certificate issuer ${JSON.stringify(issuerName ?? null)} is not letsencrypt-prod or letsencrypt-staging`,
    );
  }
  if (effectiveIssuer !== issuerName && effectiveIssuer !== STANDBY_SELFSIGNED_ISSUER) {
    throw new Error(
      `the TLS Certificate effective issuer ${JSON.stringify(effectiveIssuer ?? null)} is neither the ACME issuer nor ${STANDBY_SELFSIGNED_ISSUER}`,
    );
  }
  return { dnsNames: [...dnsNames], issuerName, effectiveIssuer };
}

/**
 * The vibecarbon-tls Certificate, as YAML. Every scalar is a JSON string,
 * which YAML reads verbatim (no YAML library ships with the CLI).
 *
 * @param {{ dnsNames: string[], issuerName: string, effectiveIssuer: string }} tls
 * @returns {string}
 */
export function renderTlsCertificateManifest(tls) {
  const { dnsNames, issuerName, effectiveIssuer } = validateTlsCertificate(tls);
  const q = (v) => JSON.stringify(String(v));
  return [
    '# Rendered by the vibecarbon deploy (scripts/render-tls-certificate.mjs); Flux does not own it.',
    'apiVersion: cert-manager.io/v1',
    'kind: Certificate',
    'metadata:',
    `  name: ${NAME}`,
    `  namespace: ${NAMESPACE}`,
    '  annotations:',
    `    ${q(PROMOTE_ISSUER_ANNOTATION)}: ${q(issuerName)}`,
    `    ${q('kustomize.toolkit.fluxcd.io/prune')}: ${q('disabled')}`,
    'spec:',
    `  secretName: ${NAME}`,
    '  issuerRef:',
    `    name: ${q(effectiveIssuer)}`,
    '    kind: ClusterIssuer',
    '  dnsNames:',
    ...dnsNames.map((n) => `    - ${q(n)}`),
    '',
  ].join('\n');
}
