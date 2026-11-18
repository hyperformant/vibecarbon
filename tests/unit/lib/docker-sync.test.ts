/**
 * tests/_shared/docker-sync.ts, the process helpers the Docker tier
 * (tests/integration/docker) shares. That tier runs only under
 * `pnpm test:docker`, so these pin the helpers' contract where every run
 * sees it. Each child is `sh`, which starts in a few milliseconds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dockerRunner, dockerTierSkip, sleepSync, waitFor } from '../../_shared/docker-sync.js';

describe('dockerRunner', () => {
  const { run, runBinary, must } = dockerRunner();

  it('run returns the exit status and both streams as text', () => {
    const r = run('sh', ['-c', 'printf out; printf err >&2; exit 3']);
    expect(r).toEqual({ status: 3, stdout: 'out', stderr: 'err' });
  });

  it('run writes input to the child and passes the env it is given', () => {
    const r = run('sh', ['-c', 'cat; printf "%s" "$VC_SYNC_TEST"'], {
      input: 'in-',
      env: { PATH: process.env.PATH, VC_SYNC_TEST: 'env' },
    });
    expect(r.stdout).toBe('in-env');
  });

  it('runBinary keeps stdout as bytes', () => {
    const r = runBinary('sh', ['-c', "printf '\\377\\000\\001'"]);
    expect(r.status).toBe(0);
    expect([...r.stdout]).toEqual([0xff, 0x00, 0x01]);
  });

  it('must returns stdout when the command exits 0', () => {
    expect(must('sh', ['-c', 'printf ok'])).toBe('ok');
  });

  it('must throws with the command, its arguments, the status and stderr', () => {
    expect(() => must('sh', ['-c', 'printf boom >&2; exit 4'])).toThrow(
      'sh -c printf boom >&2; exit 4 exited 4: boom',
    );
  });

  it('must falls back to stdout when stderr is empty', () => {
    expect(() => must('sh', ['-c', 'printf said; exit 1'])).toThrow('exited 1: said');
  });

  it("kills a child at the runner's timeout, and a call's own option wins", () => {
    const quick = dockerRunner({ timeoutMs: 100 });
    expect(quick.run('sh', ['-c', 'sleep 5']).status).toBeNull();
    expect(quick.run('sh', ['-c', 'exit 0'], { timeoutMs: 30_000 }).status).toBe(0);
  });
});

describe('waitFor', () => {
  it('returns as soon as the probe holds', () => {
    let calls = 0;
    waitFor('the third call', () => ++calls === 3, 10_000, 1);
    expect(calls).toBe(3);
  });

  it('throws naming what it waited for once the deadline passes', () => {
    expect(() => waitFor('the moon', () => false, 30, 5)).toThrow('timed out waiting for the moon');
  });
});

describe('sleepSync', () => {
  it('blocks for at least the time asked', () => {
    const start = Date.now();
    sleepSync(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});

describe('dockerTierSkip', () => {
  const saved = process.env.DOCKER_INTEGRATION;
  afterEach(() => {
    if (saved === undefined) delete process.env.DOCKER_INTEGRATION;
    else process.env.DOCKER_INTEGRATION = saved;
    vi.restoreAllMocks();
  });

  it('is null when DOCKER_INTEGRATION=true, and prints nothing', () => {
    process.env.DOCKER_INTEGRATION = 'true';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(dockerTierSkip('a-test', 'Docker')).toBeNull();
    expect(info).not.toHaveBeenCalled();
  });

  it.each([undefined, 'false', 'TRUE', '1'])(
    'otherwise returns the reason and prints it under the name (DOCKER_INTEGRATION=%s)',
    (value) => {
      if (value === undefined) delete process.env.DOCKER_INTEGRATION;
      else process.env.DOCKER_INTEGRATION = value;
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const reason =
        'skipped: needs Docker and kubectl; run it with DOCKER_INTEGRATION=true (pnpm test:docker)';
      expect(dockerTierSkip('a-test', 'Docker and kubectl')).toBe(reason);
      expect(info).toHaveBeenCalledWith(`a-test: ${reason}`);
    },
  );
});
