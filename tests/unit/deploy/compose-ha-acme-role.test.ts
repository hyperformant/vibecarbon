/**
 * Compose-HA single-active-ACME-issuer policy (the compose mirror of
 * src/lib/deploy/k8s/acme-issuer-policy.js).
 *
 * THE PROBLEM (runs 33273372657 / 33276113128, DO compose-ha): both nodes
 * run a full Traefik with an active `letsencrypt` resolver for the SAME
 * domain, so up to four concurrent DNS-01 authorizations fight over ONE
 * `_acme-challenge.${domain}` TXT name — competing values ("Incorrect TXT
 * record ... (and 1 more) found"), then mutual cleanup ("No TXT record
 * found"). The apex/wildcard serial-ordering design in
 * renderTraefikDefaultCert is per-INSTANCE and two instances break it.
 *
 * THE POLICY: only the primary-role node runs an armed ACME issuer. The
 * standby's Traefik points its `caserver` at a reserved-`.invalid` URL
 * (instant NXDOMAIN — zero ACME traffic, zero TXT writes, and the hostname
 * self-documents in any log tail) and serves the default cert until
 * failover re-arms it. Compose interpolation carries the whole policy:
 * `${ACME_DISARMED_CA_SERVER:-${ACME_CA_SERVER:-<prod>}}` — set on the
 * standby only, empty (= fall through) everywhere else. Verified against
 * live `docker compose config`: set → disarmed URL; empty/unset → the
 * ACME_CA_SERVER value or the prod default.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACME_DISARM_ENV,
  ACME_DISARMED_CA_SERVER,
  armComposeAcme,
  composeTraefikRecreateShell,
  disarmComposeAcme,
} from '../../../src/lib/deploy/acme-role.js';
import {
  restoreComposeTls,
  restoreFailoverTls,
} from '../../../src/lib/deploy/compose/tls-restore.js';
import { acmeJson } from './_tls-fixtures.ts';

describe('policy constants', () => {
  it('pins the disarm env var name and the reserved-.invalid sentinel URL', () => {
    expect(ACME_DISARM_ENV).toBe('ACME_DISARMED_CA_SERVER');
    // `.invalid` is RFC 2606-reserved: guaranteed NXDOMAIN, so lego fails
    // instantly with a hostname that says why, and can never reach a real CA.
    expect(ACME_DISARMED_CA_SERVER).toMatch(/^https:\/\/[a-z-]+\.invalid\//);
  });
});

describe('every Traefik caserver line honors the disarm var (census over carbon compose files)', () => {
  // Both command restatements (base prod.yml and the DNS-01 override, which
  // must restate the full command — Compose replaces sequences) carry the
  // caserver flag; each must consult the disarm var FIRST, then the real
  // ACME_CA_SERVER, then the prod default. A future file that adds a
  // caserver line is drafted automatically.
  const carbonDir = join(process.cwd(), 'carbon');
  const composeFiles = readdirSync(carbonDir).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));

  it('finds the two known caserver sites (base + dns01 override)', () => {
    const withCaserver = composeFiles.filter((f) =>
      readFileSync(join(carbonDir, f), 'utf8').includes('acme.caserver='),
    );
    expect(withCaserver.sort()).toEqual([
      'docker-compose.dns01.prod.yml',
      'docker-compose.prod.yml',
    ]);
  });

  for (const file of composeFiles) {
    it(`${file}: caserver lines (if any) are disarm-aware`, () => {
      const text = readFileSync(join(carbonDir, file), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.includes('acme.caserver=')) continue;
        expect(
          line,
          `${file}: a caserver flag that ignores ${ACME_DISARM_ENV} re-arms the standby's issuer`,
        ).toContain(
          `acme.caserver=\${${ACME_DISARM_ENV}:-\${ACME_CA_SERVER:-https://acme-v02.api.letsencrypt.org/directory}}`,
        );
      }
    });
  }
});

describe('composeTraefikRecreateShell', () => {
  const shell = composeTraefikRecreateShell('/opt/demo');

  it('recreates traefik with the -f set the running container was created with', () => {
    expect(shell).toContain('com.docker.compose.project.config_files');
    expect(shell).toContain('docker compose $FLAGS up -d --no-deps traefik');
  });

  it('falls back to base files plus the dns01 override when present — never a bare up', () => {
    // A bare `up` resolves docker-compose.yml alone and would recreate
    // Traefik WITHOUT the dns01 override's command — silently reverting the
    // node to HTTP-01. Same class as the db recreate's wrong-`-f` hazard.
    expect(shell).toContain('-f docker-compose.yml -f docker-compose.prod.yml');
    expect(shell).toContain('if [ -f docker-compose.dns01.prod.yml ]');
  });

  it('refuses to recreate blind when no traefik container is running', () => {
    expect(shell).toContain('refusing to recreate blind');
  });

  it('fails loudly if the recreate dropped a published port (80/443 are the site)', () => {
    expect(shell).toContain('PORTS_BEFORE');
    expect(shell).toContain('DROPPED published port');
  });
});

describe('armComposeAcme / disarmComposeAcme', () => {
  const baseArgs = { sshKeyPath: '/k', projectName: 'demo' };

  it('arm merges an EMPTY disarm value (fall through to the real CA) then recreates traefik', async () => {
    const mergeEnv = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue('ok');
    const ok = await armComposeAcme({
      ...baseArgs,
      promotedIp: '10.0.0.2',
      deps: { mergeEnv, run, log: vi.fn() },
    });
    expect(ok).toBe(true);
    expect(mergeEnv).toHaveBeenCalledWith('10.0.0.2', expect.any(String), '/opt/demo', {
      [ACME_DISARM_ENV]: '',
    });
    expect(run.mock.calls[0][2]).toContain('up -d --no-deps traefik');
  });

  it('disarm merges the sentinel URL then recreates traefik', async () => {
    const mergeEnv = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue('ok');
    const ok = await disarmComposeAcme({
      ...baseArgs,
      oldPrimaryIp: '10.0.0.1',
      deps: { mergeEnv, run, log: vi.fn(), warn: vi.fn() },
    });
    expect(ok).toBe(true);
    expect(mergeEnv).toHaveBeenCalledWith('10.0.0.1', expect.any(String), '/opt/demo', {
      [ACME_DISARM_ENV]: ACME_DISARMED_CA_SERVER,
    });
  });

  it('both are best-effort: failures warn and return false, never throw (DR path)', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('ssh: unreachable'));
    const warn = vi.fn();
    await expect(
      armComposeAcme({
        ...baseArgs,
        promotedIp: '10.0.0.2',
        deps: { mergeEnv: boom, run: vi.fn(), log: vi.fn(), warn },
      }),
    ).resolves.toBe(false);
    await expect(
      disarmComposeAcme({
        ...baseArgs,
        oldPrimaryIp: '10.0.0.1',
        deps: { mergeEnv: boom, run: vi.fn(), log: vi.fn(), warn },
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('armComposeAcme restores the saved certificate before the recreate (failover)', () => {
  const baseArgs = { sshKeyPath: '/k', projectName: 'demo', promotedIp: '10.0.0.2' };

  it('runs the restore after the .env merge and before the recreate script', async () => {
    const order: string[] = [];
    const mergeEnv = vi.fn(async () => {
      order.push('merge');
    });
    const restore = vi.fn(async () => {
      order.push('restore');
      return { restored: true, reason: 'restored from the last snapshot' };
    });
    const run = vi.fn(async () => {
      order.push('recreate');
      return 'ok';
    });
    const ok = await armComposeAcme({
      ...baseArgs,
      deps: { mergeEnv, run, restore, log: vi.fn() },
    });
    expect(ok).toBe(true);
    expect(order).toEqual(['merge', 'restore', 'recreate']);
  });

  it('says the restored certificate is served when the restore landed', async () => {
    const log = vi.fn();
    await armComposeAcme({
      ...baseArgs,
      deps: {
        mergeEnv: vi.fn().mockResolvedValue(undefined),
        run: vi.fn().mockResolvedValue('ok'),
        restore: async () => ({ restored: true, reason: 'restored from the last snapshot' }),
        log,
      },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('serving the restored certificate');
    expect(log.mock.calls[0][0]).not.toContain('issuance');
  });

  it('says issuance started when nothing was restored', async () => {
    const log = vi.fn();
    await armComposeAcme({
      ...baseArgs,
      deps: {
        mergeEnv: vi.fn().mockResolvedValue(undefined),
        run: vi.fn().mockResolvedValue('ok'),
        restore: async () => ({ restored: false, reason: 'no recorded CA' }),
        log,
      },
    });
    expect(log.mock.calls[0][0]).toContain('certificate issuance started');
  });

  it('a restore that throws still recreates traefik and returns true (a DR path never throws over certificates)', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const warn = vi.fn();
    const ok = await armComposeAcme({
      ...baseArgs,
      deps: {
        mergeEnv: vi.fn().mockResolvedValue(undefined),
        run,
        restore: vi.fn().mockRejectedValue(new Error('s3 exploded')),
        log: vi.fn(),
        warn,
      },
    });
    expect(ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toContain('up -d --no-deps traefik');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('restoreFailoverTls (the restore armComposeAcme runs on the promoted node)', () => {
  afterEach(() => vi.useRealTimers());
  const envConfig = (over: Record<string, unknown> = {}) => ({
    domain: 'app.example.com',
    provider: 'hetzner',
    ...over,
  });
  const S3 = { bucket: 'b', accessKey: 'AK', secretKey: 'SK', region: 'r', endpoint: 'e' };
  const base = { envName: 'prod', projectName: 'demo', ip: '10.0.0.2', sshKeyPath: '/k' };

  it('no recorded CA: never resolves credentials, never restores, returns the line saying why', async () => {
    const resolveS3 = vi.fn();
    const restore = vi.fn();
    const r = await restoreFailoverTls({
      ...base,
      envConfig: envConfig(),
      deps: { resolveS3, restore },
    });
    expect(r).toEqual({
      restored: false,
      reason: 'no recorded CA',
      line: 'TLS certificate not restored (no recorded CA).',
    });
    expect(resolveS3).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('with a recorded CA: no prompt, the recorded CA and domain, each piece bounded, no restart', async () => {
    const resolveS3 = vi.fn().mockResolvedValue(S3);
    const restore = vi
      .fn()
      .mockResolvedValue({ restored: true, reason: 'restored from the last snapshot' });
    const r = await restoreFailoverTls({
      ...base,
      envConfig: envConfig({ tls: { state: 'trusted', ca: 'prod' } }),
      deps: { resolveS3, restore },
    });
    expect(resolveS3).toHaveBeenCalledTimes(1);
    expect(resolveS3.mock.calls[0][0]).toMatchObject({
      isCompose: true,
      envName: 'prod',
      projectName: 'demo',
      skipPrompts: true,
    });
    const a = restore.mock.calls[0][0];
    expect(a).toMatchObject({
      ip: '10.0.0.2',
      sshKeyPath: '/k',
      projectName: 'demo',
      domain: 'app.example.com',
      envName: 'prod',
      ca: 'prod',
      s3Config: S3,
      restart: false,
      s3ClientOptions: {
        maxAttempts: 1,
        requestHandler: { connectionTimeout: 10_000, requestTimeout: 10_000 },
      },
    });
    expect(a.checkTimeoutMs).toBeLessThanOrEqual(30_000);
    expect(a.writeTimeoutMs).toBeLessThanOrEqual(60_000);
    expect(r.line).toBe('TLS certificate for app.example.com restored from its last snapshot.');
  });

  it('a promoted node that never answers the check: restore timed out, the failover goes on', async () => {
    vi.useFakeTimers();
    const hang = vi.fn(
      (_ip: string, _k: string, _argv: string[], opts: { timeout?: number } = {}) =>
        new Promise((_res, rej) =>
          setTimeout(
            () => rej(Object.assign(new Error('Command timed out'), { timedOut: true })),
            opts.timeout,
          ),
        ),
    );
    // A snapshot exists (it is read first), so the live check is what hangs.
    const read = vi.fn(async () => ({ text: acmeJson({}) }));
    const pending = restoreFailoverTls({
      ...base,
      envConfig: envConfig({ tls: { ca: 'staging' } }),
      deps: {
        resolveS3: async () => S3,
        restore: (a: Parameters<typeof restoreComposeTls>[0]) =>
          restoreComposeTls({ ...a, deps: { ssh: hang, read } }),
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await pending;
    expect(r).toMatchObject({ restored: false, reason: 'restore timed out' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a credential lookup that throws degrades to re-issuance, never a throw', async () => {
    const restore = vi.fn();
    const r = await restoreFailoverTls({
      ...base,
      envConfig: envConfig({ tls: { ca: 'staging' } }),
      deps: { resolveS3: vi.fn().mockRejectedValue(new Error('boom')), restore },
    });
    expect(r).toMatchObject({ restored: false, reason: 'restore errored' });
    expect(r.line).toBe('TLS certificate not restored (restore errored).');
    expect(restore).not.toHaveBeenCalled();
  });

  it('logs nothing itself (the failover prints the line after its spinner stops)', async () => {
    const info = vi.spyOn(p.log, 'info').mockImplementation(() => {});
    await restoreFailoverTls({ ...base, envConfig: envConfig(), deps: {} });
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });
});
