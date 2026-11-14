import { describe, expect, it, vi } from 'vitest';
import { checkDbVolumeVersion, pgMajorFromTag } from '../../../src/lib/db-volume-version.js';

const IMAGE = 'ghcr.io/hyperformant/postgres-walg';
const TAG = '17.11-walg3.0.9-r5';

/** A fake docker: inspect answers `inspect`, run answers `run`; either may be an Error to throw. */
function fakeDocker({
  inspect,
  run,
  ps = '',
  image = '',
}: {
  inspect: string | Error;
  run: string | Error;
  ps?: string;
  image?: string | Error;
}) {
  const calls: string[][] = [];
  const opts: Record<string, { timeout?: number } | undefined> = {};
  const docker = (argv: string[], o?: { timeout?: number }) => {
    calls.push(argv);
    opts[argv[0]] = o;
    const answer =
      argv[0] === 'volume' ? inspect : argv[0] === 'ps' ? ps : argv[0] === 'image' ? image : run;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { docker, calls, opts };
}

const INSPECT = JSON.stringify([{ Name: 'p_db_data', CreatedAt: '2026-04-10T17:51:54-05:00' }]);
const check = (docker: (argv: string[]) => string) =>
  checkDbVolumeVersion({ composeProject: 'p', image: IMAGE, tag: TAG, docker });

describe('vibecarbon up: the db volume must hold the PostgreSQL major this project runs', () => {
  it('reads the major from the image tag', () => {
    expect(pgMajorFromTag('17.11-walg3.0.9-r5')).toBe(17);
    expect(pgMajorFromTag('18.0-walg3.0.9-r1')).toBe(18);
    expect(pgMajorFromTag('latest')).toBeNull();
  });

  it('passes when the volume does not exist', () => {
    const { docker } = fakeDocker({
      inspect: new Error('Error: No such volume: p_db_data'),
      run: '15\n',
    });
    expect(check(docker)).toEqual({ ok: true });
  });

  it('passes when the volume holds the same major', () => {
    expect(check(fakeDocker({ inspect: INSPECT, run: '17\n' }).docker)).toEqual({ ok: true });
  });

  it('stops when the volume holds an older major, naming the volume, both majors and the date', () => {
    expect(check(fakeDocker({ inspect: INSPECT, run: '15\n' }).docker)).toEqual({
      ok: false,
      volume: 'p_db_data',
      dataMajor: 15,
      imageMajor: 17,
      createdAt: '2026-04-10T17:51:54-05:00',
    });
  });

  it('passes when the volume has no PG_VERSION (empty or fresh)', () => {
    const { docker } = fakeDocker({
      inspect: INSPECT,
      run: new Error('cat: /d/PG_VERSION: No such file or directory'),
    });
    expect(check(docker)).toEqual({ ok: true });
    expect(check(fakeDocker({ inspect: INSPECT, run: '' }).docker)).toEqual({ ok: true });
  });

  it('never blocks up when docker itself fails', () => {
    const { docker } = fakeDocker({
      inspect: new Error('Cannot connect to the Docker daemon'),
      run: '15\n',
    });
    expect(check(docker)).toEqual({ ok: true });
    expect(
      checkDbVolumeVersion({ composeProject: 'p', image: IMAGE, tag: 'latest', docker }),
    ).toEqual({ ok: true });
  });

  it('reads PG_VERSION with the db image, read-only, with no network', () => {
    const { docker, calls } = fakeDocker({ inspect: INSPECT, run: '17\n' });
    check(docker);
    expect(calls[0]).toEqual(['volume', 'inspect', 'p_db_data']);
    expect(calls.find((c) => c[0] === 'run')).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      'p_db_data:/d:ro',
      '--entrypoint',
      'cat',
      `${IMAGE}:${TAG}`,
      '/d/PG_VERSION',
    ]);
  });
});

describe('the check is quiet and cheap when it can be', () => {
  it('says why up pauses when the db image is not local, then still checks', () => {
    const notify = vi.fn();
    const { docker } = fakeDocker({
      inspect: INSPECT,
      run: '15\n',
      image: new Error('No such image'),
    });
    const result = checkDbVolumeVersion({
      composeProject: 'p',
      image: IMAGE,
      tag: TAG,
      docker,
      notify,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      'Downloading the database image to check the data already in p_db_data',
    );
    expect(result).toMatchObject({ ok: false, dataMajor: 15 });
  });

  it('stays silent when the image is already local', () => {
    const notify = vi.fn();
    const { docker } = fakeDocker({ inspect: INSPECT, run: '17\n' });
    checkDbVolumeVersion({ composeProject: 'p', image: IMAGE, tag: TAG, docker, notify });
    expect(notify).not.toHaveBeenCalled();
  });

  it('gives the read 120 s, and a read that times out passes', () => {
    const timedOut = Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const { docker, opts } = fakeDocker({ inspect: INSPECT, run: timedOut });
    expect(check(docker)).toEqual({ ok: true });
    expect(opts.run?.timeout).toBe(120_000);
  });

  it('skips the read when this project db is running on exactly this image', () => {
    const { docker, calls } = fakeDocker({
      inspect: INSPECT,
      run: '15\n',
      ps: `running ${IMAGE}:${TAG}\n`,
    });
    expect(check(docker)).toEqual({ ok: true });
    expect(calls.some((c) => c[0] === 'run')).toBe(false);
    const ps = calls.find((c) => c[0] === 'ps') ?? [];
    expect(ps).toContain('label=com.docker.compose.project=p');
    expect(ps).toContain('label=com.docker.compose.service=db');
  });

  it.each([
    ['a different tag', `running ${IMAGE}:16.4-walg3.0.9-r1\n`],
    ['an exited container', `exited ${IMAGE}:${TAG}\n`],
  ])('still reads the volume when the db is on %s', (_name, ps) => {
    const { docker, calls } = fakeDocker({ inspect: INSPECT, run: '15\n', ps });
    expect(check(docker)).toMatchObject({ ok: false, dataMajor: 15 });
    expect(calls.some((c) => c[0] === 'run')).toBe(true);
  });
});

describe('reportDbVolumeMismatch', () => {
  it('says what is in the volume and how to move on, then exits 1', async () => {
    const { reportDbVolumeMismatch } = await import('../../../src/up.js');
    const p = await import('@clack/prompts');
    const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});
    const info = vi.spyOn(p.log, 'info').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    reportDbVolumeMismatch({
      ok: false,
      volume: 'p_db_data',
      dataMajor: 15,
      imageMajor: 17,
      createdAt: '2026-04-10T17:51:54-05:00',
    });
    expect(error).toHaveBeenCalledWith(
      'Docker volume p_db_data holds PostgreSQL 15 data (created 2026-04-10), and this project runs PostgreSQL 17, which cannot open it.',
    );
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.join('\n')).toContain('vibecarbon down');
    expect(lines.join('\n')).toContain('docker volume rm p_db_data');
    expect(lines.join('\n')).toContain('COMPOSE_PROJECT_NAME');
    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });
});
