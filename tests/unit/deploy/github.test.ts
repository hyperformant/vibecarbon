/**
 * Unit tests for lib/deploy/github.js — the gh/git wrappers the deploy path
 * uses for repo creation and CI pushes. All exec goes through the mocked
 * runCommand, so these pin argument shapes and null/false handling (the
 * ignoreError contract: runCommand returns false/null on failure).
 */

import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const clackMock = vi.hoisted(() => ({
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: { step: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  note: vi.fn(),
}));
vi.mock('@clack/prompts', () => clackMock);

vi.mock('../../../src/lib/command.js', () => ({
  runCommand: vi.fn(),
  checkDependency: vi.fn(),
}));

import { runCommand } from '../../../src/lib/command.js';
import {
  checkExistingRepo,
  checkGitHubAuth,
  checkGitRemote,
  commitAndPush,
  createGitHubRepository,
  getGitHubUsername,
} from '../../../src/lib/deploy/github.js';

const mockRun = runCommand as unknown as ReturnType<typeof vi.fn>;
const mockExists = existsSync as unknown as ReturnType<typeof vi.fn>;

describe('checkGitHubAuth', () => {
  it('is true when `gh auth status` produces output', () => {
    mockRun.mockReturnValueOnce('Logged in to github.com');
    expect(checkGitHubAuth()).toBe(true);
  });

  it.each([
    ['null', null],
    ['false', false],
  ])('is false when runCommand returns %s (ignoreError contract)', (_label, value) => {
    mockRun.mockReturnValueOnce(value);
    expect(checkGitHubAuth()).toBe(false);
  });
});

describe('getGitHubUsername / checkExistingRepo / checkGitRemote', () => {
  it('trims the gh/git output', () => {
    mockRun.mockReturnValueOnce('octocat\n');
    expect(getGitHubUsername()).toBe('octocat');
    mockRun.mockReturnValueOnce('owner/repo\n');
    expect(checkExistingRepo()).toBe('owner/repo');
    mockRun.mockReturnValueOnce('git@github.com:owner/repo.git\n');
    expect(checkGitRemote()).toBe('git@github.com:owner/repo.git');
  });

  it('returns null on empty or failed output', () => {
    mockRun.mockReturnValueOnce('');
    expect(getGitHubUsername()).toBeNull();
    mockRun.mockReturnValueOnce(null);
    expect(checkExistingRepo()).toBeNull();
    mockRun.mockReturnValueOnce(false);
    expect(checkGitRemote()).toBeNull();
  });
});

describe('createGitHubRepository', () => {
  it('creates the repo with the requested visibility and returns its URL', async () => {
    mockRun.mockReset();
    mockExists.mockReturnValue(true); // .git exists
    mockRun
      .mockReturnValueOnce('abc123') // git rev-parse HEAD → has commits
      .mockReturnValueOnce('') // gh repo create
      .mockReturnValueOnce('https://github.com/owner/my-app\n'); // gh repo view url

    const result = await createGitHubRepository('my-app', { isPublic: false });
    expect(result).toEqual({
      success: true,
      url: 'https://github.com/owner/my-app',
      name: 'my-app',
    });
    const createArgv = mockRun.mock.calls[1][0];
    expect(createArgv).toEqual([
      'gh',
      'repo',
      'create',
      'my-app',
      '--private',
      '--source=.',
      '--remote=origin',
    ]);
  });

  it('reports failure without throwing when gh repo create fails', async () => {
    mockRun.mockReset();
    mockExists.mockReturnValue(true);
    mockRun
      .mockReturnValueOnce('abc123') // has commits
      .mockImplementationOnce(() => {
        throw new Error('name already exists');
      });

    const result = await createGitHubRepository('my-app');
    expect(result.success).toBe(false);
    expect(result.error).toContain('name already exists');
  });
});

describe('commitAndPush', () => {
  it('pushes to the branch and reports success (no-new-changes commit tolerated)', async () => {
    mockRun.mockReset();
    mockRun
      .mockReturnValueOnce('') // git add
      .mockReturnValueOnce(false) // git commit → nothing to commit
      .mockReturnValueOnce(''); // git push

    const result = await commitAndPush('main', '.github/workflows/deploy.yml');
    expect(result).toEqual({ success: true });
    expect(mockRun.mock.calls[2][0]).toEqual(['git', 'push', '-u', 'origin', 'main']);
  });

  it('appends [skip ci] to the commit message when requested', async () => {
    mockRun.mockReset();
    mockRun.mockReturnValue('');
    await commitAndPush('main', 'wf.yml', { skipCi: true });
    const commitArgv = mockRun.mock.calls[1][0];
    expect(commitArgv[commitArgv.length - 1]).toContain('[skip ci]');
  });

  it('reports failure when the push throws', async () => {
    mockRun.mockReset();
    mockRun
      .mockReturnValueOnce('')
      .mockReturnValueOnce('committed')
      .mockImplementationOnce(() => {
        throw new Error('remote rejected');
      });
    const result = await commitAndPush('main', 'wf.yml');
    expect(result.success).toBe(false);
    expect(result.error).toContain('remote rejected');
  });
});
