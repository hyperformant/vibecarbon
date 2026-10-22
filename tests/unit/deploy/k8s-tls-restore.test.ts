/**
 * k8s deploy TLS reuse: before `apply -k base`, the last validated snapshot
 * goes back into Secret/vibecarbon-tls when the cluster holds no valid one,
 * and once the domain is trusted the deploy saves a fresh snapshot. Neither
 * ever fails the deploy, and no key material reaches operator output or argv.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { expectNoKeyLeak, forbiddenStrings } from './_no-key-leak.ts';
import { k8sSecretJson } from './_tls-fixtures.ts';

const H = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));

vi.mock('../../../src/lib/deploy/tls-snapshot.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, readTlsSnapshot: H.read, writeTlsSnapshot: H.write };
});

const { buildRestoredTlsSecret, tlsSnapshotKey } = await import(
  '../../../src/lib/deploy/tls-snapshot.js'
);
const {
  CERT_MANAGER_MIN_BACKOFF,
  LIVE_SECRET_VALID,
  k8sTlsRestoreLine,
  quietKubectl,
  restoreK8sTlsSecret,
  snapshotK8sTlsSecret,
} = await import('../../../src/lib/deploy/k8s/tls-restore.js');

const DNS = ['app.example.com', '*.app.example.com'];
const ISSUER = 'letsencrypt-prod-hetzner';
const S3 = { bucket: 'proj-backups', accessKey: 'AK', secretKey: 'SK', endpoint: 'https://s3' };
const BASE = { s3Config: S3, projectName: 'proj', envName: 'prod', ca: 'prod', issuerName: ISSUER };

const SNAP = k8sSecretJson({ dnsNames: DNS, days: 60 });
const LIVE_VALID = k8sSecretJson({ dnsNames: DNS, days: 80 });
const SNAP_KEY_B64 = JSON.parse(SNAP).data['tls.key'] as string;
const SNAP_CRT_B64 = JSON.parse(SNAP).data['tls.crt'] as string;

type Call = { argv: string[]; opts: Record<string, unknown> };

/** A fake kubectl: `get secret` answers `live`; `apply` answers `apply`. */
function fakeKubectl({ live = '' as string | Error, apply = '' as string | Error } = {}) {
  const calls: Call[] = [];
  const run = vi.fn(async (argv: string[], opts: Record<string, unknown> = {}) => {
    calls.push({ argv, opts });
    const answer = argv.includes('get') ? live : apply;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { run, calls };
}

const applies = (calls: Call[]) => calls.filter((c) => c.argv.includes('apply'));

describe('restoreK8sTlsSecret', () => {
  it('leaves a valid live Secret alone: no S3 read, no apply', async () => {
    H.read.mockReset();
    const k = fakeKubectl({ live: LIVE_VALID });
    const r = await restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: k.run });
    expect(r).toEqual({ restored: false, reason: LIVE_SECRET_VALID });
    expect(H.read).not.toHaveBeenCalled();
    expect(applies(k.calls)).toHaveLength(0);
  });

  it('never replaces a valid live Secret, even with a longer-lived snapshot', async () => {
    H.read.mockReset();
    H.read.mockResolvedValue({ text: k8sSecretJson({ dnsNames: DNS, days: 85 }) });
    const k = fakeKubectl({ live: k8sSecretJson({ dnsNames: DNS, days: 20 }) });
    const r = await restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: k.run });
    expect(r.restored).toBe(false);
    expect(H.read).not.toHaveBeenCalled();
    expect(applies(k.calls)).toHaveLength(0);
  });

  it('fills a missing Secret from the snapshot with one apply on stdin', async () => {
    H.read.mockReset();
    H.read.mockResolvedValue({ text: SNAP });
    const k = fakeKubectl({ live: '' });
    const r = await restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: k.run });
    expect(r.restored).toBe(true);
    // The live read: the one Secret, as JSON, captured (never streamed).
    const get = k.calls.find((c) => c.argv.includes('get'));
    expect(get?.argv).toEqual([
      'get',
      'secret',
      'vibecarbon-tls',
      '-n',
      'vibecarbon',
      '-o',
      'json',
      '--ignore-not-found',
    ]);
    expect(get?.opts.captureStdout).toBe(true);
    // The snapshot is the env's k8s-secret object for this CA.
    expect(H.read.mock.calls[0][1]).toBe(
      tlsSnapshotKey({ projectName: 'proj', envName: 'prod', ca: 'prod', format: 'k8s-secret' }),
    );
    const [apply] = applies(k.calls);
    expect(applies(k.calls)).toHaveLength(1);
    expect(apply.argv).toEqual(['apply', '-f', '-']);
    expect(apply.opts.input).toBe(
      JSON.stringify(buildRestoredTlsSecret(SNAP, { namespace: 'vibecarbon', issuerName: ISSUER })),
    );
    // The restored Secret carries this deploy's issuer (cert-manager compares
    // it with the Certificate's issuerRef).
    const manifest = JSON.parse(String(apply.opts.input));
    expect(manifest.metadata.annotations['cert-manager.io/issuer-name']).toBe(ISSUER);
    for (const c of k.calls) {
      const argv = c.argv.join(' ');
      expect(argv).not.toContain(SNAP_KEY_B64);
      expect(argv).not.toContain(SNAP_CRT_B64);
    }
  });

  it('fills a Secret cert-manager has not issued (no issuer annotation)', async () => {
    H.read.mockReset();
    H.read.mockResolvedValue({ text: SNAP });
    const k = fakeKubectl({ live: k8sSecretJson({ dnsNames: DNS, omitIssuer: true }) });
    const r = await restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: k.run });
    expect(r.restored).toBe(true);
    expect(applies(k.calls)).toHaveLength(1);
  });

  it('replaces a live Secret from the standby self-signed issuer', async () => {
    H.read.mockReset();
    H.read.mockResolvedValue({ text: SNAP });
    const k = fakeKubectl({
      live: k8sSecretJson({
        dnsNames: DNS,
        selfSigned: true,
        issuerName: 'vibecarbon-standby-selfsigned',
      }),
    });
    const r = await restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: k.run });
    expect(r.restored).toBe(true);
  });

  it('treats a live Secret from another issuer as not issued for this Certificate', async () => {
    H.read.mockReset();
    H.read.mockResolvedValue({ text: SNAP });
    const k = fakeKubectl({
      live: k8sSecretJson({ dnsNames: DNS, issuerName: 'letsencrypt-staging-hetzner' }),
    });
    const r = await restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: k.run });
    expect(r.restored).toBe(true);
  });

  it('skips a snapshot issued for other names', async () => {
    H.read.mockReset();
    H.read.mockResolvedValue({ text: k8sSecretJson({ dnsNames: ['app.example.com'] }) });
    const k = fakeKubectl({ live: '' });
    const r = await restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: k.run });
    expect(r.restored).toBe(false);
    expect(r.reason).toMatch(/^snapshot refused: certificate names differ/);
    expect(applies(k.calls)).toHaveLength(0);
  });

  it('skips with no snapshot, no bucket, no credentials or no recorded CA', async () => {
    H.read.mockReset();
    H.read.mockResolvedValue({ text: null, reason: 'no snapshot' });
    const k = fakeKubectl({ live: '' });
    expect(await restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: k.run })).toEqual({
      restored: false,
      reason: 'no snapshot',
    });
    const none = fakeKubectl();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ s3Config: { ...S3, bucket: '' } }, 'no backup bucket'],
      [{ s3Config: { ...S3, secretKey: '' } }, 'no backup credentials'],
      [{ ca: null }, 'no recorded CA'],
    ];
    for (const [over, reason] of cases) {
      expect(
        await restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: none.run, ...over }),
      ).toEqual({ restored: false, reason });
    }
    expect(none.calls).toHaveLength(0);
  });

  it('a live read that fails skips the restore', async () => {
    H.read.mockReset();
    const k = fakeKubectl({ live: new Error('connection refused') });
    const r = await restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: k.run });
    expect(r).toEqual({ restored: false, reason: 'could not read the live Secret' });
    expect(H.read).not.toHaveBeenCalled();
  });

  it('a failed apply reports a fixed phrase, never the command output', async () => {
    H.read.mockReset();
    H.read.mockResolvedValue({ text: SNAP });
    const pem = Buffer.from(SNAP_KEY_B64, 'base64').toString('utf8');
    const err = Object.assign(new Error(`kubectl failed:\n${pem}`), {
      status: 1,
      stderr: `error: ${SNAP_KEY_B64}\n${pem}`,
      stdout: SNAP,
    });
    const k = fakeKubectl({ live: '', apply: err });
    const { result } = await expectNoKeyLeak(SNAP, () =>
      restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: k.run }),
    );
    expect(result).toEqual({ restored: false, reason: 'could not apply the Secret' });
    const line = k8sTlsRestoreLine(result);
    for (const bad of forbiddenStrings(SNAP)) {
      expect(result.reason.includes(bad)).toBe(false);
      expect(line.includes(bad)).toBe(false);
    }
  });

  it('a restore run leaks no key material to any operator sink', async () => {
    H.read.mockReset();
    H.read.mockResolvedValue({ text: SNAP });
    const k = fakeKubectl({ live: '' });
    const { result } = await expectNoKeyLeak(SNAP, async () => {
      const r = await restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: k.run });
      console.error(k8sTlsRestoreLine(r));
      return r;
    });
    expect(result.restored).toBe(true);
  });

  it('never throws, whatever the dependencies do', async () => {
    H.read.mockReset();
    H.read.mockRejectedValue(new Error(SNAP));
    const k = fakeKubectl({ live: '' });
    const r = await restoreK8sTlsSecret({ ...BASE, dnsNames: DNS, runKubectl: k.run });
    expect(r).toEqual({ restored: false, reason: 'restore errored' });
  });
});

describe('k8sTlsRestoreLine', () => {
  it('names the outcome in one line', () => {
    expect(k8sTlsRestoreLine({ restored: true, reason: 'restored from the last snapshot' })).toBe(
      'TLS certificate restored from its last snapshot.',
    );
    expect(k8sTlsRestoreLine({ restored: false, reason: LIVE_SECRET_VALID })).toBe(
      'TLS certificate already in the cluster; nothing to restore.',
    );
    expect(k8sTlsRestoreLine({ restored: false, reason: 'no snapshot' })).toBe(
      'TLS certificate not restored (no snapshot). cert-manager requests a new one.',
    );
  });
});

describe('snapshotK8sTlsSecret', () => {
  const SNAP_ARGS = {
    s3Config: S3,
    projectName: 'proj',
    envName: 'prod',
    ca: 'prod',
    dnsNames: DNS,
  };

  it('writes the live Secret to the env k8s-secret key', async () => {
    H.write.mockReset();
    H.write.mockResolvedValue({ ok: true });
    const k = fakeKubectl({ live: LIVE_VALID });
    const r = await snapshotK8sTlsSecret({ ...SNAP_ARGS, runKubectl: k.run });
    expect(r).toEqual({ ok: true });
    expect(k.calls[0].opts.captureStdout).toBe(true);
    expect(H.write).toHaveBeenCalledTimes(1);
    const [s3, key, body] = H.write.mock.calls[0];
    expect(s3).toBe(S3);
    expect(key).toBe(
      tlsSnapshotKey({ projectName: 'proj', envName: 'prod', ca: 'prod', format: 'k8s-secret' }),
    );
    expect(body).toBe(LIVE_VALID);
  });

  it('refuses a standby self-signed, a non-covering or another-CA Secret', async () => {
    const refused = [
      k8sSecretJson({
        dnsNames: DNS,
        selfSigned: true,
        issuerName: 'vibecarbon-standby-selfsigned',
      }),
      k8sSecretJson({ dnsNames: ['app.example.com'] }),
      k8sSecretJson({ dnsNames: DNS, issuerName: 'letsencrypt-staging-hetzner' }),
    ];
    for (const live of refused) {
      H.write.mockReset();
      const k = fakeKubectl({ live });
      const r = await snapshotK8sTlsSecret({ ...SNAP_ARGS, runKubectl: k.run });
      expect(r.ok).toBe(false);
      expect(H.write).not.toHaveBeenCalled();
    }
  });

  it('reports a missing Secret, a failed read and a failed write by fixed phrases', async () => {
    H.write.mockReset();
    expect(
      await snapshotK8sTlsSecret({ ...SNAP_ARGS, runKubectl: fakeKubectl({ live: '' }).run }),
    ).toEqual({ ok: false, reason: 'no live Secret' });
    expect(
      await snapshotK8sTlsSecret({
        ...SNAP_ARGS,
        runKubectl: fakeKubectl({ live: Object.assign(new Error('x'), { stdout: LIVE_VALID }) })
          .run,
      }),
    ).toEqual({ ok: false, reason: 'could not read the live Secret' });
    H.write.mockResolvedValue({ ok: false, reason: 'S3 AccessDenied' });
    expect(
      await snapshotK8sTlsSecret({
        ...SNAP_ARGS,
        runKubectl: fakeKubectl({ live: LIVE_VALID }).run,
      }),
    ).toEqual({ ok: false, reason: 'S3 AccessDenied' });
    expect(
      await snapshotK8sTlsSecret({
        ...SNAP_ARGS,
        s3Config: { ...S3, bucket: '' },
        runKubectl: fakeKubectl().run,
      }),
    ).toEqual({ ok: false, reason: 'no backup bucket' });
  });

  it('a snapshot run leaks no key material to any operator sink', async () => {
    H.write.mockReset();
    H.write.mockResolvedValue({ ok: true });
    const k = fakeKubectl({ live: LIVE_VALID });
    await expectNoKeyLeak(LIVE_VALID, () =>
      snapshotK8sTlsSecret({ ...SNAP_ARGS, runKubectl: k.run }),
    );
  });
});

describe('CERT_MANAGER_MIN_BACKOFF', () => {
  it('is five minutes', () => {
    expect(CERT_MANAGER_MIN_BACKOFF).toBe('5m');
  });
});

describe('quietKubectl', () => {
  /** A `kubectl` on PATH that prints the snapshot (key included) and exits `code`. */
  function fakeKubectlBin(code: number) {
    const dir = mkdtempSync(join(tmpdir(), 'vc-quiet-kubectl-'));
    const payload = join(dir, 'payload.json');
    writeFileSync(payload, SNAP);
    const bin = join(dir, 'kubectl');
    writeFileSync(bin, `#!/bin/sh\ncat "${payload}"\ncat "${payload}" >&2\nexit ${code}\n`);
    chmodSync(bin, 0o755);
    return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } };
  }

  it('returns stdout on success without printing it', async () => {
    const { dir, env } = fakeKubectlBin(0);
    try {
      const { result } = await expectNoKeyLeak(SNAP, () =>
        quietKubectl(env)(['get', 'secret', 'vibecarbon-tls']),
      );
      expect(result.trim()).toBe(SNAP);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failure under CI prints nothing and throws a fixed message', async () => {
    const { dir, env } = fakeKubectlBin(1);
    const prevCi = process.env.CI;
    process.env.CI = '1';
    try {
      const { result } = await expectNoKeyLeak(SNAP, async () => {
        try {
          await quietKubectl(env)(['apply', '-f', '-'], { input: SNAP });
          return 'no throw';
        } catch (err) {
          return (err as Error).message;
        }
      });
      expect(result).toBe('kubectl failed');
    } finally {
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
