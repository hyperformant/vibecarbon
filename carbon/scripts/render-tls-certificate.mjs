#!/usr/bin/env node
/**
 * The vibecarbon-tls Certificate a k8s cluster runs with. ONE renderer for
 * both ways a cluster gets it:
 *
 * - the vibecarbon CLI imports this module when it applies a cluster
 *   (renderK8sBase writes it into the rendered k8s/base copy);
 * - the GitOps deploy workflow (.github/workflows/deploy.yml) runs it as a
 *   script, from the GitHub Environment vars TLS_CERT_ISSUER,
 *   TLS_CERT_EFFECTIVE_ISSUER and TLS_CERT_DNS_NAMES that
 *   `vibecarbon configure cicd` seeds per environment.
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
 *
 * Script usage: `node scripts/render-tls-certificate.mjs` prints the
 * Certificate as YAML on stdout. The three vars are required and validated:
 * no value is invented, and nothing unvalidated reaches the manifest.
 */
import { fileURLToPath } from 'node:url';

/** Annotation carrying the env's real ACME ClusterIssuer (acme-issuer-policy.js). */
const PROMOTE_ISSUER_ANNOTATION = 'vibecarbon.dev/promote-issuer';

/** The pilot standby's local issuer (src/lib/deploy/tls-issuer-names.js). */
const STANDBY_SELFSIGNED_ISSUER = 'vibecarbon-standby-selfsigned';

const NAME = 'vibecarbon-tls';
const NAMESPACE = 'vibecarbon';

/** letsencrypt-{prod,staging}-{provider}, as pickIssuerName names them. */
const ACME_ISSUER = /^letsencrypt-(prod|staging)-[a-z0-9]+$/;

/** A DNS name, optionally one leading wildcard label. */
const DNS_NAME = /^(\*\.)?([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * Validate the Certificate settings; returns a clean copy or throws.
 *
 * @param {{ dnsNames: string[], issuerName: string, effectiveIssuer: string }} tls
 */
/**
 * An invalid setting. `summary` names the variable without echoing its value,
 * for the workflow log; `message` keeps the value for callers that show it.
 */
function invalid(field, message) {
  return Object.assign(new Error(message), { summary: `${field} is not valid.` });
}

export function validateTlsCertificate({ dnsNames, issuerName, effectiveIssuer }) {
  if (!Array.isArray(dnsNames) || dnsNames.length === 0) {
    throw invalid('TLS_CERT_DNS_NAMES', 'the TLS Certificate dnsNames is empty');
  }
  for (const name of dnsNames) {
    if (typeof name !== 'string' || name.length > 253 || !DNS_NAME.test(name)) {
      throw invalid(
        'TLS_CERT_DNS_NAMES',
        `the TLS Certificate DNS name ${JSON.stringify(name)} is not a DNS name`,
      );
    }
  }
  if (!ACME_ISSUER.test(String(issuerName ?? ''))) {
    throw invalid(
      'TLS_CERT_ISSUER',
      `the TLS Certificate issuer ${JSON.stringify(issuerName ?? null)} is not a letsencrypt-<stage>-<provider> ClusterIssuer`,
    );
  }
  if (effectiveIssuer !== issuerName && effectiveIssuer !== STANDBY_SELFSIGNED_ISSUER) {
    throw invalid(
      'TLS_CERT_EFFECTIVE_ISSUER',
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

/** The GitHub Environment vars `vibecarbon configure cicd` seeds, validated. */
export function tlsCertificateVars(tls) {
  const { dnsNames, issuerName, effectiveIssuer } = validateTlsCertificate(tls);
  return {
    TLS_CERT_ISSUER: issuerName,
    TLS_CERT_EFFECTIVE_ISSUER: effectiveIssuer,
    TLS_CERT_DNS_NAMES: dnsNames.join(','),
  };
}

/** The settings back from those vars; throws when one is missing or invalid. */
export function tlsCertificateFromVars(env) {
  const { TLS_CERT_ISSUER, TLS_CERT_EFFECTIVE_ISSUER, TLS_CERT_DNS_NAMES } = env;
  if (!TLS_CERT_ISSUER || !TLS_CERT_EFFECTIVE_ISSUER || !TLS_CERT_DNS_NAMES) {
    const missing =
      'TLS_CERT_ISSUER, TLS_CERT_EFFECTIVE_ISSUER and TLS_CERT_DNS_NAMES are not set for this environment.';
    throw Object.assign(new Error(missing), { summary: missing });
  }
  return validateTlsCertificate({
    dnsNames: TLS_CERT_DNS_NAMES.split(','),
    issuerName: TLS_CERT_ISSUER,
    effectiveIssuer: TLS_CERT_EFFECTIVE_ISSUER,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(renderTlsCertificateManifest(tlsCertificateFromVars(process.env)));
  } catch (err) {
    // Name the variable, never its value: these come from the workflow's
    // environment, and CI logs are wider-read than the settings themselves.
    const what = err?.summary ?? 'The TLS Certificate settings are not valid.';
    console.error(
      `${what} Run \`vibecarbon configure cicd <env>\` from the project to seed them, then re-run this workflow.`,
    );
    process.exit(1);
  }
}
