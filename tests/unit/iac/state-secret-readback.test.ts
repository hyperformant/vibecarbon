import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePulumi } from '../../_shared/fake-pulumi-workspace.js';
import { createTempDir } from '../../_shared/temp-dir.js';

/**
 * Once the programs export `k3sToken` as a secret, every reader of stack
 * outputs must still get the plain token: Pulumi's automation API reports a
 * secret output as `{ value, secret: true }` with the value decrypted, and
 * the readers flatten that to the value. A reader that took the entry itself
 * would replay `[object Object]` into the next cluster's user data.
 */

vi.mock('@pulumi/pulumi/automation/index.js', async () =>
  (await import('../../_shared/fake-pulumi-workspace.js')).fakeAutomationModule(),
);

const { getStackOutputs, upStack, classifyK3sTokenProbe, __resetStateProbesForTests } =
  await import('../../../src/lib/iac/index.js');
const { __resetStatePassphraseForTests } = await import('../../../src/lib/state-passphrase.js');

const TOKEN = 'SENTINEL-k3s-token-9b7e';
const RAW = {
  k3sToken: { value: TOKEN, secret: true },
  masterIp: { value: '203.0.113.5', secret: false },
};

describe('a secret k3sToken output reads back as the plain token', () => {
  beforeEach(() => {
    fakePulumi.reset();
    __resetStatePassphraseForTests();
    __resetStateProbesForTests();
    const dir = createTempDir('state-secret-readback-');
    writeFileSync(join(dir, '.vibecarbon.json'), '{}\n');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5');
  });

  it('getStackOutputs flattens it, and the probe recovers it for replay', async () => {
    fakePulumi.behaviour.outputs = () => RAW;
    const outputs = await getStackOutputs('e1', async () => ({}), { projectName: 'proj' });
    expect(outputs.k3sToken).toBe(TOKEN);
    expect(outputs.masterIp).toBe('203.0.113.5');
    expect(classifyK3sTokenProbe({ outputs })).toMatchObject({
      status: 'recovered',
      priorK3sToken: TOKEN,
    });
  });

  it('upStack hands back the plain token to the deploy that reads infraOutputs.k3sToken', async () => {
    fakePulumi.behaviour.up = () => ({ outputs: RAW, summary: { result: 'succeeded' } });
    const { outputs } = await upStack('e1', async () => ({}), { projectName: 'proj' });
    expect(outputs.k3sToken).toBe(TOKEN);
  });
});
