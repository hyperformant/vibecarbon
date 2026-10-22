// Certificates are generated at runtime so no PEM private key is ever committed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A self-signed cert + key (PEM text) covering `dnsNames`, valid for `days`. */
export function makeCert(dnsNames: string[], days = 60): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tls-fixture-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-days',
        String(days),
        '-subj',
        `/CN=${dnsNames[0]}`,
        '-addext',
        `subjectAltName=${dnsNames.map((n) => `DNS:${n}`).join(',')}`,
      ],
      { stdio: 'ignore' },
    );
    return {
      cert: readFileSync(join(dir, 'c.pem'), 'utf8'),
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

/** Traefik acme.json text with one certificate for `main`, registered at `registrationUri`. */
export function acmeJson(opts: { main?: string; days?: number; registrationUri?: string }): string {
  const main = opts.main ?? 'app.example.com';
  const { cert, key } = makeCert([main], opts.days);
  return JSON.stringify({
    letsencrypt: {
      Account: {
        Registration: {
          uri: opts.registrationUri ?? 'https://acme-staging-v02.api.letsencrypt.org/acme/acct/1',
        },
      },
      Certificates: [{ domain: { main }, certificate: b64(cert), key: b64(key) }],
    },
  });
}

/** `kubectl get secret -o json` text for a kubernetes.io/tls Secret. */
export function k8sSecretJson(opts: {
  dnsNames?: string[];
  days?: number;
  issuerName?: string;
  omitKey?: boolean;
}): string {
  const { cert, key } = makeCert(
    opts.dnsNames ?? ['app.example.com', '*.app.example.com'],
    opts.days,
  );
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/tls',
    metadata: {
      name: 'vibecarbon-tls',
      namespace: 'vibecarbon',
      resourceVersion: '123',
      uid: 'u-1',
      creationTimestamp: '2026-01-01T00:00:00Z',
      managedFields: [{ manager: 'cert-manager' }],
      ownerReferences: [{ kind: 'Certificate', name: 'vibecarbon-tls' }],
      annotations: { 'cert-manager.io/issuer-name': opts.issuerName ?? 'letsencrypt-prod-hetzner' },
    },
    data: {
      'tls.crt': b64(cert),
      ...(opts.omitKey ? {} : { 'tls.key': b64(key) }),
    },
  });
}
