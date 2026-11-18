/**
 * `destroy` finishes a stack whose `pulumi destroy` failed on something the
 * sweeps then removed, on the real Pulumi engine (file:// backend) and the
 * fake cloud (fakecloud/).
 *
 * Evidence (DigitalOcean k8s-ha, e2e run of 2026-11-15, stack `cid4-standby`):
 * a deploy was interrupted while a droplet was being created. The droplet
 * existed, and the stack held only the unfinished create. `pulumi destroy`
 * deleted the firewall, then failed on the VPC: `409 Can not delete VPC with
 * members`. The orphaned-server sweep deleted the droplet and the backstop
 * deleted the VPC, so the provider was clean, but the stack file, its
 * `.json.bak` and its history stayed in the state bucket, still listing the
 * VPC and the unfinished create. Destroy reported the VPC UNVERIFIED and
 * exited 2.
 *
 * The same sequence here, with the fake cloud's Vpc refusing its delete while
 * it has a member no stack records:
 *   - the sweeps removed the member and the VPC: the one second pass
 *     (settleFailedStackDestroys) refreshes the VPC away, destroys what is
 *     left and removes the stack's state, unfinished create included, and
 *     nothing is reported;
 *   - the sweeps removed something, but the VPC still has its member: the
 *     second pass fails the same way, once, and the report and the state
 *     stay;
 *   - the sweeps removed nothing of the stack: no second pass at all.
 *
 * Skipped locally where no pulumi CLI is installed. Under CI the integration
 * job installs it, and a missing CLI fails this test instead of skipping it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import * as pulumi from '@pulumi/pulumi';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordPulumiDestroyFailure, settleFailedStackDestroys } from '../../../src/destroy.js';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { __resetStateProbesForTests, destroyStack, upStack } from '../../../src/lib/iac/index.js';
import { __resetStatePassphraseForTests } from '../../../src/lib/state-passphrase.js';
import { pulumiOnPath } from '../../_shared/pulumi-cli.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';

const hasPulumi = pulumiOnPath();

const PROJECT = 'finishtest';
const PASSPHRASE = 'ZmluaXNoZmluaXNoZmluaXNoZmluaXNoZmluaXNoZmlu';
const VPC = 'fakecloud:index:Vpc';
const REFUSAL = '409 Can not delete VPC with members';

const root = createTempDir('vc-destroy-finish-');
const backend = join(root, 'state');
const cloudFile = join(root, 'cloud.json');
const projectDir = join(root, 'project');
const stackFile = (stack: string) => join(backend, '.pulumi/stacks', PROJECT, `${stack}.json`);
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fakecloud');
const opts = { projectName: PROJECT, projectDir };

class FakeVpc extends pulumi.CustomResource {
  constructor(name: string, args: { name: string }) {
    super(VPC, name, args, {});
  }
}
class FakeFirewall extends pulumi.CustomResource {
  constructor(name: string, args: { name: string }, opts: pulumi.CustomResourceOptions) {
    super('fakecloud:index:Firewall', name, args, opts);
  }
}

/** A cluster's network and firewall, as every k8s program makes them first. */
const program = (stack: string) => async () => {
  const vpc = new FakeVpc('network', { name: `${PROJECT}-${stack}-network` });
  new FakeFirewall('firewall', { name: `${PROJECT}-${stack}-firewall` }, { dependsOn: [vpc] });
  return { vpcId: vpc.id };
};

type Cloud = {
  things: Record<string, Record<string, unknown>>;
  members?: Record<string, string[]>;
};
const readCloud = (): Cloud => JSON.parse(readFileSync(cloudFile, 'utf8'));
const writeCloud = (cloud: Cloud) => writeFileSync(cloudFile, JSON.stringify(cloud));
const latest = (stack: string) =>
  JSON.parse(readFileSync(stackFile(stack), 'utf8')).checkpoint.latest;

/** Every file under the backend that belongs to `stack`, relative to it. */
function filesOf(stack: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  return walk(backend)
    .map((f) => f.slice(backend.length + 1))
    .filter((f) => f.split('/').includes(stack) || f.includes(`/${stack}.`))
    .sort();
}

/**
 * A deployed stack as the interrupted deploy left it: the VPC and firewall
 * recorded, a droplet running in the VPC that no stack records, and only the
 * droplet's unfinished create in the state. Returns the VPC's id.
 */
async function interruptedDeploy(stack: string): Promise<string> {
  await upStack(stack, program(stack), opts);
  // A second update is what makes Pulumi keep a previous copy (.json.bak).
  await upStack(stack, program(stack), opts);

  const saved = JSON.parse(readFileSync(stackFile(stack), 'utf8'));
  const state = saved.checkpoint.latest;
  const vpc = state.resources.find((r: { type: string }) => r.type === VPC);
  state.pending_operations = [
    {
      type: 'creating',
      resource: {
        urn: vpc.urn.replace(`${VPC}::network`, 'fakecloud:index:Server::master'),
        custom: true,
        type: 'fakecloud:index:Server',
        inputs: { name: `${PROJECT}-${stack}-master`, size: 'small' },
        parent: vpc.parent,
        provider: vpc.provider,
      },
    },
  ];
  writeFileSync(stackFile(stack), JSON.stringify(saved));

  const cloud = readCloud();
  cloud.members = { ...cloud.members, [vpc.id]: [`${PROJECT}-${stack}-master`] };
  writeCloud(cloud);
  return vpc.id;
}

/** The orphaned-server sweep: the droplet no stack records is deleted. */
function sweepDeletesDroplet(vpcId: string) {
  const cloud = readCloud();
  delete cloud.members?.[vpcId];
  writeCloud(cloud);
}
/** The backstop's VPC delete, by name through the provider's API. */
function backstopDeletesVpc(vpcId: string) {
  const cloud = readCloud();
  delete cloud.things[VPC][vpcId];
  writeCloud(cloud);
}

const newResults = () => ({ leaks: createLeakLedger(), pulumiDestroyFailed: false });

describe.runIf(hasPulumi || process.env.CI)(
  'a stack whose destroy failed, after the sweeps',
  () => {
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
      // The destroy's own narration, off the test output.
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** The first `pulumi destroy`, which the member makes fail on the VPC. */
    async function firstDestroyFails(stack: string) {
      const error = await destroyStack(stack, program(stack), opts).then(
        () => null,
        (e) => e,
      );
      expect(error, 'the first destroy fails').toBeInstanceOf(Error);
      // The firewall went; the VPC stays, with the provider's own refusal.
      expect(error.remainingResources.map((r: { type: string }) => r.type)).toEqual([VPC]);
      expect(error.remainingResources[0].error).toContain(REFUSAL);
      // Neither the refresh nor the failed destroy dropped the unfinished create.
      expect(latest(stack).pending_operations).toHaveLength(1);
      return error;
    }

    const settle = (
      stack: string,
      error: Error,
      swept: string[],
      results: ReturnType<typeof newResults>,
    ) => {
      const destroyAgain = vi.fn((stackEnv: string) =>
        destroyStack(stackEnv, program(stackEnv), opts),
      );
      return settleFailedStackDestroys({
        stacks: [{ stackEnv: stack, dirLabel: '', error }],
        sweptStacks: new Set(swept),
        destroyAgain,
        environment: stack,
        args: {},
        results,
        providerName: 'FakeCloud',
      }).then(() => destroyAgain);
    };

    it('the sweeps removed what blocked it: one more pass removes the stack, its backup and the unfinished create, and nothing is reported', async () => {
      const vpcId = await interruptedDeploy('s1');
      const error = await firstDestroyFails('s1');

      // What destroy reported before it finished the stack itself.
      const before = newResults();
      recordPulumiDestroyFailure({
        error,
        stackEnv: 's1',
        dirLabel: '',
        environment: 's1',
        results: before,
        providerName: 'FakeCloud',
      });
      expect(before.leaks.exitCode()).toBe(2);
      expect(existsSync(`${stackFile('s1')}.bak`)).toBe(true);

      sweepDeletesDroplet(vpcId);
      backstopDeletesVpc(vpcId);

      const results = newResults();
      const destroyAgain = await settle('s1', error, ['s1'], results);

      expect(destroyAgain).toHaveBeenCalledTimes(1);
      expect(existsSync(stackFile('s1'))).toBe(false);
      expect(existsSync(`${stackFile('s1')}.bak`)).toBe(false);
      expect(filesOf('s1')).toEqual([]);
      expect(results.leaks.entries).toEqual([]);
      expect(results.leaks.exitCode()).toBe(0);
      expect(results.pulumiDestroyFailed).toBe(false);
    });

    it('the second pass fails too: it ran once, the VPC is still reported and the state stays', async () => {
      await interruptedDeploy('s2');
      const error = await firstDestroyFails('s2');

      // A sweep removed something of the stack, but not the VPC's member.
      const results = newResults();
      const destroyAgain = await settle('s2', error, ['s2'], results);

      expect(destroyAgain).toHaveBeenCalledTimes(1);
      expect(results.leaks.entries).toHaveLength(1);
      expect(results.leaks.entries[0]).toMatchObject({ severity: 'unverified' });
      expect(results.leaks.entries[0].reason).toContain('still in Pulumi stack s2');
      expect(results.leaks.entries[0].reason).toContain(REFUSAL);
      expect(results.leaks.exitCode()).toBe(2);
      expect(results.pulumiDestroyFailed).toBe(true);
      expect(existsSync(stackFile('s2'))).toBe(true);
      expect(latest('s2').resources.map((r: { type: string }) => r.type)).toContain(VPC);
    });

    it('the sweeps removed nothing of the stack: no second pass, and the first failure is reported', async () => {
      await interruptedDeploy('s3');
      const error = await firstDestroyFails('s3');

      const results = newResults();
      const destroyAgain = await settle('s3', error, ['another-stack'], results);

      expect(destroyAgain).not.toHaveBeenCalled();
      expect(results.leaks.entries).toHaveLength(1);
      expect(results.leaks.entries[0].reason).toContain(REFUSAL);
      expect(results.leaks.exitCode()).toBe(2);
      expect(results.pulumiDestroyFailed).toBe(true);
      expect(existsSync(stackFile('s3'))).toBe(true);
    });
  },
);
