/**
 * The k3s join token a k8s program is built with (lib/iac/k3s-token.js).
 *
 * A first `up` that fails after it created servers leaves the stack with no
 * outputs while those servers booted with its token. The rerun's probe reads
 * `empty`, and a random token there would differ from theirs: user data is
 * ignored on an existing server, so the servers keep the first token while
 * the stack records the second, and no node a later scale or the
 * carbon-autoscaler makes could join. So a stack with no recorded token gets
 * one derived from the project's state passphrase, the project and the stack:
 * the same on every rerun. A recorded token is replayed unchanged.
 *
 * Sentinels only, never a real passphrase or token.
 */
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PASSPHRASE = 'SENTINEL-passphrase-k3s-0000000000000000000000';
const passphrase = vi.hoisted(() => ({ dirs: [] as string[] }));
vi.mock('../../../src/lib/state-passphrase.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/state-passphrase.js')>()),
  ensureStatePassphrase: async (dir: string) => {
    passphrase.dirs.push(dir);
    return PASSPHRASE;
  },
}));

const { deriveK3sToken, k3sTokenForStack, requireK3sToken } = await import(
  '../../../src/lib/iac/k3s-token.js'
);

beforeEach(() => {
  passphrase.dirs.length = 0;
});

describe('deriveK3sToken', () => {
  const base = { passphrase: PASSPHRASE, projectName: 'shop', stackName: 'prod' };

  it('is the hex HMAC-SHA256 of the versioned message, keyed by the passphrase', () => {
    const expected = createHmac('sha256', PASSPHRASE)
      .update('vibecarbon-k3s-token-v1\0shop\0prod')
      .digest('hex');
    expect(deriveK3sToken(base)).toBe(expected);
  });

  it('is 64 hex characters, as the random token it replaces was', () => {
    expect(deriveK3sToken(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same on every call for the same passphrase, project and stack', () => {
    expect(deriveK3sToken(base)).toBe(deriveK3sToken({ ...base }));
  });

  it.each([
    ['project', { projectName: 'shop2' }],
    ['stack', { stackName: 'prod-standby' }],
    ['passphrase', { passphrase: `${PASSPHRASE}x` }],
  ])('differs when the %s differs', (_label, change) => {
    expect(deriveK3sToken({ ...base, ...change })).not.toBe(deriveK3sToken(base));
  });

  // The NUL separators keep two fields from sliding into each other.
  it('never lets the project and stack trade characters', () => {
    expect(deriveK3sToken({ ...base, projectName: 'shop-a', stackName: 'b' })).not.toBe(
      deriveK3sToken({ ...base, projectName: 'shop', stackName: 'a-b' }),
    );
  });

  // The Pulumi project the stack lives under: the same trimmed name the
  // stack's state key uses, so the derivation and the stack never disagree.
  it('uses the project name as it scopes the Pulumi state', () => {
    expect(deriveK3sToken({ ...base, projectName: '  shop  ' })).toBe(deriveK3sToken(base));
  });

  it.each([
    ['no passphrase', { passphrase: '' }],
    ['no project', { projectName: '' }],
    ['no stack', { stackName: '' }],
  ])('refuses with %s', (_label, change) => {
    expect(() => deriveK3sToken({ ...base, ...change })).toThrow();
  });
});

describe('k3sTokenForStack', () => {
  const where = { projectName: 'shop', stackName: 'prod', projectDir: '/proj' };

  it('recovered: replays the recorded token unchanged, reading no passphrase', async () => {
    const recorded = 'SENTINEL-recorded-token';
    const token = await k3sTokenForStack(
      { status: 'recovered', priorK3sToken: recorded, reason: 'k3sToken present' },
      where,
    );
    expect(token).toEqual({ k3sToken: recorded, k3sTokenReplayed: true });
    expect(passphrase.dirs).toEqual([]);
  });

  it.each(['missing', 'empty'])(
    '%s: the token derived from the project passphrase, project and stack',
    async (status) => {
      const token = await k3sTokenForStack({ status, reason: 'r' }, where);
      expect(token).toEqual({
        k3sToken: deriveK3sToken({
          passphrase: PASSPHRASE,
          projectName: 'shop',
          stackName: 'prod',
        }),
        k3sTokenReplayed: false,
      });
      // The resolver the stack open uses, for this project.
      expect(passphrase.dirs).toEqual(['/proj']);
    },
  );

  it('a failed first up and its rerun get the same token', async () => {
    const first = await k3sTokenForStack({ status: 'missing', reason: 'r' }, where);
    const rerun = await k3sTokenForStack({ status: 'empty', reason: 'r' }, where);
    expect(rerun.k3sToken).toBe(first.k3sToken);
  });

  it('defaults to the working directory, as a stack open does', async () => {
    await k3sTokenForStack(
      { status: 'empty', reason: 'r' },
      { projectName: 'shop', stackName: 'p' },
    );
    expect(passphrase.dirs).toEqual([process.cwd()]);
  });

  it('refuses a status it does not know, and a recovered probe with no token', async () => {
    await expect(k3sTokenForStack({ status: 'weird', reason: 'r' }, where)).rejects.toThrow(
      /weird/,
    );
    await expect(
      k3sTokenForStack({ status: 'recovered', priorK3sToken: '', reason: 'r' }, where),
    ).rejects.toThrow();
  });
});

describe('requireK3sToken', () => {
  it('hands back the token a program is given', () => {
    expect(requireK3sToken({ k3sToken: 'SENTINEL-t' }, 'buildX')).toBe('SENTINEL-t');
  });

  it.each([{}, { k3sToken: '' }, { k3sToken: 42 }])('refuses %j, naming the program', (config) => {
    expect(() => requireK3sToken(config, 'buildX')).toThrow(/buildX.*k3sToken/);
  });
});
