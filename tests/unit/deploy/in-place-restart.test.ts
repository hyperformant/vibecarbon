/**
 * The in-place db restart (Task A3): the live-pod guard, the one sanctioned
 * in-pod postmaster stop, the stage-busy refusal, and ssh-safe remote argv.
 *
 * Pinned here:
 *   - the guard reads the RUNNING pod (its command, the db-guard.sh and role
 *     mounts), the protocol marker in the MOUNTED wrapper and the cluster's
 *     role intent; any miss refuses and issues no further call;
 *   - the stop is `kill -INT 1` exactly once, never retried; the container's
 *     state decides the outcome, and a recreated pod goes to the attach-watched
 *     rollout wait;
 *   - a busy stage (RESEED_REFUSED busy) is a terminal refusal: one call;
 *   - every remote argv survives the remote shell through shJoin.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertLiveDbGuardSupportsReseed,
  DB_GUARD_COMMAND,
  DB_GUARD_MARKER_GREP,
  DB_GUARD_PROTOCOL_MARKER,
  DB_IN_PLACE_STOP,
  DB_STS_BOOT_TIMEOUT_S,
  DbGuardMissingError,
  evaluateDbGuardSupport,
  ReseedStageBusyError,
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

const pod = (
  o: Partial<{
    uid: string;
    command: string[] | null;
    rc: number;
    cid: string;
    ready: boolean;
    waiting: string;
    mounts: object[];
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
    expect(evaluateDbGuardSupport(pod(), '1', 'standby')).toEqual(GUARD);
    expect(evaluateDbGuardSupport(pod({ command: null }), '1', 'standby')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/command/),
    });
    expect(
      evaluateDbGuardSupport(pod({ command: ['sh', '/usr/local/bin/other.sh'] }), '1', 'standby'),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/command/) });
    expect(evaluateDbGuardSupport(pod(), '0', 'standby')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/protocol/),
    });
    expect(evaluateDbGuardSupport(pod(), '', 'standby')).toMatchObject({ ok: false });
    expect(evaluateDbGuardSupport(pod(), '1', 'primary')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/intent/),
    });
  });

  it('refuses a pod without the role mount or the db-guard.sh mount', () => {
    expect(evaluateDbGuardSupport(pod({ mounts: [GUARD_MOUNT] }), '1', 'standby')).toMatchObject({
      ok: false,
      missing: true,
      reason: expect.stringMatching(/role/),
    });
    expect(evaluateDbGuardSupport(pod({ mounts: [ROLE_MOUNT] }), '1', 'standby')).toMatchObject({
      ok: false,
      missing: true,
      reason: expect.stringMatching(/db-guard\.sh/),
    });
  });

  it('refuses a db container that is not running, and anything unparseable', () => {
    expect(
      evaluateDbGuardSupport(pod({ waiting: 'CrashLoopBackOff' }), '1', 'standby'),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/CrashLoopBackOff/),
    });
    expect(evaluateDbGuardSupport('not json', '1', 'standby')).toMatchObject({ ok: false });
    expect(evaluateDbGuardSupport(pod(), '1', '')).toMatchObject({
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
      if (argv.includes('exec')) return o.marker ?? '1';
      if (argv.includes('configmap')) return o.intent ?? 'standby';
      return o.pod ?? pod();
    });
    return { kubectl, argvs };
  };

  it('reads the running pod, the intent ConfigMap, then greps the mounted wrapper; returns the guard', async () => {
    const { kubectl, argvs } = stub();
    await expect(assertLiveDbGuardSupportsReseed(kubectl, { envName: 'prod' })).resolves.toEqual(
      GUARD,
    );
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

  it('a mounted wrapper without the protocol marker is a missing wrapper', async () => {
    const { kubectl } = stub({ marker: '0' });
    await expect(
      assertLiveDbGuardSupportsReseed(kubectl, { envName: 'prod' }),
    ).rejects.toBeInstanceOf(DbGuardMissingError);
    expect(kubectl).toHaveBeenCalledTimes(3);
  });
});

describe('restartDbContainerInPlace', () => {
  it('sends SIGINT to PID 1 only, then waits for the same pod restarted and Ready', async () => {
    const seq = [pod({ rc: 1, cid: 'c2', ready: false }), pod({ rc: 1, cid: 'c2', ready: true })];
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
    const kubectl = vi.fn(async (argv: string[]) =>
      argv.includes('exec') ? '' : pod({ uid: 'u2' }),
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
  it('a deadline names the container state, one stop, no retry', async () => {
    let t = 0;
    const kubectl = vi.fn(async (argv: string[]) =>
      argv.includes('exec')
        ? ''
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
    const kubectl = vi.fn(async (argv: string[]) => {
      if (argv.includes('exec')) throw new Error('command terminated with exit code 137');
      return pod({ rc: 1, cid: 'c2' });
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

  it('the stop is the exact exec on db-0, and the default budget is DB_STS_BOOT_TIMEOUT_S', async () => {
    const argvs: string[][] = [];
    let t = 0;
    const kubectl = vi.fn(async (argv: string[]) => {
      argvs.push(argv);
      return argv.includes('exec') ? '' : pod();
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
    expect(argvs[0]).toEqual([
      '-n',
      'vibecarbon',
      'exec',
      'db-0',
      '-c',
      'db',
      '--',
      ...DB_IN_PLACE_STOP,
    ]);
    expect(argvs.slice(1).every((a) => a.join(' ') === '-n vibecarbon get pod db-0 -o json')).toBe(
      true,
    );
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
