import { describe, expect, it } from 'vitest';
import {
  releaseMovedStack,
  resolveComposeProjectName,
} from '../../../src/lib/compose-project-name.js';

const stack = (project: string, workingDir: string, names = ['my-app-db']) => ({
  project,
  workingDir,
  configFiles: [`${workingDir}/docker-compose.yml`],
  containers: names.map((name) => ({ name, state: 'running' })),
});

describe('resolveComposeProjectName', () => {
  const base = { cwd: '/p/my-app2', projectName: 'my-app', pinned: null };

  it('pins the folder-derived name for a fresh project', () => {
    expect(resolveComposeProjectName({ ...base, stacks: [], exists: () => true })).toEqual({
      action: 'pin',
      name: 'my-app2',
    });
  });

  it('keeps an existing pin when nothing conflicts', () => {
    expect(
      resolveComposeProjectName({ ...base, pinned: 'my-app', stacks: [], exists: () => true }),
    ).toEqual({ action: 'keep', name: 'my-app' });
  });

  it('pins the running stack name when the stack is already ours', () => {
    const r = resolveComposeProjectName({
      ...base,
      stacks: [stack('my-app', '/p/my-app2')],
      exists: () => true,
    });
    expect(r).toEqual({ action: 'pin', name: 'my-app' });
  });

  it('keeps the pin when the stack is already ours and pinned', () => {
    const r = resolveComposeProjectName({
      ...base,
      pinned: 'my-app',
      stacks: [stack('my-app', '/p/my-app2')],
      exists: () => true,
    });
    expect(r).toEqual({ action: 'keep', name: 'my-app' });
  });

  it('adopts a stack whose folder is gone (renamed or moved)', () => {
    const r = resolveComposeProjectName({
      ...base,
      stacks: [stack('my-app', '/p/my-app')],
      exists: (p: string) => p !== '/p/my-app',
    });
    expect(r).toEqual({ action: 'adopt', name: 'my-app', from: '/p/my-app' });
  });

  it('refuses when the stack belongs to a folder that still exists (a copy)', () => {
    const r = resolveComposeProjectName({
      ...base,
      stacks: [stack('my-app', '/p/my-app')],
      exists: () => true,
    });
    expect(r).toEqual({ action: 'refuse', from: '/p/my-app' });
  });

  it('refuses a copy even when a pin was copied along with .env', () => {
    const r = resolveComposeProjectName({
      ...base,
      pinned: 'my-app',
      stacks: [stack('my-app', '/p/my-app')],
      exists: () => true,
    });
    expect(r).toEqual({ action: 'refuse', from: '/p/my-app' });
  });

  it('ignores stacks that belong to other projects', () => {
    const r = resolveComposeProjectName({
      ...base,
      stacks: [stack('other', '/p/other', ['other-db'])],
      exists: () => true,
    });
    expect(r).toEqual({ action: 'pin', name: 'my-app2' });
  });

  it('treats a missing projectName as no owning stack', () => {
    const r = resolveComposeProjectName({
      ...base,
      projectName: null,
      stacks: [stack('my-app', '/p/my-app')],
      exists: () => true,
    });
    expect(r).toEqual({ action: 'pin', name: 'my-app2' });
  });
});

describe('resolveComposeProjectName symlinks and stale pins', () => {
  const base = { cwd: '/p/my-app2', projectName: 'my-app', pinned: null };

  it('treats a symlinked working_dir that resolves to cwd as ours, not a copy', () => {
    const r = resolveComposeProjectName({
      ...base,
      stacks: [stack('my-app', '/link/my-app')],
      exists: () => true,
      realpath: (p: string) => (p === '/link/my-app' ? '/p/my-app2' : p),
    });
    expect(r).toEqual({ action: 'pin', name: 'my-app' });
  });

  it('falls back to the raw path when realpath throws', () => {
    const r = resolveComposeProjectName({
      ...base,
      stacks: [stack('my-app', '/p/my-app')],
      exists: () => true,
      realpath: () => {
        throw new Error('ENOENT');
      },
    });
    expect(r).toEqual({ action: 'refuse', from: '/p/my-app' });
  });

  it('repins when the stack at cwd has a different name than the stale pin', () => {
    const r = resolveComposeProjectName({
      ...base,
      pinned: 'old-name',
      stacks: [stack('my-app', '/p/my-app2')],
      exists: () => true,
    });
    expect(r).toEqual({ action: 'pin', name: 'my-app' });
  });
});

describe('releaseMovedStack', () => {
  it('runs compose down --remove-orphans for the adopted name and never -v', () => {
    const calls: string[][] = [];
    expect(releaseMovedStack('my-app', { run: (a: string[]) => calls.push(a) })).toBe(true);
    expect(calls).toEqual([['compose', '-p', 'my-app', 'down', '--remove-orphans']]);
    expect(calls[0]).not.toContain('-v');
  });

  it('returns false instead of throwing when docker fails', () => {
    expect(
      releaseMovedStack('my-app', {
        run: () => {
          throw new Error('boom');
        },
      }),
    ).toBe(false);
  });
});
