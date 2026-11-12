/**
 * The k8s deploy's public probe, in two phases.
 *
 * App phase: is the app reachable and healthy from the public internet? TLS
 * verification is off for this phase only (the trust verdict is the TLS
 * phase's), SNI is pinned to the domain and resolution stays on public DNS.
 * Its 20 minute budget and its hard failure are unchanged.
 *
 * TLS phase: does the domain serve a trusted chain? Full verification plus
 * the ACME watchdog, for the first-look budget. A miss finishes the deploy
 * with TLS pending (recorded, warned, exit 0) instead of failing it; a hit
 * records trusted and saves a snapshot from the primary cluster.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSourceTree, maskSource } from '../helpers/runtime-reach-walk.js';
import { expectNoKeyLeak } from './_no-key-leak.ts';
import { k8sSecretJson } from './_tls-fixtures.ts';

const p = await import('@clack/prompts');
const { verifyK8sTls } = await import('../../../src/lib/deploy/orchestrator.js');
const { publicProbeConnect } = await import('../../../src/lib/deploy/public-domain-probe.js');
const { TLS_FIRST_LOOK_BUDGET_MS } = await import('../../../src/lib/deploy/tls-ready.js');
const { caSlug } = await import('../../../src/lib/deploy/tls-snapshot.js');

const SRC = readFileSync(join(__dirname, '../../../src/lib/deploy/orchestrator.js'), 'utf8');

const DOMAIN = 'app.example.com';
const IDENTITY = {
  issuerName: 'letsencrypt-staging',
  dnsNames: [DOMAIN, `*.${DOMAIN}`],
  ca: 'staging',
};
// The uploads bucket's store, and the backups bucket in another region: the
// snapshot goes to the backups bucket at ITS endpoint (an environment an older
// CLI put in another region's bucket keeps it there).
const S3 = { accessKey: 'AK', secretKey: 'SK', endpoint: 'https://s3', region: 'eu' };
const BACKUPS = { bucket: 'proj-backups', region: 'nbg1', endpoint: 'https://nbg1.s3' };

const quietSpinner = () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() });

function harness(probeResult: Record<string, unknown>) {
  const probe = vi.fn(async () => probeResult);
  const snapshot = vi.fn(async () => ({ ok: true, serial: 'AB01' }));
  // What the domain serves and what Secret/vibecarbon-tls holds: the same
  // certificate unless a test says otherwise.
  const servedSerial = vi.fn(async (): Promise<string | null> => 'AB01');
  const secretSerial = vi.fn(async (): Promise<string | null> => 'AB01');
  const watchdog = vi.fn(async () => ({ action: 'none' }));
  const kubectlFor = vi.fn((kubeconfig: string) => {
    const run = vi.fn(async () => '');
    Object.assign(run, { kubeconfig });
    return run;
  });
  const deps = {
    probe,
    snapshot,
    kubectlFor,
    identity: vi.fn(() => IDENTITY),
    makeWatchdog: vi.fn(() => watchdog),
    kubeconfigExists: vi.fn(() => true),
    spinner: quietSpinner,
    servedSerial,
    secretSerial,
  };
  return { deps, probe, snapshot, watchdog, kubectlFor, servedSerial, secretSerial };
}

const ARGS = {
  domain: DOMAIN,
  environment: 'prod',
  projectName: 'proj',
  dnsProvider: 'hetzner',
  kubeconfig: '/proj/.vibecarbon/kubeconfig-prod-primary',
  s3Config: S3,
  backupS3Config: BACKUPS,
};

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
  info = vi.spyOn(p.log, 'info').mockImplementation(() => {});
  exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);
});
afterEach(() => {
  warn.mockRestore();
  info.mockRestore();
  exit.mockRestore();
});

describe('app phase', () => {
  it('turns TLS verification off, pins SNI to the domain, keeps public DNS', () => {
    const off = publicProbeConnect(DOMAIN, { verifyTls: false });
    expect(off.rejectUnauthorized).toBe(false);
    expect(off.servername).toBe(DOMAIN);
    expect(typeof off.lookup).toBe('function');
  });

  it('verification stays on by default', () => {
    const on = publicProbeConnect(DOMAIN, {});
    expect(on.rejectUnauthorized).toBeUndefined();
    expect(on.servername).toBe(DOMAIN);
    expect(typeof on.lookup).toBe('function');
  });

  it('the k8s app probe keeps its 20 minute budget and runs without verification or watchdog', () => {
    const k8s = SRC.slice(SRC.indexOf('// --- Verifiable success gate for k8s ---'));
    expect(k8s).toMatch(
      /probePublicHealth\(domain, \{ timeoutMs: 1_200_000, verifyTls: false \}\)/,
    );
    // Its failure is still the hard one (diagnostics, then exit 1).
    const appFail = k8s.slice(k8s.indexOf('if (probeResult?.ok)'));
    expect(appFail.indexOf('process.exit(1)')).toBeGreaterThan(-1);
    expect(appFail.indexOf('verifyK8sTls(')).toBeLessThan(appFail.indexOf('process.exit(1)'));
  });

  it('the TLS phase is given the primary cluster kubeconfig', () => {
    const k8s = SRC.slice(SRC.indexOf('// --- Verifiable success gate for k8s ---'));
    const call = k8s.slice(k8s.indexOf('verifyK8sTls('), k8s.indexOf('verifyK8sTls(') + 600);
    expect(call).toMatch(/kubeconfig: probeKubeconfig/);
    expect(k8s).toMatch(/resolveKubeconfigPath\(environment, envConfig\)/);
  });

  it('the only verification opt-out of the public probe is the verifyTls: false branch', () => {
    // The probe's socket options live in public-domain-probe.js now, the one
    // path every probe of the app's domain takes; the orchestrator has none.
    expect(SRC.match(/rejectUnauthorized/g) ?? []).toHaveLength(0);
    const probeSrc = readFileSync(
      join(__dirname, '../../../src/lib/deploy/public-domain-probe.js'),
      'utf8',
    );
    expect(probeSrc.match(/rejectUnauthorized/g) ?? []).toHaveLength(1);
    expect(probeSrc).toMatch(/if \(verifyTls === false\) \{[^}]*rejectUnauthorized = false/);
  });
});

describe('census: the verification opt-out is passed exactly once in src/', () => {
  it('`verifyTls: false` appears once as code (the k8s app phase), comments and strings aside', () => {
    const hits = loadSourceTree('src').flatMap((f) =>
      (maskSource(f.src).match(/verifyTls:\s*false/g) ?? []).map(() => f.path),
    );
    expect(hits).toEqual(['src/lib/deploy/orchestrator.js']);
  });
});

describe('TLS phase (verifyK8sTls)', () => {
  it('probes with verification and the ACME watchdog for the first-look budget', async () => {
    const h = harness({ ok: true, status: '200', attempts: 1 });
    await verifyK8sTls({ ...ARGS, deps: h.deps });
    expect(h.probe).toHaveBeenCalledTimes(1);
    const [domain, opts] = h.probe.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(domain).toBe(DOMAIN);
    expect(opts.timeoutMs).toBe(TLS_FIRST_LOOK_BUDGET_MS);
    expect(opts.onPoll).toBe(h.watchdog);
    expect(opts.verifyTls).not.toBe(false);
  });

  it('trusted: records trusted with the CA of the issuer and snapshots the primary once', async () => {
    const h = harness({ ok: true, status: '200', attempts: 2 });
    const tls = await verifyK8sTls({ ...ARGS, deps: h.deps });
    expect(tls.state).toBe('trusted');
    expect(tls.ca).toBe(caSlug(IDENTITY.issuerName));
    expect(typeof tls.checkedAt).toBe('string');
    expect(h.snapshot).toHaveBeenCalledTimes(1);
    const [snapArgs] = h.snapshot.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(snapArgs).toMatchObject({
      projectName: 'proj',
      envName: 'prod',
      ca: 'staging',
      dnsNames: IDENTITY.dnsNames,
      s3Config: {
        accessKey: 'AK',
        secretKey: 'SK',
        bucket: 'proj-backups',
        region: 'nbg1',
        endpoint: 'https://nbg1.s3',
      },
    });
    // Never the uploads store's host or region.
    const written = snapArgs.s3Config as Record<string, unknown>;
    expect(written.endpoint).not.toBe(S3.endpoint);
    expect(written.region).not.toBe(S3.region);
    expect((snapArgs.runKubectl as unknown as { kubeconfig: string }).kubeconfig).toBe(
      ARGS.kubeconfig,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('a saved snapshot names the serial it saved', async () => {
    const h = harness({ ok: true, status: '200', attempts: 1 });
    await verifyK8sTls({ ...ARGS, deps: h.deps });
    expect(info.mock.calls.map((c) => String(c[0]))).toContain(
      'TLS certificate snapshot saved (serial AB01).',
    );
  });

  it('one certificate per name: a served serial other than the live Secret is one warning', async () => {
    const h = harness({ ok: true, status: '200', attempts: 1 });
    h.servedSerial.mockResolvedValue('CD02');
    const tls = await verifyK8sTls({ ...ARGS, deps: h.deps });
    expect(tls.state).toBe('trusted');
    expect(h.servedSerial).toHaveBeenCalledWith(DOMAIN);
    expect(
      (h.secretSerial.mock.calls[0] as unknown as [{ kubeconfig: string }])[0].kubeconfig,
    ).toBe(ARGS.kubeconfig);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('app.example.com serves certificate serial CD02');
    expect(line).toContain('Secret vibecarbon-tls holds serial AB01');
    expect(line).toContain('`vibecarbon diagnose prod`');
    expect(line).not.toContain('\u2014');
  });

  it('serials compare by value, whatever their spelling', async () => {
    const h = harness({ ok: true, status: '200', attempts: 1 });
    h.servedSerial.mockResolvedValue('00:ab:01');
    await verifyK8sTls({ ...ARGS, deps: h.deps });
    expect(warn).not.toHaveBeenCalled();
  });

  it('an unread serial on either side is no warning (it proves nothing)', async () => {
    for (const side of ['servedSerial', 'secretSerial'] as const) {
      warn.mockClear();
      const h = harness({ ok: true, status: '200', attempts: 1 });
      h[side].mockResolvedValue(null);
      await verifyK8sTls({ ...ARGS, deps: h.deps });
      expect(warn).not.toHaveBeenCalled();
    }
    const h = harness({ ok: true, status: '200', attempts: 1 });
    h.servedSerial.mockRejectedValue(new Error('ECONNRESET'));
    await verifyK8sTls({ ...ARGS, deps: h.deps });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a pending TLS reads no serial', async () => {
    const h = harness({ ok: false, attempts: 3 });
    await verifyK8sTls({ ...ARGS, deps: h.deps });
    expect(h.servedSerial).not.toHaveBeenCalled();
    expect(h.secretSerial).not.toHaveBeenCalled();
  });

  it('a failed snapshot is one warning; the verdict stays trusted', async () => {
    const h = harness({ ok: true, status: '200', attempts: 1 });
    h.snapshot.mockResolvedValue({ ok: false, reason: 'S3 AccessDenied' } as never);
    const tls = await verifyK8sTls({ ...ARGS, deps: h.deps });
    expect(tls.state).toBe('trusted');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(
      /TLS certificate snapshot not saved \(S3 AccessDenied\)/,
    );
  });

  it('a probe miss is TLS pending: recorded, one warning, no snapshot, no exit', async () => {
    const h = harness({
      ok: false,
      attempts: 18,
      timeoutMs: TLS_FIRST_LOOK_BUDGET_MS,
      lastErrorClass: 'TypeError',
      lastErrorMessage: 'fetch failed',
      lastErrorCause: 'Error: self-signed certificate',
    });
    const tls = await verifyK8sTls({ ...ARGS, deps: h.deps });
    expect(tls.state).toBe('pending');
    expect(tls.ca).toBe('staging');
    expect(tls.reason).toMatch(/self-signed certificate/);
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toMatch(
      /^TLS pending: app\.example\.com does not serve a trusted certificate yet/,
    );
    expect(line).toContain('`vibecarbon status`');
    expect(line).not.toContain('—');
  });

  it('a watchdog abort is TLS pending with the watchdog reason', async () => {
    const h = harness({
      ok: false,
      attempts: 6,
      abortReason: 'order errored: 403 orderNotReady',
      lastErrorClass: 'TypeError',
    });
    const tls = await verifyK8sTls({ ...ARGS, deps: h.deps });
    expect(tls).toMatchObject({ state: 'pending', reason: 'order errored: 403 orderNotReady' });
    expect(String(warn.mock.calls[0][0])).toContain('order errored: 403 orderNotReady');
  });

  it('no kubeconfig on disk: no watchdog, no snapshot runner', async () => {
    const h = harness({ ok: true, status: '200', attempts: 1 });
    h.deps.kubeconfigExists = vi.fn(() => false);
    const tls = await verifyK8sTls({ ...ARGS, deps: h.deps });
    expect(tls.state).toBe('trusted');
    const [, opts] = h.probe.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(opts.onPoll).toBeNull();
    expect(h.deps.makeWatchdog).not.toHaveBeenCalled();
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(
      /^TLS certificate snapshot not saved \(no kubeconfig at \/proj\/\.vibecarbon\/kubeconfig-prod-primary\)\./,
    );
  });

  it('a snapshot run through the TLS phase leaks no key material', async () => {
    const live = k8sSecretJson({ dnsNames: IDENTITY.dnsNames, issuerName: IDENTITY.issuerName });
    const h = harness({ ok: true, status: '200', attempts: 1 });
    const { snapshotK8sTlsSecret } = await import('../../../src/lib/deploy/k8s/tls-restore.js');
    h.deps.snapshot = vi.fn((args: Record<string, unknown>) =>
      snapshotK8sTlsSecret({
        ...(args as never),
        runKubectl: async () => live,
        deps: { write: async () => ({ ok: false, reason: 'S3 AccessDenied' }) },
      }),
    ) as never;
    await expectNoKeyLeak(live, () => verifyK8sTls({ ...ARGS, deps: h.deps }));
  });
});

describe('TLS phase: re-issue of a restored certificate (tls-reissue-watch.js)', () => {
  const RESTORED_AT = '2026-11-01T10:00:05.400Z';

  it('a trusted deploy that restored a snapshot runs the one-shot check on the primary', async () => {
    const h = harness({ ok: true, status: '200', attempts: 1 });
    const reissueCheck = vi.fn(async () => {});
    await verifyK8sTls({ ...ARGS, tlsRestoredAt: RESTORED_AT, deps: { ...h.deps, reissueCheck } });
    expect(reissueCheck).toHaveBeenCalledTimes(1);
    const [args] = reissueCheck.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args).toMatchObject({ restoredAt: RESTORED_AT, domain: DOMAIN, environment: 'prod' });
    expect((args.runKubectl as unknown as { kubeconfig: string }).kubeconfig).toBe(ARGS.kubeconfig);
    (args.warn as (m: string) => void)('re-issued');
    expect(warn).toHaveBeenCalledWith('re-issued');
  });

  it('the check warns end to end when a request follows the restore', async () => {
    const h = harness({ ok: true, status: '200', attempts: 1 });
    const cert = JSON.stringify({
      metadata: { name: 'vibecarbon-tls', creationTimestamp: '2026-11-01T10:00:07Z' },
      status: { revision: 1, conditions: [] },
    });
    const requests = JSON.stringify({
      items: [
        {
          metadata: {
            name: 'vibecarbon-tls-1',
            creationTimestamp: '2026-11-01T10:00:07Z',
            annotations: { 'cert-manager.io/certificate-name': 'vibecarbon-tls' },
          },
        },
      ],
    });
    const events = JSON.stringify({
      items: [
        {
          reason: 'Issuing',
          message: 'Issuing certificate as Secret does not exist',
          lastTimestamp: '2026-11-01T10:00:07Z',
        },
      ],
    });
    h.deps.kubectlFor = vi.fn(() =>
      vi.fn(async (argv: string[]) => {
        const a = argv.join(' ');
        if (a.includes('get certificaterequests')) return requests;
        if (a.includes('get certificate ')) return cert;
        if (a.includes('get events')) return events;
        return '';
      }),
    ) as never;
    await verifyK8sTls({ ...ARGS, tlsRestoredAt: RESTORED_AT, deps: h.deps });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes('CertificateRequest vibecarbon-tls-1'));
    expect(line).toContain('Issuing certificate as Secret does not exist');
    expect(line).toContain('`vibecarbon diagnose prod`');
  });

  it('no restore, a pending TLS, or no kubeconfig: no check', async () => {
    const reissueCheck = vi.fn(async () => {});
    const h1 = harness({ ok: true, status: '200', attempts: 1 });
    await verifyK8sTls({ ...ARGS, deps: { ...h1.deps, reissueCheck } });
    const h2 = harness({ ok: false, attempts: 3 });
    await verifyK8sTls({ ...ARGS, tlsRestoredAt: RESTORED_AT, deps: { ...h2.deps, reissueCheck } });
    const h3 = harness({ ok: true, status: '200', attempts: 1 });
    h3.deps.kubeconfigExists = vi.fn(() => false);
    await verifyK8sTls({ ...ARGS, tlsRestoredAt: RESTORED_AT, deps: { ...h3.deps, reissueCheck } });
    expect(reissueCheck).not.toHaveBeenCalled();
  });

  it('the deploy hands the TLS phase the restore time of the single cluster or the HA primary', () => {
    const k8s = SRC.slice(SRC.indexOf('// --- Verifiable success gate for k8s ---'));
    const call = k8s.slice(k8s.indexOf('verifyK8sTls('), k8s.indexOf('verifyK8sTls(') + 600);
    expect(call).toMatch(
      /tlsRestoredAt:\s+deployResult\?\.tlsRestoredAt \?\? deployResult\?\.primary\?\.tlsRestoredAt \?\? null/,
    );
  });
});

describe('deploy timing records (k3s.js)', () => {
  const K3S = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf8');

  it('the restore records its write, and the apply records the Certificate and the controller', () => {
    const restore = K3S.indexOf('restoreK8sTlsSecret({');
    const wrote = K3S.indexOf('tlsRestoreTimingLine(timingKubectl, tlsRestoredAt)');
    const apply = K3S.indexOf('applyKustomization(baseDir,');
    const after = K3S.indexOf('tlsApplyTimingLines(timingKubectl)');
    expect(restore).toBeGreaterThan(-1);
    expect(wrote).toBeGreaterThan(restore);
    expect(apply).toBeGreaterThan(wrote);
    expect(after).toBeGreaterThan(apply);
    // Stamped only when the restore wrote the Secret.
    expect(K3S.slice(restore, wrote)).toMatch(
      /if \(tlsRestore\.restored\) \{\s*tlsRestoredAt = new Date\(\)\.toISOString\(\);/,
    );
  });

  it('the restore time travels out of applyK3sManifests and deployK3s', () => {
    expect(K3S).toMatch(/return \{ tlsRestoredAt \};\n\}/);
    expect(K3S).toMatch(/tlsRestoredAt = applied\?\.tlsRestoredAt \?\? null;/);
    expect(K3S).toMatch(/imageTag,\n {4}tlsRestoredAt,\n {2}\};/);
  });
});
