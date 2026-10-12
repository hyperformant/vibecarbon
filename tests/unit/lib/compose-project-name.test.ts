import { describe, expect, it } from 'vitest';
import { resolveComposeProjectName } from '../../../src/lib/compose-project-name.js';

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
