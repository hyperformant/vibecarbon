/**
 * Primary-only add-on e2e checks: name-list parsing, the lists read from the
 * standby policy, and skip-when-nothing-is-enabled (HA scenarios turn the
 * add-ons on; no SSH is involved, the remote is injected).
 */
import { describe, expect, it } from 'vitest';
import type { IncarnationRead, RemoteRun } from '../../e2e/checks/ha-integrity.js';
import {
  buildN8nKeyFingerprintCommand,
  checkN8nKeyShared,
  checkPromotedAddonsReady,
  checkPromotedDbNotRecreated,
  checkPromotedPrimaryOnlyRunning,
  checkStandbyPrimaryOnlyAbsent,
  enabledAddons,
  haScenarioFeatures,
  parseContainerNames,
  parseN8nKeyFingerprint,
  parseReadyDeployments,
} from '../../e2e/checks/standby-addons.js';

const KEY = '/tmp/key';
const IP = '203.0.113.20';
const P = 'quorum';
const FEATURES = ['observability', 'n8n', 'metabase', 'redis'];

function runner(output: string, ok = true): RemoteRun & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (_ip: string, remote: string) => {
    calls.push(remote);
    return ok ? { ok: true, output } : { ok: false, output: '', error: 'boom' };
  }) as RemoteRun & { calls: string[] };
  run.calls = calls;
  return run;
}
const ps = (...names: string[]) => `${names.join('\n')}\nPROBE_DONE`;
const base = { mode: 'compose-ha' as const, projectName: P, sshKeyPath: KEY, features: FEATURES };

describe('parseContainerNames', () => {
  it('returns the names without the sentinel', () => {
    expect(parseContainerNames(ps('quorum-db', 'quorum-app'))).toEqual(['quorum-db', 'quorum-app']);
  });
  it('is null without the sentinel (a truncated or empty read proves nothing)', () => {
    expect(parseContainerNames('quorum-db\n')).toBeNull();
    expect(parseContainerNames('')).toBeNull();
    expect(parseContainerNames(undefined)).toBeNull();
  });
  it('an empty list with the sentinel is an empty list', () => {
    expect(parseContainerNames('PROBE_DONE')).toEqual([]);
  });
});

describe('feature selection', () => {
  it('enabledAddons keeps only declared add-ons', () => {
    expect(enabledAddons(['n8n', 'bogus'])).toEqual(['n8n']);
  });
  it('HA modes add every declared add-on, non-HA and overrides do not', () => {
    const ha = haScenarioFeatures('compose-ha', ['observability'], false);
    expect(ha).toEqual(expect.arrayContaining(['observability', 'n8n', 'metabase', 'redis']));
    expect(new Set(ha).size).toBe(ha.length);
    expect(haScenarioFeatures('k8s-ha', ['observability'], false)).toEqual(ha);
    expect(haScenarioFeatures('compose', ['observability'], false)).toEqual(['observability']);
    expect(haScenarioFeatures('k8s', ['observability'], false)).toEqual(['observability']);
    expect(haScenarioFeatures('compose-ha', [], true)).toEqual([]);
  });
});

describe('standby_primary_only_absent', () => {
  it('passes when no scaled add-on container exists (setup containers included)', async () => {
    const run = runner(ps('quorum-db', 'quorum-app', 'quorum-redis'));
    const r = await checkStandbyPrimaryOnlyAbsent({ ...base, standbyIp: IP, run });
    expect(r.status).toBe('pass');
    expect(run.calls[0]).toContain('docker ps -a');
  });
  it('fails naming a leftover add-on container or setup', async () => {
    const r = await checkStandbyPrimaryOnlyAbsent({
      ...base,
      standbyIp: IP,
      run: runner(ps('quorum-db', 'quorum-n8n', 'quorum-metabase-setup')),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('quorum-n8n');
    expect(r.errorMessage).toContain('quorum-metabase-setup');
  });
  it('skips with no primary-only add-on enabled', async () => {
    const run = runner(ps());
    const r = await checkStandbyPrimaryOnlyAbsent({
      ...base,
      features: ['observability', 'redis'],
      standbyIp: IP,
      run,
    });
    expect(r.status).toBe('skip');
    expect(run.calls).toEqual([]);
  });
  it('fails on a missing handle, a failed read, or an unreadable list', async () => {
    const never = runner(ps());
    expect(
      (await checkStandbyPrimaryOnlyAbsent({ ...base, standbyIp: null, run: never })).status,
    ).toBe('fail');
    expect(
      (
        await checkStandbyPrimaryOnlyAbsent({
          ...base,
          sshKeyPath: null,
          standbyIp: IP,
          run: never,
        })
      ).status,
    ).toBe('fail');
    expect(never.calls).toEqual([]);
    expect(
      (await checkStandbyPrimaryOnlyAbsent({ ...base, standbyIp: IP, run: runner('', false) }))
        .status,
    ).toBe('fail');
    expect(
      (await checkStandbyPrimaryOnlyAbsent({ ...base, standbyIp: IP, run: runner('quorum-db') }))
        .status,
    ).toBe('fail');
  });
});

describe('promoted_primary_only_running', () => {
  it('passes when n8n and metabase run (setups are not required)', async () => {
    const run = runner(ps('quorum-db', 'quorum-app', 'quorum-n8n', 'quorum-metabase'));
    const r = await checkPromotedPrimaryOnlyRunning({ ...base, primaryIp: IP, run });
    expect(r.status).toBe('pass');
    expect(run.calls[0]).not.toContain('-a ');
  });
  it('fails naming the add-on that is not running', async () => {
    const r = await checkPromotedPrimaryOnlyRunning({
      ...base,
      primaryIp: IP,
      run: runner(ps('quorum-db', 'quorum-n8n')),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('quorum-metabase');
    expect(r.errorMessage).not.toContain('quorum-n8n,');
  });
  it('skips with none enabled and fails without a handle', async () => {
    expect(
      (await checkPromotedPrimaryOnlyRunning({ ...base, features: [], primaryIp: IP })).status,
    ).toBe('skip');
    expect((await checkPromotedPrimaryOnlyRunning({ ...base, primaryIp: null })).status).toBe(
      'fail',
    );
  });
});

describe('promoted_db_not_recreated', () => {
  const read = (id: string, startedAt = 't0'): IncarnationRead => ({
    ok: true,
    incarnation: { id, startedAt },
  });
  const bad: IncarnationRead = { ok: false, error: 'db is not running' };
  const opts = { features: FEATURES, ip: IP };
  it('passes on the same container id (a changed start time alone is not a recreate)', () => {
    expect(
      checkPromotedDbNotRecreated({ ...opts, before: read('a'), after: read('a', 't1') }).status,
    ).toBe('pass');
  });
  it('fails on a different id and on an unread side', () => {
    const r = checkPromotedDbNotRecreated({ ...opts, before: read('a'), after: read('b') });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('a -> b');
    expect(checkPromotedDbNotRecreated({ ...opts, before: bad, after: read('a') }).status).toBe(
      'fail',
    );
    expect(checkPromotedDbNotRecreated({ ...opts, before: read('a'), after: bad }).status).toBe(
      'fail',
    );
  });
  it('skips with no primary-only add-on enabled', () => {
    expect(
      checkPromotedDbNotRecreated({ features: [], ip: IP, before: bad, after: bad }).status,
    ).toBe('skip');
  });
});

describe('promoted_addons_ready', () => {
  const deployments = (...items: Array<[string, number | undefined]>) =>
    JSON.stringify({
      items: items.map(([name, readyReplicas]) => ({
        metadata: { name },
        status: readyReplicas === undefined ? {} : { readyReplicas },
      })),
    });
  const k8s = { ...base, mode: 'k8s-ha' as const };
  it('parses ready deployments, null when unparseable', () => {
    expect([...(parseReadyDeployments(deployments(['n8n', 1], ['x', 0])) as Set<string>)]).toEqual([
      'n8n',
    ]);
    expect(parseReadyDeployments('nope')).toBeNull();
    expect(parseReadyDeployments('{}')).toBeNull();
  });
  it('passes when every vibecarbon add-on deployment is ready', async () => {
    const run = runner(deployments(['n8n', 1], ['metabase', 2], ['redis', 1], ['app', 2]));
    expect((await checkPromotedAddonsReady({ ...k8s, primaryIp: IP, run })).status).toBe('pass');
  });
  it('fails naming a zero, absent, or status-less deployment', async () => {
    const r = await checkPromotedAddonsReady({
      ...k8s,
      primaryIp: IP,
      run: runner(deployments(['n8n', 0], ['redis', undefined])),
    });
    expect(r.status).toBe('fail');
    for (const n of ['n8n', 'metabase', 'redis']) expect(r.errorMessage).toContain(n);
  });
  it('skips with no add-on enabled and fails without a handle or on bad reads', async () => {
    expect((await checkPromotedAddonsReady({ ...k8s, features: [], primaryIp: IP })).status).toBe(
      'skip',
    );
    expect((await checkPromotedAddonsReady({ ...k8s, primaryIp: null })).status).toBe('fail');
    expect(
      (await checkPromotedAddonsReady({ ...k8s, primaryIp: IP, run: runner('', false) })).status,
    ).toBe('fail');
    expect(
      (await checkPromotedAddonsReady({ ...k8s, primaryIp: IP, run: runner('garbage') })).status,
    ).toBe('fail');
  });
});

describe('n8n_key_shared', () => {
  const FP_A = 'a'.repeat(64);
  const FP_B = 'b'.repeat(64);
  const probe = (fp: string) => `FP=${fp}\nPROBE_DONE`;
  /** Answers the primary and the standby from a per-IP table. */
  const perIp = (table: Record<string, { ok: boolean; output: string }>): RemoteRun =>
    (async (ip: string) => ({ error: 'boom', ...table[ip] })) as RemoteRun;
  const P_IP = '203.0.113.1';
  const S_IP = '203.0.113.2';
  const o = { ...base, primaryIp: P_IP, standbyIp: S_IP };

  it('parses fingerprints, MISSING, and unreadable output', () => {
    expect(parseN8nKeyFingerprint(probe(FP_A))).toBe(FP_A);
    expect(parseN8nKeyFingerprint(probe('MISSING'))).toBe('MISSING');
    expect(parseN8nKeyFingerprint('FP=abc\nPROBE_DONE')).toBeNull();
    expect(parseN8nKeyFingerprint(`FP=${FP_A}`)).toBeNull();
  });
  it('the command fingerprints remotely and never prints the value', () => {
    for (const mode of ['compose-ha', 'k8s-ha'] as const) {
      const cmd = buildN8nKeyFingerprintCommand(mode, P);
      expect(cmd).toContain('sha256sum');
      expect(cmd).toContain('N8N_ENCRYPTION_KEY');
      expect(cmd).not.toMatch(/echo "?\$v/);
    }
    expect(buildN8nKeyFingerprintCommand('k8s-ha', P)).toContain('vibecarbon-infra-secrets');
    expect(buildN8nKeyFingerprintCommand('compose-ha', P)).toContain('/opt/quorum/.env');
  });
  it('passes on equal fingerprints', async () => {
    const run = perIp({
      [P_IP]: { ok: true, output: probe(FP_A) },
      [S_IP]: { ok: true, output: probe(FP_A) },
    });
    expect((await checkN8nKeyShared({ ...o, run })).status).toBe('pass');
  });
  it('fails on different fingerprints without leaking values', async () => {
    const run = perIp({
      [P_IP]: { ok: true, output: probe(FP_A) },
      [S_IP]: { ok: true, output: probe(FP_B) },
    });
    const r = await checkN8nKeyShared({ ...o, run });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('differs');
  });
  it('fails when missing on either side', async () => {
    for (const [a, b] of [
      ['MISSING', FP_A],
      [FP_A, 'MISSING'],
    ]) {
      const run = perIp({
        [P_IP]: { ok: true, output: probe(a) },
        [S_IP]: { ok: true, output: probe(b) },
      });
      const r = await checkN8nKeyShared({ ...o, run });
      expect(r.status).toBe('fail');
      expect(r.errorMessage).toContain('missing');
    }
  });
  it('fails when a side is unreadable or unreachable', async () => {
    const good = { ok: true, output: probe(FP_A) };
    expect(
      (
        await checkN8nKeyShared({
          ...o,
          run: perIp({ [P_IP]: good, [S_IP]: { ok: true, output: 'junk' } }),
        })
      ).status,
    ).toBe('fail');
    expect(
      (
        await checkN8nKeyShared({
          ...o,
          run: perIp({ [P_IP]: good, [S_IP]: { ok: false, output: '' } }),
        })
      ).status,
    ).toBe('fail');
    expect((await checkN8nKeyShared({ ...o, standbyIp: null })).status).toBe('fail');
  });
  it('skips only when n8n is not enabled', async () => {
    expect((await checkN8nKeyShared({ ...o, features: ['metabase', 'redis'] })).status).toBe(
      'skip',
    );
  });
});
