/**
 * A stack this project's passphrase cannot decrypt surfaces as one typed
 * error that names the stack and says what still works, not as Pulumi's own
 * advice to set PULUMI_CONFIG_PASSPHRASE (which vibecarbon overrides).
 *
 * The iac layer runs for real over the shared fake Pulumi workspace, whose
 * stack refuses the passphrase with the CLI's exact text (corpus, 2026-11-11).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePulumi } from '../../_shared/fake-pulumi-workspace.js';
import { createTempDir } from '../../_shared/temp-dir.js';
import { STATE_ERROR_CORPUS } from './fixtures/state-error-corpus.js';

vi.mock('@pulumi/pulumi/automation/index.js', async () =>
  (await import('../../_shared/fake-pulumi-workspace.js')).fakeAutomationModule(),
);

const PASSPHRASE = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
const refusal = (id: string) => {
  const found = STATE_ERROR_CORPUS.find((c) => c.id === id);
  if (!found) throw new Error(`no corpus entry '${id}'`);
  return new Error(found.message);
};
const refuse = (id: string) => () => {
  throw refusal(id);
};

const { getStackOutputs, destroyStack } = await import('../../../src/lib/iac/index.js');
const { StateUndecryptableError } = await import('../../../src/lib/iac/state-error.js');
const { __resetStatePassphraseForTests } = await import('../../../src/lib/state-passphrase.js');

const BASE = { projectName: 'proj' };

describe('an undecryptable stack surfaces as StateUndecryptableError', () => {
  let logged: string[];

  beforeEach(() => {
    fakePulumi.reset();
    __resetStatePassphraseForTests();
    const dir = createTempDir('state-undecryptable-');
    writeFileSync(join(dir, '.vibecarbon.json'), '{}\n');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', PASSPHRASE);
    // progressLog's line when no spinner is running.
    logged = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('getStackOutputs: names the stack and carries the raw refusal as its cause', async () => {
    const raw = refusal('passphrase-incorrect-on-outputs');
    fakePulumi.behaviour.outputs = () => {
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
    fakePulumi.behaviour.outputs = () => {
      throw other;
    };
    await expect(getStackOutputs('e1', async () => ({}), BASE)).rejects.toBe(other);
  });

  it('destroyStack: stops at the pre-destroy refresh, never runs the destroy, and removes nothing', async () => {
    fakePulumi.behaviour.refresh = refuse('passphrase-incorrect-on-refresh');
    const err = await destroyStack('e1', async () => ({}), BASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateUndecryptableError);
    // Once: the refusal is not retried, and nothing after it runs.
    expect(fakePulumi.calls).toEqual(['select:e1', 'refresh']);
  });

  it("destroyStack: logs Pulumi's own line once, and never the passphrase", async () => {
    fakePulumi.behaviour.refresh = refuse('passphrase-incorrect-on-refresh');
    await destroyStack('e1', async () => ({}), BASE).catch(() => {});
    const lines = logged.filter((l) => l.includes('refused the state passphrase'));
    expect(lines).toEqual([
      expect.stringContaining('getting snapshot: failed to decrypt: incorrect passphrase'),
    ]);
    expect(logged.join('\n')).not.toContain(PASSPHRASE);
  });

  it('destroyStack: a refusal from the destroy itself is typed and logged too', async () => {
    fakePulumi.behaviour.destroy = refuse('passphrase-incorrect-on-destroy-stack-config');
    const err = await destroyStack('e1', async () => ({}), BASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateUndecryptableError);
    expect(fakePulumi.calls.filter((c) => c === 'destroy')).toHaveLength(1);
    expect(fakePulumi.calls.some((c) => c.startsWith('removeStack'))).toBe(false);
    expect(logged.filter((l) => l.includes('destroy refused the state passphrase'))).toHaveLength(
      1,
    );
  });
});
