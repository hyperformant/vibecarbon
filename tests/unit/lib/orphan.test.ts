/**
 * Unit tests for orphan-port reclaim helpers (src/lib/orphan.js).
 *
 * `vibecarbon up` uses these to detect a port held by THIS project's own
 * orphaned dev session and kill its process tree, instead of bumping
 * DEV_PORT_OFFSET and leaving a runaway Vite/API server alive.
 *
 * Everything is mocked hermetically — no real lsof/ps, no real /proc reads,
 * no real signals. `process.kill` is spied to drive a tiny in-memory process
 * table so we can assert exactly which signals were sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  execFileSync: (_cmd: string, _args: string[]): string => {
    throw new Error('execFileSync not configured for this test');
  },
  readlinkSync: (_p: string): string => {
    throw new Error('readlinkSync not configured for this test');
  },
}));

vi.mock('node:child_process', () => ({
  execFileSync: (cmd: string, args: string[]) => state.execFileSync(cmd, args),
}));
vi.mock('node:fs', () => ({
  readlinkSync: (p: string) => state.readlinkSync(p),
}));

const { findPortListeners, getProcessGroup, isOwnedByProject, reclaimPort, reclaimOrphanPorts } =
  await import('../../../src/lib/orphan.js');

type Proc = {
  pid: number;
  cwd: string | null; // null => readlink throws EACCES (foreign user)
  pgid: number;
  port: number;
  dieOn?: 'SIGTERM' | 'SIGKILL' | 'never';
};

/** Wires execFileSync/readlinkSync/process.kill around an in-memory table. */
function installProcs(procs: Proc[]) {
  const alive = new Set(procs.map((p) => p.pid));

  state.execFileSync = (cmd, args) => {
    if (cmd === 'lsof' && args.includes('-t')) {
      const spec = args.find((a) => a.startsWith('-iTCP:'));
      const port = Number(spec?.split(':')[1]);
      return `${procs
        .filter((p) => p.port === port && alive.has(p.pid))
        .map((p) => p.pid)
        .join('\n')}\n`;
    }
    if (cmd === 'ps') {
      const pid = Number(args[args.indexOf('-p') + 1]);
      const proc = procs.find((p) => p.pid === pid);
      if (!proc) throw new Error('no such process');
      return `${proc.pgid}\n`;
    }
    throw new Error(`unexpected execFileSync: ${cmd} ${args.join(' ')}`);
  };

  state.readlinkSync = (p) => {
    const pid = Number(p.match(/\/proc\/(\d+)\/cwd/)?.[1]);
    const proc = procs.find((x) => x.pid === pid);
    if (!proc || proc.cwd === null) {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }
    return proc.cwd;
  };

  const killSpy = vi.spyOn(process, 'kill').mockImplementation(((target: number, sig: unknown) => {
    if (sig === 0) {
      if (alive.has(target)) return true;
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    }
    const isGroup = target < 0;
    const id = Math.abs(target);
    for (const proc of procs) {
      const matches = isGroup ? proc.pgid === id : proc.pid === id;
      if (!matches || !alive.has(proc.pid)) continue;
      const dieOn = proc.dieOn ?? 'SIGTERM';
      if (sig === 'SIGKILL' && dieOn !== 'never') alive.delete(proc.pid);
      else if (sig === 'SIGTERM' && dieOn === 'SIGTERM') alive.delete(proc.pid);
    }
    return true;
  }) as typeof process.kill);

  return { alive, killSpy };
}

// Fast grace/interval so the SIGKILL-escalation poll doesn't slow the suite.
const FAST = { graceMs: 30, intervalMs: 5 };

beforeEach(() => {
  state.execFileSync = () => {
    throw new Error('execFileSync not configured for this test');
  };
  state.readlinkSync = () => {
    throw new Error('readlinkSync not configured for this test');
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('findPortListeners', () => {
  it('parses and dedupes lsof -t PIDs into numbers', () => {
    state.execFileSync = () => '1234\n1234\n5678\n';
    expect(findPortListeners(5373)).toEqual([1234, 5678]);
  });

  it('returns [] when lsof is unavailable (throws)', () => {
    state.execFileSync = () => {
      throw new Error('lsof: command not found');
    };
    expect(findPortListeners(5373)).toEqual([]);
  });

  it('returns [] when nothing listens on the port', () => {
    state.execFileSync = () => '\n';
    expect(findPortListeners(5373)).toEqual([]);
  });
});

describe('getProcessGroup', () => {
  it('parses the pgid from ps -o pgid=', () => {
    state.execFileSync = () => '  4242 \n';
    expect(getProcessGroup(1234)).toBe(4242);
  });

  it('returns null when the process is gone', () => {
    state.execFileSync = () => {
      throw new Error('no such process');
    };
    expect(getProcessGroup(1234)).toBeNull();
  });
});

describe('isOwnedByProject', () => {
  const project = '/home/dev/myproject';

  it('is true when the process cwd equals the project dir', () => {
    state.readlinkSync = () => project;
    expect(isOwnedByProject(1234, project)).toBe(true);
  });

  it('is true when the process cwd is a subdirectory of the project', () => {
    state.readlinkSync = () => `${project}/packages/web`;
    expect(isOwnedByProject(1234, project)).toBe(true);
  });

  it('is false when the process cwd is a different project', () => {
    state.readlinkSync = () => '/home/dev/otherproject';
    expect(isOwnedByProject(1234, project)).toBe(false);
  });

  it('is false (foreign) when the cwd is unreadable (EACCES)', () => {
    state.readlinkSync = () => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    expect(isOwnedByProject(1234, project)).toBe(false);
  });

  it('does not treat a sibling dir with a shared prefix as owned', () => {
    state.readlinkSync = () => '/home/dev/myproject-staging';
    expect(isOwnedByProject(1234, project)).toBe(false);
  });
});

describe('reclaimPort', () => {
  const project = '/home/dev/myproject';

  it("kills the process group of this project's orphan and reports it freed", async () => {
    const { alive, killSpy } = installProcs([
      { pid: 1234, cwd: project, pgid: 1234, port: 5373, dieOn: 'SIGTERM' },
    ]);

    const result = await reclaimPort(5373, project, FAST);

    expect(result.killed).toEqual([1234]);
    expect(result.foreign).toEqual([]);
    expect(result.freed).toBe(true);
    expect(alive.has(1234)).toBe(false);
    // SIGTERM was sent to the negative pgid (the whole group).
    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGTERM');
  });

  it('does not kill a foreign process and returns it under `foreign`', async () => {
    const { alive, killSpy } = installProcs([
      { pid: 9999, cwd: '/opt/other-app', pgid: 9999, port: 5373 },
    ]);

    const result = await reclaimPort(5373, project, FAST);

    expect(result.killed).toEqual([]);
    expect(result.foreign).toEqual([9999]);
    expect(result.freed).toBe(false);
    expect(alive.has(9999)).toBe(true);
    // Never sent a terminating signal to the foreign process.
    expect(killSpy).not.toHaveBeenCalledWith(-9999, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(9999, 'SIGTERM');
  });

  it('escalates to SIGKILL when the orphan survives SIGTERM', async () => {
    const { alive, killSpy } = installProcs([
      { pid: 1234, cwd: project, pgid: 1234, port: 5373, dieOn: 'SIGKILL' },
    ]);

    const result = await reclaimPort(5373, project, FAST);

    expect(result.freed).toBe(true);
    expect(alive.has(1234)).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGKILL');
  });

  it('is a no-op when nothing listens on the port', async () => {
    const { killSpy } = installProcs([]);

    const result = await reclaimPort(5373, project, FAST);

    expect(result).toEqual({ killed: [], foreign: [], freed: false });
    // No signal of any kind was sent.
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('reports not-freed if a foreign survivor still holds the port after killing an owned one', async () => {
    // One owned orphan + one foreign holder on the same port. We kill ours,
    // but the port stays occupied, so the caller must fall back to offsetting.
    const { alive } = installProcs([
      { pid: 1234, cwd: project, pgid: 1234, port: 5373, dieOn: 'SIGTERM' },
      { pid: 9999, cwd: '/opt/other-app', pgid: 9999, port: 5373 },
    ]);

    const result = await reclaimPort(5373, project, FAST);

    expect(result.killed).toEqual([1234]);
    expect(result.foreign).toEqual([9999]);
    expect(result.freed).toBe(false);
    expect(alive.has(1234)).toBe(false);
    expect(alive.has(9999)).toBe(true);
  });
});

describe('reclaimOrphanPorts', () => {
  const project = '/home/dev/myproject';

  it('reclaims an owned orphan and drops the port from `remaining`', async () => {
    const reclaim = vi.fn().mockResolvedValue({ killed: [1234], foreign: [], freed: true });
    const recheck = vi.fn().mockResolvedValue(false); // port free after kill
    const onReclaim = vi.fn();

    const result = await reclaimOrphanPorts([{ name: 'Vite', port: 5373 }], project, {
      reclaim,
      recheck,
      onReclaim,
    });

    expect(result.reclaimed).toEqual([{ name: 'Vite', port: 5373, killed: [1234] }]);
    expect(result.remaining).toEqual([]);
    expect(reclaim).toHaveBeenCalledWith(5373, project);
    expect(onReclaim).toHaveBeenCalledTimes(1);
  });

  it('keeps a foreign conflict in `remaining` and does not report a reclaim', async () => {
    const reclaim = vi.fn().mockResolvedValue({ killed: [], foreign: [9999], freed: false });
    const recheck = vi.fn().mockResolvedValue(true); // still in use
    const onReclaim = vi.fn();

    const result = await reclaimOrphanPorts([{ name: 'Vite', port: 5373 }], project, {
      reclaim,
      recheck,
      onReclaim,
    });

    expect(result.reclaimed).toEqual([]);
    expect(result.remaining).toEqual([{ name: 'Vite', port: 5373 }]);
    expect(onReclaim).not.toHaveBeenCalled();
  });

  it('frees a sibling port killed by the same process-group tree', async () => {
    // Killing the Vite orphan also takes down the API server in its group, so
    // the API port is already free by the time we re-check it.
    const reclaim = vi
      .fn()
      .mockResolvedValueOnce({ killed: [1234], foreign: [], freed: true }) // Vite
      .mockResolvedValueOnce({ killed: [], foreign: [], freed: false }); // API: nothing left to kill
    const recheck = vi.fn().mockResolvedValue(false); // both free after the group kill

    const result = await reclaimOrphanPorts(
      [
        { name: 'Vite', port: 5373 },
        { name: 'API', port: 3200 },
      ],
      project,
      { reclaim, recheck },
    );

    expect(result.reclaimed).toEqual([{ name: 'Vite', port: 5373, killed: [1234] }]);
    expect(result.remaining).toEqual([]);
  });

  it('returns only the unrecoverable conflicts when reclaim is partial', async () => {
    const reclaim = vi
      .fn()
      .mockResolvedValueOnce({ killed: [1234], foreign: [], freed: true }) // Vite reclaimed
      .mockResolvedValueOnce({ killed: [], foreign: [8888], freed: false }); // API foreign
    const recheck = vi
      .fn()
      .mockResolvedValueOnce(false) // Vite now free
      .mockResolvedValueOnce(true); // API still held

    const result = await reclaimOrphanPorts(
      [
        { name: 'Vite', port: 5373 },
        { name: 'API', port: 3200 },
      ],
      project,
      { reclaim, recheck },
    );

    expect(result.reclaimed).toEqual([{ name: 'Vite', port: 5373, killed: [1234] }]);
    expect(result.remaining).toEqual([{ name: 'API', port: 3200 }]);
  });
});
