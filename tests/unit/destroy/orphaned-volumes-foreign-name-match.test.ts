/**
 * A volume that names nothing of this environment is never this environment's.
 *
 * Destroy matched a volume as its own ("server-name", an identity match,
 * attachment-blind) when the volume's name contained one of the env's server
 * names. Those names are role words (`master`, `db`, `worker-1`, `primary`,
 * `standby`), and a CSI volume's name is `pvc-` plus hex, so about one CSI
 * volume in sixteen contains `db`. GitHub run 43680508383 (linode/k8s, env
 * cil3): destroy claimed `pvc-f683a0d09f9d4dbc`, a volume of another live
 * cluster on the same account, waited for it to detach, reported it LEAKED,
 * wrote it to the leaked-volume ledger for the sweep to delete by id, and kept
 * the env's buckets because of the "leak". Had it detached inside the wait,
 * destroy would have deleted another cluster's database disk.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cleanupOrphanedVolumes } from '../../../src/destroy.js';
import { encodeLabel, LinodeProvider } from '../../../src/lib/providers/linode.js';

/** The server names a k8s env records (envConfig.servers[].name). */
const ROLE_NAMES = ['master', 'db', 'worker-1', 'worker-2', 'primary', 'standby'];

const volume = (id: number, label: string, over: Record<string, unknown> = {}) => ({
  id,
  label,
  region: 'us-iad',
  linode_id: null,
  tags: [encodeLabel('project', 'other-project')],
  created: '2026-11-15T05:48:28',
  ...over,
});

function setup(volumes: Array<ReturnType<typeof volume>>) {
  const provider = new LinodeProvider('token');
  vi.spyOn(provider, 'listVolumesDetailed').mockResolvedValue({ items: volumes, complete: true });
  const deleteVolume = vi.spyOn(provider, 'deleteVolume').mockResolvedValue(true);
  return { provider, deleteVolume };
}

const lines: string[] = [];
/**
 * The destroy's own call, for env cil3 in us-iad, with no detach wait. The env
 * records ROLE_NAMES as its servers, and none of them is passed: a server's
 * name is not evidence a volume is ours.
 */
const run = (provider: LinodeProvider, knownIds: string[] = [], identityComplete = false) =>
  cleanupOrphanedVolumes(provider, 'proj', 'cil3', knownIds, ['us-iad'], {
    identityComplete,
    detachWaitMs: 0,
    pollIntervalMs: 0,
    sleep: async () => {},
    report: (l: string) => lines.push(l),
  });

/** Deterministic `pvc-<16 hex>` labels (Linode's CSI volume label shape). */
function csiLabels(n: number): string[] {
  let seed = 0x5eed;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  return Array.from(
    { length: n },
    () =>
      `pvc-${Array.from({ length: 16 }, () => '0123456789abcdef'[(next() >> 16) % 16]).join('')}`,
  );
}

describe('destroy never claims a volume for a role word in its name', () => {
  it('leaves an attached CSI volume of another cluster alone (run 43680508383)', async () => {
    lines.length = 0;
    const { provider, deleteVolume } = setup([
      volume(19141038, 'pvc-f683a0d09f9d4dbc', { linode_id: 88001 }),
      volume(19141162, 'pvc-ac8776e99ead466c', { tags: [encodeLabel('project', 'proj')] }),
    ]);
    const { deleted, unresolved } = await run(provider, ['19141162'], true);
    expect(deleted).toEqual(['pvc-ac8776e99ead466c']);
    expect(unresolved).toEqual([]);
    expect(deleteVolume).toHaveBeenCalledExactlyOnceWith(19141162);
    expect(lines.join('\n')).not.toContain('pvc-f683a0d09f9d4dbc');
  });

  it('never deletes a detached volume whose only tie is a role word', async () => {
    const { provider, deleteVolume } = setup([
      volume(1, 'pvc-00000000000db000', { tags: [], region: 'eu-central' }),
      ...ROLE_NAMES.map((role, i) =>
        volume(10 + i, `data-${role}`, { tags: [], region: 'eu-central' }),
      ),
    ]);
    const { deleted } = await run(provider);
    expect(deleted).toEqual([]);
    expect(deleteVolume).not.toHaveBeenCalled();
  });

  it('claims none of 500 unrelated CSI volumes, attached or not', async () => {
    const labels = csiLabels(500);
    // The sample must hold the shape that broke, or it proves nothing.
    expect(labels.filter((l) => l.includes('db')).length).toBeGreaterThan(10);
    const { provider, deleteVolume } = setup(
      labels.map((label, i) =>
        volume(1000 + i, label, {
          tags: [],
          region: 'eu-central',
          linode_id: i % 2 ? 77000 + i : null,
        }),
      ),
    );
    const { deleted, unresolved } = await run(provider);
    expect(deleted).toEqual([]);
    expect(unresolved).toEqual([]);
    expect(deleteVolume).not.toHaveBeenCalled();
  });

  it("destroy's call passes nothing built from the env's servers", () => {
    const src = readFileSync(join(__dirname, '../../../src/destroy.js'), 'utf-8');
    const calls = [...src.matchAll(/await cleanupOrphanedVolumes\(([\s\S]*?)\);/g)];
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).not.toMatch(/server/i);
  });
});
