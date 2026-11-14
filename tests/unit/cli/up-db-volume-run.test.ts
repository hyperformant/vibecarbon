import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  createServer: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../../../src/lib/db-volume-version.js', () => ({ checkDbVolumeVersion: mocks.check }));
vi.mock('../../../src/lib/project-guard.js', () => ({ assertInProjectDir: () => {} }));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));
vi.mock('../../../src/lib/local-stacks.js', () => ({
  listVibecarbonStacks: () => [],
  formatStackPath: (x: string) => x,
}));
vi.mock('../../../src/lib/compose-project-name.js', () => ({
  // A folder that moved: the action that writes .env and stops the old stack.
  resolveComposeProjectName: () => ({ action: 'adopt', name: 'resolved-name', from: '/old' }),
  releaseMovedStack: mocks.release,
}));
vi.mock('../../../src/lib/orphan-stack-notice.js', () => ({ warnAboutOrphanStacks: () => {} }));
vi.mock('node:net', () => ({ createServer: mocks.createServer }));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  // docker info and docker compose version both succeed.
  execFileSync: () => '2.30.0\n',
}));

import { run } from '../../../src/up.js';

describe('vibecarbon up: a mismatched db volume stops it before anything is written or started', () => {
  const cwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = createTempDir('up-db-volume-');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'dev:start': 'x' } }));
    writeFileSync(join(dir, '.env'), 'PROJECT_NAME=demo\n');
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    delete process.env.COMPOSE_PROJECT_NAME;
    mocks.check.mockReset();
    mocks.createServer.mockReset();
    mocks.release.mockReset();
  });

  it('exits 1 with the message; .env, the old stack and the port probe are never touched', async () => {
    mocks.check.mockReturnValue({
      ok: false,
      volume: 'resolved-name_db_data',
      dataMajor: 15,
      imageMajor: 17,
      createdAt: '2026-04-10T17:51:54-05:00',
    });
    const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});
    vi.spyOn(p.log, 'info').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as () => never);

    await expect(run([])).rejects.toThrow('exit');

    expect(exit).toHaveBeenCalledWith(1);
    expect(String(error.mock.calls[0][0])).toContain(
      'Docker volume resolved-name_db_data holds PostgreSQL 15 data (created 2026-04-10)',
    );
    expect(mocks.check).toHaveBeenCalledWith(
      expect.objectContaining({ composeProject: 'resolved-name' }),
    );
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('PROJECT_NAME=demo\n');
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.createServer).not.toHaveBeenCalled();
  });
});
