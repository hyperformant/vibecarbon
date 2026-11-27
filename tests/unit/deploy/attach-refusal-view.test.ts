/**
 * logAttachRefusalView: when the provider refused to attach the db volume and
 * the refusal held (VolumeAttachRefusedError), the deploy logs what the
 * provider says about the database server and about the volume, one `[db]`
 * line per fact, so the next hit carries evidence.
 *
 * WHY (Vultr runs 45940611622 and 45966805225, 2026-11-27): a fresh
 * vc2-4c-8gb database server in ewr took no NVMe block volume for 900 s
 * ("Block storage is not compatible with this server", status 400), and the
 * rig was destroyed with nothing recorded of the server's plan or the
 * volume's type, region and attachment.
 *
 * Pinned here: the reads are bounded and never throw, a failed read is a log
 * line, the volume id comes from the PersistentVolume's CSI handle, and only
 * named fields are printed.
 */
import { describe, expect, it, vi } from 'vitest';
import { logAttachRefusalView } from '../../../src/lib/deploy/k8s/attach-refusal-view.js';

const DB_IP = '45.77.120.14';
const BLOCK_ID = 'cb676a46-66fd-4dfb-b839-443f2e6c0b60';
const VOLUME = 'pvc-d77e8ece45b54f59';

const Provider = {
  NAME: 'Vultr',
  getPublicIP: (s: { main_ip: string }) => s.main_ip,
};
const dbNode = { role: 'db' as const, ip: DB_IP };

/** The PersistentVolume vultr-csi made for the db claim, as `kubectl get pv -o json` shows it. */
const pv = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: VOLUME },
    spec: {
      csi: { driver: 'block.csi.vultr.com', volumeHandle: BLOCK_ID, fsType: 'ext4' },
      persistentVolumeReclaimPolicy: 'Delete',
      storageClassName: 'vultr-block-storage-vibecarbon',
      ...overrides,
    },
    status: { phase: 'Bound' },
  });

const serverView = {
  id: 'inst-1',
  name: 'proj-db',
  status: 'ok',
  detail: 'power running, subscription active',
  created: '2026-11-27T09:12:40+00:00',
  location: 'ewr',
  plan: 'vc2-4c-8gb',
  publicIp: DB_IP,
  privateIp: '10.1.96.4',
  events: [],
  eventsNote: "Vultr's API keeps no event history for an instance",
};

const volumeView = {
  id: BLOCK_ID,
  label: VOLUME,
  blockType: 'high_perf',
  region: 'ewr',
  sizeGb: 10,
  status: 'active',
  attachedToInstance: null,
  created: '2026-11-27T09:19:02+00:00',
};

function fakeProvider(over: Record<string, unknown> = {}) {
  return {
    listServersDetailed: vi.fn(async () => ({
      items: [{ id: 'inst-1', main_ip: DB_IP }],
      complete: true,
    })),
    describeServerForDiagnosis: vi.fn(async () => serverView),
    describeVolumeForDiagnosis: vi.fn(async () => volumeView),
    ...over,
  };
}

describe('logAttachRefusalView', () => {
  it("logs the provider's view of the database server, with its plan, and of the volume", async () => {
    const lines: string[] = [];
    const provider = fakeProvider();
    const readPv = vi.fn(async () => pv());
    await logAttachRefusalView({
      provider: provider as never,
      Provider: Provider as never,
      dbNode,
      volume: VOLUME,
      readPv,
      log: (l) => lines.push(l),
    });
    expect(readPv).toHaveBeenCalledWith(VOLUME);
    expect(provider.describeServerForDiagnosis).toHaveBeenCalledWith('inst-1');
    expect(provider.describeVolumeForDiagnosis).toHaveBeenCalledWith(BLOCK_ID);
    expect(lines).toEqual([
      `[db] Vultr's view of proj-db (${DB_IP}, database node): status ok (power running, subscription active), ` +
        `created 2026-11-27T09:12:40+00:00, at ewr, id inst-1, public ${DB_IP}, private 10.1.96.4, plan vc2-4c-8gb`,
      "[db]   no recent actions: Vultr's API keeps no event history for an instance",
      `[db] Vultr's view of the db volume ${VOLUME} (id ${BLOCK_ID}): type high_perf, region ewr, ` +
        'size 10 GB, status active, attached to no instance, created 2026-11-27T09:19:02+00:00',
    ]);
  });

  it('a volume attached to an instance names it', async () => {
    const lines: string[] = [];
    await logAttachRefusalView({
      provider: fakeProvider({
        describeVolumeForDiagnosis: async () => ({ ...volumeView, attachedToInstance: 'inst-9' }),
      }) as never,
      Provider: Provider as never,
      dbNode,
      volume: VOLUME,
      readPv: async () => pv(),
      log: (l) => lines.push(l),
    });
    expect(lines.at(-1)).toContain('attached to instance inst-9');
  });

  it('never throws: every read that fails is a log line', async () => {
    const lines: string[] = [];
    await expect(
      logAttachRefusalView({
        provider: fakeProvider({
          listServersDetailed: async () => {
            throw new Error('Vultr answered HTTP 401 for /instances');
          },
          describeVolumeForDiagnosis: async () => {
            throw new Error('unused');
          },
        }) as never,
        Provider: Provider as never,
        dbNode,
        volume: VOLUME,
        readPv: async () => {
          throw new Error('error: the server could not find the requested resource');
        },
        log: (l) => lines.push(l),
      }),
    ).resolves.toBeUndefined();
    expect(lines).toEqual([
      `[db] could not read Vultr's view of ${DB_IP}: Vultr answered HTTP 401 for /instances`,
      `[db] could not read the PersistentVolume ${VOLUME}, so Vultr's view of the volume was not read: ` +
        'error: the server could not find the requested resource',
    ]);
  });

  it("a PV whose handle is not one of a known CSI driver's, or a provider with no volume read, says so", async () => {
    const unreadable: string[] = [];
    await logAttachRefusalView({
      provider: fakeProvider() as never,
      Provider: Provider as never,
      dbNode,
      volume: VOLUME,
      readPv: async () =>
        pv({ csi: { driver: 'block.csi.vultr.com', volumeHandle: 'not-a-uuid' } }),
      log: (l) => unreadable.push(l),
    });
    expect(unreadable.at(-1)).toBe(
      `[db] the PersistentVolume ${VOLUME} names no volume id Vultr's view can be read by ` +
        '(driver block.csi.vultr.com, handle not-a-uuid)',
    );

    const none: string[] = [];
    await logAttachRefusalView({
      provider: fakeProvider({ describeVolumeForDiagnosis: async () => null }) as never,
      Provider: Provider as never,
      dbNode,
      volume: VOLUME,
      readPv: async () => pv(),
      log: (l) => none.push(l),
    });
    expect(none.at(-1)).toBe(
      `[db] Vultr's view of the db volume ${VOLUME} (id ${BLOCK_ID}) was not read: this provider has no read of a volume`,
    );
  });

  it('a volume name that is not a Kubernetes name is never handed to kubectl', async () => {
    const lines: string[] = [];
    const readPv = vi.fn(async () => pv());
    await logAttachRefusalView({
      provider: fakeProvider() as never,
      Provider: Provider as never,
      dbNode,
      volume: 'the db volume',
      readPv,
      log: (l) => lines.push(l),
    });
    expect(readPv).not.toHaveBeenCalled();
    expect(lines.at(-1)).toBe(
      "[db] the refusal named no PersistentVolume (the db volume), so Vultr's view of the volume was not read",
    );
  });

  it('is bounded: reads that never answer stop at the budget, and what answered is kept', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      let settled = false;
      const done = logAttachRefusalView({
        provider: fakeProvider({
          describeServerForDiagnosis: () => new Promise(() => {}),
        }) as never,
        Provider: Provider as never,
        dbNode,
        volume: VOLUME,
        readPv: () => new Promise(() => {}),
        log: (l) => lines.push(l),
        budgetMs: 30_000,
      }).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(settled).toBe(true);
      await done;
      expect([...lines].sort()).toEqual(
        [
          "[db] stopped reading Vultr's view after 30s; what it had answered is above",
          `[db] stopped reading Vultr's view of the db volume ${VOLUME} after 30s`,
        ].sort(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
