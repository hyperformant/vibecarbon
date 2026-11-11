/**
 * A stack this project's passphrase cannot decrypt surfaces as one typed
 * error that names the stack and says what still works, not as Pulumi's own
 * advice to set PULUMI_CONFIG_PASSPHRASE (which vibecarbon overrides).
 *
 * The iac layer runs for real over a mocked LocalWorkspace whose stack
 * refuses the passphrase with the CLI's exact text (corpus, 2026-11-11).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';
import { STATE_ERROR_CORPUS } from './fixtures/state-error-corpus.js';

const PASSPHRASE = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
const refusal = (id: string) => {
  const found = STATE_ERROR_CORPUS.find((c) => c.id === id);
  if (!found) throw new Error(`no corpus entry '${id}'`);
  return new Error(found.message);
};

const calls: string[] = [];
let stackBehaviour: Record<string, () => Promise<unknown>> = {};
const fakeStack = () => {
  const call = (name: string, fallback: () => Promise<unknown>) => async () => {
    calls.push(name);
    return (stackBehaviour[name] ?? fallback)();
  };
  return {
    name: 'e1',
    refresh: call('refresh', async () => undefined),
    destroy: call('destroy', async () => ({
      summary: { result: 'succeeded', resourceChanges: { delete: 1 } },
    })),
    outputs: call('outputs', async () => ({ masterIp: { value: '1.2.3.4' } })),
    exportStack: call('exportStack', async () => ({ deployment: { resources: [] } })),
    cancel: call('cancel', async () => undefined),
    workspace: { removeStack: call('removeStack', async () => undefined) },
  };
};
vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: async () => fakeStack(),
    createStack: async () => {
      throw new Error('createStack must not be called');
    },
    create: async () => ({ listStacks: async () => [], whoAmI: async () => 'me' }),
  },
}));

const { getStackOutputs, destroyStack } = await import('../../../src/lib/iac/index.js');
const { StateUndecryptableError } = await import('../../../src/lib/iac/state-error.js');
const { __resetStatePassphraseForTests } = await import('../../../src/lib/state-passphrase.js');

const BASE = { projectName: 'proj' };

describe('an undecryptable stack surfaces as StateUndecryptableError', () => {
  beforeEach(() => {
    calls.length = 0;
    stackBehaviour = {};
    __resetStatePassphraseForTests();
    const dir = createTempDir('state-undecryptable-');
    writeFileSync(join(dir, '.vibecarbon.json'), '{}\n');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', PASSPHRASE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('getStackOutputs: names the stack and carries the raw refusal as its cause', async () => {
    const raw = refusal('passphrase-incorrect-on-outputs');
    stackBehaviour.outputs = async () => {
      throw raw;
    };
    const err = await getStackOutputs('e1', async () => ({}), BASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateUndecryptableError);
    expect((err as Error).message).toContain('Pulumi state for e1');
    expect((err as Error).message).not.toContain('please set PULUMI_CONFIG_PASSPHRASE');
    expect((err as Error & { cause?: unknown }).cause).toBe(raw);
  });

  it('getStackOutputs: any other failure passes through untouched', async () => {
    const other = new Error('error: could not read bucket: NoSuchBucket: status code: 404');
    stackBehaviour.outputs = async () => {
      throw other;
    };
    await expect(getStackOutputs('e1', async () => ({}), BASE)).rejects.toBe(other);
  });

  it('destroyStack: stops at the pre-destroy refresh, never runs the destroy, and removes nothing', async () => {
    stackBehaviour.refresh = async () => {
      throw refusal('passphrase-incorrect-on-refresh');
    };
    const err = await destroyStack('e1', async () => ({}), BASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateUndecryptableError);
    // Once: the refusal is not retried, and nothing after it runs.
    expect(calls).toEqual(['refresh']);
  });

  it('destroyStack: a refusal from the destroy itself is typed too', async () => {
    stackBehaviour.destroy = async () => {
      throw refusal('passphrase-incorrect-on-destroy-stack-config');
    };
    const err = await destroyStack('e1', async () => ({}), BASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateUndecryptableError);
    expect(calls.filter((c) => c === 'destroy')).toHaveLength(1);
    expect(calls).not.toContain('removeStack');
  });
});
