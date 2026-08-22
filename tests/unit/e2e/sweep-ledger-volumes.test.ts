import { describe, expect, it, vi } from 'vitest';

import { selectLedgerVolumes, sweepLedgerVolumes } from '../../../scripts/sweep-hetzner.js';

/**
 * Layer 3 of the CSI-volume leak fix: the standing sweep finishes what a
 * destroy started.
 *
 * The sweep's existing `pvc-*` pass only fires when the whole project has ZERO
 * servers, which during a back-to-back e2e matrix is never — so a volume a
 * destroy identified but failed to delete (still detaching, API 403, step
 * SIGKILLed) sat there billing. Ledger entries are IDENTITIES a destroy
 * captured from a cluster's own PersistentVolumes, so they need no gate. They
 * do need the two guards below, because a ledger is a claim about the past.
 */

const entry = (over: Record<string, unknown> = {}) => ({
  provider: 'hetzner',
  id: '100604631',
  name: 'pvc-1c3f8b2a-4d5e-4f60-9a1b-2c3d4e5f6071',
  region: 'nbg1',
  project: 'testapp',
  environment: 'e3',
  ...over,
});

const liveVolume = (over: Record<string, unknown> = {}) => ({
  id: 100604631,
  name: 'pvc-1c3f8b2a-4d5e-4f60-9a1b-2c3d4e5f6071',
  server: null,
  size: 10,
  location: { name: 'nbg1' },
  ...over,
});

describe('selectLedgerVolumes', () => {
  it('matches a string ledger id against the numeric id the API returns', () => {
    const { deletable } = selectLedgerVolumes([entry()], [liveVolume()]);
    expect(deletable.map((d) => d.entry.id)).toEqual(['100604631']);
  });

  it('treats an entry absent from the listing as already resolved', () => {
    const { deletable, gone } = selectLedgerVolumes([entry()], []);
    expect(deletable).toEqual([]);
    expect(gone.map((e) => e.id)).toEqual(['100604631']);
  });

  it('refuses to delete when the id now carries a different name (id reuse)', () => {
    const { deletable, skipped } = selectLedgerVolumes(
      [entry()],
      [liveVolume({ name: 'someone-elses-data' })],
    );

    expect(deletable).toEqual([]);
    expect(skipped[0].why).toContain('id was reused');
  });

  it('refuses to delete a volume that is attached to a server', () => {
    // If something is using it, our belief that the owning cluster is gone is
    // wrong — and a mounted disk is the worst possible thing to be wrong about.
    const { deletable, skipped } = selectLedgerVolumes([entry()], [liveVolume({ server: 4242 })]);

    expect(deletable).toEqual([]);
    expect(skipped[0].why).toContain('attached to server 4242');
  });

  it('does not require a name when the ledger entry has none', () => {
    const { deletable } = selectLedgerVolumes([entry({ name: null })], [liveVolume()]);
    expect(deletable).toHaveLength(1);
  });
});

describe('sweepLedgerVolumes', () => {
  it('deletes ledger volumes by id and prunes them, with no zero-servers gate', async () => {
    const doDelete = vi.fn(async () => true);
    const prune = vi.fn();

    const touched = await sweepLedgerVolumes({
      entries: [entry()],
      listVolumes: async () => ({ items: [liveVolume()], complete: true }),
      doDelete,
      prune,
    });

    expect(touched).toBe(1);
    expect(doDelete).toHaveBeenCalledWith('volumes', '100604631');
    expect(prune).toHaveBeenCalledWith([{ provider: 'hetzner', id: '100604631' }]);
  });

  it('prunes entries the listing shows are already gone, without a delete call', async () => {
    const doDelete = vi.fn(async () => true);
    const prune = vi.fn();

    const touched = await sweepLedgerVolumes({
      entries: [entry()],
      listVolumes: async () => ({ items: [], complete: true }),
      doDelete,
      prune,
    });

    expect(touched).toBe(0);
    expect(doDelete).not.toHaveBeenCalled();
    expect(prune).toHaveBeenCalledWith([{ provider: 'hetzner', id: '100604631' }]);
  });

  it('defers the whole pass on an incomplete listing — an absent row proves nothing', async () => {
    const doDelete = vi.fn(async () => true);
    const prune = vi.fn();

    const touched = await sweepLedgerVolumes({
      entries: [entry()],
      listVolumes: async () => ({ items: [], complete: false }),
      doDelete,
      prune,
    });

    expect(touched).toBe(0);
    expect(doDelete).not.toHaveBeenCalled();
    // Critically: nothing is pruned either. A truncated walk must not be able
    // to erase the only record that a volume is still out there.
    expect(prune).not.toHaveBeenCalled();
  });

  it('keeps a failed delete in the ledger for the next sweep', async () => {
    const prune = vi.fn();

    const touched = await sweepLedgerVolumes({
      entries: [entry()],
      listVolumes: async () => ({ items: [liveVolume()], complete: true }),
      doDelete: async () => false,
      deleteOptions: { attempts: 2, delayMs: 0 },
      prune,
    });

    expect(touched).toBe(0);
    expect(prune).not.toHaveBeenCalled();
  });

  it('is a no-op with an empty ledger', async () => {
    const listVolumes = vi.fn();
    expect(await sweepLedgerVolumes({ entries: [], listVolumes })).toBe(0);
    expect(listVolumes).not.toHaveBeenCalled();
  });
});
