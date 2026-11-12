/**
 * Engine-level proof of the retired-resource surgery (lib/iac/retired-resources.js).
 *
 * DigitalOcean k8s clusters made before 2026-11 hold a reserved IP assigned to
 * the master; today's program declares neither. Left in state, the next `up`
 * deletes the assignment (cutting the address off while the domain may still
 * point at it) and the IP. The surgery takes both out of the deployment with
 * exportStack/importStack before any up or preview, so Pulumi never touches
 * them and the address stays assigned and serving.
 *
 * Real Pulumi engine, a file:// backend in a tmp dir, and the fake cloud
 * (fakecloud/), whose ReservedIpAssignment records on its IP which server it
 * is assigned to, so the test can see whether Pulumi ever unassigned it.
 *
 *   - control: without the surgery, the new program's plan deletes both;
 *   - a removal that leaves references dangling is refused by the import
 *     (so the import really verifies, and the reference cleanup is
 *     load-bearing);
 *   - with it: the import is accepted, refresh + plan create, replace and
 *     delete nothing, the up leaves the cloud as it was (the IP still
 *     assigned to the master), and a second surgery is a no-op;
 *   - a child parented to the removed IP moves to the IP's parent and the
 *     import accepts that too;
 *   - k8s-ha with the address on the environment's own record, which names
 *     both side stacks, through the deploy's own drop
 *     (createDeployDropRetired): one side lets go of it and the other cannot
 *     (its state is locked by another run, which the drop's lock handling
 *     refuses). Nothing is released, the address stays on record and
 *     assigned, and both stacks still destroy;
 *   - a warm redeploy (no up, so the stack still lists the IP and its
 *     assignment): the deploy's release takes them out of the stack before
 *     it releases the address, and destroy then succeeds. The control
 *     releases the address with the stack still listing it, and destroy
 *     fails on the assignment's 404, as it would forever.
 *
 * Skipped locally where no pulumi CLI is installed. Under CI it runs: the
 * integration job installs the CLI pinned to the SDK version, and a missing
 * CLI there fails this test instead of skipping it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pulumi from '@pulumi/pulumi';
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDeployDropRetired,
  releaseRetiredReservedIps,
} from '../../../src/lib/deploy/k8s/retired-reserved-ip.js';
import { dropStackResources } from '../../../src/lib/iac/retired-resources.js';
import { makeWorkspaceDir } from '../../../src/lib/iac/workspace-dir.js';

// The fake cloud as a provider, for the deploy's own drop: its retired
// resources are the fake cloud's reserved IP and assignment, as DigitalOcean's
// are its own (RETIRED_STACK_RESOURCES). Every other id is the real provider.
vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = await orig<typeof import('../../../src/lib/providers/index.js')>();
  const FakeCloud = {
    NAME: 'FakeCloud',
    IAC_STACK_CONFIG: {},
    RETIRED_STACK_RESOURCES: [
      { type: 'fakecloud:index:ReservedIp', name: 'ingress' },
      { type: 'fakecloud:index:ReservedIpAssignment', name: 'ingress-assignment' },
    ],
  };
  return {
    ...real,
    getProviderClass: (id: string) =>
      id === 'fakecloud' ? FakeCloud : real.getProviderClass(id as never),
  };
});

// The surgery's progress line ([pulumi] took ... out of ...'s state) and the
// state telemetry go to the progress log; kept here, off the test output.
const progress: string[] = [];
vi.mock('../../../src/lib/cli/progress.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/cli/progress.js')>()),
  progressLog: (line: string) => progress.push(line),
}));

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(join(tmpdir(), 'vc-retired-'));
const cloudFile = join(dir, 'cloud.json');
const backend = join(dir, 'state');
mkdirSync(backend);
// The stacks' passphrase: the deploy's own drop opens them through
// getOrCreateStack, which reads it from the environment and checks it
// against the fingerprint it records in this dir's .vibecarbon.json.
const PASSPHRASE = 'retired-surgery-integration-passphrase-0123456789';
// Every test starts its own stack in one fake cloud, in any order or alone.
beforeAll(() => {
  writeFileSync(cloudFile, JSON.stringify({ next: 1, servers: {} }));
  writeFileSync(join(dir, '.vibecarbon.json'), '{}\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Thing = Record<string, unknown> & { assignedTo?: string | null };
type Cloud = {
  next: number;
  servers: Record<string, unknown>;
  things?: Record<string, Record<string, Thing>>;
};
const readCloud = (): Cloud => JSON.parse(readFileSync(cloudFile, 'utf-8'));

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fakecloud');

/** The fake cloud's types, standing in for DigitalOcean's. */
const RETIRED = [
  { type: 'fakecloud:index:ReservedIp', name: 'ingress' },
  { type: 'fakecloud:index:ReservedIpAssignment', name: 'ingress-assignment' },
] as const;

class FakeServer extends pulumi.CustomResource {
  constructor(
    name: string,
    args: { size: string; userData: string },
    opts?: pulumi.CustomResourceOptions,
  ) {
    super('fakecloud:index:Server', name, { ...args, ip: undefined }, opts);
  }
}
class FakeReservedIp extends pulumi.CustomResource {
  declare readonly ipAddress: pulumi.Output<string>;
  constructor(name: string, args: { region: string }, opts?: pulumi.CustomResourceOptions) {
    super('fakecloud:index:ReservedIp', name, { ...args, ipAddress: undefined }, opts);
  }
}
class FakeAssignment extends pulumi.CustomResource {
  constructor(
    name: string,
    args: { ipAddress: pulumi.Input<string>; serverId: pulumi.Input<string> },
  ) {
    super('fakecloud:index:ReservedIpAssignment', name, args, {});
  }
}
class FakeNote extends pulumi.CustomResource {
  constructor(
    name: string,
    args: { note: pulumi.Input<string> },
    opts?: pulumi.CustomResourceOptions,
  ) {
    super('fakecloud:index:Note', name, args, opts);
  }
}

/**
 * The program before 2026-11: a master, a reserved IP assigned to it, a db
 * that waits on the assignment (dependencies) and a note that reads the
 * address (propertyDependencies). `withChild` adds a resource parented to the
 * reserved IP.
 */
const oldProgram =
  (withChild = false) =>
  async () => {
    const master = new FakeServer('master', { size: 's', userData: '#cloud-config\n' });
    const ip = new FakeReservedIp('ingress', { region: 'nyc3' });
    const assignment = new FakeAssignment('ingress-assignment', {
      ipAddress: ip.ipAddress,
      serverId: master.id,
    });
    new FakeServer('db', { size: 's', userData: '#db\n' }, { dependsOn: [assignment] });
    new FakeNote('ingress-note', { note: ip.ipAddress });
    if (withChild) new FakeNote('ip-child', { note: 'child' }, { parent: ip });
    return { masterId: master.id, floatingIp: ip.ipAddress };
  };

/** Today's program: no reserved IP. The note keeps the address as a literal. */
const newProgram = (address: string) => async () => {
  const master = new FakeServer('master', { size: 's', userData: '#cloud-config\n' });
  new FakeServer('db', { size: 's', userData: '#db\n' });
  new FakeNote('ingress-note', { note: address });
  return { masterId: master.id };
};

async function stackFor(name: string, program: () => Promise<Record<string, unknown>>) {
  return LocalWorkspace.createOrSelectStack(
    { stackName: name, projectName: 'vcretired', program },
    {
      // Removed after this file by the test setup, as the CLI's are at exit.
      workDir: makeWorkspaceDir(),
      projectSettings: {
        name: 'vcretired',
        runtime: 'nodejs',
        backend: { url: `file://${backend}` },
      },
      envVars: {
        PULUMI_CONFIG_PASSPHRASE: PASSPHRASE,
        PULUMI_SKIP_UPDATE_CHECK: 'true',
        FAKECLOUD_FILE: cloudFile,
        PATH: `${PLUGIN_DIR}:${process.env.PATH}`,
      },
    },
  );
}

/** A deploy's sequence after the surgery: refresh, then the plan `up` would run. */
async function plan(stack: Awaited<ReturnType<typeof stackFor>>) {
  await stack.refresh();
  const preview = await stack.preview();
  return preview.changeSummary as Record<string, number>;
}

const ipOf = (stackOutputs: Record<string, { value: unknown }>) =>
  String(stackOutputs.floatingIp.value);

/**
 * DigitalOcean's DELETE /v2/reserved_ips/{address} and the read that proves
 * it: the address leaves the account, and is released once it is not listed.
 */
function releaseByAddress(address: string) {
  const cloud = readCloud();
  delete cloud.things?.['fakecloud:index:ReservedIp'][address];
  writeFileSync(cloudFile, JSON.stringify(cloud));
  const listed = Boolean(readCloud().things?.['fakecloud:index:ReservedIp'][address]);
  return listed
    ? { released: false, held: true, region: null, reason: 'still listed' }
    : { released: true };
}

const DOMAIN = 'app.example.test';
const MASTER = '10.0.0.1';
/** DNS has moved: every name answers the master, long past its TTL. */
const moved = async () => ({
  ok: true,
  zone: 'example.test',
  answers: [DOMAIN, `*.${DOMAIN}`].map((name) => ({
    name,
    server: '192.0.2.1',
    host: 'ns1.example.test',
    addresses: [MASTER],
    ttl: 60,
  })),
});

/** The deploy's release, on a warm redeploy's record, with `dropRetired` as given. */
async function releaseOnWarmRedeploy(
  stackName: string,
  address: string,
  dropRetired: (stack: string) => Promise<unknown>,
) {
  const config = { environments: { [stackName]: { floatingIp: address, ingressIp: MASTER } } };
  return releaseRetiredReservedIps({
    environment: stackName,
    Provider: { K8S_FLOATING_IP: false, NAME: 'DigitalOcean' },
    provider: { deleteReservedIpByAddress: async (a: string) => releaseByAddress(a) },
    log: { info: () => {}, warn: () => {} },
    domain: DOMAIN,
    dnsWrite: { target: MASTER, changedAt: Date.now() - 3_600_000 },
    newAddress: MASTER,
    dropRetired,
    zoneRecordsAt: async () => [],
    lookup: moved as never,
    readConfig: () => config,
    updateConfig: (fn: (c: typeof config) => void) => fn(config),
  });
}

describe.skipIf(!hasPulumi && !process.env.CI)(
  'retired reserved IP leaves the stack, never deleted (real engine, fake cloud)',
  () => {
    it('control: without the surgery, the current program deletes the IP and its assignment', async () => {
      expect(hasPulumi, 'CI must install the pulumi CLI (test.yml integration job)').toBe(true);

      const stack = await stackFor('control', oldProgram());
      const address = ipOf((await stack.up()).outputs);
      const summary = await plan(await stackFor('control', newProgram(address)));
      expect(summary.delete).toBe(2);
    });

    it('a removal that leaves references dangling is refused by the import', async () => {
      const stack = await stackFor('dangling', oldProgram());
      await stack.up();
      const state = await stack.exportStack();
      const naive = structuredClone(state);
      naive.deployment.resources = naive.deployment.resources.filter(
        (r: { type: string }) =>
          r.type !== 'fakecloud:index:ReservedIp' &&
          r.type !== 'fakecloud:index:ReservedIpAssignment',
      );
      // `pulumi stack import` checks the snapshot's integrity: the note's
      // dependency on the IP now names a resource the state no longer holds.
      await expect(stack.importStack(naive)).rejects.toThrow(/refers to missing resource/);
    });

    it('with the surgery: import accepted, nothing deleted, the IP stays assigned, idempotent', async () => {
      const stack = await stackFor('prod', oldProgram());
      const up = await stack.up();
      const address = ipOf(up.outputs);
      const masterId = String(up.outputs.masterId.value);
      expect(readCloud().things?.['fakecloud:index:ReservedIp'][address].assignedTo).toBe(masterId);

      const { deployment, removed } = dropStackResources(await stack.exportStack(), RETIRED);
      expect(removed.map((urn) => urn.split('::').pop()).sort()).toEqual([
        'ingress',
        'ingress-assignment',
      ]);
      await stack.importStack(deployment);

      // References to the removed URNs are gone from what the engine holds.
      const held = JSON.stringify((await stack.exportStack()).deployment);
      for (const urn of removed) expect(held).not.toContain(urn);

      const current = await stackFor('prod', newProgram(address));
      const summary = await plan(current);
      expect(summary.delete ?? 0).toBe(0);
      expect(summary.create ?? 0).toBe(0);
      expect(summary.replace ?? 0).toBe(0);

      await current.up();
      const ipAfter = readCloud().things?.['fakecloud:index:ReservedIp'][address];
      expect(ipAfter, 'the reserved IP still exists').toBeDefined();
      expect(ipAfter?.assignedTo, 'and is still assigned to the master').toBe(masterId);

      // Idempotent: a second surgery finds nothing to remove and changes nothing.
      const again = dropStackResources(await current.exportStack(), RETIRED);
      expect(again.removed).toEqual([]);
    });

    it('control: an address released while the stack lists it fails destroy on the 404', async () => {
      const stack = await stackFor('warm-control', oldProgram());
      const address = ipOf((await stack.up()).outputs);
      // What the release did before it dropped the stack's hold first.
      releaseByAddress(address);
      const current = await stackFor('warm-control', newProgram(address));
      await expect(current.destroy()).rejects.toThrow(/404/);
    });

    it('warm redeploy: the release takes the address out of the stack first, and destroy succeeds', async () => {
      const stack = await stackFor('warm', oldProgram());
      const address = ipOf((await stack.up()).outputs);
      // A warm redeploy runs no up: the stack still lists the IP and its assignment.
      const held = JSON.stringify((await stack.exportStack()).deployment);
      expect(held).toContain('::ingress-assignment');

      const dropRetired = async (stackName: string) => {
        const s = await stackFor(stackName, newProgram(address));
        const { deployment, removed } = dropStackResources(await s.exportStack(), RETIRED);
        if (removed.length > 0) await s.importStack(deployment);
      };
      const out = await releaseOnWarmRedeploy('warm', address, dropRetired);
      expect(out).toEqual({ released: [address], kept: [] });
      expect(readCloud().things?.['fakecloud:index:ReservedIp'][address]).toBeUndefined();

      const current = await stackFor('warm', newProgram(address));
      await current.refresh();
      await current.destroy();
      const after = JSON.stringify((await current.exportStack()).deployment ?? {});
      expect(after).not.toContain('::master');
    });

    it('k8s-ha: one side lets go and the other cannot, so nothing is released and both stacks still destroy', async () => {
      const primaryUp = await (await stackFor('mix-primary', oldProgram())).up();
      const standbyUp = await (await stackFor('mix-standby', oldProgram())).up();
      const address = ipOf(primaryUp.outputs);
      const standbyAddress = ipOf(standbyUp.outputs);
      const masterId = String(primaryUp.outputs.masterId.value);

      // The address is on the environment's own record, so it could be either
      // side's: both side stacks are asked to let go of it, primary first.
      const config = {
        environments: {
          mix: {
            floatingIp: address,
            ingressIp: MASTER,
            ha: { primary: { stack: 'mix-primary' }, standby: { stack: 'mix-standby' } },
          },
        },
      };
      const updateConfig = (fn: (c: typeof config) => void) => fn(config);
      // Another run holds the standby's state: its import is refused.
      const standbyLocks = join(backend, '.pulumi/locks/organization/vcretired/mix-standby');
      mkdirSync(standbyLocks, { recursive: true });
      writeFileSync(
        join(standbyLocks, '11111111-2222-3333-4444-555555555555.json'),
        JSON.stringify({
          pid: 4194000,
          username: 'someone',
          hostname: 'another-laptop',
          timestamp: new Date().toISOString(),
        }),
      );

      // The deploy's own drop (createDeployDropRetired): the stack opened
      // through getOrCreateStack (requireExisting) on this backend, and the
      // surgery and lock handling every up runs (dropRetiredStackResources),
      // on the fake cloud's retired types (the providers mock above).
      process.env.PULUMI_BACKEND_URL = `file://${backend}`;
      process.env.VIBECARBON_STATE_PASSPHRASE = PASSPHRASE;
      const dropRetired = createDeployDropRetired({
        environment: 'mix',
        providerId: 'fakecloud',
        providerToken: '',
        s3Config: null,
        projectName: 'vcretired',
        projectDir: dir,
        updateConfig: updateConfig as never,
      });
      const deletes: string[] = [];
      const out = await releaseRetiredReservedIps({
        environment: 'mix',
        Provider: { K8S_FLOATING_IP: false, NAME: 'DigitalOcean' },
        provider: {
          deleteReservedIpByAddress: async (a: string) => {
            deletes.push(a);
            return releaseByAddress(a);
          },
        },
        log: { info: () => {}, warn: () => {} },
        domain: DOMAIN,
        dnsWrite: { target: MASTER, changedAt: Date.now() - 3_600_000 },
        newAddress: MASTER,
        dropRetired,
        zoneRecordsAt: async () => [],
        lookup: moved as never,
        readConfig: () => config,
        updateConfig: updateConfig as never,
      });

      // Nothing released: no DELETE, the address on record and still assigned.
      expect(out.released).toEqual([]);
      expect(out.kept).toEqual([{ address, reason: expect.stringContaining('stack mix-standby') }]);
      // The production lock handling refused it as held by the other run
      // (StackHeldError), and left that run's lock where it was.
      expect(out.kept[0].reason).toMatch(/is in use by another run: someone@another-laptop/);
      expect(readdirSync(standbyLocks)).toHaveLength(1);
      // The primary's surgery recorded the address on its own side, and said
      // what it took out.
      expect(config.environments.mix.ha.primary).toEqual({
        stack: 'mix-primary',
        floatingIp: address,
      });
      expect(progress).toContainEqual(
        expect.stringContaining("took ingress and ingress-assignment out of mix-primary's state"),
      );
      expect(deletes).toEqual([]);
      expect(config.environments.mix.floatingIp).toBe(address);
      expect(readCloud().things?.['fakecloud:index:ReservedIp'][address]?.assignedTo).toBe(
        masterId,
      );
      // The primary let go of its IP; the standby still lists its own.
      const primaryHeld = JSON.stringify(
        (await stackFor('mix-primary', newProgram(address)).then((st) => st.exportStack()))
          .deployment,
      );
      expect(primaryHeld).not.toContain('::ingress-assignment');
      const standbyHeld = JSON.stringify(
        (await stackFor('mix-standby', newProgram(address)).then((st) => st.exportStack()))
          .deployment,
      );
      expect(standbyHeld).toContain('::ingress-assignment');

      // Once the other run is done, both stacks destroy.
      rmSync(standbyLocks, { recursive: true, force: true });
      for (const [name, held] of [
        ['mix-primary', address],
        ['mix-standby', standbyAddress],
      ] as const) {
        const current = await stackFor(name, newProgram(held));
        await current.refresh();
        await current.destroy();
        const after = JSON.stringify((await current.exportStack()).deployment ?? {});
        expect(after, `${name} destroyed`).not.toContain('::master');
      }
      // The primary's address outlived both stacks, still on record: destroy's
      // reserved-IP backstop releases it by that record.
      expect(readCloud().things?.['fakecloud:index:ReservedIp'][address]).toBeDefined();
      expect(readCloud().things?.['fakecloud:index:ReservedIp'][standbyAddress]).toBeUndefined();
    });

    it('a child of the removed IP moves to its parent, and the import accepts it', async () => {
      const stack = await stackFor('child', oldProgram(true));
      await stack.up();
      const state = await stack.exportStack();
      const stackUrn = state.deployment.resources.find(
        (r: { type: string }) => r.type === 'pulumi:pulumi:Stack',
      ).urn;
      const { deployment } = dropStackResources(state, RETIRED);
      const child = deployment.deployment.resources.find((r: { urn: string }) =>
        r.urn.endsWith('::ip-child'),
      );
      expect(child.parent).toBe(stackUrn);
      await stack.importStack(deployment);
    });
  },
);
