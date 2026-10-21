/**
 * `vibecarbon failover <env> -abort` (HA-correctness final review C1).
 *
 * The deadlock it breaks: a failover journal is set and the standby can no
 * longer be proven, so deploy refuses (journal), a rerun of failover refuses
 * (standby unreadable or mismatched) and every rerun keeps the old primary
 * fenced. -abort fences the STANDBY instead (its db stopped and proven down),
 * lifts the old primary's fence, starts its writers, clears the journal and
 * marks replication degraded so the next deploy reseeds the standby.
 *
 * Also the message census: every refusal that fires while a journal is set
 * names `vibecarbon failover <env> -abort`, never a command that refuses.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/ssh.js')>()),
  getPostgresPod: vi.fn(async () => 'db-0'),
  sshKubectl: vi.fn(async () => ''),
}));

const { abortFailover, recordFailoverAbort } = await import(
  '../../../src/lib/deploy/failover-abort.js'
);
const { composeFailoverAbortBackend } = await import('../../../src/lib/deploy/compose/ha.js');
const { k8sFailoverAbortBackend, SPEC } = await import('../../../src/failover.js');
const guard = await import('../../../src/lib/deploy/failover-guard.js');
const { assertRolePrimaryWritable } = await import('../../../src/lib/deploy/write-fence.js');
const { composeHaStandbyResyncHint } = await import(
  '../../../src/lib/deploy/compose/ha-role-swap.js'
);

const JOURNAL = { id: 'j1', target: 'standby', systemIdentifier: '7412345678901234567' };
const ABORT = /vibecarbon failover prod -abort/;

const journalEnv = (over: Record<string, unknown> = {}) => ({
  deployMode: 'compose-ha',
  replication: 'streaming',
  servers: [
    { name: 'myapp-prod-primary', role: 'primary', ip: '10.0.0.1' },
    { name: 'myapp-prod-standby', role: 'standby', ip: '10.0.0.2' },
  ],
  ...over,
  ha: { enabled: true, systemIdentifier: JOURNAL.systemIdentifier, failoverInFlight: JOURNAL },
});

/** A backend whose every step records its name, with overridable verdicts. */
const fakeBackend = (over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const step = (name: string, value: unknown) => async () => {
    calls.push(name);
    return value;
  };
  return {
    calls,
    backend: {
      ips: { primary: '10.0.0.1', standby: '10.0.0.2' },
      stopDbHint: "ssh root@10.0.0.2 'docker stop myapp-db'",
      unfenceHint: 'psql -c reset',
      stopStandbyDb: step('stopStandbyDb', { ok: true }),
      disarmStandby: step('disarmStandby', true),
      repointDns: step('repointDns', { ok: true }),
      primaryReachable: step('primaryReachable', true),
      unfencePrimary: step('unfencePrimary', true),
      armPrimary: step('armPrimary', true),
      writeBackupFence: step('writeBackupFence', { ok: true }),
      startPrimaryWriters: step('startPrimaryWriters', true),
      ...over,
    },
  };
};

const run = (envConfig: object, backend: object) => {
  const record = vi.fn();
  const lines: string[] = [];
  const warnings: string[] = [];
  const result = abortFailover({
    environment: 'prod',
    envConfig,
    backend,
    log: (l: string) => lines.push(l),
    warn: (l: string) => warnings.push(l),
    record,
  });
  return { result, record, lines, warnings };
};

describe('abortFailover: order and refusals', () => {
  it('refuses with no journal set, touching nothing', async () => {
    const { calls, backend } = fakeBackend();
    const { result, record } = run({ ha: { enabled: true } }, backend);
    await expect(result).rejects.toThrow(/Abort refused: no failover is in flight for prod/);
    expect(calls).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses when the standby db cannot be proven down: nothing else runs, nothing saved', async () => {
    const { calls, backend } = fakeBackend({
      stopStandbyDb: async () => {
        calls.push('stopStandbyDb');
        return { ok: false, reason: 'the node did not answer' };
      },
    });
    const { result, record } = run(journalEnv(), backend);
    await expect(result).rejects.toThrow(
      /could not prove the standby's database \(10\.0\.0\.2\) stopped \(the node did not answer\).*docker stop myapp-db.*rerun vibecarbon failover prod -abort/,
    );
    expect(calls).toEqual(['stopStandbyDb']);
    expect(record).not.toHaveBeenCalled();
  });

  it('fences the standby before anything on the primary, then saves once with the lift proven', async () => {
    const { calls, backend } = fakeBackend();
    const { result, record, warnings } = run(journalEnv(), backend);
    await expect(result).resolves.toEqual({ fenceLifted: true, warnings: [] });
    expect(calls).toEqual([
      'stopStandbyDb',
      'disarmStandby',
      'repointDns',
      'primaryReachable',
      'unfencePrimary',
      'armPrimary',
      'writeBackupFence',
      'startPrimaryWriters',
    ]);
    expect(record).toHaveBeenCalledWith(
      { environment: 'prod' },
      { fenceLifted: true, backupFence: { written: true, at: expect.any(String) } },
    );
    expect(warnings).toEqual([]);
  });

  it('a dead old primary: the journal still clears, the fence marker stays for the next deploy', async () => {
    const { calls, backend } = fakeBackend({ primaryReachable: async () => false });
    const { result, record, warnings } = run(journalEnv(), backend);
    await expect(result).resolves.toMatchObject({ fenceLifted: false });
    expect(calls).not.toContain('unfencePrimary');
    expect(record).toHaveBeenCalledWith(
      { environment: 'prod' },
      { fenceLifted: false, backupFence: null },
    );
    expect(warnings.join('\n')).toMatch(/does not answer.*next vibecarbon deploy prod/);
  });

  it('a lift that cannot be proven warns with the manual fix and keeps the marker', async () => {
    const { backend } = fakeBackend({ unfencePrimary: async () => false });
    const { result, record, warnings } = run(journalEnv(), backend);
    await expect(result).resolves.toMatchObject({ fenceLifted: false });
    expect(record).toHaveBeenCalledWith(
      { environment: 'prod' },
      { fenceLifted: false, backupFence: { written: true, at: expect.any(String) } },
    );
    expect(warnings.join('\n')).toMatch(/could not lift the database write fence.*psql -c reset/);
  });

  it('manual DNS (no repointDns) skips the flip; a failed flip names the record to set', async () => {
    const manual = fakeBackend({ repointDns: null });
    await run(journalEnv(), manual.backend).result;
    expect(manual.calls).not.toContain('repointDns');

    const failed = fakeBackend({ repointDns: async () => ({ ok: false, reason: 'token unset' }) });
    const { result, warnings } = run(journalEnv(), failed.backend);
    await result;
    expect(warnings.join('\n')).toMatch(
      /token unset.*A records \(apex and wildcard\) to 10\.0\.0\.1/,
    );
  });
});

describe('recordFailoverAbort: the one save', () => {
  let dir: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const seed = (env: Record<string, unknown>) => {
    dir = mkdtempSync(join(tmpdir(), 'vc-abort-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ projectName: 'myapp', environments: { prod: env } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  };
  const readEnv = () =>
    JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')).environments.prod;

  it('clears the journal, drops the identifier, marks degraded, and clears the marker on a proven lift', () => {
    seed(journalEnv({ ha: undefined }) as Record<string, unknown>);
    const env = readEnv();
    env.ha.writeFence = { node: 'myapp-prod-primary', ip: '10.0.0.1', at: 'x' };
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({ projectName: 'myapp', environments: { prod: env } }),
    );
    recordFailoverAbort({ environment: 'prod' }, { fenceLifted: true });
    const after = readEnv();
    expect(after.ha).toEqual({ enabled: true });
    expect(after.replication).toBe('degraded');
    expect(after.degraded).toBe(true);
    expect(after.servers).toHaveLength(2);
  });

  it('keeps the write-fence marker when the lift was not proven', () => {
    const env = journalEnv() as Record<string, unknown> & { ha: Record<string, unknown> };
    env.ha.writeFence = { node: 'myapp-prod-primary', ip: '10.0.0.1', at: 'x' };
    seed(env);
    recordFailoverAbort({ environment: 'prod' }, { fenceLifted: false });
    expect(readEnv().ha).toEqual({
      enabled: true,
      writeFence: { node: 'myapp-prod-primary', ip: '10.0.0.1', at: 'x' },
    });
  });
});

describe('compose-ha abort backend', () => {
  const make = (answers: Record<string, string | false>, over: Record<string, unknown> = {}) => {
    const commands: Array<{ ip: string; command: string }> = [];
    const rearm = vi.fn(async () => ({ ok: true }));
    const backend = composeFailoverAbortBackend({
      envName: 'prod',
      envConfig: journalEnv(),
      projectName: 'myapp',
      sshKeyPath: '/k',
      deps: {
        run: async (ip: string, _k: string, command: string) => {
          commands.push({ ip, command });
          for (const [needle, out] of Object.entries(answers)) {
            if (command.includes(needle)) return out;
          }
          return '';
        },
        mergeEnv: vi.fn(async () => {}),
        rearmWalg: rearm,
        armAcme: vi.fn(async () => true),
        disarmAcme: vi.fn(async () => true),
        ...over,
      },
    });
    return { backend, commands, rearm };
  };

  it('stops the standby db by container name, and proves it', async () => {
    const { backend, commands } = make({ 'docker stop myapp-db': 'DB_RUNNING=false' });
    await expect(backend.stopStandbyDb()).resolves.toEqual({ ok: true });
    expect(commands[0].ip).toBe('10.0.0.2');
    expect(commands[0].command).toMatch(/docker stop myapp-db/);
  });

  it('a db that still runs, or a node that does not answer, is not proven down', async () => {
    await expect(
      make({ 'docker stop myapp-db': 'DB_RUNNING=true' }).backend.stopStandbyDb(),
    ).resolves.toMatchObject({ ok: false, reason: /running=true/ });
    await expect(
      make({ 'docker stop myapp-db': false }).backend.stopStandbyDb(),
    ).resolves.toMatchObject({ ok: false, reason: /did not answer/ });
  });

  it('an absent db container counts as down', async () => {
    await expect(
      make({ 'docker stop myapp-db': 'DB_RUNNING=absent' }).backend.stopStandbyDb(),
    ).resolves.toEqual({ ok: true });
  });

  it('re-arms WALG_ROLE on the old primary only when its running db lost it', async () => {
    const kept = make({ 'docker inspect': 'WALG_ROLE=primary' });
    await expect(kept.backend.armPrimary()).resolves.toBe(true);
    expect(kept.rearm).not.toHaveBeenCalled();

    const lost = make({ 'docker inspect': 'WALG_ROLE=standby' });
    await expect(lost.backend.armPrimary()).resolves.toBe(true);
    expect(lost.rearm).toHaveBeenCalledWith(expect.objectContaining({ promotedIp: '10.0.0.1' }));
  });

  it('starts the stopped writers on the old primary', async () => {
    const { backend, commands } = make({ START_DONE: 'START_DONE' });
    await expect(backend.startPrimaryWriters()).resolves.toBe(true);
    expect(commands[0].ip).toBe('10.0.0.1');
    expect(commands[0].command).toMatch(/myapp-app myapp-n8n myapp-metabase/);
  });
});

describe('k8s-ha abort backend', () => {
  const envConfig = {
    deployMode: 'kubernetes',
    ha: {
      enabled: true,
      failoverInFlight: JOURNAL,
      primary: { masterIp: '10.1.0.1', floatingIp: '10.1.0.9', stack: 'prod-primary' },
      standby: { masterIp: '10.2.0.1', stack: 'prod-standby' },
      scaleUpList: [{ name: 'app', replicas: 2 }],
    },
  };
  const make = (respond: (argv: string[]) => unknown) => {
    const calls: Array<{ ip: string; argv: string[] }> = [];
    const scale = vi.fn(async () => {});
    const backend = k8sFailoverAbortBackend({
      envName: 'prod',
      envConfig,
      strategy: {},
      deps: {
        sshKeyPath: '/k',
        kubectl: async (ip: string, argv: string[]) => {
          calls.push({ ip, argv });
          return respond(argv);
        },
        scale,
      },
    });
    return { backend, calls, scale };
  };

  it('scales the standby db StatefulSet to zero and proves its pod gone', async () => {
    const { backend, calls } = make(() => '');
    await expect(backend.stopStandbyDb()).resolves.toEqual({ ok: true });
    expect(calls.every((c) => c.ip === '10.2.0.1')).toBe(true);
    expect(calls[0].argv).toEqual(['-n', 'vibecarbon', 'scale', 'statefulset/db', '--replicas=0']);
    expect(calls.at(-1)?.argv).toEqual(
      expect.arrayContaining(['get', 'pods', '-l', 'app=vibecarbon-db']),
    );
  });

  it('a db pod still listed is not proven down', async () => {
    const { backend } = make((argv) => (argv.includes('get') ? 'pod/db-0' : ''));
    await expect(backend.stopStandbyDb()).resolves.toMatchObject({
      ok: false,
      reason: /pod\/db-0 still exists/,
    });
  });

  it('re-arms WALG_ROLE=primary on the old primary only when the StatefulSet lost it', async () => {
    const sts = (role: string) =>
      JSON.stringify({
        spec: {
          template: {
            spec: { containers: [{ name: 'db', env: [{ name: 'WALG_ROLE', value: role }] }] },
          },
        },
      });
    const kept = make((argv) => (argv.includes('get') ? sts('primary') : ''));
    await expect(kept.backend.armPrimary()).resolves.toBe(true);
    expect(kept.calls.some((c) => c.argv.includes('set'))).toBe(false);

    const lost = make((argv) => (argv.includes('get') ? sts('standby') : ''));
    await expect(lost.backend.armPrimary()).resolves.toBe(true);
    expect(lost.calls.find((c) => c.argv.includes('set'))?.argv).toContain('WALG_ROLE=primary');
  });

  it('scales the old primary app tier back up from the persisted list', async () => {
    const { backend, scale } = make(() => '');
    await expect(backend.startPrimaryWriters()).resolves.toBe(true);
    expect(scale).toHaveBeenCalledWith(
      '10.1.0.1',
      envConfig.ha.scaleUpList,
      'up',
      expect.any(String),
    );
  });
});

describe('message census: a refusal that fires on a journal names -abort', () => {
  const env = journalEnv();
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it.each(['deploy', 'restore', 'scale'] as const)('assertNoFailoverInFlight (%s)', (action) => {
    const msg = refusal(() =>
      guard.assertNoFailoverInFlight({ environment: 'prod', envConfig: env, action }),
    );
    expect(msg).toMatch(new RegExp(`Refusing to ${action} "prod"`));
    expect(msg).toMatch(ABORT);
  });

  const unknown = {
    inRecovery: null,
    systemIdentifier: null,
    replayLsn: null,
    receiverStatus: null,
    lastMsgAgeS: null,
  };
  const rows: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['an unreadable standby', {}, unknown],
    [
      'a standby out of recovery under another identifier',
      {},
      { ...unknown, inRecovery: false, systemIdentifier: '1' },
    ],
    [
      'a standby holding another database',
      {},
      { ...unknown, inRecovery: true, systemIdentifier: '1', receiverStatus: 'streaming' },
    ],
    [
      'a degraded env',
      { replication: 'degraded' },
      { ...unknown, inRecovery: true, systemIdentifier: JOURNAL.systemIdentifier },
    ],
  ];
  it.each(rows)('assertFailoverPreconditions: %s', (_name, over, standbyState) => {
    const msg = refusal(() =>
      guard.assertFailoverPreconditions({
        envConfig: { ...env, ...over },
        environment: 'prod',
        standbyState,
        tier: 'compose-ha',
      }),
    );
    expect(msg).toMatch(ABORT);
    // Never a bare "run vibecarbon deploy" as the first thing to do.
    expect(msg).not.toMatch(
      /(?<!-abort to call it off and keep the old primary, then )run vibecarbon deploy/,
    );
  });

  it('without a journal the same refusal still names deploy (unchanged)', () => {
    const msg = refusal(() =>
      guard.assertFailoverPreconditions({
        envConfig: { ...env, ha: { enabled: true } },
        environment: 'prod',
        standbyState: unknown,
        tier: 'compose-ha',
      }),
    );
    expect(msg).toMatch(/run vibecarbon deploy prod to repair replication/);
    expect(msg).not.toMatch(/-abort/);
  });

  it('promotionUnknownMessage names the resume and the abort', () => {
    expect(guard.promotionUnknownMessage('prod')).toMatch(
      /rerun vibecarbon failover prod to finish it, or run vibecarbon failover prod -abort/,
    );
  });

  it('assertRolePrimaryWritable on a fenced primary with a journal', async () => {
    await expect(
      assertRolePrimaryWritable({
        environment: 'prod',
        envConfig: env,
        exec: async () => 'on',
        warn: () => {},
        deps: { read: async () => 'on' },
      }),
    ).rejects.toThrow(ABORT);
  });

  it('composeHaStandbyResyncHint with a journal', () => {
    expect(
      composeHaStandbyResyncHint({ projectName: 'myapp', environment: 'prod', envConfig: env }),
    ).toMatch(ABORT);
  });

  it('-abort is a documented failover flag', () => {
    const flag = SPEC.flags.find((f: { name: string }) => f.name === 'abort');
    expect(flag?.boolean).toBe(true);
    expect(flag?.description).not.toMatch(/—/);
  });
});

describe('run(): -abort sits behind the production confirmation', () => {
  it('confirmProdOrExit runs before runFailoverAbort in the abort branch', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(__dirname, '../../../src/failover.js'), 'utf-8');
    const branch = src.slice(src.indexOf('if (parsed.abort) {'));
    const confirm = branch.indexOf('await confirmProdOrExit(envName');
    const abort = branch.indexOf('await runFailoverAbort(');
    expect(confirm).toBeGreaterThan(-1);
    expect(confirm).toBeLessThan(abort);
  });
});
