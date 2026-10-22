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
import { expectNoKeyLeak } from './_no-key-leak.ts';
import { k8sSecretJson } from './_tls-fixtures.ts';

const p = await import('@clack/prompts');
const { probeConnectOptions, verifyK8sTls } = await import(
  '../../../src/lib/deploy/orchestrator.js'
);
const { TLS_FIRST_LOOK_BUDGET_MS } = await import('../../../src/lib/deploy/tls-ready.js');
const { caSlug } = await import('../../../src/lib/deploy/tls-snapshot.js');

const SRC = readFileSync(join(__dirname, '../../../src/lib/deploy/orchestrator.js'), 'utf8');

const DOMAIN = 'app.example.com';
const IDENTITY = {
  issuerName: 'letsencrypt-staging-hetzner',
  dnsNames: [DOMAIN, `*.${DOMAIN}`],
  ca: 'staging',
};
const S3 = { accessKey: 'AK', secretKey: 'SK', endpoint: 'https://s3', region: 'eu' };

const quietSpinner = () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() });

function harness(probeResult: Record<string, unknown>) {
  const probe = vi.fn(async () => probeResult);
  const snapshot = vi.fn(async () => ({ ok: true }));
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
  };
  return { deps, probe, snapshot, watchdog, kubectlFor };
}

const ARGS = {
  domain: DOMAIN,
  environment: 'prod',
  projectName: 'proj',
  dnsProvider: 'hetzner',
  kubeconfig: '/proj/.vibecarbon/kubeconfig-prod-primary',
  s3Config: S3,
  backupS3Config: { bucket: 'proj-backups' },
};

let warn: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
  exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);
});
afterEach(() => {
  warn.mockRestore();
  exit.mockRestore();
});

describe('app phase', () => {
  it('turns TLS verification off, pins SNI to the domain, keeps public DNS', () => {
    const off = probeConnectOptions(DOMAIN, { verifyTls: false });
    expect(off.rejectUnauthorized).toBe(false);
    expect(off.servername).toBe(DOMAIN);
    expect(typeof off.lookup).toBe('function');
  });

  it('verification stays on by default', () => {
    const on = probeConnectOptions(DOMAIN, {});
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

  it('the only verification opt-out in the orchestrator is the verifyTls: false branch', () => {
    const hits = SRC.match(/rejectUnauthorized/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(SRC).toMatch(/if \(verifyTls === false\) \{[^}]*rejectUnauthorized = false/);
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
      s3Config: { ...S3, bucket: 'proj-backups' },
    });
    expect((snapArgs.runKubectl as unknown as { kubeconfig: string }).kubeconfig).toBe(
      ARGS.kubeconfig,
    );
    expect(warn).not.toHaveBeenCalled();
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
