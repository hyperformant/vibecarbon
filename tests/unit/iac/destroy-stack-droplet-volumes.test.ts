/**
 * `destroyStack` must never hand the DigitalOcean provider a Droplet whose
 * state lists CSI-owned volumes.
 *
 * The failure (DO k8s-ha e2e, 2026-10-31, stack d4-standby): destroy.js's
 * cleanupClusterPVCs deletes the `vibecarbon` namespace, which hands every
 * PersistentVolume to the DO CSI driver to detach and delete. That runs
 * asynchronously. destroyStack's pre-destroy `refresh` then read the db
 * Droplet while CSI volume 4c926666 was still attached, so the Droplet's
 * state gained `volumeIds: ["4c926666-..."]`. A few seconds later CSI deleted
 * the volume. terraform-provider-digitalocean's Droplet Delete detaches every
 * id in STATE before deleting the Droplet, so it POSTed a detach for a volume
 * that no longer existed and failed with 404:
 *
 *   Error detaching the volumes from the droplet (614595377): Error detaching
 *   volume "4c926666-..." from droplet (614595377): POST .../actions: 404
 *
 * Our programs never set `volumeIds`: every volume on a cluster Droplet is
 * CSI-owned, and a Droplet delete detaches its volumes on DO's side anyway.
 * So the fix removes the dependency instead of racing it: after the refresh,
 * the Droplet's state forgets the volume list. These tests reproduce the
 * ordering (refresh sees the volume, CSI then deletes it, destroy runs) with
 * a fake provider that fails exactly the way the real one did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DROPLET = 'digitalocean:index/droplet:Droplet';
const CSI_VOLUME = '4c926666-d563-11f1-b0a0-0a58ac14f33c';

type Resource = {
  type: string;
  urn: string;
  id?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
};

/**
 * A stack whose refresh captures a CSI volume on the db Droplet, and whose
 * destroy behaves like terraform-provider-digitalocean's Droplet Delete: it
 * detaches every volume id the Droplet's STATE lists, and a detach of a
 * volume CSI has already deleted is a 404 that fails the Droplet delete.
 */
function makeRacingStack() {
  let state: { deployment: { resources: Resource[] } } = {
    deployment: {
      resources: [
        { type: 'pulumi:pulumi:Stack', urn: 'urn:pulumi:d4-standby::p::pulumi:pulumi:Stack::p' },
        {
          type: DROPLET,
          urn: `urn:pulumi:d4-standby::p::${DROPLET}::db`,
          id: '614595377',
          inputs: { name: 'p-d4-standby-db' },
          outputs: { name: 'p-d4-standby-db', volumeIds: [] },
        },
        {
          type: DROPLET,
          urn: `urn:pulumi:d4-standby::p::${DROPLET}::master`,
          id: '614595376',
          inputs: { name: 'p-d4-standby-master' },
          outputs: { name: 'p-d4-standby-master', volumeIds: [] },
        },
      ],
    },
  };
  const csiDeleted = new Set<string>();
  const destroyOpts: unknown[] = [];
  const stack = {
    exportStack: vi.fn(async () => structuredClone(state)),
    importStack: vi.fn(async (next: typeof state) => {
      state = structuredClone(next);
    }),
    refresh: vi.fn(async () => {
      // The refresh reads the db Droplet while CSI's detach is still in
      // flight: the volume is attached right now, so it lands in state.
      const db = state.deployment.resources[1];
      db.outputs = { ...db.outputs, volumeIds: [CSI_VOLUME] };
      db.inputs = { ...db.inputs, volumeIds: [CSI_VOLUME] };
      // ...and then the CSI driver finishes: detach, then DeleteVolume.
      csiDeleted.add(CSI_VOLUME);
    }),
    destroy: vi.fn(async (opts: unknown) => {
      destroyOpts.push(opts);
      for (const r of state.deployment.resources) {
        if (r.type !== DROPLET) continue;
        for (const volumeId of (r.outputs?.volumeIds as string[] | undefined) ?? []) {
          if (csiDeleted.has(volumeId)) {
            throw new Error(
              `Error detaching the volumes from the droplet (${r.id}): Error detaching volume "${volumeId}" from droplet (${r.id}): POST https://api.digitalocean.com/v2/volumes/${volumeId}/actions: 404 error detaching volume from droplet: not found`,
            );
          }
        }
      }
      const deleted = state.deployment.resources.filter((r) => r.type !== 'pulumi:pulumi:Stack');
      state = { deployment: { resources: [state.deployment.resources[0]] } };
      return { summary: { result: 'succeeded', resourceChanges: { delete: deleted.length } } };
    }),
    workspace: { removeStack: vi.fn(async () => undefined) },
  };
  return { stack, destroyOpts, getState: () => state };
}

const selectStackMock = vi.fn();

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: () => {
      throw new Error('createStack must not be called: it would clobber real state');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));

describe('destroyStack: a Droplet never carries CSI volume ids into destroy', () => {
  beforeEach(() => {
    selectStackMock.mockReset();
  });

  it('destroys cleanly when CSI deletes a volume between the refresh and the Droplet delete', async () => {
    const { stack } = makeRacingStack();
    selectStackMock.mockResolvedValue(stack);

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    const out = await destroyStack('d4-standby', () => ({}), {
      projectName: 'p',
      provider: 'digitalocean',
    });

    expect(out.destroyed).toBe(true);
    expect(stack.workspace.removeStack).toHaveBeenCalledWith('d4-standby');
  });

  it('forgets the volume list on both sides after the refresh and before the destroy', async () => {
    const { stack } = makeRacingStack();
    selectStackMock.mockResolvedValue(stack);

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    await destroyStack('d4-standby', () => ({}), { projectName: 'p', provider: 'digitalocean' });

    expect(stack.importStack).toHaveBeenCalledTimes(1);
    const written = stack.importStack.mock.calls[0][0] as { deployment: { resources: Resource[] } };
    const db = written.deployment.resources.find((r) => r.urn.endsWith('::db'));
    expect(db?.outputs?.volumeIds).toEqual([]);
    expect(db?.inputs?.volumeIds).toEqual([]);
    // Ordering: refresh, then the state write, then destroy.
    const refreshAt = stack.refresh.mock.invocationCallOrder[0];
    const importAt = stack.importStack.mock.invocationCallOrder[0];
    const destroyAt = stack.destroy.mock.invocationCallOrder[0];
    expect(refreshAt).toBeLessThan(importAt);
    expect(importAt).toBeLessThan(destroyAt);
  });

  it('writes no state when no Droplet lists a volume', async () => {
    const { stack } = makeRacingStack();
    stack.refresh.mockImplementation(async () => undefined);
    selectStackMock.mockResolvedValue(stack);

    const { destroyStack } = await import('../../../src/lib/iac/index.js');
    await destroyStack('d4-standby', () => ({}), { projectName: 'p', provider: 'digitalocean' });

    expect(stack.importStack).not.toHaveBeenCalled();
  });
});

describe('releaseDropletVolumeIds', () => {
  it('touches only DigitalOcean Droplets', async () => {
    const state = {
      deployment: {
        resources: [
          {
            type: 'hcloud:index/server:Server',
            urn: 'u1',
            outputs: { volumeIds: ['x'] },
          },
        ],
      },
    };
    const stack = {
      exportStack: vi.fn(async () => state),
      importStack: vi.fn(async () => undefined),
    };
    const { releaseDropletVolumeIds } = await import('../../../src/lib/iac/index.js');

    expect(await releaseDropletVolumeIds(stack as never)).toBe(0);
    expect(stack.importStack).not.toHaveBeenCalled();
  });
});

describe('precondition: no program gives a Droplet Pulumi-owned volumes', () => {
  // releaseDropletVolumeIds is only correct while every Droplet volume is
  // CSI-owned. A program that starts passing `volumeIds` (or creating a
  // digitalocean.Volume / VolumeAttachment) owns attachments Pulumi must
  // detach, and the release would have to learn to keep those.
  it('the DigitalOcean programs set no volumeIds and create no Volume resources', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../../src/lib/iac/programs/', import.meta.url));
    const programs = readdirSync(dir).filter((f) => f.startsWith('digitalocean'));
    expect(programs.length).toBeGreaterThan(0);
    for (const file of programs) {
      const code = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .join('\n');
      expect(code, file).not.toMatch(/\bvolumeIds\s*:/);
      expect(code, file).not.toMatch(/digitalocean\.(Volume|VolumeAttachment)\b/);
    }
  });
});
