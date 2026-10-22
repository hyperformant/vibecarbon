/**
 * Single-ACME-issuer policy — promote half (d4 runs 3/5 RCA, 2026-08-28).
 *
 * Both clusters used to run active ACME issuers for the SAME dns names;
 * cert-manager's name-keyed DigitalOcean solver made the standby-role
 * cluster's issuance live-lock against the primary's, and after a failover
 * the promoted cluster served the Traefik default cert indefinitely. The
 * deploy half points a pilot-standby's Certificate at the local self-signed
 * ClusterIssuer and stamps the REAL issuer name into the
 * `vibecarbon.dev/promote-issuer` annotation; this half — run right after
 * the promoted app tier scales up — reads that annotation and patches
 * issuerRef back, making the promoted cluster the SOLE ACME solver.
 *
 * Best-effort by contract: DNS has already flipped by the time a failure
 * here could abort, and a promoted site serving on a self-signed cert is
 * strictly better than an aborted failover — so failures WARN loudly and
 * the reconverge redeploy repairs issuer ownership.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderTlsCertificateManifest } from '../../../carbon/scripts/render-tls-certificate.mjs';
import {
  k8sTlsSnapshotInputs,
  promoteAcmeIssuer,
  promoteTlsKubectl,
} from '../../../src/failover.js';
import { tlsSnapshotKey } from '../../../src/lib/deploy/tls-snapshot.js';
import { expectNoKeyLeak } from '../deploy/_no-key-leak.ts';
import { k8sSecretJson, k8sSecretJsonWithCa } from '../deploy/_tls-fixtures.ts';

const CERT_JSON = (issuer: string, annotation?: string) =>
  JSON.stringify({
    metadata: annotation ? { annotations: { 'vibecarbon.dev/promote-issuer': annotation } } : {},
    spec: { issuerRef: { name: issuer, kind: 'ClusterIssuer' } },
  });

describe('promoteAcmeIssuer', () => {
  it('patches issuerRef to the annotated ACME issuer when the cert is on the standby self-signed issuer', async () => {
    const calls: string[][] = [];
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      calls.push(argv);
      // grafana-tls does not exist on a promoted ex-standby (observability is
      // skipped on the pilot path) — the real cluster answers NotFound.
      if (argv.includes('grafana-tls'))
        throw new Error('Error from server (NotFound): certificates.cert-manager.io not found');
      if (argv.includes('get'))
        return CERT_JSON('vibecarbon-standby-selfsigned', 'letsencrypt-staging-digitalocean');
      return '';
    });
    const result = await promoteAcmeIssuer({
      promotedIp: '203.0.113.9',
      sshKeyPath: '/k',
      deps: { kubectl },
    });
    expect(result.patched).toEqual(['vibecarbon/vibecarbon-tls']);
    const patch = calls.find((a) => a.includes('patch'));
    expect(patch).toBeDefined();
    expect(patch?.join(' ')).toContain('certificate');
    expect(patch?.join(' ')).toContain('vibecarbon-tls');
    expect(JSON.stringify(patch)).toContain('letsencrypt-staging-digitalocean');
  });

  it('no-ops when issuerRef already equals the annotated issuer (idempotent on re-promote)', async () => {
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv.includes('get'))
        return CERT_JSON('letsencrypt-staging-digitalocean', 'letsencrypt-staging-digitalocean');
      return '';
    });
    const result = await promoteAcmeIssuer({
      promotedIp: '203.0.113.9',
      sshKeyPath: '/k',
      deps: { kubectl },
    });
    expect(result.patched).toEqual([]);
    expect(kubectl.mock.calls.some((c) => c[2].includes('patch'))).toBe(false);
  });

  it('skips a certificate with no promote annotation (pre-policy cluster) without patching', async () => {
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv.includes('get')) return CERT_JSON('letsencrypt-staging-digitalocean');
      return '';
    });
    const result = await promoteAcmeIssuer({
      promotedIp: '203.0.113.9',
      sshKeyPath: '/k',
      deps: { kubectl },
    });
    expect(result.patched).toEqual([]);
    expect(kubectl.mock.calls.some((c) => c[2].includes('patch'))).toBe(false);
  });

  it('a missing certificate (standby never installed it) is skipped, never thrown', async () => {
    const kubectl = vi.fn(async () => {
      throw new Error('Error from server (NotFound): certificates.cert-manager.io not found');
    });
    await expect(
      promoteAcmeIssuer({ promotedIp: '203.0.113.9', sshKeyPath: '/k', deps: { kubectl } }),
    ).resolves.toMatchObject({ patched: [] });
  });

  it('any other kubectl failure warns and resolves — a promoted site on a self-signed cert beats an aborted failover', async () => {
    const warns: string[] = [];
    const kubectl = vi.fn(async () => {
      throw new Error('Unable to connect to the server: TLS handshake timeout');
    });
    await expect(
      promoteAcmeIssuer({
        promotedIp: '203.0.113.9',
        sshKeyPath: '/k',
        deps: { kubectl, warn: (m: string) => warns.push(m) },
      }),
    ).resolves.toMatchObject({ patched: [] });
    expect(warns.join('\n')).toMatch(/promote-issuer|issuer/i);
  });
});

// ============================================================================
// TLS certificate reuse: the promoted cluster serves the primary's certificate.
// With a valid snapshot from this env's own issuer, vibecarbon-tls is not
// re-pointed by a patch (cert-manager would then see a self-signed Secret and
// issue): its Certificate is deleted, the snapshot goes into the Secret, and
// the Certificate comes back on the ACME issuer, finding a Secret that
// matches it. grafana-tls always takes the patch path.
// ============================================================================

const TARGET = 'letsencrypt-staging-digitalocean';
const DNS = ['app.example.com', '*.app.example.com'];
const S3 = { bucket: 'proj-backups', accessKey: 'AK', secretKey: 'SK', endpoint: 'https://s3' };
const SNAPSHOT_INPUTS = { s3Config: S3, projectName: 'proj', envName: 'prod', ca: 'staging' };
const SNAP = k8sSecretJson({ dnsNames: DNS, days: 60, issuerName: TARGET });
const SNAP_KEY_B64 = JSON.parse(SNAP).data['tls.key'] as string;
const SNAP_CRT_B64 = JSON.parse(SNAP).data['tls.crt'] as string;
// The pilot standby's own Secret: issued by the local self-signed issuer.
const LIVE_STANDBY = k8sSecretJson({
  dnsNames: DNS,
  days: 80,
  issuerName: 'vibecarbon-standby-selfsigned',
  selfSigned: true,
});

const LIVE_CERT = (name: string) =>
  JSON.stringify({
    metadata: { name, annotations: { 'vibecarbon.dev/promote-issuer': TARGET } },
    spec: {
      secretName: name,
      issuerRef: { name: 'vibecarbon-standby-selfsigned', kind: 'ClusterIssuer' },
      dnsNames: name === 'grafana-tls' ? ['app.example.com'] : DNS,
    },
  });

type Call = { via: 'kubectl' | 'quiet'; argv: string[]; opts: Record<string, unknown> };

interface Cluster {
  grafana?: boolean;
  /** Certificate/vibecarbon-tls is gone (a crash between the delete and the re-create). */
  certMissing?: boolean;
  liveSecret?: string;
  failOn?: (argv: string[]) => Error | null;
}

/** One recorder for both runners: the plain kubectl and the quiet one. */
function cluster({
  grafana = false,
  certMissing = false,
  liveSecret = LIVE_STANDBY,
  failOn,
}: Cluster = {}) {
  const calls: Call[] = [];
  const answer = async (via: Call['via'], argv: string[], opts: Record<string, unknown> = {}) => {
    calls.push({ via, argv, opts });
    const err = failOn?.(argv);
    if (err) throw err;
    if (argv[0] === 'get' && argv[1] === 'certificate') {
      if (
        (argv[2] === 'grafana-tls' && !grafana) ||
        (argv[2] === 'vibecarbon-tls' && certMissing)
      ) {
        throw new Error('Error from server (NotFound): certificates.cert-manager.io not found');
      }
      return LIVE_CERT(argv[2]);
    }
    if (argv[0] === 'get' && argv[1] === 'secret') return liveSecret;
    return '';
  };
  const kubectl = vi.fn(
    (_ip: string, _key: string, argv: string[], opts?: Record<string, unknown>) =>
      answer('kubectl', argv, opts),
  );
  const quietKubectl = vi.fn((argv: string[], opts?: Record<string, unknown>) =>
    answer('quiet', argv, opts),
  );
  return { calls, kubectl, quietKubectl };
}

const mutations = (calls: Call[]) => calls.filter((c) => c.argv[0] !== 'get');
const argvs = (calls: Call[]) => calls.map((c) => c.argv);

function run(
  c: ReturnType<typeof cluster>,
  {
    snapshot = SNAPSHOT_INPUTS as typeof SNAPSHOT_INPUTS | null,
    read = vi.fn(async () => ({ text: SNAP })),
    warn,
    message,
  }: {
    snapshot?: typeof SNAPSHOT_INPUTS | null;
    read?: ReturnType<typeof vi.fn>;
    warn?: (m: string) => void;
    message?: (m: string) => void;
  } = {},
) {
  return promoteAcmeIssuer({
    promotedIp: '203.0.113.9',
    sshKeyPath: '/k',
    ...(snapshot ? { snapshot } : {}),
    deps: {
      kubectl: c.kubectl,
      quietKubectl: c.quietKubectl,
      readSnapshot: read,
      ...(warn ? { warn } : {}),
      ...(message ? { message } : {}),
    },
  });
}

/** Today's patch-path argv, from a run with no snapshot inputs at all. */
async function patchPathArgv(opts: Cluster = {}) {
  const c = cluster(opts);
  await run(c, { snapshot: null });
  return argvs(c.calls);
}

describe('promoteAcmeIssuer with a TLS snapshot', () => {
  it('restores the snapshot: delete Certificate, write Secret, re-create the Certificate on the ACME issuer', async () => {
    const c = cluster();
    const read = vi.fn(async () => ({ text: SNAP }));
    const { result } = await expectNoKeyLeak(SNAP, () => run(c, { read }));

    expect(result.patched).toEqual(['vibecarbon/vibecarbon-tls']);
    expect(result.tls).toEqual({ restored: true, reason: 'restored from the last snapshot' });

    // The snapshot key of this env and CA, read once with the DR client options.
    expect(read).toHaveBeenCalledTimes(1);
    const [s3, key, readOpts] = read.mock.calls[0] as unknown as [
      unknown,
      string,
      { clientOptions: { maxAttempts: number } },
    ];
    expect(s3).toEqual(S3);
    expect(key).toBe(
      tlsSnapshotKey({ projectName: 'proj', envName: 'prod', ca: 'staging', format: 'k8s-secret' }),
    );
    expect(readOpts.clientOptions.maxAttempts).toBe(1);

    const m = mutations(c.calls);
    expect(m.map((x) => [x.via, ...x.argv])).toEqual([
      [
        'kubectl',
        'delete',
        'certificate',
        'vibecarbon-tls',
        '-n',
        'vibecarbon',
        '--ignore-not-found',
      ],
      ['quiet', 'replace', '-f', '-'],
      ['kubectl', 'apply', '-f', '-'],
    ]);
    // The restored Secret carries the promote annotation's issuer.
    const secret = JSON.parse(String(m[1].opts.input));
    expect(secret.metadata.annotations['cert-manager.io/issuer-name']).toBe(TARGET);
    expect(secret.data['tls.key']).toBe(SNAP_KEY_B64);
    // The Certificate as the shared renderer renders it, on the ACME issuer.
    expect(m[2].opts.input).toBe(
      renderTlsCertificateManifest({ dnsNames: DNS, issuerName: TARGET, effectiveIssuer: TARGET }),
    );
    // The live Secret (key material) is read through the quiet runner only.
    expect(
      c.calls.filter((x) => x.argv[0] === 'get' && x.argv[1] === 'secret').map((x) => x.via),
    ).toEqual(['quiet']);
    // No patch of vibecarbon-tls, and no argv anywhere carries certificate data.
    expect(c.calls.some((x) => x.argv[0] === 'patch' && x.argv.includes('vibecarbon-tls'))).toBe(
      false,
    );
    for (const x of c.calls) {
      const joined = x.argv.join(' ');
      expect(joined.includes(SNAP_KEY_B64) || joined.includes(SNAP_CRT_B64)).toBe(false);
      expect(joined).not.toMatch(/BEGIN|PRIVATE KEY/);
    }
  });

  it('an absent live Secret is filled with create, never replace', async () => {
    const c = cluster({ liveSecret: '' });
    const result = await run(c);
    expect(result.tls?.restored).toBe(true);
    expect(mutations(c.calls).map((x) => x.argv[0])).toEqual(['delete', 'create', 'apply']);
  });

  it('a prod snapshot must chain to a trusted root', async () => {
    const { json, ca } = k8sSecretJsonWithCa({
      dnsNames: DNS,
      days: 60,
      issuerName: 'letsencrypt-prod-digitalocean',
    });
    const prodCert = (name: string) =>
      LIVE_CERT(name).replaceAll(TARGET, 'letsencrypt-prod-digitalocean');
    for (const [roots, restored] of [
      [[ca as string], true],
      [[], false],
    ] as const) {
      const c = cluster();
      const kubectl = vi.fn(async (ip: string, key: string, argv: string[], o?: object) =>
        argv[0] === 'get' && argv[1] === 'certificate' && argv[2] === 'vibecarbon-tls'
          ? prodCert('vibecarbon-tls')
          : c.kubectl(ip, key, argv, o as Record<string, unknown>),
      );
      const result = await promoteAcmeIssuer({
        promotedIp: '203.0.113.9',
        sshKeyPath: '/k',
        snapshot: { ...SNAPSHOT_INPUTS, ca: 'prod' },
        deps: {
          kubectl,
          quietKubectl: c.quietKubectl,
          readSnapshot: vi.fn(async () => ({ text: json })),
          trustRoots: roots,
        },
      });
      expect(result.tls?.restored).toBe(restored);
      expect(mutations(c.calls).some((x) => x.argv[0] === 'delete')).toBe(restored);
    }
  });

  it.each([
    ['no snapshot', { text: null, reason: 'no snapshot' }],
    ['an S3 timeout', { text: null, reason: 'S3 TimeoutError', timedOut: true }],
    [
      'an expired snapshot',
      { text: k8sSecretJson({ dnsNames: DNS, days: 3, issuerName: TARGET }) },
    ],
    [
      'a snapshot from another issuer',
      {
        text: k8sSecretJson({ dnsNames: DNS, days: 60, issuerName: 'letsencrypt-staging-hetzner' }),
      },
    ],
    [
      'a snapshot for other names',
      { text: k8sSecretJson({ dnsNames: ['other.example.com'], days: 60, issuerName: TARGET }) },
    ],
  ])('%s: today’s patch path, byte-identical argv, no delete', async (_label, answer) => {
    const c = cluster();
    const result = await run(c, { read: vi.fn(async () => answer) });
    expect(argvs(c.calls)).toEqual(await patchPathArgv());
    expect(c.quietKubectl).not.toHaveBeenCalled();
    expect(result.patched).toEqual(['vibecarbon/vibecarbon-tls']);
    expect(result.tls?.restored).toBe(false);
  });

  it.each([
    ['no s3Config', { ...SNAPSHOT_INPUTS, s3Config: null }],
    ['no recorded CA', { ...SNAPSHOT_INPUTS, ca: null }],
  ])('%s: today’s patch path without reading S3', async (_label, snapshot) => {
    const c = cluster();
    const read = vi.fn(async () => ({ text: SNAP }));
    // biome-ignore lint/suspicious/noExplicitAny: the null fields are the point.
    await run(c, { snapshot: snapshot as any, read });
    expect(read).not.toHaveBeenCalled();
    expect(argvs(c.calls)).toEqual(await patchPathArgv());
  });

  it('grafana-tls always takes the patch path', async () => {
    const c = cluster({ grafana: true });
    const result = await run(c);
    expect(result.patched).toEqual([
      'vibecarbon/vibecarbon-tls',
      'vibecarbon-observability/grafana-tls',
    ]);
    const grafana = c.calls.filter((x) => x.argv.includes('grafana-tls'));
    expect(grafana.map((x) => x.argv[0])).toEqual(['get', 'patch']);
    expect(c.calls.some((x) => x.argv[0] === 'delete' && x.argv.includes('grafana-tls'))).toBe(
      false,
    );
  });

  it.each([
    ['the S3 read throws', {}, true],
    [
      'the delete throws',
      { failOn: (a: string[]) => (a[0] === 'delete' ? new Error('ssh: timeout') : null) },
      false,
    ],
  ])(
    '%s: falls back to the patch path, warns once, never throws',
    async (_label, opts, readThrows) => {
      const c = cluster(opts as Cluster);
      const warns: string[] = [];
      const read = readThrows
        ? vi.fn(async () => {
            throw new Error('boom');
          })
        : vi.fn(async () => ({ text: SNAP }));
      const result = await run(c, { read, warn: (m) => warns.push(m) });
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/vibecarbon-tls/);
      expect(warns[0]).not.toMatch(/BEGIN|PRIVATE KEY/);
      // The patch path ran after the snapshot path gave up.
      const tlsCalls = c.calls.filter((x) => x.argv.includes('vibecarbon-tls'));
      expect(tlsCalls.at(-1)?.argv[0]).toBe('patch');
      expect(result.patched).toEqual(['vibecarbon/vibecarbon-tls']);
    },
  );

  it('the Certificate re-create throws after the delete: says there is no Certificate until the next deploy, prints the command, no patch', async () => {
    const c = cluster({
      failOn: (a: string[]) => (a[0] === 'apply' ? new Error('ssh: timeout') : null),
    });
    const warns: string[] = [];
    const messages: string[] = [];
    const result = await run(c, {
      warn: (m) => warns.push(m),
      message: (m) => messages.push(m),
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/no Certificate on the promoted cluster until the next deploy/);
    expect(messages).toEqual(['vibecarbon deploy prod']);
    expect(c.calls.some((x) => x.argv[0] === 'patch' && x.argv.includes('vibecarbon-tls'))).toBe(
      false,
    );
    expect(result.patched).toEqual([]);
    // The Secret itself was restored before the re-create failed.
    expect(result.tls?.restored).toBe(true);
  });

  describe('Certificate NotFound with snapshot inputs (a resume after a crash between the delete and the re-create)', () => {
    const LIVE_RESTORED = k8sSecretJson({ dnsNames: DNS, days: 60, issuerName: TARGET });

    it('a valid live Secret: the Certificate is re-created from its issuer annotation and names', async () => {
      const c = cluster({ certMissing: true, liveSecret: LIVE_RESTORED });
      const warns: string[] = [];
      const { result } = await expectNoKeyLeak(LIVE_RESTORED, () =>
        run(c, { warn: (m) => warns.push(m) }),
      );
      expect(warns).toEqual([]);
      const m = mutations(c.calls);
      expect(m.map((x) => [x.via, ...x.argv])).toEqual([['kubectl', 'apply', '-f', '-']]);
      expect(m[0].opts.input).toBe(
        renderTlsCertificateManifest({
          dnsNames: DNS,
          issuerName: TARGET,
          effectiveIssuer: TARGET,
        }),
      );
      // Judged through the quiet runner only.
      expect(
        c.calls.filter((x) => x.argv[0] === 'get' && x.argv[1] === 'secret').map((x) => x.via),
      ).toEqual(['quiet']);
      expect(result.patched).toEqual(['vibecarbon/vibecarbon-tls']);
    });

    it.each([
      ['the standby self-signed Secret', LIVE_STANDBY],
      ['no Secret', ''],
      ['an expired Secret', k8sSecretJson({ dnsNames: DNS, days: 3, issuerName: TARGET })],
    ])(
      '%s: warns that the Certificate is missing and prints the deploy command',
      async (_l, live) => {
        const c = cluster({ certMissing: true, liveSecret: live });
        const warns: string[] = [];
        const messages: string[] = [];
        const result = await run(c, {
          warn: (m) => warns.push(m),
          message: (m) => messages.push(m),
        });
        expect(warns).toHaveLength(1);
        expect(warns[0]).toMatch(/vibecarbon\/vibecarbon-tls is missing/);
        expect(messages).toEqual(['vibecarbon deploy prod']);
        expect(mutations(c.calls)).toEqual([]);
        expect(result.patched).toEqual([]);
      },
    );

    it('without snapshot inputs a missing Certificate is still skipped quietly', async () => {
      const c = cluster({ certMissing: true });
      const warns: string[] = [];
      await run(c, { snapshot: null, warn: (m) => warns.push(m) });
      expect(warns).toEqual([]);
      expect(c.quietKubectl).not.toHaveBeenCalled();
    });
  });

  it('promoteTlsKubectl: the live Secret read is bounded at 30s, the write at 60s', async () => {
    const made: Array<{ timeoutMs: number; calls: string[][] }> = [];
    const makeQuiet = (_ip: string, _key: string, { timeoutMs }: { timeoutMs: number }) => {
      const rec = { timeoutMs, calls: [] as string[][] };
      made.push(rec);
      return async (argv: string[]) => {
        rec.calls.push(argv);
        return '';
      };
    };
    const runner = promoteTlsKubectl('203.0.113.9', '/k', { makeQuiet });
    await runner(['get', 'secret', 'vibecarbon-tls', '-n', 'vibecarbon', '-o', 'json']);
    await runner(['replace', '-f', '-'], { input: '{}' });
    const byTimeout = Object.fromEntries(made.map((r) => [r.timeoutMs, r.calls.map((a) => a[0])]));
    expect(byTimeout).toEqual({ 30000: ['get'], 60000: ['replace'] });
  });

  it('a Certificate already on its ACME issuer is left alone: no snapshot read', async () => {
    const read = vi.fn(async () => ({ text: SNAP }));
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv.includes('get')) return CERT_JSON(TARGET, TARGET);
      return '';
    });
    const result = await promoteAcmeIssuer({
      promotedIp: '203.0.113.9',
      sshKeyPath: '/k',
      snapshot: SNAPSHOT_INPUTS,
      deps: { kubectl, quietKubectl: vi.fn(), readSnapshot: read },
    });
    expect(result.patched).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('k8sTlsSnapshotInputs', () => {
  it('resolves the backup S3 config without prompting, with the recorded CA', async () => {
    const resolveS3 = vi.fn(async () => S3);
    const envConfig = { tls: { state: 'trusted', ca: 'staging' } };
    const r = await k8sTlsSnapshotInputs({
      envName: 'prod',
      envConfig,
      projectName: 'proj',
      deps: { resolveS3 },
    });
    expect(r).toEqual({ s3Config: S3, projectName: 'proj', envName: 'prod', ca: 'staging' });
    expect(resolveS3).toHaveBeenCalledWith({
      isCompose: false,
      envName: 'prod',
      projectName: 'proj',
      envConfig,
      skipPrompts: true,
    });
  });

  it('no recorded CA: nothing resolved, never a guess', async () => {
    const resolveS3 = vi.fn(async () => S3);
    const r = await k8sTlsSnapshotInputs({
      envName: 'prod',
      envConfig: {},
      projectName: 'proj',
      deps: { resolveS3 },
    });
    expect(r.ca).toBeNull();
    expect(r.s3Config).toBeNull();
    expect(resolveS3).not.toHaveBeenCalled();
  });

  it('a throwing resolve is no S3 config, never a throw', async () => {
    const r = await k8sTlsSnapshotInputs({
      envName: 'prod',
      envConfig: { tls: { ca: 'prod' } },
      projectName: 'proj',
      deps: {
        resolveS3: async () => {
          throw new Error('no creds');
        },
      },
    });
    expect(r).toMatchObject({ s3Config: null, ca: 'prod' });
  });
});
