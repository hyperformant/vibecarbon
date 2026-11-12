/**
 * mergeRemoteDotenv (src/lib/deploy/utils.js) pulls the server's .env, every
 * secret on it, into a local temp dir, merges the updates in, and pushes it
 * back. The dir is gone when it returns, and when the pull or the push fails.
 *
 * scp is mocked: the pull writes a server .env to the local path, the push
 * records what it would send.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tempLeftovers } from '../../_shared/temp-census.js';

const h = vi.hoisted(() => ({
  pushed: null as null | string,
  localDirs: [] as string[],
  failPull: false,
  failPush: false,
}));

vi.mock('../../../src/lib/ssh.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  scpWithRetry: vi.fn(async (argv: string[]) => {
    const [from, to] = argv.slice(-2);
    if (to.startsWith('root@')) {
      if (h.failPush) throw new Error('lost connection');
      h.pushed = readFileSync(from, 'utf-8');
      return;
    }
    h.localDirs.push(dirname(to));
    if (h.failPull) throw new Error('lost connection');
    writeFileSync(to, 'A=1\nSECRET=not-a-real-secret\n');
  }),
}));

const { mergeRemoteDotenv } = await import('../../../src/lib/deploy/utils.js');

const merge = () =>
  mergeRemoteDotenv('203.0.113.7', '-o BatchMode=yes', '/opt/app', { A: '2', B: '3' });

beforeEach(() => {
  h.pushed = null;
  h.localDirs = [];
  h.failPull = false;
  h.failPush = false;
});

describe('mergeRemoteDotenv and its local copy of the server .env', () => {
  it('pushes the merged file, then removes the local copy', async () => {
    await merge();
    expect(h.pushed).toBe('A=2\nSECRET=not-a-real-secret\n\nB=3');
    expect(h.localDirs).toHaveLength(1);
    expect(existsSync(h.localDirs[0])).toBe(false);
    expect(tempLeftovers(tmpdir())).toEqual([]);
  });

  it.each([
    ['the pull', 'failPull', /Failed to pull \/opt\/app\/\.env/],
    ['the push', 'failPush', /Failed to push merged \.env back/],
  ] as const)('removes the local copy when %s fails', async (_what, flag, message) => {
    h[flag] = true;
    await expect(merge()).rejects.toThrow(message);
    expect(existsSync(h.localDirs[0])).toBe(false);
    expect(tempLeftovers(tmpdir())).toEqual([]);
  });
});
