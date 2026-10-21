/**
 * Preview-level proof that Pulumi state follows a compose scale (Task 7b).
 *
 * Real Pulumi engine, a file:// backend in a tmp dir, and a fake cloud: a
 * resource plugin over a JSON file (fakecloud/) that behaves like the bridged providers
 * where it matters. Its Read returns nothing for a server that is gone and
 * keeps the last known inputs it cannot read back (user data); a changed user
 * data replaces the server, a changed size updates it in place.
 *
 * The scale is simulated the way compose scale does it, outside Pulumi: a new
 * server appears in the cloud, the old one is deleted. Then the deploy's own
 * sequence runs (refresh, then preview of `up`):
 *   - without the sync, the plan creates a server (the bug);
 *   - after retargetServerResource, the plan creates, replaces and deletes
 *     nothing, and the server resource is `same`.
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
import { afterAll, describe, expect, it } from 'vitest';
import { retargetServerResource } from '../../../src/lib/iac/server-state.js';

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(join(tmpdir(), 'vc-server-state-'));
const cloudFile = join(dir, 'cloud.json');
const backend = join(dir, 'state');
mkdirSync(backend);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Cloud = { next: number; servers: Record<string, { size: string; ip: string }> };
const readCloud = (): Cloud => JSON.parse(readFileSync(cloudFile, 'utf-8'));
const writeCloud = (c: Cloud) => writeFileSync(cloudFile, JSON.stringify(c));

// The fake cloud's resource plugin, found on PATH (fakecloud/provider.mjs).
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fakecloud');

class FakeServer extends pulumi.CustomResource {
  declare readonly ip: pulumi.Output<string>;
  constructor(name: string, args: { size: string; userData: string }) {
    super('fakecloud:index:Server', name, { ...args, ip: undefined }, {});
  }
}

const program = (size: string) => async () => {
  const server = new FakeServer('server', { size, userData: '#cloud-config\n' });
  return { serverId: server.id, serverIp: server.ip };
};

const SPEC = { type: 'fakecloud:index:Server', sizeKey: 'size', ipKey: 'ip' };

async function stackFor(name: string, size: string) {
  return LocalWorkspace.createOrSelectStack(
    { stackName: name, projectName: 'vcstate', program: program(size) },
    {
      projectSettings: {
        name: 'vcstate',
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

/** Compose scale, outside Pulumi: a new server of `size`, the old one deleted. */
function scaleOutsidePulumi(oldId: string, size: string) {
  const c = readCloud();
  const id = String(c.next++);
  c.servers[id] = { size, ip: `10.0.0.${id}` };
  delete c.servers[oldId];
  writeCloud(c);
  return { serverId: id, ip: c.servers[id].ip, serverType: size };
}

/** The deploy's sequence: refresh, then the plan `up` would run. */
async function deployPlan(stack: Awaited<ReturnType<typeof stackFor>>) {
  await stack.refresh();
  const preview = await stack.preview();
  return preview.changeSummary as Record<string, number>;
}

describe.skipIf(!hasPulumi && !process.env.CI)(
  'Pulumi state follows a compose scale (real engine, fake cloud)',
  () => {
    it('without the sync the next deploy plans a new server; after it, no server is created, replaced or deleted', async () => {
      expect(hasPulumi, 'CI must install the pulumi CLI (test.yml integration job)').toBe(true);
      writeCloud({ next: 1, servers: {} });

      // The bug, as a control.
      const control = await stackFor('control', 'small');
      const first = await control.up();
      const controlOld = String(first.outputs.serverId.value);
      scaleOutsidePulumi(controlOld, 'big');
      const unsynced = await deployPlan(await stackFor('control', 'big'));
      expect(unsynced.create).toBe(1);

      // The fix.
      const live = await stackFor('prod', 'small');
      const up = await live.up();
      const oldId = String(up.outputs.serverId.value);
      const target = scaleOutsidePulumi(oldId, 'big');
      const { deployment, changed } = retargetServerResource(
        await live.exportStack(),
        SPEC,
        target,
        'prod',
      );
      expect(changed).toBe(true);
      await live.importStack(deployment);

      // The program reads the scaled size from config: 'big'.
      const synced = await deployPlan(await stackFor('prod', 'big'));
      expect(synced.create ?? 0).toBe(0);
      expect(synced.replace ?? 0).toBe(0);
      expect(synced.delete ?? 0).toBe(0);
      expect(synced.update ?? 0).toBe(0);
      expect(synced.same).toBeGreaterThanOrEqual(2);

      // The refreshed state names the live replacement.
      const after = await live.exportStack();
      const server = after.deployment.resources.find((r: { urn: string }) =>
        r.urn.endsWith('::server'),
      );
      expect(server.id).toBe(target.serverId);
      expect(server.outputs.ip).toBe(target.ip);
      expect(server.inputs.userData).toBe('#cloud-config\n');
    });
  },
);
