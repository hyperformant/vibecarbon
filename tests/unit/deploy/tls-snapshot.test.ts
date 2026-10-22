import { PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDBY_SELFSIGNED_ISSUER } from '../../../src/lib/deploy/k8s/acme-issuer-policy.js';
import {
  buildRestoredTlsSecret,
  caSlug,
  inspectComposeAcme,
  inspectK8sTlsSecret,
  isSnapshotBetter,
  MIN_REMAINING_VALIDITY_MS,
  readTlsSnapshot,
  tlsSnapshotKey,
  tlsSnapshotS3Prefix,
  writeTlsSnapshot,
} from '../../../src/lib/deploy/tls-snapshot.js';
import { envBackupPrefix, walgPrefixFor } from '../../../src/lib/walg/restore-base.js';
import { acmeJson, DAY_MS, k8sSecretJson } from './_tls-fixtures.ts';

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
  it('carries the cert-manager annotations', () => {
    expect(out.metadata.annotations).toMatchObject({
      'cert-manager.io/issuer-name': 'letsencrypt-prod-hetzner',
      'cert-manager.io/issuer-kind': 'ClusterIssuer',
      'cert-manager.io/issuer-group': 'cert-manager.io',
      'cert-manager.io/certificate-name': 'vibecarbon-tls',
    });
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
