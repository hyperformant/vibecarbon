/**
 * A Vultr resource gone from the cloud, on the real Pulumi engine (file://
 * backend) and the fake cloud (fakecloud/).
 *
 * Evidence (e2e run 45922250720, vultr k8s, stack civ3): the destroy's
 * refresh failed on a reserved IP the backstop had released. The provider's
 * Read looks for "Invalid reserved-ip ID" and Vultr answers "reserved ip not
 * found", so the Read returns the 404 as an error and the refresh fails. The
 * warning said only `error: update failed`, and the destroy then failed on
 * the same 404.
 *
 * Here a stack lists a Vultr instance the cloud does not hold (written into
 * its state by hand; the fake cloud answers for it as the bridged provider
 * does):
 *   - left in state (Vultr's answer is not its not-found), the refresh fails
 *     and its warning names the instance and the provider's own error line,
 *     and the destroy fails on it, as civ3's did;
 *   - pruned first (Vultr answers its measured 404), the import is accepted,
 *     the refresh and the destroy succeed, and the count includes it.
 *
 * Vultr's API is a stub (fetch); nothing reaches Vultr. Skipped locally where
 * no pulumi CLI is installed. Under CI the integration job installs it, and a
 * missing CLI fails this test instead of skipping it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pulumi from '@pulumi/pulumi';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pulumiOnPath } from '../../_shared/pulumi-cli.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';

const logged: string[] = [];
vi.mock('../../../src/lib/cli/progress.js', () => ({
  progressLog: (m: string) => logged.push(m),
}));
const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args) };
});

const { __resetStateProbesForTests, destroyStack, upStack } = await import(
  '../../../src/lib/iac/index.js'
);
const { __resetStatePassphraseForTests } = await import('../../../src/lib/state-passphrase.js');

const hasPulumi = pulumiOnPath();

const PROJECT = 'pruneit';
const PASSPHRASE = 'cHJ1bmVwcnVuZXBydW5lcHJ1bmVwcnVuZXBydW5lcHJ1';
const INSTANCE = 'vultr:index/instance:Instance';
const GONE_ID = 'cb676a46-66fd-4dfb-b839-443f2e6c0b60';

const root = createTempDir('vc-vultr-prune-');
const backend = join(root, 'state');
const cloudFile = join(root, 'cloud.json');
const projectDir = join(root, 'project');
const stackFile = (stack: string) => join(backend, '.pulumi/stacks', PROJECT, `${stack}.json`);
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fakecloud');
const opts = { projectName: PROJECT, projectDir, provider: 'vultr', providerToken: 'tok' };

class FakeVpc extends pulumi.CustomResource {
  constructor(name: string, args: { name: string }) {
    super('fakecloud:index:Vpc', name, args, {});
  }
}

/** A cluster's network, as every k8s program makes it first. */
const program = (stack: string) => async () => {
  const vpc = new FakeVpc('network', { name: `${PROJECT}-${stack}-network` });
  return { vpcId: vpc.id };
};

/**
 * Deploy `stack`, then list in its state a Vultr instance the cloud does not
 * hold, on the stack's own provider: what a destroy finds after the instance
 * was deleted outside Pulumi.
 */
async function deployWithGoneInstance(stack: string) {
  await upStack(stack, program(stack), opts);
  const saved = JSON.parse(readFileSync(stackFile(stack), 'utf8'));
  const latest = saved.checkpoint.latest;
  const vpc = latest.resources.find((r: { type: string }) => r.type === 'fakecloud:index:Vpc');
  latest.resources.push({
    urn: `urn:pulumi:${stack}::${PROJECT}::${INSTANCE}::master`,
    custom: true,
    id: GONE_ID,
    type: INSTANCE,
    inputs: { label: `${PROJECT}-${stack}-master` },
    outputs: { label: `${PROJECT}-${stack}-master` },
    parent: vpc.parent,
    provider: vpc.provider,
    dependencies: [vpc.urn],
  });
  writeFileSync(stackFile(stack), JSON.stringify(saved));
}

/** Vultr answers GET /instances/<GONE_ID> with `status` and `body`. */
function vultrAnswers(status: number, body: string) {
  fetchWithRetryMock.mockImplementation(async (url: string) => {
    expect(new URL(url).pathname).toBe(`/v2/instances/${GONE_ID}`);
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  });
}

describe.runIf(hasPulumi || process.env.CI)('a Vultr instance gone from the cloud', () => {
  beforeAll(() => {
    mkdirSync(backend);
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, '.vibecarbon.json'), '{}\n');
    writeFileSync(cloudFile, JSON.stringify({ next: 1, servers: {} }));
  });
  afterAll(() => {
    cleanupTempDir(root);
  });
  // Each test, not once: tests/setup/global-setup.ts resets process.env after
  // every test, and the iac layer hands its workspaces process.env.
  beforeEach(() => {
    expect(hasPulumi, 'CI must install the pulumi CLI (test.yml integration job)').toBe(true);
    process.env.PULUMI_BACKEND_URL = `file://${backend}`;
    process.env.FAKECLOUD_FILE = cloudFile;
    process.env.PATH = `${PLUGIN_DIR}:${process.env.PATH}`;
    process.env.VIBECARBON_STATE_PASSPHRASE = PASSPHRASE;
    __resetStatePassphraseForTests();
    __resetStateProbesForTests();
    fetchWithRetryMock.mockReset();
    logged.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('control: left in state, the refresh fails naming it, and the destroy fails on it', async () => {
    await deployWithGoneInstance('c1');
    // Not Vultr's not-found for the instance: the prune leaves it.
    vultrAnswers(503, '{"error":"Service Unavailable"}');

    const error = await destroyStack('c1', program('c1'), opts).then(
      () => null,
      (e) => e,
    );

    const warning = logged.find((l) => l.startsWith('[pulumi] pre-destroy refresh warning:'));
    expect(warning, logged.join('\n')).toBeDefined();
    expect(warning).toContain('vultr:index:Instance (master): ');
    expect(warning).toContain(
      `error getting instance (${GONE_ID}): {"error":"instance not found","status":404}`,
    );
    expect(warning).not.toMatch(/warning: error: update failed$/);
    expect(error, 'the destroy fails on the gone instance').toBeInstanceOf(Error);
    expect(
      JSON.parse(readFileSync(stackFile('c1'), 'utf8')).checkpoint.latest.resources.map(
        (r: { type: string }) => r.type,
      ),
    ).toContain(INSTANCE);
  });

  it("pruned on Vultr's measured 404: the refresh and the destroy succeed, and it is counted", async () => {
    await deployWithGoneInstance('f1');
    vultrAnswers(404, '{"error":"instance not found","status":404}');

    const result = await destroyStack('f1', program('f1'), opts);

    expect(logged).toContain(
      `[pulumi] took the instance master (id ${GONE_ID}) out of f1's state: Vultr says it's gone ("instance not found"), and the refresh would fail on it instead of dropping it`,
    );
    expect(logged.filter((l) => l.includes('refresh warning'))).toEqual([]);
    // The VPC and its provider deleted, the instance taken out: all three counted.
    expect(result).toEqual({ destroyed: true, resourceCount: 3 });
  });
});
