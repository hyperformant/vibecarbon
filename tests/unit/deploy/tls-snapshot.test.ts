import { PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDBY_SELFSIGNED_ISSUER } from '../../../src/lib/deploy/k8s/acme-issuer-policy.js';
import {
  buildRestoredTlsSecret,
  CERT_MANAGER_CONTROLLER_LABEL,
  caSlug,
  certificateDetailsAnnotations,
  certificateSerial,
  chainReachesTrustedRoot,
  inspectComposeAcme,
  inspectK8sTlsSecret,
  isSnapshotBetter,
  k8sSecretSerial,
  MIN_REMAINING_VALIDITY_MS,
  normalizeSerial,
  readTlsSnapshot,
  tlsSnapshotKey,
  tlsSnapshotS3Prefix,
  writeTlsSnapshot,
} from '../../../src/lib/deploy/tls-snapshot.js';
import { envBackupPrefix, walgPrefixFor } from '../../../src/lib/walg/restore-base.js';
import {
  acmeJson,
  acmeJsonWithCas,
  DAY_MS,
  k8sSecretJson,
  makeCert,
  makeChain,
} from './_tls-fixtures.ts';

const s3Config = {
  region: 'r',
  endpoint: 'https://e',
  bucket: 'b',
  accessKey: 'a',
  secretKey: 's',
};
const names = ['app.example.com', '*.app.example.com'];

afterEach(() => vi.restoreAllMocks());

describe('caSlug', () => {
  it('maps a staging ACME directory to staging', () => {
    expect(caSlug('https://acme-staging-v02.api.letsencrypt.org/directory')).toBe('staging');
  });
  it('maps a prod issuer name to prod', () => {
    expect(caSlug('letsencrypt-prod-hetzner')).toBe('prod');
  });
  it('maps empty to prod', () => {
    expect(caSlug('')).toBe('prod');
  });
});

describe('envBackupPrefix', () => {
  it('is the folder walgPrefixFor and snapshot keys live under', () => {
    expect(envBackupPrefix('myapp', 'prod')).toBe('backups/myapp/prod/');
    expect(walgPrefixFor('myapp', 'prod')).toBe('backups/myapp/prod/walg');
  });
});

describe('keys', () => {
  it('keys the snapshot beside the wal-g prefix, inside the env folder -purge deletes', () => {
    const key = tlsSnapshotKey({
      projectName: 'myapp',
      envName: 'prod',
      ca: 'staging',
      format: 'k8s-secret',
    });
    expect(key).toBe('backups/myapp/prod/tls/staging/k8s-secret.json');
    expect(key.startsWith(`${walgPrefixFor('myapp', 'prod').replace(/walg$/, '')}`)).toBe(true);
    expect(key.startsWith(walgPrefixFor('myapp', 'prod'))).toBe(false);
    expect(
      tlsSnapshotS3Prefix({ backupBucket: 'b', projectName: 'myapp', envName: 'prod', ca: 'prod' }),
    ).toBe('s3://b/backups/myapp/prod/tls/prod');
  });
});

const PROD_URI = 'https://acme-v02.api.letsencrypt.org/acme/acct/1';

describe('chainReachesTrustedRoot', () => {
  it('reaches the root through the intermediate the bundle carries', () => {
    const { leaf, intermediate, root } = makeChain();
    expect(chainReachesTrustedRoot(`${leaf}${intermediate}`, [root])).toBe(true);
    expect(chainReachesTrustedRoot(leaf, [root])).toBe(false);
    expect(chainReachesTrustedRoot(`${leaf}${intermediate}`, [intermediate])).toBe(true);
    expect(chainReachesTrustedRoot(`${leaf}${intermediate}`, [])).toBe(false);
    expect(chainReachesTrustedRoot('not a pem', [root])).toBe(false);
  });
});

describe('inspectComposeAcme', () => {
  it('accepts a matching certificate and reports notAfter', () => {
    const v = inspectComposeAcme(acmeJson({}), { domain: 'app.example.com', ca: 'staging' });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.notAfter.getTime()).toBeGreaterThan(Date.now() + 50 * DAY_MS);
  });
  it('rejects a CA mismatch', () => {
    const v = inspectComposeAcme(acmeJson({}), { domain: 'app.example.com', ca: 'prod' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('CA');
  });
  it('rejects when no certificate main matches the domain', () => {
    const v = inspectComposeAcme(acmeJson({}), { domain: 'other.example.com', ca: 'staging' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('other.example.com');
  });
  it('rejects a certificate with 3 days left', () => {
    expect(
      inspectComposeAcme(acmeJson({ days: 3 }), { domain: 'app.example.com', ca: 'staging' }).ok,
    ).toBe(false);
  });
  it('rejects unparsable JSON without echoing the input', () => {
    const v = inspectComposeAcme('{not json SECRETTEXT', {
      domain: 'app.example.com',
      ca: 'staging',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).not.toContain('SECRETTEXT');
  });
  it('skips a wrong-CA resolver and finds the cert under the right one', () => {
    const parsed = JSON.parse(acmeJson({}));
    const wrong = {
      Account: { Registration: { uri: 'https://acme-v02.api.letsencrypt.org/acme/acct/9' } },
      Certificates: null,
    };
    const text = JSON.stringify({ other: wrong, ...parsed });
    expect(inspectComposeAcme(text, { domain: 'app.example.com', ca: 'staging' }).ok).toBe(true);
  });
  it('tolerates a null Certificates list', () => {
    const text = JSON.stringify({
      r: {
        Account: { Registration: { uri: 'https://acme-staging-v02.api.letsencrypt.org/x' } },
        Certificates: null,
      },
    });
    const v = inspectComposeAcme(text, { domain: 'app.example.com', ca: 'staging' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('app.example.com');
  });
  it('rejects a self-signed certificate', () => {
    expect(
      inspectComposeAcme(acmeJson({ selfSigned: true }), {
        domain: 'app.example.com',
        ca: 'staging',
      }).ok,
    ).toBe(false);
  });
  it('rejects a key that does not match the certificate', () => {
    const v = inspectComposeAcme(acmeJson({ mismatchedKey: true }), {
      domain: 'app.example.com',
      ca: 'staging',
    });
    expect(v).toEqual({ ok: false, reason: 'certificate and key do not match' });
  });
  it('rejects a cert that is not base64 PEM', () => {
    const text = JSON.stringify({
      r: {
        Account: { Registration: { uri: 'https://acme-staging-v02.api.letsencrypt.org/x' } },
        Certificates: [
          { domain: { main: 'app.example.com' }, certificate: 'bm9wZQ==', key: 'a2V5' },
        ],
      },
    });
    expect(inspectComposeAcme(text, { domain: 'app.example.com', ca: 'staging' }).ok).toBe(false);
  });
  it('rejects a compose entry with the key missing', () => {
    const parsed = JSON.parse(acmeJson({}));
    delete parsed.letsencrypt.Certificates[0].key;
    expect(
      inspectComposeAcme(JSON.stringify(parsed), { domain: 'app.example.com', ca: 'staging' }).ok,
    ).toBe(false);
  });
  it('rejects an empty acme.json', () => {
    expect(inspectComposeAcme('', { domain: 'app.example.com', ca: 'staging' }).ok).toBe(false);
  });
  it('rejects a resolver with null Account and Certificates', () => {
    const text = '{"letsencrypt":{"Account":null,"Certificates":null}}';
    expect(inspectComposeAcme(text, { domain: 'app.example.com', ca: 'staging' }).ok).toBe(false);
  });
  it('rejects a leaf whose names do not include the domain, whatever the entry label says', () => {
    const v = inspectComposeAcme(acmeJson({ sanNames: ['other.example.com'] }), {
      domain: 'app.example.com',
      ca: 'staging',
    });
    expect(v).toEqual({ ok: false, reason: 'certificate names do not cover its domain' });
  });
  it('drops a non-apex entry whose leaf misses one of the sans it asks for', () => {
    const text = acmeJson({
      extra: [
        {
          main: 'www.app.example.com',
          sans: ['api.app.example.com'],
          sanNames: ['www.app.example.com'],
        },
      ],
    });
    const v = inspectComposeAcme(text, { domain: 'app.example.com', ca: 'staging' });
    expect(v.ok && v.dropped).toBe(1);
  });
  it('prod: rejects a chain that does not reach a trusted root', () => {
    const { json } = acmeJsonWithCas({ registrationUri: PROD_URI });
    const v = inspectComposeAcme(json, { domain: 'app.example.com', ca: 'prod', trustRoots: [] });
    expect(v).toEqual({ ok: false, reason: 'certificate does not chain to a trusted root' });
  });
  it('prod: accepts a chain that reaches one of the trust roots', () => {
    const { json, cas } = acmeJsonWithCas({ registrationUri: PROD_URI });
    const v = inspectComposeAcme(json, { domain: 'app.example.com', ca: 'prod', trustRoots: cas });
    expect(v.ok).toBe(true);
  });
  it('prod: defaults to the platform roots, which no fixture CA is in', () => {
    const v = inspectComposeAcme(acmeJson({ registrationUri: PROD_URI }), {
      domain: 'app.example.com',
      ca: 'prod',
    });
    expect(v).toEqual({ ok: false, reason: 'certificate does not chain to a trusted root' });
  });
  it('drops a second entry that is near expiry and keeps the apex', () => {
    const v = inspectComposeAcme(acmeJson({ extra: [{ main: '*.app.example.com', days: 3 }] }), {
      domain: 'app.example.com',
      ca: 'staging',
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.dropped).toBe(1);
    const out = JSON.parse(v.text);
    expect(
      out.letsencrypt.Certificates.map((c: { domain: { main: string } }) => c.domain.main),
    ).toEqual(['app.example.com']);
    expect(out.letsencrypt.Account.Registration.uri).toContain('acme-staging');
    expect(v.text).toBe(JSON.stringify(out, null, 2));
  });
  it('drops a second entry whose key is another certificate', () => {
    const text = acmeJson({ extra: [{ main: 'www.app.example.com', mismatchedKey: true }] });
    const v = inspectComposeAcme(text, { domain: 'app.example.com', ca: 'staging' });
    expect(v.ok && v.dropped).toBe(1);
  });
  it('prod: drops a second entry that does not chain to a trusted root', () => {
    const { json, cas } = acmeJsonWithCas({
      registrationUri: PROD_URI,
      extra: [{ main: '*.app.example.com' }],
    });
    const v = inspectComposeAcme(json, {
      domain: 'app.example.com',
      ca: 'prod',
      trustRoots: [cas[0]],
    });
    expect(v.ok && v.dropped).toBe(1);
  });
  it('refuses the file when the apex entry is near expiry, even with valid others', () => {
    const v = inspectComposeAcme(acmeJson({ days: 3, extra: [{ main: '*.app.example.com' }] }), {
      domain: 'app.example.com',
      ca: 'staging',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/too soon$/);
  });
  it('refuses an entry without a valid domain label, without echoing it', () => {
    const parsed = JSON.parse(acmeJson({ extra: [{ main: 'www.app.example.com' }] }));
    parsed.letsencrypt.Certificates[1].domain.main = "x'; SECRETTEXT";
    const v = inspectComposeAcme(JSON.stringify(parsed), {
      domain: 'app.example.com',
      ca: 'staging',
    });
    expect(v).toEqual({ ok: false, reason: 'a certificate entry has no valid domain' });
  });
  it('accepts a resolver whose every entry is valid', () => {
    const text = acmeJson({
      extra: [{ main: '*.app.example.com' }, { main: 'www.app.example.com' }],
    });
    const v = inspectComposeAcme(text, { domain: 'app.example.com', ca: 'staging' });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.dropped).toBe(0);
      expect(v.text).toBe(text); // byte-for-byte, nothing re-serialized
    }
  });
  it('exposes a validity floor of at least a few days', () => {
    expect(MIN_REMAINING_VALIDITY_MS).toBeGreaterThan(3 * DAY_MS);
  });
});

describe('inspectK8sTlsSecret', () => {
  it('passes when SANs equal the required names', () => {
    const v = inspectK8sTlsSecret(k8sSecretJson({}), { dnsNames: names });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.issuerName).toBe('letsencrypt-prod-hetzner');
  });
  it('fails when a required name is not covered', () => {
    expect(
      inspectK8sTlsSecret(k8sSecretJson({}), { dnsNames: [...names, 'x.example.com'] }).ok,
    ).toBe(false);
  });
  it('fails when the certificate has extra names', () => {
    expect(
      inspectK8sTlsSecret(k8sSecretJson({ dnsNames: [...names, 'x.example.com'] }), {
        dnsNames: names,
      }).ok,
    ).toBe(false);
  });
  it('fails for a standby self-signed issuer', () => {
    expect(
      inspectK8sTlsSecret(k8sSecretJson({ issuerName: STANDBY_SELFSIGNED_ISSUER }), {
        dnsNames: names,
      }).ok,
    ).toBe(false);
  });
  it('fails when tls.key is missing', () => {
    expect(inspectK8sTlsSecret(k8sSecretJson({ omitKey: true }), { dnsNames: names }).ok).toBe(
      false,
    );
  });
  it('fails when the secret carries no cert-manager issuer annotation', () => {
    expect(inspectK8sTlsSecret(k8sSecretJson({ omitIssuer: true }), { dnsNames: names })).toEqual({
      ok: false,
      reason: 'secret has no cert-manager issuer',
    });
  });
  it('fails for a self-signed certificate', () => {
    expect(inspectK8sTlsSecret(k8sSecretJson({ selfSigned: true }), { dnsNames: names }).ok).toBe(
      false,
    );
  });
  it('fails for a key that does not match the certificate', () => {
    expect(
      inspectK8sTlsSecret(k8sSecretJson({ mismatchedKey: true }), { dnsNames: names }),
    ).toEqual({
      ok: false,
      reason: 'certificate and key do not match',
    });
  });
  it('fails for unparsable JSON without echoing it', () => {
    const v = inspectK8sTlsSecret('{nope SECRETTEXT', { dnsNames: names });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).not.toContain('SECRETTEXT');
  });
  it('fails when tls.crt is not a certificate', () => {
    const s = JSON.parse(k8sSecretJson({}));
    s.data['tls.crt'] = Buffer.from('nope').toString('base64');
    expect(inspectK8sTlsSecret(JSON.stringify(s), { dnsNames: names }).ok).toBe(false);
  });
  it('fails for a nearly expired certificate', () => {
    expect(inspectK8sTlsSecret(k8sSecretJson({ days: 3 }), { dnsNames: names }).ok).toBe(false);
  });
});

describe('buildRestoredTlsSecret', () => {
  const out = buildRestoredTlsSecret(k8sSecretJson({}), {
    namespace: 'vibecarbon',
    issuerName: 'letsencrypt-prod-hetzner',
  }) as { type: string; metadata: Record<string, unknown> };
  it('is a named kubernetes.io/tls secret', () => {
    expect(out.type).toBe('kubernetes.io/tls');
    expect(out.metadata.name).toBe('vibecarbon-tls');
    expect(out.metadata.namespace).toBe('vibecarbon');
  });
  // cert-manager v1.20.2 keeps Secrets labelled controller.cert-manager.io/fao
  // in a typed cache and the rest in a metadata cache. A restored Secret
  // without the label is moved between the two when cert-manager adds it, and
  // in that moment its lister says NotFound: the trigger controller then
  // re-issued ("Issuing certificate as Secret does not exist"). The restore
  // writes exactly what cert-manager's SecretsManager.setValues would, so
  // nothing is left for cert-manager to add.
  it("carries the label that keeps it in cert-manager's typed Secret cache", () => {
    expect(CERT_MANAGER_CONTROLLER_LABEL).toBe('controller.cert-manager.io/fao');
    expect(out.metadata.labels).toEqual({ 'controller.cert-manager.io/fao': 'true' });
  });
  it('carries every annotation cert-manager writes for this certificate, and no other', () => {
    expect(out.metadata.annotations).toEqual({
      'cert-manager.io/issuer-name': 'letsencrypt-prod-hetzner',
      'cert-manager.io/issuer-kind': 'ClusterIssuer',
      'cert-manager.io/issuer-group': 'cert-manager.io',
      'cert-manager.io/certificate-name': 'vibecarbon-tls',
      'cert-manager.io/common-name': 'app.example.com',
      'cert-manager.io/alt-names': 'app.example.com,*.app.example.com',
      'cert-manager.io/ip-sans': '',
      'cert-manager.io/uri-sans': '',
    });
  });
  it('is still judged a valid issued Secret, as one cert-manager wrote is', () => {
    const verdict = inspectK8sTlsSecret(JSON.stringify(out), { dnsNames: names });
    expect(verdict).toMatchObject({ ok: true, issuerName: 'letsencrypt-prod-hetzner' });
  });
  it('drops server-owned metadata', () => {
    for (const f of [
      'resourceVersion',
      'uid',
      'creationTimestamp',
      'managedFields',
      'ownerReferences',
    ]) {
      expect(out.metadata).not.toHaveProperty(f);
    }
  });
});

// cert-manager v1.20.2 internal/controller/certificates/secrets.go,
// AnnotationsForCertificate: the values it derives from the leaf.
describe('certificateDetailsAnnotations', () => {
  const pem = (o: Parameters<typeof makeCert>[1]) =>
    makeCert(['app.example.com', '*.app.example.com'], o).cert;

  it('keeps common-name, alt-names, ip-sans and uri-sans when empty, drops the rest', () => {
    expect(certificateDetailsAnnotations(pem({ subject: '/O=Acme' }))).toEqual({
      'cert-manager.io/common-name': '',
      'cert-manager.io/subject-organizations': 'Acme',
      'cert-manager.io/alt-names': 'app.example.com,*.app.example.com',
      'cert-manager.io/ip-sans': '',
      'cert-manager.io/uri-sans': '',
    });
  });

  it('writes every subject and SAN field, CSV-joined as Go encoding/csv does', () => {
    const cert = pem({
      subject: '/C=US/ST=CA/L=SF/O=Acme, Inc/OU=Ops/OU=Web/CN=app.example.com/serialNumber=42',
      extraSans: [
        'IP:10.0.0.1',
        'IP:2001:db8:0:0:0:0:0:1',
        'URI:spiffe://example.org/x',
        'email:ops@example.com',
      ],
    });
    expect(certificateDetailsAnnotations(cert)).toEqual({
      'cert-manager.io/common-name': 'app.example.com',
      'cert-manager.io/subject-serialnumber': '42',
      'cert-manager.io/subject-organizations': '"Acme, Inc"',
      'cert-manager.io/subject-organizationalunits': 'Ops,Web',
      'cert-manager.io/subject-countries': 'US',
      'cert-manager.io/subject-provinces': 'CA',
      'cert-manager.io/subject-localities': 'SF',
      'cert-manager.io/email-sans': 'ops@example.com',
      'cert-manager.io/alt-names': 'app.example.com,*.app.example.com',
      'cert-manager.io/ip-sans': '10.0.0.1,2001:db8::1',
      'cert-manager.io/uri-sans': 'spiffe://example.org/x',
    });
  });

  it('reads only the leaf of a bundle', () => {
    const { leaf, intermediate } = makeChain();
    expect(certificateDetailsAnnotations(`${leaf}${intermediate}`)).toEqual(
      certificateDetailsAnnotations(leaf),
    );
  });
});

describe('buildRestoredTlsSecret errors', () => {
  const opts = { namespace: 'vibecarbon', issuerName: 'i' };
  it('throws a fixed message that never echoes unparsable input', () => {
    expect(() => buildRestoredTlsSecret('{oops SECRETTEXT', opts)).toThrow(
      'snapshot secret is unparsable',
    );
    try {
      buildRestoredTlsSecret('{oops SECRETTEXT', opts);
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRETTEXT');
    }
  });
  it('throws when tls.crt or tls.key is missing', () => {
    const s = JSON.parse(k8sSecretJson({}));
    delete s.data['tls.key'];
    expect(() => buildRestoredTlsSecret(JSON.stringify(s), opts)).toThrow(
      'snapshot secret is unparsable',
    );
    const t = JSON.parse(k8sSecretJson({}));
    delete t.data['tls.crt'];
    expect(() => buildRestoredTlsSecret(JSON.stringify(t), opts)).toThrow(
      'snapshot secret is unparsable',
    );
  });
});

describe('isSnapshotBetter', () => {
  const early = { ok: true as const, notAfter: new Date(1000) };
  const late = { ok: true as const, notAfter: new Date(2000) };
  const bad = { ok: false as const, reason: 'x' };
  it('prefers stored when live is unusable', () => expect(isSnapshotBetter(bad, late)).toBe(true));
  it('prefers stored when it expires later', () =>
    expect(isSnapshotBetter(early, late)).toBe(true));
  it('keeps live when it expires later', () => expect(isSnapshotBetter(late, early)).toBe(false));
  it('never prefers an unusable stored', () => expect(isSnapshotBetter(early, bad)).toBe(false));
});

describe('readTlsSnapshot', () => {
  const failing = (name: string) => ({
    makeClient: async () => ({
      send: async () => {
        throw Object.assign(new Error('boom'), { name });
      },
    }),
  });
  it('maps NoSuchKey to no snapshot', async () => {
    expect(await readTlsSnapshot(s3Config, 'k', failing('NoSuchKey'))).toEqual({
      text: null,
      reason: 'no snapshot',
    });
  });
  it('treats a bare 404 NotFound (HEAD-style) as no snapshot', async () => {
    const makeClient = async () => ({
      send: async () => {
        throw Object.assign(new Error('x'), {
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        });
      },
    });
    expect(await readTlsSnapshot(s3Config, 'k', { makeClient })).toEqual({
      text: null,
      reason: 'no snapshot',
    });
  });
  it('maps other errors to S3 <name> without throwing or logging', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    expect(await readTlsSnapshot(s3Config, 'k', failing('AccessDenied'))).toEqual({
      text: null,
      reason: 'S3 AccessDenied',
    });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
  it('returns the object body text', async () => {
    const makeClient = async () => ({
      send: async () => ({ Body: { transformToString: async () => 'hello' } }),
    });
    expect(await readTlsSnapshot(s3Config, 'k', { makeClient })).toEqual({ text: 'hello' });
  });
  it('hands the client options to the client factory (the failover bound)', async () => {
    const clientOptions = { maxAttempts: 1, requestHandler: { requestTimeout: 10_000 } };
    const makeClient = vi.fn(async () => ({
      send: async () => ({ Body: { transformToString: async () => 'hello' } }),
    }));
    await readTlsSnapshot(s3Config, 'k', { makeClient, clientOptions });
    expect(makeClient).toHaveBeenCalledWith(s3Config, clientOptions);
  });
  it('marks a request that timed out', async () => {
    expect(await readTlsSnapshot(s3Config, 'k', failing('TimeoutError'))).toEqual({
      text: null,
      reason: 'S3 TimeoutError',
      timedOut: true,
    });
  });
});

describe('writeTlsSnapshot', () => {
  it('sends one PutObjectCommand with the key and body', async () => {
    const send = vi.fn(async () => ({}));
    const r = await writeTlsSnapshot(s3Config, 'the/key', 'body-text', {
      makeClient: async () => ({ send }),
    });
    expect(r).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = (send.mock.calls[0] as unknown as [PutObjectCommand])[0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input.Key).toBe('the/key');
    expect(cmd.input.Body).toBe('body-text');
    expect(cmd.input.Bucket).toBe('b');
  });
  it('returns the reason on a rejected send', async () => {
    const makeClient = async () => ({
      send: async () => {
        throw Object.assign(new Error('x'), { name: 'AccessDenied' });
      },
    });
    expect(await writeTlsSnapshot(s3Config, 'k', 'b', { makeClient })).toEqual({
      ok: false,
      reason: 'S3 AccessDenied',
    });
  });
});

describe('certificate serials (public, never key material)', () => {
  it('normalizes the spellings openssl, node and Traefik use', () => {
    expect(normalizeSerial('0A:B0:1C')).toBe('AB01C');
    expect(normalizeSerial('00ab01')).toBe('AB01');
    expect(normalizeSerial(' ab01 ')).toBe('AB01');
    expect(normalizeSerial('0')).toBe('0');
    expect(normalizeSerial(undefined)).toBe('');
  });

  it("reads the leaf's serial from a PEM bundle, and '' from anything else", () => {
    const live = k8sSecretJson({ dnsNames: ['app.example.com'] });
    const crt = Buffer.from(JSON.parse(live).data['tls.crt'], 'base64').toString('utf8');
    const serial = certificateSerial(crt);
    expect(serial).toMatch(/^[0-9A-F]+$/);
    expect(certificateSerial('not a pem')).toBe('');
    expect(k8sSecretSerial(live)).toBe(serial);
    expect(k8sSecretSerial('{')).toBe('');
    expect(k8sSecretSerial(JSON.stringify({ data: {} }))).toBe('');
  });
});
