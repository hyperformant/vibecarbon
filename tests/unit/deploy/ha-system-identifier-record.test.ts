/**
 * The deploy records `ha.systemIdentifier` (failover's replica proof, R1) only
 * when it verified streaming. A deploy that finished degraded records nothing,
 * so an unplanned failover refuses until a deploy proves the standby.
 *
 * Three links, each checked: setupReplication's result reaches ctx through the
 * k8s-ha replication effect; the orchestrator copies ctx onto the k8s-ha
 * deployResult; and the final save spreads `haSeedRecord(deployResult)` into
 * the persisted `ha` block.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/deploy/compose/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/deploy/compose/index.js')>()),
  sshRun: vi.fn(),
}));

vi.mock('../../../src/lib/deploy/k8s/ha/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/deploy/k8s/ha/index.js')>()),
  setupReplication: vi.fn(),
}));

// The standby image copy runs once the transport is up; stubbed so no test
// reaches the real ssh copy.
vi.mock('../../../src/lib/deploy/k8s/ha/image-copy.js', () => ({
  copyAppImageToStandby: vi.fn(async () => ({ digest: 'sha256:aa', skipped: true })),
}));

const { setupReplication } = await import('../../../src/lib/deploy/k8s/ha/index.js');
const { K8S_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/k8s-ha.js');
const { haSeedRecord } = await import('../../../src/lib/deploy/failover-guard.js');
const composeSsh = await import('../../../src/lib/deploy/compose/index.js');
const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const SYSID = '7412345678901234567';

describe('haSeedRecord', () => {
  it('records the identifier when streaming was verified', () => {
    expect(haSeedRecord({ replicationStatus: 'streaming', systemIdentifier: SYSID })).toEqual({
      systemIdentifier: SYSID,
    });
  });

  it('records nothing for a degraded deploy, even with an identifier in hand', () => {
    expect(
      haSeedRecord({
        replicationStatus: 'DEGRADED (warm standby: NOT streaming)',
        systemIdentifier: SYSID,
      }),
    ).toEqual({});
  });

  it('records nothing without an identifier (compose-ha, single cluster, no result)', () => {
    expect(haSeedRecord({ replicationStatus: 'streaming', systemIdentifier: null })).toEqual({});
    expect(haSeedRecord({ replication: 'streaming' } as never)).toEqual({});
    expect(haSeedRecord(undefined as never)).toEqual({});
  });
});

describe('k8s-ha replication effect', () => {
  const ctx = () => ({
    s: { start: vi.fn(), stop: vi.fn() },
    options: {},
    primaryResult: { masterIp: '1.1.1.1', dbIp: '1.1.1.2', dbPrivateIp: '10.0.1.2' },
    standbyResult: { masterIp: '2.2.2.1', dbIp: '2.2.2.2', dbPrivateIp: '10.0.1.2' },
    sharedSshKeyPath: '/k',
  });

  it('carries the verified-streaming identifier onto ctx', async () => {
    vi.mocked(setupReplication).mockResolvedValueOnce({
      streaming: true,
      lastState: 'streaming',
      systemIdentifier: SYSID,
    });
    const c = ctx() as Record<string, unknown>;
    await K8S_HA_EFFECTS.haK8sConfigureReplication(c);
    expect(c.systemIdentifier).toBe(SYSID);
  });

  it('leaves it null when replication did not stream or threw', async () => {
    vi.mocked(setupReplication).mockResolvedValueOnce({
      streaming: false,
      lastState: '',
      systemIdentifier: null,
    });
    const c1 = ctx() as Record<string, unknown>;
    await K8S_HA_EFFECTS.haK8sConfigureReplication(c1);
    expect(c1.systemIdentifier ?? null).toBeNull();

    vi.mocked(setupReplication).mockRejectedValueOnce(new Error('tunnel down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c2 = ctx() as Record<string, unknown>;
    await K8S_HA_EFFECTS.haK8sConfigureReplication(c2);
    expect(c2.systemIdentifier ?? null).toBeNull();
    errSpy.mockRestore();
  });
});

describe('orchestrator persistence', () => {
  const src = readFileSync(join(REPO, 'src/lib/deploy/orchestrator.js'), 'utf-8');

  it('the k8s-ha deployResult carries the replication status and the identifier', () => {
    const after = src.slice(src.indexOf('const k8sHaCtx = { options: deploymentConfig };'));
    const block = after.slice(after.indexOf('deployResult = {'));
    const result = block.slice(0, block.indexOf('};') + 2);
    expect(result).toContain('replicationStatus: k8sHaCtx.replicationStatus');
    expect(result).toContain('systemIdentifier: k8sHaCtx.systemIdentifier');
  });

  it('the compose-ha deployResult carries the replication status and the identifier', () => {
    const after = src.slice(src.indexOf('const composeHaCtx = {'));
    const block = after.slice(after.indexOf('deployResult = {'));
    const result = block.slice(0, block.indexOf('};') + 2);
    // A reconverge that has not proven streaming records nothing (Task 3b).
    expect(result).toContain(
      "replicationStatus: composeHaCtx.replActive && !haDegraded ? 'streaming'",
    );
    expect(result).toContain('systemIdentifier: composeHaCtx.systemIdentifier');
  });

  it('the persisted ha block records it only through haSeedRecord', () => {
    expect(src).toContain('...haSeedRecord(deployResult),');
    // No ungated write of the field: the only other spellings are the two HA
    // tiers' deployResult copies from their ctx.
    const writes = src.split('\n').filter((l) => /systemIdentifier:/.test(l));
    expect(writes.map((l) => l.trim())).toEqual([
      'systemIdentifier: composeHaCtx.systemIdentifier ?? null,',
      'systemIdentifier: k8sHaCtx.systemIdentifier ?? null,',
    ]);
  });
});

describe('compose-ha verify-streaming effect', () => {
  const ctx = () => ({
    projectConfig: { projectName: 'myapp' },
    primary: { ip: '1.1.1.1' },
    standby: { ip: '2.2.2.2' },
    sshKeyPath: '/k',
    allowDegraded: true,
    onProgress: () => {},
  });
  const answer = (primaryState: string, standbyRow: string) =>
    vi.mocked(composeSsh.sshRun).mockImplementation((async (
      ip: string,
      _k: string,
      cmd: string,
    ) => {
      if (cmd.includes('pg_stat_replication')) return primaryState;
      if (ip === '2.2.2.2' && cmd.includes('pg_control_system')) return standbyRow;
      return '';
    }) as never);

  it('records the identifier the standby reports in recovery when streaming was verified', async () => {
    answer('streaming', `t|${SYSID}|0/3000060|streaming|1`);
    const c = ctx() as Record<string, unknown>;
    await COMPOSE_HA_EFFECTS.haVerifyStreaming(c);
    expect(c.replActive).toBe(true);
    expect(c.systemIdentifier).toBe(SYSID);
  });

  it('records nothing when the standby does not read in recovery', async () => {
    answer('streaming', `f|${SYSID}|0/3000060||`);
    const c = ctx() as Record<string, unknown>;
    await COMPOSE_HA_EFFECTS.haVerifyStreaming(c);
    expect(c.systemIdentifier).toBeNull();
  });

  it('records nothing for a degraded deploy, and never reads the standby', async () => {
    answer('', `t|${SYSID}|0/3000060|streaming|1`);
    const c = ctx() as Record<string, unknown>;
    // verifyStreaming backs off between its reads; run its sleeps on a fake clock.
    vi.useFakeTimers();
    try {
      const done = COMPOSE_HA_EFFECTS.haVerifyStreaming(c);
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(c.replActive).toBe(false);
    expect(c.systemIdentifier).toBeNull();
    const reads = vi
      .mocked(composeSsh.sshRun)
      .mock.calls.filter((call) => String(call[2]).includes('pg_control_system'));
    expect(reads).toEqual([]);
  });
});
