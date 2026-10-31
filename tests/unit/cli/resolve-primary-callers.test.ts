/**
 * Callers of resolvePrimary that must not guess (backup/restore integrity H4,
 * fix round 1): destroy stays an escape hatch, diagnose follows the roles,
 * compose failover refuses two primaries, status names a failed check.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AmbiguousPrimaryError, resolvePrimary } from '../../../src/lib/cli/resolve-primary.js';

const { backupOfferIp } = await import('../../../src/destroy.js');
const { controlplaneIpOf } = await import('../../../src/diagnose.js');
const { rejectedChecks } = await import('../../../src/status.js');
const { composeFailoverAbortBackend, failoverComposeHA } = await import(
  '../../../src/lib/deploy/compose/ha.js'
);

const A = '10.0.0.1';
const B = '10.0.0.9';

const twoPrimaries = () => ({
  deployMode: 'compose-ha',
  region: 'nbg1',
  secondaryRegion: 'ash',
  ha: { enabled: true },
  servers: [
    { name: 'app-prod-primary', role: 'primary', ip: A },
    { name: 'app-prod-standby', role: 'primary', ip: B },
  ],
});

describe('AmbiguousPrimaryError is actionable', () => {
  it('names the env and the deploy remedy', () => {
    const env = twoPrimaries();
    let err: unknown;
    try {
      resolvePrimary(env, { env: 'prod' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AmbiguousPrimaryError);
    expect((err as Error).message).toMatch(/^prod: /);
    expect((err as Error).message).toMatch(
      /Run `vibecarbon deploy prod` to record the server roles\.$/,
    );
  });

  it('returns the matched servers[] record as entry', () => {
    const env = { deployMode: 'compose', servers: [{ name: 'master', id: 7, ip: A }] };
    expect(resolvePrimary(env)?.entry).toBe(env.servers[0]);
  });

  it('a config known HA only by ha.failoverRegion is still held to the roles', () => {
    expect(() =>
      resolvePrimary({ ha: { failoverRegion: 'ash' }, servers: [{ ip: A }, { ip: B }] }),
    ).toThrow(AmbiguousPrimaryError);
  });
});

describe('destroy stays the escape hatch', () => {
  it('ambiguous roles skip the backup offer with the reason, and do not throw', () => {
    const warn = vi.fn();
    expect(backupOfferIp(twoPrimaries(), 'prod', warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/Skipping the pre-destroy backup offer.*prod/);
  });

  it('a resolvable primary is offered', () => {
    const env = twoPrimaries();
    env.servers[1].role = 'standby';
    expect(backupOfferIp(env, 'prod', vi.fn())).toBe(A);
  });
});

describe('diagnose probes the role primary', () => {
  it('after a k8s-ha failover it picks the promoted master, not the server named primary', () => {
    const env = {
      deployMode: 'kubernetes',
      ha: { enabled: true, primary: { masterIp: B }, standby: { masterIp: A } },
      servers: [
        { name: 'primary', role: 'standby', ip: A },
        { name: 'standby', role: 'primary', ip: B },
      ],
    };
    expect(controlplaneIpOf(env, 'prod')).toBe(B);
  });

  it('ambiguous roles skip the host probes instead of throwing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(controlplaneIpOf(twoPrimaries(), 'prod')).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('compose failover refuses two primaries (not first-wins)', () => {
  it('the abort backend throws AmbiguousPrimaryError', () => {
    expect(() =>
      composeFailoverAbortBackend({
        envName: 'prod',
        envConfig: twoPrimaries(),
        projectName: 'app',
        sshKeyPath: '/nonexistent',
      }),
    ).toThrow(AmbiguousPrimaryError);
  });

  it('failoverComposeHA throws AmbiguousPrimaryError', async () => {
    await expect(
      failoverComposeHA(
        'prod',
        twoPrimaries(),
        { projectName: 'app' },
        { values: {} },
        { start() {}, stop() {} },
        { keyExists: () => true },
      ),
    ).rejects.toThrow(AmbiguousPrimaryError);
  });

  it('zero primaries keeps the names-deploy refusal wording', () => {
    const env = twoPrimaries();
    env.servers[0].role = 'standby';
    env.servers[1].role = 'standby';
    expect(() =>
      composeFailoverAbortBackend({
        envName: 'prod',
        envConfig: env,
        projectName: 'app',
        sshKeyPath: '/nonexistent',
      }),
    ).toThrow(/Abort refused/);
  });
});

describe('status surfaces a rejected check', () => {
  it('names each failed check with its reason', () => {
    expect(
      rejectedChecks({
        replication: { status: 'rejected', reason: new AmbiguousPrimaryError('x.', 'prod') },
        containers: { status: 'fulfilled', value: null },
      }),
    ).toEqual({ replication: expect.stringMatching(/^prod: x\. Run `vibecarbon deploy prod`/) });
    expect(rejectedChecks({ replication: { status: 'fulfilled', value: null } })).toBeNull();
  });
});

describe('deploy cannot be blocked by the error it recommends', () => {
  it('the write-fence lift resolves the primary inside its try', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/orchestrator.js'), 'utf-8');
    const at = src.indexOf('rolePrimaryOf(tier, envConfig, environment)');
    const gate = src.lastIndexOf('envConfig?.ha?.writeFence', at);
    const tryAt = src.lastIndexOf('try {', at);
    expect(gate).toBeGreaterThan(-1);
    expect(tryAt).toBeGreaterThan(gate);
  });
});
