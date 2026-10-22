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
import { describe, expect, it, vi } from 'vitest';
import {
  ACME_DISARM_ENV,
  ACME_DISARMED_CA_SERVER,
  armComposeAcme,
  composeTraefikRecreateShell,
  disarmComposeAcme,
} from '../../../src/lib/deploy/acme-role.js';
import { restoreFailoverTls } from '../../../src/lib/deploy/compose/tls-restore.js';

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
  const envConfig = (over: Record<string, unknown> = {}) => ({
    domain: 'app.example.com',
    provider: 'hetzner',
    ...over,
  });
  const S3 = { bucket: 'b', accessKey: 'AK', secretKey: 'SK', region: 'r', endpoint: 'e' };

  it('no recorded CA: never resolves credentials, never restores, says why in one info line', async () => {
    const resolveS3 = vi.fn();
    const restore = vi.fn();
    const log = vi.fn();
    const r = await restoreFailoverTls({
      envName: 'prod',
      envConfig: envConfig(),
      projectName: 'demo',
      ip: '10.0.0.2',
      sshKeyPath: '/k',
      deps: { resolveS3, restore, log },
    });
    expect(r).toEqual({ restored: false, reason: 'no recorded CA' });
    expect(resolveS3).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe('TLS certificate not restored (no recorded CA).');
  });

  it('with a recorded CA: resolves the backup bucket without prompting and restores with the recorded CA and domain', async () => {
    const resolveS3 = vi.fn().mockResolvedValue(S3);
    const restore = vi
      .fn()
      .mockResolvedValue({ restored: true, reason: 'restored from the last snapshot' });
    const log = vi.fn();
    await restoreFailoverTls({
      envName: 'prod',
      envConfig: envConfig({ tls: { state: 'trusted', ca: 'prod' } }),
      projectName: 'demo',
      ip: '10.0.0.2',
      sshKeyPath: '/k',
      deps: { resolveS3, restore, log },
    });
    expect(resolveS3).toHaveBeenCalledTimes(1);
    expect(resolveS3.mock.calls[0][0]).toMatchObject({
      isCompose: true,
      envName: 'prod',
      projectName: 'demo',
      skipPrompts: true,
    });
    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({
        ip: '10.0.0.2',
        sshKeyPath: '/k',
        projectName: 'demo',
        domain: 'app.example.com',
        envName: 'prod',
        ca: 'prod',
        s3Config: S3,
      }),
    );
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      'TLS certificate for app.example.com restored from its last snapshot.',
    ]);
  });

  it('a credential lookup that throws degrades to re-issuance with one line, never a throw', async () => {
    const log = vi.fn();
    const restore = vi.fn();
    const r = await restoreFailoverTls({
      envName: 'prod',
      envConfig: envConfig({ tls: { ca: 'staging' } }),
      projectName: 'demo',
      ip: '10.0.0.2',
      sshKeyPath: '/k',
      deps: { resolveS3: vi.fn().mockRejectedValue(new Error('boom')), restore, log },
    });
    expect(r.restored).toBe(false);
    expect(restore).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe('TLS certificate not restored (restore errored).');
  });
});

describe('failoverComposeHA wiring', () => {
  it('arms the promoted node with the saved-certificate restore', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/compose/ha.js'), 'utf8');
    const call = src.slice(src.indexOf('const acmeArmed = await armComposeAcme({'));
    const body = call.slice(0, call.indexOf('});'));
    expect(body).toContain('restore: () =>');
    expect(body).toContain('restoreFailoverTls({');
    expect(body).toContain('envConfig,');
  });
});
