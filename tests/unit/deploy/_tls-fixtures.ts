// Certificates are generated at runtime so no PEM private key is ever committed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DAY_MS = 24 * 60 * 60 * 1000;

interface CertOpts {
  days?: number;
  /** Self-signed leaf (no CA): what a standby or a failed issuance serves. */
  selfSigned?: boolean;
}

function openssl(args: string[]) {
  execFileSync('openssl', args, { stdio: 'ignore' });
}

/** A cert + key (PEM text) covering `dnsNames`, signed by a throwaway CA unless `selfSigned`. */
export function makeCert(
  dnsNames: string[],
  opts: CertOpts | number = {},
): { cert: string; key: string; ca?: string } {
  const { days = 60, selfSigned = false } = typeof opts === 'number' ? { days: opts } : opts;
  const dir = mkdtempSync(join(tmpdir(), 'tls-fixture-'));
  const p = (f: string) => join(dir, f);
  const san = `subjectAltName=${dnsNames.map((n) => `DNS:${n}`).join(',')}`;
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  try {
    if (selfSigned) {
      openssl([
        'req',
        '-x509',
        ...ec,
        '-keyout',
        p('k.pem'),
        '-out',
        p('c.pem'),
        '-days',
        String(days),
        '-subj',
        `/CN=${dnsNames[0]}`,
        '-addext',
        san,
      ]);
    } else {
      openssl([
        'req',
        '-x509',
        ...ec,
        '-keyout',
        p('ca.key'),
        '-out',
        p('ca.pem'),
        '-days',
        '365',
        '-subj',
        '/CN=fixture-ca',
      ]);
      openssl([
        'req',
        '-new',
        ...ec,
        '-keyout',
        p('k.pem'),
        '-out',
        p('c.csr'),
        '-subj',
        `/CN=${dnsNames[0]}`,
      ]);
      writeFileSync(p('ext.cnf'), `${san}\n`);
      openssl([
        'x509',
        '-req',
        '-in',
        p('c.csr'),
        '-CA',
        p('ca.pem'),
        '-CAkey',
        p('ca.key'),
        '-CAcreateserial',
        '-out',
        p('c.pem'),
        '-days',
        String(days),
        '-extfile',
        p('ext.cnf'),
      ]);
    }
    return {
      cert: readFileSync(p('c.pem'), 'utf8'),
      key: readFileSync(p('k.pem'), 'utf8'),
      ...(selfSigned ? {} : { ca: readFileSync(p('ca.pem'), 'utf8') }),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

/** Traefik acme.json text with one certificate for `main`, registered at `registrationUri`. */
export function acmeJson(opts: {
  main?: string;
  days?: number;
  registrationUri?: string;
  selfSigned?: boolean;
  mismatchedKey?: boolean;
}): string {
  const main = opts.main ?? 'app.example.com';
  const { cert, key: ownKey } = makeCert([main], { days: opts.days, selfSigned: opts.selfSigned });
  const key = opts.mismatchedKey ? makeCert([main]).key : ownKey;
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

interface K8sSecretOpts {
  dnsNames?: string[];
  days?: number;
  issuerName?: string;
  omitKey?: boolean;
  omitIssuer?: boolean;
  selfSigned?: boolean;
  mismatchedKey?: boolean;
}

/** `kubectl get secret -o json` text for a kubernetes.io/tls Secret. */
export function k8sSecretJson(opts: K8sSecretOpts): string {
  return k8sSecretJsonWithCa(opts).json;
}

/** k8sSecretJson plus the PEM of the throwaway CA that signed it (none when self-signed). */
export function k8sSecretJsonWithCa(opts: K8sSecretOpts): { json: string; ca?: string } {
  const dnsNames = opts.dnsNames ?? ['app.example.com', '*.app.example.com'];
  const {
    cert,
    key: ownKey,
    ca,
  } = makeCert(dnsNames, {
    days: opts.days,
    selfSigned: opts.selfSigned,
  });
  const key = opts.mismatchedKey ? makeCert(dnsNames).key : ownKey;
  const json = JSON.stringify({
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
      annotations: opts.omitIssuer
        ? {}
        : { 'cert-manager.io/issuer-name': opts.issuerName ?? 'letsencrypt-prod-hetzner' },
    },
    data: {
      'tls.crt': b64(cert),
      ...(opts.omitKey ? {} : { 'tls.key': b64(key) }),
    },
  });
  return { json, ca };
}

/** A leaf signed by an intermediate signed by a root, as PEM text each. */
export function makeChain(): { leaf: string; intermediate: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tls-chain-'));
  const p = (f: string) => join(dir, f);
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  try {
    openssl(
      ['req', '-x509', ...ec, '-keyout', p('root.key'), '-out', p('root.pem')].concat([
        '-days',
        '365',
        '-subj',
        '/CN=fixture-root',
      ]),
    );
    writeFileSync(p('ca.cnf'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=keyCertSign,cRLSign\n');
    openssl(
      ['req', '-new', ...ec, '-keyout', p('int.key'), '-out', p('int.csr')].concat([
        '-subj',
        '/CN=fixture-intermediate',
      ]),
    );
    openssl(
      ['x509', '-req', '-in', p('int.csr'), '-CA', p('root.pem'), '-CAkey', p('root.key')].concat([
        '-CAcreateserial',
        '-out',
        p('int.pem'),
        '-days',
        '365',
        '-extfile',
        p('ca.cnf'),
      ]),
    );
    openssl(
      ['req', '-new', ...ec, '-keyout', p('leaf.key'), '-out', p('leaf.csr')].concat([
        '-subj',
        '/CN=app.example.com',
      ]),
    );
    writeFileSync(p('leaf.cnf'), 'subjectAltName=DNS:app.example.com\n');
    openssl(
      ['x509', '-req', '-in', p('leaf.csr'), '-CA', p('int.pem'), '-CAkey', p('int.key')].concat([
        '-CAcreateserial',
        '-out',
        p('leaf.pem'),
        '-days',
        '60',
        '-extfile',
        p('leaf.cnf'),
      ]),
    );
    return {
      leaf: readFileSync(p('leaf.pem'), 'utf8'),
      intermediate: readFileSync(p('int.pem'), 'utf8'),
      root: readFileSync(p('root.pem'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
