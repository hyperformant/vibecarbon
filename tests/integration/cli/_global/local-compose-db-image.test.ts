/**
 * Every local compose run gets the CLI's db image through the environment.
 *
 * carbon/docker-compose.yml requires DB_IMAGE/DB_IMAGE_TAG (`:?`). The
 * carbon/ source tree's .env never has them (dev-init writes none), so a
 * `pnpm dev:stop` / `vibecarbon down` there, or a reset, failed before compose
 * did anything. up, down and reset hand their child the resolved pair
 * (localComposeEnv), and so does up's `docker compose ps` probe. This drives
 * each command against a project whose .env lacks the pair, exactly the
 * source tree's state.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_IMAGE, DB_IMAGE_TAG } from '../../../../src/lib/images.js';
import {
  destroyRealProject,
  type ExecStubs,
  installExecStubs,
  realProject,
  runCli,
} from '../../_harness/index.js';

const RECORD = ['DB_IMAGE', 'DB_IMAGE_TAG'];
const RELEASE = { DB_IMAGE, DB_IMAGE_TAG };

describe('local compose runs carry the db image when .env has none', () => {
  let project: string;
  let stubs: ExecStubs;
  beforeEach(() => {
    project = realProject();
    const envPath = join(project, '.env');
    const stripped = readFileSync(envPath, 'utf-8')
      .split('\n')
      .filter((line) => !/^DB_IMAGE(_TAG)?=/.test(line))
      .join('\n');
    writeFileSync(envPath, stripped);
    stubs = installExecStubs([
      { command: 'docker', respond: { stdout: '', exitCode: 0 }, recordEnv: RECORD },
      { command: 'npm', respond: { stdout: '', exitCode: 0 }, recordEnv: RECORD },
    ]);
  });
  afterEach(() => {
    destroyRealProject(project);
    stubs.teardown();
  });

  const run = (command: string, args: string[] = []) => {
    const r = runCli(command, args, {
      cwd: project,
      execStubs: stubs,
      timeoutMs: 30_000,
      env: { VIBECARBON_DB_IMAGE: '' },
    });
    if (r.exitCode === null) throw new Error(`${command} timed out:\n${r.stderr}`);
    return r;
  };
  const npmScript = (script: string) => stubs.callsTo('npm').find((c) => c.argv.includes(script));

  it('the project .env really lacks the pair', () => {
    expect(readFileSync(join(project, '.env'), 'utf-8')).not.toMatch(/^DB_IMAGE/m);
  });

  it('up: dev:start and the compose ps probe get the release pair', () => {
    run('up');
    expect(npmScript('dev:start')?.env).toEqual(RELEASE);
    const ps = stubs.callsTo('docker').find((c) => c.argv.join(' ') === 'compose ps --format json');
    expect(ps?.env).toEqual(RELEASE);
  });

  it('down: dev:stop gets the release pair', () => {
    run('down');
    expect(npmScript('dev:stop')?.env).toEqual(RELEASE);
  });

  it('reset: dev:reset gets the release pair', () => {
    run('reset', ['-y']);
    expect(npmScript('dev:reset')?.env).toEqual(RELEASE);
  });
});
