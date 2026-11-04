/**
 * The in-place db restart (Task A3): the live-pod guard, the one sanctioned
 * in-pod postmaster stop, the stage-busy refusal, and ssh-safe remote argv.
 *
 * Pinned here:
 *   - the guard reads the RUNNING pod (its command, the db-guard.sh and role
 *     mounts), the protocol marker in the MOUNTED wrapper and the cluster's
 *     role intent; any miss refuses and issues no further call;
 *   - the stop is `kill -QUIT 1` exactly once, never retried; the container's
 *     state decides the outcome, and a recreated pod goes to the attach-watched
 *     rollout wait;
 *   - a busy stage (RESEED_REFUSED busy) is a terminal refusal: one call;
 *   - every remote argv survives the remote shell through shJoin.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertLiveDbGuardSupportsReseed,
  DB_GUARD_COMMAND,
  DB_GUARD_MARKER_GREP,
  DB_GUARD_PROTOCOL_MARKER,
  DB_GUARD_READY_WAIT_S,
  DB_IN_PLACE_STOP,
  DB_IN_PLACE_STOP_BEGIN_TIMEOUT_S,
  DB_IN_PLACE_STOP_UNSEEDED,
  DB_STS_BOOT_TIMEOUT_S,
  DbGuardMissingError,
  evaluateDbGuardSupport,
  RESEED_BASEBACKUP_FLOOR_BYTES_PER_S,
  ReseedStageBusyError,
  ReseedStageTimeoutError,
  reseedStageBoundsS,
  restartDbContainerInPlace,
  runInPlaceStage,
} from '../../../src/lib/deploy/replication.js';
import { shJoin } from '../../../src/lib/shell.js';

const ROLE_MOUNT = {
  name: 'data',
  mountPath: '/var/lib/vibecarbon/role',
  subPath: 'vibecarbon-role',
};
const GUARD_MOUNT = {
  name: 'wal-archive-script',
  mountPath: '/usr/local/bin/db-guard.sh',
  subPath: 'db-guard.sh',
};

const INTENT_ENV = {
  name: 'VC_WALG_ROLE_INTENT',
  valueFrom: {
    configMapKeyRef: { name: 'vibecarbon-db-role', key: 'VC_WALG_ROLE_INTENT', optional: true },
  },
};
/** DB_GUARD_MARKER_GREP's output on a guarded standby: the count, then recovery. */
const OUT = '1\nin_recovery=t';
/** A passed guard's readings beyond the pod: nothing read but recovery. */
const READ = (inRecovery: string) => ({
  ...GUARD,
  dbReady: null,
  inRecovery,
  slotCount: null,
  systemIdentifier: null,
  timeline: null,
});

const pod = (
  o: Partial<{
    uid: string;
    command: string[] | null;
    rc: number;
    cid: string;
    ready: boolean;
    waiting: string;
    mounts: object[];
    env: object[];
  }> = {},
) =>
  JSON.stringify({
    metadata: { uid: o.uid ?? 'u1' },
    spec: {
      containers: [
        {
          name: 'db',
          ...(o.command === null
            ? {}
            : { command: o.command ?? ['sh', '/usr/local/bin/db-guard.sh'] }),
          volumeMounts: o.mounts ?? [GUARD_MOUNT, ROLE_MOUNT],
          env: o.env ?? [INTENT_ENV],
        },
      ],
    },
    status: {
      containerStatuses: [
        {
          name: 'db',
          restartCount: o.rc ?? 0,
          containerID: o.cid ?? 'c1',
          ready: o.ready ?? true,
          state: o.waiting ? { waiting: { reason: o.waiting } } : { running: {} },
        },
      ],
    },
  });
const GUARD = { ok: true as const, uid: 'u1', restartCount: 0, containerID: 'c1' };

describe('the wrapper the guard looks for is the one the template ships', () => {
  it('DB_GUARD_COMMAND is the StatefulSet command, and the marker is line 2 of both db-guard.sh copies', () => {
    const sts = readFileSync('carbon/k8s/base/db/statefulset.yaml', 'utf-8');
    expect(sts).toContain(`command: ${JSON.stringify(DB_GUARD_COMMAND).replace(',', ', ')}`);
    expect(readFileSync('carbon/volumes/db/db-guard.sh', 'utf-8').split('\n')[1]).toBe(
      DB_GUARD_PROTOCOL_MARKER,
    );
    expect(readFileSync('carbon/k8s/base/backup/configmap-walg.yaml', 'utf-8')).toContain(
      `    ${DB_GUARD_PROTOCOL_MARKER}\n`,
    );
    expect(DB_GUARD_MARKER_GREP[2]).toContain(`'^${DB_GUARD_PROTOCOL_MARKER}$'`);
  });
});

describe('evaluateDbGuardSupport', () => {
  it('ok only with the wrapper command, the protocol marker in the mounted file, and a standby intent', () => {
    expect(evaluateDbGuardSupport(pod(), OUT, 'standby')).toEqual(READ('t'));
    expect(evaluateDbGuardSupport(pod({ command: null }), OUT, 'standby')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/command/),
    });
    expect(
      evaluateDbGuardSupport(pod({ command: ['sh', '/usr/local/bin/other.sh'] }), OUT, 'standby'),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/command/) });
    expect(evaluateDbGuardSupport(pod(), '0', 'standby')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/protocol/),
    });
    expect(evaluateDbGuardSupport(pod(), '', 'standby')).toMatchObject({ ok: false });
    expect(evaluateDbGuardSupport(pod(), OUT, 'primary')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/intent/),
    });
  });

  it('refuses a pod without the role mount or the db-guard.sh mount', () => {
    expect(evaluateDbGuardSupport(pod({ mounts: [GUARD_MOUNT] }), OUT, 'standby')).toMatchObject({
      ok: false,
      missing: true,
      reason: expect.stringMatching(/role/),
    });
    expect(evaluateDbGuardSupport(pod({ mounts: [ROLE_MOUNT] }), OUT, 'standby')).toMatchObject({
      ok: false,
      missing: true,
      reason: expect.stringMatching(/db-guard\.sh/),
    });
  });

  it('refuses a pod whose db container does not take its intent from vibecarbon-db-role', () => {
    for (const env of [
      [],
      [{ name: 'VC_WALG_ROLE_INTENT', value: 'standby' }],
      [
        {
          ...INTENT_ENV,
          valueFrom: { configMapKeyRef: { name: 'other', key: 'VC_WALG_ROLE_INTENT' } },
        },
      ],
    ]) {
      expect(evaluateDbGuardSupport(pod({ env }), OUT, 'standby')).toMatchObject({
        ok: false,
        missing: true,
        reason: expect.stringMatching(/VC_WALG_ROLE_INTENT.*vibecarbon-db-role/),
      });
    }
  });

  it('refuses a standby intent over postgres that is not in recovery (same exec as the marker)', () => {
    const v = evaluateDbGuardSupport(pod(), '1\nin_recovery=f', 'standby');
    expect(v).toMatchObject({ ok: false, reason: expect.stringMatching(/is not in recovery/) });
    expect(v).not.toHaveProperty('missing');
  });

  it('requireRecovery: false (the cold deploy seed) passes a standby that runs as its own primary, and reports what it read', () => {
    for (const [out, inRecovery] of [
      ['1\nin_recovery=f', 'f'],
      ['1\nin_recovery=', ''],
      ['1', ''],
      ['1\nin_recovery=t', 't'],
    ]) {
      expect(evaluateDbGuardSupport(pod(), out, 'standby', { requireRecovery: false })).toEqual(
        READ(inRecovery),
      );
    }
    // Everything else still refuses: the marker, the intent, the mounts.
    expect(
      evaluateDbGuardSupport(pod(), '0\nin_recovery=f', 'standby', { requireRecovery: false }),
    ).toMatchObject({ ok: false, missing: true });
    expect(
      evaluateDbGuardSupport(pod(), '1\nin_recovery=f', 'primary', { requireRecovery: false }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/intent/) });
    expect(
      evaluateDbGuardSupport(pod({ mounts: [GUARD_MOUNT] }), '1\nin_recovery=f', 'standby', {
        requireRecovery: false,
      }),
    ).toMatchObject({ ok: false, missing: true });
  });

  it('reads the slot count and the lineage the guard exec prints (the cold deploy compares them)', () => {
    const out = '1\nready=1\nin_recovery=f\nslots=2\nident=7412345678901234567|0000000A';
    expect(evaluateDbGuardSupport(pod(), out, 'standby', { requireRecovery: false })).toEqual({
      ...GUARD,
      dbReady: true,
      inRecovery: 'f',
      slotCount: 2,
      systemIdentifier: '7412345678901234567',
      timeline: 10,
    });
    // In recovery there is no current WAL file: the timeline is unread.
    expect(
      evaluateDbGuardSupport(
        pod(),
        '1\nin_recovery=t\nslots=0\nident=7412345678901234567|',
        'standby',
      ),
    ).toEqual({ ...READ('t'), slotCount: 0, systemIdentifier: '7412345678901234567' });
    expect(DB_GUARD_MARKER_GREP[2]).toContain('SELECT count(*) FROM pg_replication_slots');
    expect(DB_GUARD_MARKER_GREP[2]).toContain('pg_walfile_name(pg_current_wal_lsn())');
    expect(DB_GUARD_MARKER_GREP[2]).toContain('FROM pg_control_system()');
  });

  it('a silent psql over a data directory with standby.signal passes: a standby in crash recovery is still a standby', () => {
    const v = evaluateDbGuardSupport(
      pod(),
      '1\nready=0\nin_recovery=\nstandby_signal=1',
      'standby',
    );
    expect(v).toMatchObject({ ok: true, standbySignal: true });
    // No file and no answer: still no verdict.
    expect(
      evaluateDbGuardSupport(pod(), '1\nready=0\nin_recovery=\nstandby_signal=0', 'standby'),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/could not confirm the db is in recovery/),
    });
    // A live f wins over the file.
    expect(
      evaluateDbGuardSupport(pod(), '1\nready=1\nin_recovery=f\nstandby_signal=1', 'standby'),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/is not in recovery/) });
    // The guard exec reports the file.
    expect(DB_GUARD_MARKER_GREP[2]).toContain('standby_signal=');
    expect(DB_GUARD_MARKER_GREP[2]).toContain('/standby.signal');
  });

  it('an unanswered recovery read says it could not confirm recovery, never "not in recovery"', () => {
    for (const out of ['1\nin_recovery=', '1']) {
      const v = evaluateDbGuardSupport(pod(), out, 'standby');
      expect(v).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/could not confirm the db is in recovery/),
      });
      expect(v).toMatchObject({ reason: expect.not.stringMatching(/not in recovery/) });
      expect(v).not.toHaveProperty('missing');
    }
    expect(evaluateDbGuardSupport(pod(), 'in_recovery=t', 'standby')).toMatchObject({
      ok: false,
      missing: true,
      reason: expect.stringMatching(/protocol/),
    });
  });

  it('refuses a db container that is not running, and anything unparseable', () => {
    expect(
      evaluateDbGuardSupport(pod({ waiting: 'CrashLoopBackOff' }), OUT, 'standby'),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/CrashLoopBackOff/),
    });
    expect(evaluateDbGuardSupport('not json', OUT, 'standby')).toMatchObject({ ok: false });
    expect(evaluateDbGuardSupport(pod(), OUT, '')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/intent/),
    });
  });
});

describe('assertLiveDbGuardSupportsReseed', () => {
  const stub = (o: { pod?: string; intent?: string; marker?: string } = {}) => {
    const argvs: string[][] = [];
    const kubectl = vi.fn(async (argv: string[]) => {
      argvs.push(argv);
      if (argv.includes('exec')) return o.marker ?? OUT;
      if (argv.includes('configmap')) return o.intent ?? 'standby';
      return o.pod ?? pod();
    });
    return { kubectl, argvs };
  };

  it('reads the running pod, the intent ConfigMap, then greps the mounted wrapper; returns the guard', async () => {
    const { kubectl, argvs } = stub();
    // The guard carries the ConfigMap intent it read: the in-place stage
    // builds only for it (the running container's env can be stale).
    await expect(assertLiveDbGuardSupportsReseed(kubectl, { envName: 'prod' })).resolves.toEqual({
      ...READ('t'),
      intent: 'standby',
    });
    expect(argvs).toEqual([
      ['-n', 'vibecarbon', 'get', 'pod', 'db-0', '-o', 'json'],
      [
        '-n',
        'vibecarbon',
        'get',
        'configmap',
        'vibecarbon-db-role',
        '--ignore-not-found',
        '-o',
        'jsonpath={.data.VC_WALG_ROLE_INTENT}',
      ],
      ['-n', 'vibecarbon', 'exec', 'db-0', '-c', 'db', '--', ...DB_GUARD_MARKER_GREP],
    ]);
  });

  it('a pod without the wrapper throws DbGuardMissingError naming the deploy fix, with no further call', async () => {
    const { kubectl } = stub({ pod: pod({ command: null }) });
    const err = await assertLiveDbGuardSupportsReseed(kubectl, { envName: 'prod' }).catch((e) => e);
    expect(err).toBeInstanceOf(DbGuardMissingError);
    expect(err.message).toContain(
      "this cluster's db predates in-place reseeds; run `vibecarbon deploy prod` once (one db restart), then retry",
    );
    expect(kubectl).toHaveBeenCalledTimes(1);
  });

  it('a pod without the role mount is a missing wrapper too', async () => {
    const { kubectl } = stub({ pod: pod({ mounts: [GUARD_MOUNT] }) });
    await expect(
      assertLiveDbGuardSupportsReseed(kubectl, { envName: 'prod' }),
    ).rejects.toBeInstanceOf(DbGuardMissingError);
    expect(kubectl).toHaveBeenCalledTimes(1);
  });

  it('a non-standby intent refuses before the exec', async () => {
    const { kubectl } = stub({ intent: 'primary' });
    await expect(assertLiveDbGuardSupportsReseed(kubectl, { envName: 'prod' })).rejects.toThrow(
      'reseed refused: role intent is primary',
    );
    expect(kubectl).toHaveBeenCalledTimes(2);
    const missing = stub({ intent: '' });
    await expect(
      assertLiveDbGuardSupportsReseed(missing.kubectl, { envName: 'prod' }),
    ).rejects.toThrow(/reseed refused: role intent is/);
  });

  it('a primary in the pod (not in recovery) refuses, not as a missing wrapper', async () => {
    const { kubectl } = stub({ marker: '1\nin_recovery=f' });
    const err = await assertLiveDbGuardSupportsReseed(kubectl, { envName: 'prod' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(DbGuardMissingError);
    expect(err.message).toMatch(/reseed refused: .*not in recovery/);
  });

  it('a mounted wrapper without the protocol marker is a missing wrapper', async () => {
    const { kubectl } = stub({ marker: '0\nin_recovery=t' });
    await expect(
      assertLiveDbGuardSupportsReseed(kubectl, { envName: 'prod' }),
    ).rejects.toBeInstanceOf(DbGuardMissingError);
    expect(kubectl).toHaveBeenCalledTimes(3);
  });
});

describe('restartDbContainerInPlace', () => {
  it('sends SIGINT to PID 1 only, then waits for the same pod restarted and Ready', async () => {
    const seq = [
      pod(),
      pod({ rc: 1, cid: 'c2', ready: false }),
      pod({ rc: 1, cid: 'c2', ready: true }),
    ];
    const argvs: string[][] = [];
    const kubectl = vi.fn(async (argv: string[]) => {
      argvs.push(argv);
      return argv.includes('exec') ? '' : (seq.shift() ?? pod({ rc: 1, cid: 'c2' }));
    });
    const r = await restartDbContainerInPlace(kubectl, {
      guard: GUARD,
      recreatedWait: vi.fn(),
      pollMs: 1,
      sleep: async () => {},
      now: Date.now,
      log: () => {},
    });
    expect(r).toEqual({ inPlace: true, uid: 'u1' });
    const stops = argvs.filter((a) => a.includes('exec'));
    expect(stops).toHaveLength(1);
    expect(stops[0].slice(-3)).toEqual(DB_IN_PLACE_STOP);
    expect(argvs.flat().join(' ')).not.toMatch(/pg_ctl|scale|delete pod/);
  });
  it('a recreated pod (new uid) is reported and handed to the attach-watched rollout wait', async () => {
    const recreatedWait = vi.fn(async () => {});
    const log = vi.fn();
    let reads = 0;
    const kubectl = vi.fn(async (argv: string[]) =>
      argv.includes('exec') ? '' : reads++ === 0 ? pod() : pod({ uid: 'u2' }),
    );
    expect(
      await restartDbContainerInPlace(kubectl, {
        guard: GUARD,
        recreatedWait,
        pollMs: 1,
        sleep: async () => {},
        now: Date.now,
        log,
      }),
    ).toEqual({ inPlace: false, uid: 'u2' });
    expect(recreatedWait).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/recreated.*u1.*u2/));
  });
  it("a recreated pod's failed rollout wait is the verdict: thrown once, never waited again", async () => {
    // A stale volume attachment stops the attach-watched wait by name; the
    // restart must surface it, not poll the pod and start a second wait.
    const recreatedWait = vi.fn(async () => {
      throw new Error('The db volume pvc-1 reads attached: a stale volume attachment');
    });
    let reads = 0;
    const kubectl = vi.fn(async (argv: string[]) =>
      argv.includes('exec') ? '' : reads++ === 0 ? pod() : pod({ uid: 'u2' }),
    );
    await expect(
      restartDbContainerInPlace(kubectl, {
        guard: GUARD,
        recreatedWait,
        pollMs: 1,
        sleep: async () => {},
        now: Date.now,
        log: () => {},
      }),
    ).rejects.toThrow(/stale volume attachment/);
    expect(recreatedWait).toHaveBeenCalledOnce();
  });
  it('requireRecovery: false sends the unseeded stop: the wrapper proof, no recovery proof', async () => {
    const argvs: string[][] = [];
    let reads = 0;
    const kubectl = vi.fn(async (argv: string[]) => {
      argvs.push(argv);
      if (argv.includes('exec')) return '';
      return reads++ === 0 ? pod() : pod({ rc: 1, cid: 'c2' });
    });
    await restartDbContainerInPlace(kubectl, {
      guard: GUARD,
      recreatedWait: vi.fn(),
      requireRecovery: false,
      pollMs: 1,
      sleep: async () => {},
      now: Date.now,
      log: () => {},
    });
    const stops = argvs.filter((a) => a.includes('exec'));
    expect(stops).toHaveLength(1);
    expect(stops[0].slice(-3)).toEqual(DB_IN_PLACE_STOP_UNSEEDED);
    expect(DB_IN_PLACE_STOP_UNSEEDED[2]).toContain('vc-reseed-protocol');
    expect(DB_IN_PLACE_STOP_UNSEEDED[2]).not.toContain('pg_is_in_recovery');
    expect(DB_IN_PLACE_STOP_UNSEEDED[2]).toMatch(/kill -QUIT 1$/);
  });
  it('a deadline names the container state, one stop, no retry', async () => {
    let t = 0;
    let reads = 0;
    const kubectl = vi.fn(async (argv: string[]) =>
      argv.includes('exec')
        ? ''
        : reads++ === 0
          ? pod()
          : pod({ rc: 1, cid: 'c2', ready: false, waiting: 'CrashLoopBackOff' }),
    );
    await expect(
      restartDbContainerInPlace(kubectl, {
        guard: GUARD,
        recreatedWait: vi.fn(),
        timeoutS: 1,
        pollMs: 1,
        sleep: async () => {
          t += 600;
        },
        now: () => t,
        log: () => {},
      }),
    ).rejects.toThrow(/CrashLoopBackOff/);
    expect(kubectl.mock.calls.filter(([a]) => a.includes('exec'))).toHaveLength(1);
  });
  it('an exec that dies because the container stopped under it is not a failure (state decides)', async () => {
    let reads = 0;
    const kubectl = vi.fn(async (argv: string[]) => {
      if (argv.includes('exec')) throw new Error('command terminated with exit code 137');
      return reads++ === 0 ? pod() : pod({ rc: 1, cid: 'c2' });
    });
    await expect(
      restartDbContainerInPlace(kubectl, {
        guard: GUARD,
        recreatedWait: vi.fn(),
        pollMs: 1,
        sleep: async () => {},
        now: Date.now,
        log: () => {},
      }),
    ).resolves.toMatchObject({ inPlace: true });
  });

  it('reads the pod, sends the exact stop on db-0, and the default budget is DB_STS_BOOT_TIMEOUT_S', async () => {
    const argvs: string[][] = [];
    let t = 0;
    const kubectl = vi.fn(async (argv: string[]) => {
      argvs.push(argv);
      if (argv.includes('exec')) return '';
      return argvs.length === 1
        ? pod()
        : pod({ rc: 1, cid: 'c2', ready: false, waiting: 'CrashLoopBackOff' });
    });
    await expect(
      restartDbContainerInPlace(kubectl, {
        guard: GUARD,
        recreatedWait: vi.fn(),
        pollMs: 1,
        sleep: async () => {
          t += 100_000;
        },
        now: () => t,
        log: () => {},
      }),
    ).rejects.toThrow(`${DB_STS_BOOT_TIMEOUT_S}s`);
    expect(argvs[0]).toEqual(['-n', 'vibecarbon', 'get', 'pod', 'db-0', '-o', 'json']);
    expect(argvs[1]).toEqual([
      '-n',
      'vibecarbon',
      'exec',
      'db-0',
      '-c',
      'db',
      '--',
      ...DB_IN_PLACE_STOP,
    ]);
    expect(argvs.slice(2).every((a) => a.join(' ') === '-n vibecarbon get pod db-0 -o json')).toBe(
      true,
    );
  });

  // The guard is minutes old at the stop (a base backup ran in between).
  const refusesBeforeStop = async (preRead: string | Error, re: RegExp) => {
    const argvs: string[][] = [];
    const kubectl = vi.fn(async (argv: string[]) => {
      argvs.push(argv);
      if (argv.includes('exec')) return '';
      if (preRead instanceof Error) throw preRead;
      return preRead;
    });
    await expect(
      restartDbContainerInPlace(kubectl, {
        guard: GUARD,
        recreatedWait: vi.fn(),
        pollMs: 1,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(re);
    expect(argvs).toEqual([['-n', 'vibecarbon', 'get', 'pod', 'db-0', '-o', 'json']]);
  };
  it('a container restart between the guard and the stop refuses with no stop sent', async () => {
    await refusesBeforeStop(
      pod({ rc: 1, cid: 'c2' }),
      /changed since the guard.*restartCount 0 -> 1/,
    );
    await refusesBeforeStop(pod({ cid: 'c9' }), /changed since the guard.*c1 -> c9/);
  });
  it('a recreated pod between the guard and the stop refuses with no stop sent', async () => {
    await refusesBeforeStop(pod({ uid: 'u2' }), /changed since the guard.*uid u1 -> u2/);
  });
  it('a pod that is not running, or cannot be read, at the stop refuses with no stop sent', async () => {
    await refusesBeforeStop(pod({ ready: false, waiting: 'CrashLoopBackOff' }), /not running/);
    await refusesBeforeStop(new Error('pods "db-0" not found'), /not found/);
  });
  it('a stop the container refuses (not in recovery, no protocol) is reported, with no wait', async () => {
    for (const said of [
      'RESEED_STOP_REFUSED postgres is not in recovery (pg_is_in_recovery: f)',
      'RESEED_STOP_REFUSED the mounted db-guard.sh does not speak the reseed protocol',
    ]) {
      const argvs: string[][] = [];
      const recreatedWait = vi.fn();
      const kubectl = vi.fn(async (argv: string[]) => {
        argvs.push(argv);
        if (argv.includes('exec'))
          throw Object.assign(new Error('exit status 3'), { stdout: `${said}\n` });
        return pod();
      });
      await expect(
        restartDbContainerInPlace(kubectl, {
          guard: GUARD,
          recreatedWait,
          pollMs: 1,
          sleep: async () => {},
          log: () => {},
        }),
      ).rejects.toThrow(
        new RegExp(
          `reseed refused in db-0: ${said.slice('RESEED_STOP_REFUSED '.length).replace(/[()]/g, '.')}; nothing was stopped`,
        ),
      );
      expect(argvs).toHaveLength(2);
      expect(argvs[1].slice(-3)).toEqual(DB_IN_PLACE_STOP);
      expect(recreatedWait).not.toHaveBeenCalled();
    }
  });
  it('a second call with the same guard refuses and sends no second stop', async () => {
    let restarted = false;
    const kubectl = vi.fn(async (argv: string[]) => {
      if (argv.includes('exec')) {
        restarted = true;
        return '';
      }
      return restarted ? pod({ rc: 1, cid: 'c2' }) : pod();
    });
    const opts = {
      guard: GUARD,
      recreatedWait: vi.fn(),
      pollMs: 1,
      sleep: async () => {},
      log: () => {},
    };
    await expect(restartDbContainerInPlace(kubectl, opts)).resolves.toEqual({
      inPlace: true,
      uid: 'u1',
    });
    await expect(restartDbContainerInPlace(kubectl, opts)).rejects.toThrow(
      /changed since the guard/,
    );
    expect(kubectl.mock.calls.filter(([a]) => a.includes('exec'))).toHaveLength(1);
  });
  it('a stop that never takes fails fast, after DB_IN_PLACE_STOP_BEGIN_TIMEOUT_S, not the whole budget', async () => {
    let t = 0;
    const kubectl = vi.fn(async (argv: string[]) => {
      if (argv.includes('exec'))
        throw new Error('ssh: connect to host 10.0.0.1 port 22: Connection refused');
      return pod();
    });
    await expect(
      restartDbContainerInPlace(kubectl, {
        guard: GUARD,
        recreatedWait: vi.fn(),
        pollMs: 1,
        sleep: async () => {
          t += 10_000;
        },
        now: () => t,
        log: () => {},
      }),
    ).rejects.toThrow(
      `the stop did not take: db-0's db container is still running unchanged ${DB_IN_PLACE_STOP_BEGIN_TIMEOUT_S}s after it`,
    );
    expect(t).toBeLessThan(DB_STS_BOOT_TIMEOUT_S * 1000);
    expect(t).toBeGreaterThanOrEqual(DB_IN_PLACE_STOP_BEGIN_TIMEOUT_S * 1000);
    expect(kubectl.mock.calls.filter(([a]) => a.includes('exec'))).toHaveLength(1);
  });

  it('without a passed guard it stops nothing', async () => {
    const kubectl = vi.fn(async () => pod());
    for (const guard of [undefined, { ok: false, reason: 'x' }]) {
      await expect(
        restartDbContainerInPlace(kubectl, { guard: guard as never, recreatedWait: vi.fn() }),
      ).rejects.toThrow(/guard/);
    }
    expect(kubectl).not.toHaveBeenCalled();
  });
});

describe('the guard and stop scripts, executed under sh', () => {
  // The real script text, with only the wrapper's absolute path pointed at a
  // temp file; psql is a PATH stub printing the recovery answer, and kill a
  // shell function (functions shadow the regular builtin) that records it.
  const run = (
    script: string,
    o: { marker: boolean | null; recovery: string; standbySignal?: boolean },
  ) => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-stop-'));
    const pgdata = join(dir, 'pgdata');
    mkdirSync(pgdata);
    if (o.standbySignal) writeFileSync(join(pgdata, 'standby.signal'), '');
    const guard = join(dir, 'db-guard.sh');
    if (o.marker !== null) {
      writeFileSync(
        guard,
        `#!/bin/sh\n${o.marker ? DB_GUARD_PROTOCOL_MARKER : '# something else'}\nexec true\n`,
      );
    }
    writeFileSync(join(dir, 'psql'), `#!/bin/sh\nprintf '%s\\n' '${o.recovery}'\n`);
    chmodSync(join(dir, 'psql'), 0o755);
    writeFileSync(join(dir, 'pg_isready'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'pg_isready'), 0o755);
    const body = script.replaceAll('/usr/local/bin/db-guard.sh', guard);
    expect(body).not.toBe(script);
    return spawnSync('sh', ['-c', `kill() { echo "KILLED $*"; }; ${body}`], {
      encoding: 'utf-8',
      env: { PATH: `${dir}:${process.env.PATH}`, PGDATA: pgdata },
    });
  };

  it('the stop signals PID 1 only with the protocol marker AND recovery = t', () => {
    const ok = run(DB_IN_PLACE_STOP[2], { marker: true, recovery: 't' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('KILLED -QUIT 1\n');
    for (const o of [
      { marker: true, recovery: 'f' },
      { marker: true, recovery: '' },
      { marker: false, recovery: 't' },
      { marker: null, recovery: 't' },
    ]) {
      const r = run(DB_IN_PLACE_STOP[2], o);
      expect(r.status).toBe(3);
      expect(r.stdout).toMatch(/^RESEED_STOP_REFUSED /);
      expect(r.stdout).not.toContain('KILLED');
    }
  });

  it('the unseeded stop (the cold deploy seed) signals PID 1 on the protocol marker alone, whatever the recovery state', () => {
    for (const recovery of ['t', 'f', '']) {
      const ok = run(DB_IN_PLACE_STOP_UNSEEDED[2], { marker: true, recovery });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toBe('KILLED -QUIT 1\n');
    }
    for (const marker of [false, null]) {
      const r = run(DB_IN_PLACE_STOP_UNSEEDED[2], { marker, recovery: 'f' });
      expect(r.status).toBe(3);
      expect(r.stdout).toBe(
        'RESEED_STOP_REFUSED the mounted db-guard.sh does not speak the reseed protocol\n',
      );
    }
  });

  it('the stop says it could not confirm recovery when psql answers nothing, and "not in recovery" only on f', () => {
    const silent = run(DB_IN_PLACE_STOP[2], { marker: true, recovery: '' });
    expect(silent.status).toBe(3);
    expect(silent.stdout).toBe(
      'RESEED_STOP_REFUSED could not confirm the db is in recovery (psql did not answer and PGDATA has no standby.signal)\n',
    );
    const primary = run(DB_IN_PLACE_STOP[2], { marker: true, recovery: 'f' });
    expect(primary.stdout).toBe(
      'RESEED_STOP_REFUSED postgres is not in recovery (pg_is_in_recovery: f)\n',
    );
  });

  it('a standby psql cannot reach (crash recovery after a restored primary) still stops on its standby.signal', () => {
    // A standby whose primary was restored onto a new timeline can sit in
    // crash recovery, refusing every connection ("the database system is in
    // recovery mode"): exactly the standby the reseed exists for. Its data
    // directory still says what it is: standby.signal, which a primary never has.
    const down = run(DB_IN_PLACE_STOP[2], { marker: true, recovery: '', standbySignal: true });
    expect(down.status).toBe(0);
    expect(down.stdout).toBe('KILLED -QUIT 1\n');
    // A live answer always wins: a db that says f is a primary, whatever the file says.
    const primary = run(DB_IN_PLACE_STOP[2], { marker: true, recovery: 'f', standbySignal: true });
    expect(primary.status).toBe(3);
    expect(primary.stdout).toMatch(/^RESEED_STOP_REFUSED postgres is not in recovery/);
    // The protocol marker still comes first.
    const noMarker = run(DB_IN_PLACE_STOP[2], { marker: false, recovery: '', standbySignal: true });
    expect(noMarker.status).toBe(3);
    expect(noMarker.stdout).not.toContain('KILLED');
  });

  /**
   * The guard exec under sh, against a db that starts accepting connections
   * on pg_isready's `readyOn`-th call (0: never). psql answers by query once
   * the db is up and fails before; `sleep` is a function that only counts the
   * waits, so the bounded wait runs at full length instantly.
   */
  const runGuardExec = (readyOn: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-guard-'));
    const guardFile = join(dir, 'db-guard.sh');
    writeFileSync(guardFile, `#!/bin/sh\n${DB_GUARD_PROTOCOL_MARKER}\n`);
    const calls = join(dir, 'isready-calls');
    writeFileSync(
      join(dir, 'pg_isready'),
      `#!/bin/sh\nn=$(($(cat ${calls} 2>/dev/null || echo 0) + 1)); echo $n > ${calls}\n` +
        `if [ ${readyOn} -gt 0 ] && [ $n -ge ${readyOn} ]; then touch ${dir}/up; fi\n[ -e ${dir}/up ]\n`,
    );
    // psql answers by the query it was given ($4 after -U postgres -tAc).
    writeFileSync(
      join(dir, 'psql'),
      `#!/bin/sh\n[ -e ${dir}/up ] || exit 2\ncase "$4" in\n  *pg_replication_slots*) echo 3 ;;\n` +
        '  *pg_control_system*) echo "7412345678901234567|00000002" ;;\n  *) echo f ;;\nesac\n',
    );
    chmodSync(join(dir, 'pg_isready'), 0o755);
    chmodSync(join(dir, 'psql'), 0o755);
    const script = DB_GUARD_MARKER_GREP[2].replaceAll('/usr/local/bin/db-guard.sh', guardFile);
    const r = spawnSync('sh', ['-c', `sleep() { echo x >> ${dir}/sleeps; }; ${script}`], {
      encoding: 'utf-8',
      env: { PATH: `${dir}:${process.env.PATH}` },
    });
    let sleeps = 0;
    try {
      sleeps = readFileSync(join(dir, 'sleeps'), 'utf-8').split('\n').filter(Boolean).length;
    } catch {
      sleeps = 0;
    }
    return { stdout: r.stdout, sleeps };
  };

  it('the guard exec waits (bounded) for a db that is still starting, then reads slots and lineage', () => {
    const { stdout, sleeps } = runGuardExec(4);
    expect(sleeps).toBe(3);
    expect(stdout).toBe(
      '1\nready=1\nin_recovery=f\nstandby_signal=0\nslots=3\nident=7412345678901234567|00000002\n',
    );
    expect(evaluateDbGuardSupport(pod(), stdout, 'standby', { requireRecovery: false })).toEqual({
      ...GUARD,
      dbReady: true,
      inRecovery: 'f',
      slotCount: 3,
      systemIdentifier: '7412345678901234567',
      timeline: 2,
    });
  });

  it('the guard exec gives a db that never accepts connections exactly DB_GUARD_READY_WAIT_S, then reports it', () => {
    const { stdout, sleeps } = runGuardExec(0);
    expect(sleeps).toBe(DB_GUARD_READY_WAIT_S);
    expect(stdout).toBe('1\nready=0\nin_recovery=\nstandby_signal=0\nslots=\nident=\n');
    expect(evaluateDbGuardSupport(pod(), stdout, 'standby', { requireRecovery: false })).toEqual({
      ...READ(''),
      dbReady: false,
    });
  });

  it("the guard probe's real output is what evaluateDbGuardSupport accepts or refuses", () => {
    const out = (o: { marker: boolean | null; recovery: string }) =>
      run(DB_GUARD_MARKER_GREP[2], o).stdout;
    expect(evaluateDbGuardSupport(pod(), out({ marker: true, recovery: 't' }), 'standby')).toEqual({
      ...READ('t'),
      dbReady: true,
    });
    expect(
      evaluateDbGuardSupport(pod(), out({ marker: true, recovery: 'f' }), 'standby'),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/not in recovery/) });
    expect(
      evaluateDbGuardSupport(pod(), out({ marker: false, recovery: 't' }), 'standby'),
    ).toMatchObject({ ok: false, missing: true });
    expect(
      evaluateDbGuardSupport(pod(), out({ marker: null, recovery: 't' }), 'standby'),
    ).toMatchObject({ ok: false, missing: true });
  });
});

describe('a failed exec whose message quotes the script is never read as its refusal', () => {
  // runCommandAsync (src/lib/command.js) rejects with
  // `Command failed: <argv>\n<stderr>`; over ssh the argv's last token is the
  // whole remote command, so the stop script, and with it the literal
  // `echo 'RESEED_STOP_REFUSED ...'`, sits in every failed stop's message.
  const sshFailure = (
    remote: string[],
    { stderr, status, stdout = '' }: { stderr: string; status: number; stdout?: string },
  ) =>
    Object.assign(
      new Error(
        `Command failed: ssh -i /k -o BatchMode=yes -- root@10.0.0.2 ${shJoin(['env', 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml', 'kubectl', ...remote])}\n${stderr}`,
      ),
      { stdout, stderr: `${stderr}\n`, status, timedOut: false },
    );
  const stopArgv = ['-n', 'vibecarbon', 'exec', 'db-0', '-c', 'db', '--', ...DB_IN_PLACE_STOP];

  it('the realistic message does carry the sentinel text (the trap this guards)', () => {
    expect(sshFailure(stopArgv, { stderr: 'x', status: 255 }).message).toContain(
      'RESEED_STOP_REFUSED',
    );
  });

  it.each([
    ['an ssh drop', { stderr: 'Connection to 10.0.0.2 closed by remote host.', status: 255 }],
    [
      'an exec killed with its container',
      { stderr: 'command terminated with exit code 137', status: 137 },
    ],
    [
      'a refusal line on stdout under another status',
      {
        stderr: '',
        status: 255,
        stdout: 'RESEED_STOP_REFUSED postgres is not in recovery (pg_is_in_recovery: f)\n',
      },
    ],
    [
      'a refusal line only in stderr, status 3',
      { stderr: 'RESEED_STOP_REFUSED postgres is not in recovery', status: 3 },
    ],
  ])('%s falls through to the state poll', async (_label, failure) => {
    let reads = 0;
    const kubectl = vi.fn(async (argv: string[]) => {
      if (argv.includes('exec')) throw sshFailure(stopArgv, failure);
      return reads++ === 0 ? pod() : pod({ rc: 1, cid: 'c2' });
    });
    const log = vi.fn();
    await expect(
      restartDbContainerInPlace(kubectl, {
        guard: GUARD,
        recreatedWait: vi.fn(),
        pollMs: 1,
        sleep: async () => {},
        log,
      }),
    ).resolves.toEqual({ inPlace: true, uid: 'u1' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/the container state decides/));
  });

  it('only a status-3 stdout refusal line is the stop refusing', async () => {
    const kubectl = vi.fn(async (argv: string[]) => {
      if (argv.includes('exec')) {
        throw sshFailure(stopArgv, {
          stderr: '',
          status: 3,
          stdout: 'RESEED_STOP_REFUSED postgres is not in recovery (pg_is_in_recovery: f)\n',
        });
      }
      return pod();
    });
    await expect(
      restartDbContainerInPlace(kubectl, {
        guard: GUARD,
        recreatedWait: vi.fn(),
        pollMs: 1,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(
      'reseed refused in db-0: postgres is not in recovery (pg_is_in_recovery: f); nothing was stopped',
    );
  });

  it('a stage failure whose message or stderr holds RESEED_REFUSED busy, with empty stdout, is not busy', async () => {
    for (const failure of [
      { stderr: 'RESEED_REFUSED busy', status: 1 },
      { stderr: 'Connection reset by peer', status: 255, stdout: 'RESEED_REFUSED busy\n' },
    ]) {
      const err = sshFailure(
        [
          '-n',
          'vibecarbon',
          'exec',
          '-i',
          'db-0',
          '--',
          'sh',
          '-c',
          'echo "RESEED_REFUSED busy"\nRESEED_REFUSED busy',
        ],
        failure,
      );
      const caught = await runInPlaceStage(
        async () => {
          throw err;
        },
        { attempt: 'att-1' },
      ).catch((e) => e);
      expect(caught).toBe(err);
      expect(caught).not.toBeInstanceOf(ReseedStageBusyError);
    }
  });

  it('a status-1 stdout busy line is busy', async () => {
    const err = sshFailure(['-n', 'vibecarbon', 'exec', 'db-0', '--', 'sh'], {
      stderr: 'a restore or another reseed stage holds the lock',
      status: 1,
      stdout: 'RESEED_REFUSED busy\n',
    });
    await expect(
      runInPlaceStage(
        async () => {
          throw err;
        },
        { attempt: 'att-1' },
      ),
    ).rejects.toBeInstanceOf(ReseedStageBusyError);
  });
});

describe('runInPlaceStage: a busy stage is a terminal refusal', () => {
  const busyErr = () =>
    Object.assign(new Error('command failed: exit 1'), { stdout: 'RESEED_REFUSED busy\n' });

  it('RESEED_REFUSED busy throws ReseedStageBusyError telling the operator to wait and rerun, after one call', async () => {
    const exec = vi.fn(async () => {
      throw busyErr();
    });
    const err = await runInPlaceStage(exec, { attempt: 'att-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ReseedStageBusyError);
    expect(err.message).toMatch(/earlier reseed stage is still running/);
    expect(err.message).toMatch(/wait.*rerun/i);
    expect(exec).toHaveBeenCalledOnce();
  });

  it('staged only when the output names this attempt', async () => {
    await expect(
      runInPlaceStage(async () => 'x\nRESEED_STAGED att-1\n', { attempt: 'att-1' }),
    ).resolves.toEqual({ staged: 'att-1' });
    await expect(
      runInPlaceStage(async () => 'RESEED_STAGED att-0', { attempt: 'att-1' }),
    ).rejects.toThrow(/att-1/);
  });

  it('RESEED_SKIPPED (the probe never reached the primary) is a skip, not a failure', async () => {
    await expect(
      runInPlaceStage(async () => 'RESEED_SKIPPED\n', { attempt: 'att-1' }),
    ).resolves.toEqual({ skipped: true });
  });

  it('RESEED_TIMEOUT under exit 1 is a ReseedStageTimeoutError naming the deadline, after one call', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('exit 1'), { stdout: 'RESEED_TIMEOUT 900\n', status: 1 });
    });
    const err = await runInPlaceStage(exec, { attempt: 'att-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ReseedStageTimeoutError);
    expect(err.deadlineS).toBe(900);
    expect(exec).toHaveBeenCalledOnce();
  });

  it('any other failure is rethrown as is, after one call', async () => {
    const boom = new Error('pg_basebackup failed');
    const exec = vi.fn(async () => {
      throw boom;
    });
    await expect(runInPlaceStage(exec, { attempt: 'att-1' })).rejects.toBe(boom);
    expect(exec).toHaveBeenCalledOnce();
  });
});

describe('shJoin: remote commands survive the remote shell (C13)', () => {
  // The exact string ssh hands the remote shell, run through sh -c with a stub
  // kubectl that prints each argument it received on its own line.
  const argvSeenRemotely = (argv: string[]) => {
    const bin = mkdtempSync(join(tmpdir(), 'vc-kubectl-'));
    writeFileSync(join(bin, 'kubectl'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
    chmodSync(join(bin, 'kubectl'), 0o755);
    return spawnSync('sh', ['-c', shJoin(['kubectl', ...argv])], {
      encoding: 'utf-8',
      env: { PATH: `${bin}:${process.env.PATH}` },
    })
      .stdout.split('\n')
      .slice(0, -1);
  };
  it.each([
    [['exec', 'db-0', '-n', 'vibecarbon', '-c', 'db', '--', ...DB_IN_PLACE_STOP]],
    [['exec', 'db-0', '-n', 'vibecarbon', '-c', 'db', '--', ...DB_GUARD_MARKER_GREP]],
  ])('%j arrives as the same argv', (argv) => {
    expect(argvSeenRemotely(argv)).toEqual(argv);
  });
  it('a bare join(" ") would not (the bug this guards against)', () => {
    const joined = ['kubectl', 'exec', '--', ...DB_IN_PLACE_STOP].join(' ');
    expect(
      spawnSync('sh', ['-c', `set -- ${joined.slice('kubectl '.length)}; echo $#`], {
        encoding: 'utf-8',
      }).stdout.trim(),
    ).not.toBe('4');
  });
});

describe('reseedStageBoundsS: the stage bound comes from the primary size', () => {
  it('a small or unknown db gets the floor; the client bound is twice the remote deadline', () => {
    for (const size of [0, 1, 1024 ** 2, Number.NaN]) {
      expect(reseedStageBoundsS(size)).toEqual({
        remoteS: DB_STS_BOOT_TIMEOUT_S,
        clientS: 2 * DB_STS_BOOT_TIMEOUT_S,
      });
    }
  });
  it('a large db scales at the floor rate, the remote deadline strictly below the client bound', () => {
    const size = 100 * 1024 ** 3;
    const b = reseedStageBoundsS(size);
    expect(b.remoteS).toBe(Math.ceil(size / RESEED_BASEBACKUP_FLOOR_BYTES_PER_S));
    expect(b.clientS).toBe(2 * b.remoteS);
    expect(b.remoteS).toBeLessThan(b.clientS);
  });
});
