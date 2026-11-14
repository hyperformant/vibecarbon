import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkDbVolumeVersion, pgMajorFromTag } from '../../../src/lib/db-volume-version.js';

const IMAGE = 'ghcr.io/hyperformant/postgres-walg';
const TAG = '17.11-walg3.0.9-r5';

/** A fake docker: inspect answers `inspect`, run answers `run`; either may be an Error to throw. */
function fakeDocker({ inspect, run }: { inspect: string | Error; run: string | Error }) {
  const calls: string[][] = [];
  const docker = (argv: string[]) => {
    calls.push(argv);
    const answer = argv[0] === 'volume' ? inspect : run;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { docker, calls };
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
    expect(calls[1]).toEqual([
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

describe('src/up.js run(): the check stops up before any other work', () => {
  const text = readFileSync(join(process.cwd(), 'src/up.js'), 'utf8');
  const run = text.slice(text.indexOf('export async function run('));

  it('runs after the project name is set and before the port probes and dev:start', () => {
    const at = run.indexOf('checkDbVolumeVersion(');
    expect(at).toBeGreaterThan(run.indexOf('process.env.COMPOSE_PROJECT_NAME = resolved.name'));
    expect(at).toBeLessThan(run.indexOf('getProjectPorts(cwd)'));
    expect(at).toBeLessThan(run.indexOf('const spawnArgs'));
  });

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
