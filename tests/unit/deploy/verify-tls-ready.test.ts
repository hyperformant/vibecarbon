/**
 * The compose(-ha) verify-tls effect reports the TLS state instead of failing
 * the deploy (a deploy reports its TLS state; it does not wait out a CA). It
 * looks for a trusted apex certificate for the first-look budget, then sets
 * ctx.tlsState, which the orchestrator persists as envConfig.tls. A pending
 * state is one warning naming the reason and `vibecarbon status`; the
 * server's tls-retry cron finishes issuance in the background.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  wait: vi.fn(),
  ssh: vi.fn(async () => 'time="..." level=error msg="unable to obtain ACME certificate"'),
  cron: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('../../../src/lib/deploy/tls-ready.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, waitForTrustedTls: H.wait };
});

// A silent spinner: the effect drives it, the test reads the warning.
vi.mock('../../../src/lib/cli/progress.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spinner: () => ({ start: () => {}, message: () => {}, stop: () => {} }),
  };
});

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, sshRunAsync: H.ssh, setupComposeBackupCron: H.cron };
});

const p = await import('@clack/prompts');
const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');
const { TLS_FIRST_LOOK_BUDGET_MS, TLS_READY_MANUAL_BUDGET_MS } = await import(
  '../../../src/lib/deploy/tls-ready.js'
);

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    domain: 'app.example.com',
    dnsProvider: 'hetzner',
    sshKeyPath: '/k',
    serverIp: '10.0.0.1',
    projectConfig: { projectName: 'myapp' },
    ...over,
  }) as Record<string, unknown> & { tlsState?: Record<string, unknown> };

let warn: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;
const savedCa = process.env.ACME_CA_SERVER;

beforeEach(() => {
  H.wait.mockReset();
  H.ssh.mockClear();
  warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
  exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);
});

afterEach(() => {
  warn.mockRestore();
  exit.mockRestore();
  if (savedCa === undefined) delete process.env.ACME_CA_SERVER;
  else process.env.ACME_CA_SERVER = savedCa;
});

describe('verifyTlsReady: untrusted on managed DNS', () => {
  beforeEach(() => {
    process.env.ACME_CA_SERVER = 'https://acme-staging-v02.api.letsencrypt.org/directory';
    H.wait.mockResolvedValue({
      trusted: false,
      reason: 'self-signed certificate',
      served: { subject: 'TRAEFIK DEFAULT CERT', issuer: 'TRAEFIK DEFAULT CERT' },
    });
  });

  it('waits the first-look budget, not the old 480s', async () => {
    await EFFECTS.verifyTlsReady(ctx());
    expect(H.wait).toHaveBeenCalledWith(
      'app.example.com',
      expect.objectContaining({ budgetMs: TLS_FIRST_LOOK_BUDGET_MS }),
    );
  });

  it('warns once: TLS pending, the reason and `vibecarbon status`', async () => {
    await EFFECTS.verifyTlsReady(ctx());
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('TLS pending');
    expect(msg).toContain('self-signed certificate');
    expect(msg).toContain('`vibecarbon status`');
    // The Traefik log tail travels with the warning, as it did with the abort.
    expect(msg).toContain('unable to obtain ACME certificate');
  });

  it('records a pending state with the CA the server .env carries', async () => {
    const c = ctx();
    await EFFECTS.verifyTlsReady(c);
    expect(c.tlsState).toMatchObject({
      state: 'pending',
      reason: 'self-signed certificate',
      ca: 'staging',
    });
    expect(Number.isNaN(Date.parse(String(c.tlsState?.checkedAt)))).toBe(false);
  });

  it('never exits or throws: the deploy finishes', async () => {
    await expect(EFFECTS.verifyTlsReady(ctx())).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('verifyTlsReady: trusted', () => {
  it('records trusted on the prod CA, with no warning', async () => {
    delete process.env.ACME_CA_SERVER;
    H.wait.mockResolvedValue({ trusted: true, elapsedMs: 4_000 });
    const c = ctx();
    await EFFECTS.verifyTlsReady(c);
    expect(c.tlsState).toMatchObject({ state: 'trusted', ca: 'prod' });
    expect(c.tlsState).not.toHaveProperty('reason');
    expect(warn).not.toHaveBeenCalled();
    expect(H.ssh).not.toHaveBeenCalled();
  });
});

describe('verifyTlsReady: manual DNS', () => {
  it('keeps the short courtesy window and records pending', async () => {
    H.wait.mockResolvedValue({ trusted: false, reason: 'getaddrinfo ENOTFOUND', served: null });
    const c = ctx({ dnsProvider: 'manual' });
    await EFFECTS.verifyTlsReady(c);
    expect(H.wait).toHaveBeenCalledWith(
      'app.example.com',
      expect.objectContaining({ budgetMs: TLS_READY_MANUAL_BUDGET_MS }),
    );
    expect(c.tlsState).toMatchObject({ state: 'pending', reason: 'getaddrinfo ENOTFOUND' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('TLS pending');
  });

  it('says the retries run for 24 hours once DNS points here, then a deploy restarts them', async () => {
    H.wait.mockResolvedValue({ trusted: false, reason: 'getaddrinfo ENOTFOUND', served: null });
    await EFFECTS.verifyTlsReady(ctx({ dnsProvider: 'manual', environment: 'prod' }));
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('every 30 minutes for 24 hours');
    expect(msg).toContain('Once app.example.com points at this server');
    // The command on its own indented line, nothing glued to it.
    expect(msg.split('\n')).toContain('  vibecarbon deploy prod');
  });
});

describe('the retry cron gets the apex', () => {
  beforeEach(() => H.cron.mockClear());

  it('compose: setupBackupCron passes ctx.domain', async () => {
    await EFFECTS.setupBackupCron(ctx({ backupConfig: { schedule: '0 2 * * *' } }));
    expect(H.cron).toHaveBeenCalledWith(
      '10.0.0.1',
      '/k',
      'myapp',
      { schedule: '0 2 * * *' },
      { domain: 'app.example.com' },
    );
  });

  it('compose-ha: both nodes get it', async () => {
    await COMPOSE_HA_EFFECTS.haSetupBackupCron(
      ctx({
        primary: { ip: '1.1.1.1' },
        standby: { ip: '2.2.2.2' },
        onProgress: () => {},
      }),
    );
    expect(H.cron.mock.calls.map((c) => [c[0], c[4]])).toEqual([
      ['1.1.1.1', { domain: 'app.example.com' }],
      ['2.2.2.2', { domain: 'app.example.com' }],
    ]);
  });
});
