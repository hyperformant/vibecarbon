import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listProviders } from '../../../src/lib/providers/index.js';

/**
 * A provider's own Pulumi settings reach every stack the CLI opens.
 *
 * The hcloud provider polls a running action at 0.5, 1.5, 3.5, 7.5, 15.5,
 * 31.5, 63.5, 123.5 s by default, so Pulumi could sit idle for up to a minute
 * after Hetzner had finished. On a k8s server that attaches to a network after
 * create, that alone was 56 s (2026-11-05, Hetzner action log against Pulumi).
 *
 * Neither poll setting has an environment variable, so they have to travel as
 * stack config, and the workspace is a fresh temp directory on every open: a
 * value set on one path is gone on the next. These tests pin that select and
 * create both carry it, that it is plain text (the stack file has no use for a
 * { value } object), and that no other provider inherits Hetzner's keys.
 */

const selectStackMock = vi.fn();
const createStackMock = vi.fn();

// These tests drive getOrCreateStack against a mocked LocalWorkspace. The real
// state-passphrase check would write a passphrase into the cwd's .env.local and
// .vibecarbon.json, so it is stubbed; state-passphrase-census.test.ts covers
// the real wiring.
vi.mock('../../../src/lib/state-passphrase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/state-passphrase.js')>()),
  ensureStatePassphrase: async () => 'test-passphrase',
}));

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: (...args: unknown[]) => createStackMock(...args),
    create: async () => ({ listStacks: async () => [] }),
  },
}));

vi.mock('../../../src/lib/cli/progress.js', () => ({ progressLog: vi.fn() }));

const open = async (provider: string | undefined, stackName = 'production') => {
  const { getOrCreateStack } = await import('../../../src/lib/iac/index.js');
  await getOrCreateStack(stackName, async () => ({}), {
    provider,
    projectName: 'acme',
  });
  return selectStackMock.mock.calls[0]?.[1] ?? createStackMock.mock.calls[0]?.[1];
};

beforeEach(() => {
  vi.resetModules();
  selectStackMock.mockReset();
  createStackMock.mockReset();
  // getOrCreateStack reads the state it opens once (the passphrase probe).
  const stack = { name: 'production', exportStack: async () => ({ deployment: {} }) };
  selectStackMock.mockResolvedValue(stack);
  createStackMock.mockResolvedValue(stack);
});

describe('provider stack config', () => {
  it('a Hetzner stack polls actions on a constant 1 s', async () => {
    const wsOpts = await open('hetzner');
    expect(wsOpts.stackSettings).toEqual({
      production: {
        config: { 'hcloud:pollFunction': 'constant', 'hcloud:pollInterval': '1s' },
      },
    });
  });

  it('creating a stack carries the same settings as selecting one', async () => {
    const notFound = Object.assign(new Error('no stack named production found'), {
      name: 'StackNotFoundError',
    });
    selectStackMock.mockRejectedValue(notFound);
    const { getOrCreateStack } = await import('../../../src/lib/iac/index.js');
    await getOrCreateStack('production', async () => ({}), {
      provider: 'hetzner',
      projectName: 'acme',
    });
    const [, wsOpts] = createStackMock.mock.calls[0];
    expect(wsOpts.stackSettings.production.config).toEqual({
      'hcloud:pollFunction': 'constant',
      'hcloud:pollInterval': '1s',
    });
  });

  it('settings are keyed by the stack being opened', async () => {
    const wsOpts = await open('hetzner', 'e3-standby');
    expect(Object.keys(wsOpts.stackSettings)).toEqual(['e3-standby']);
  });

  it('a stack opened without a provider writes no stack file', async () => {
    const wsOpts = await open(undefined);
    expect(wsOpts).not.toHaveProperty('stackSettings');
  });

  it('every provider declares only its own package, as plain text', async () => {
    const { getProviderClass } = await import('../../../src/lib/providers/index.js');
    for (const { id } of listProviders()) {
      const config = getProviderClass(id).IAC_STACK_CONFIG;
      for (const [key, value] of Object.entries(config)) {
        expect(key.split(':')).toHaveLength(2);
        expect(typeof value).toBe('string');
      }
    }
    expect(getProviderClass('digitalocean').IAC_STACK_CONFIG).toEqual({});
  });

  it('a provider with no settings writes no stack file', async () => {
    const wsOpts = await open('digitalocean');
    expect(wsOpts).not.toHaveProperty('stackSettings');
  });
});
