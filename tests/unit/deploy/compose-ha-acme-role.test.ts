/**
 * Compose-HA single-active-ACME-issuer policy (the compose mirror of
 * src/lib/deploy/k8s/acme-issuer-policy.js).
 *
 * THE PROBLEM: both nodes run a full Traefik with a `letsencrypt` resolver
 * for the SAME names. Every certificate validates with HTTP-01, and Let's
 * Encrypt fetches the challenge from the address the domain resolves to, so
 * only the node DNS points at can pass one. An armed issuer on the other
 * node fails every order, and each failure counts against the 5 failed
 * validations per hostname per hour that the serving node shares.
 *
 * THE POLICY: only the node DNS points at (the primary role) runs an armed
 * ACME issuer. The standby's Traefik points its `caserver` at a
 * reserved-`.invalid` URL (instant NXDOMAIN, zero ACME traffic, and the
 * hostname self-documents in any log tail) and serves what its acme.json
 * holds, or the default cert, until a failover arms it after the DNS flip.
 * Compose interpolation carries the whole policy:
 * `${ACME_DISARMED_CA_SERVER:-${ACME_CA_SERVER:-<prod>}}`, set on the
 * standby only, empty (= fall through) everywhere else. Verified against
 * live `docker compose config`: set → disarmed URL; empty/unset → the
 * ACME_CA_SERVER value or the prod default.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { composeFileFlags } from '../../../src/lib/deploy/bundle.js';
import {
  restoreComposeTls,
  restoreFailoverTls,
} from '../../../src/lib/deploy/compose/tls-restore.js';
import { writeVcCompose } from '../../_shared/vc-compose-stub.js';
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
  // The caserver flag must consult the disarm var FIRST, then the real
  // ACME_CA_SERVER, then the prod default. Any compose file that restates the
  // Traefik command (Compose replaces sequences) must keep that order; a
  // future file that adds a caserver line is drafted automatically.
  const carbonDir = join(process.cwd(), 'carbon');
  const composeFiles = readdirSync(carbonDir).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));

  it('finds the one caserver site (the base prod file)', () => {
    const withCaserver = composeFiles.filter((f) =>
      readFileSync(join(carbonDir, f), 'utf8').includes('acme.caserver='),
    );
    expect(withCaserver).toEqual(['docker-compose.prod.yml']);
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

  it('recreates traefik through vc-compose, never a bare up', () => {
    expect(shell).toContain('sh vc-compose up -d --no-deps traefik');
    expect(shell).not.toMatch(/\bdocker compose\b/);
  });

  it('the recreate keeps the add-on overlays the node runs (vc-compose carries the deploy set)', () => {
    // A bare `up` resolves docker-compose.yml alone and would recreate
    // Traefik WITHOUT the prod file and the add-on overlays the node runs.
    // vc-compose carries the deploy's own set.
    const dir = mkdtempSync(join(tmpdir(), 'vc-acme-role-'));
    try {
      writeVcCompose(dir, composeFileFlags({ observability: true }));
      writeFileSync(
        join(dir, 'docker'),
        `#!/bin/sh\necho "$*" >> "${dir}/calls"\ncase "$*" in *" ps -q traefik") echo cid ;; esac\nexit 0\n`,
      );
      chmodSync(join(dir, 'docker'), 0o755);
      const r = spawnSync('bash', ['-c', composeTraefikRecreateShell(dir)], {
        encoding: 'utf-8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
      expect(r.status, r.stderr).toBe(0);
      const up = readFileSync(join(dir, 'calls'), 'utf-8')
        .split('\n')
        .find((l) => l.endsWith(' up -d --no-deps traefik'));
      expect(up).toBe(
        'compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.observability.yml -f docker-compose.observability.prod.yml up -d --no-deps traefik',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('a failed arm warns that the recreate ran on the live node: how to check it and how to repair', async () => {
    const warn = vi.fn();
    await armComposeAcme({
      ...baseArgs,
      promotedIp: '10.0.0.2',
      deps: { mergeEnv: vi.fn().mockRejectedValue(new Error('ssh: reset')), run: vi.fn(), warn },
    });
    const said = String(warn.mock.calls[0][0]);
    expect(said).toContain('ran on the live node and may have left Traefik stopped');
    expect(said).toContain("ssh root@10.0.0.2 'cd /opt/demo && sh vc-compose ps traefik'");
    expect(said).toContain('`vibecarbon deploy <env>`');
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

describe('restoreFailoverTls (the restore the failover runs on the promoted node, before the DNS flip)', () => {
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

  it('with a recorded CA: no prompt, the recorded CA and domain, each piece bounded, traefik restarted onto it', async () => {
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
      // The promoted node's Traefik loads acme.json only when it starts: the
      // restart makes it serve the certificate before DNS moves. Its issuer
      // stays disarmed until after the flip.
      restart: true,
      s3ClientOptions: {
        maxAttempts: 1,
        requestHandler: { connectionTimeout: 10_000, socketTimeout: 10_000 },
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
