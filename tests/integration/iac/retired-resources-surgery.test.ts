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
 *     import accepts that too.
 *
 * Skipped locally where no pulumi CLI is installed. Under CI it runs: the
 * integration job installs the CLI pinned to the SDK version, and a missing
 * CLI there fails this test instead of skipping it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pulumi from '@pulumi/pulumi';
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropStackResources } from '../../../src/lib/iac/retired-resources.js';

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
// Every test starts its own stack in one fake cloud, in any order or alone.
beforeAll(() => writeFileSync(cloudFile, JSON.stringify({ next: 1, servers: {} })));
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
      projectSettings: {
        name: 'vcretired',
        runtime: 'nodejs',
        backend: { url: `file://${backend}` },
      },
      envVars: {
        PULUMI_CONFIG_PASSPHRASE: 'test',
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
