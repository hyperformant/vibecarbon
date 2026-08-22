import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultLedgerPath,
  ledgerEntriesFor,
  pruneVolumeLedger,
  readVolumeLedger,
  recordLeakedVolumes,
} from '../../../src/lib/volume-ledger.js';

/**
 * The ledger is the handoff between `vibecarbon destroy` (which can PROVE which
 * provider volumes a cluster owned, by reading its PersistentVolumes) and the
 * standing sweep (which otherwise has only the blunt "unattached pvc-* and only
 * when the project is completely quiet" heuristic, and so defers forever during
 * a back-to-back e2e matrix).
 *
 * Real temp dirs, no fs mocking — mocking node: builtins is flaky under the
 * parallel unit run and the whole point here is that the file survives the
 * process that wrote it.
 */

let dir: string;
let ledger: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-volume-ledger-'));
  ledger = join(dir, 'leaked-volumes.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recordLeakedVolumes', () => {
  it('writes entries a later process can read back', () => {
    recordLeakedVolumes(
      [
        {
          provider: 'hetzner',
          id: 100604631,
          name: 'pvc-1c3f8b2a-4d5e-4f60-9a1b-2c3d4e5f6071',
          region: 'nbg1',
          project: 'testapp',
          environment: 'prod',
        },
      ],
      ledger,
    );

    const { volumes } = readVolumeLedger(ledger);
    expect(volumes).toHaveLength(1);
    expect(volumes[0]).toMatchObject({
      provider: 'hetzner',
      // Ids are normalized to strings: they arrive as numbers from Hetzner's
      // API and as strings from a PV's volumeHandle.
      id: '100604631',
      region: 'nbg1',
      environment: 'prod',
    });
    expect(volumes[0].recordedAt).toBeTruthy();
  });

  it('upserts by provider+id instead of duplicating on a retried destroy', () => {
    recordLeakedVolumes([{ provider: 'hetzner', id: 1, name: 'a' }], ledger);
    recordLeakedVolumes([{ provider: 'hetzner', id: 1, name: 'a' }], ledger);
    recordLeakedVolumes([{ provider: 'hetzner', id: 2, name: 'b' }], ledger);

    expect(readVolumeLedger(ledger).volumes.map((v) => v.id)).toEqual(['1', '2']);
  });

  it('keeps the same id under two providers apart', () => {
    recordLeakedVolumes(
      [
        { provider: 'hetzner', id: '7', name: 'h' },
        { provider: 'digitalocean', id: '7', name: 'd' },
      ],
      ledger,
    );

    expect(readVolumeLedger(ledger).volumes).toHaveLength(2);
    expect(ledgerEntriesFor('hetzner', ledger).map((v) => v.name)).toEqual(['h']);
    expect(ledgerEntriesFor('digitalocean', ledger).map((v) => v.name)).toEqual(['d']);
  });

  it('is a no-op for an empty list — a clean destroy leaves no file behind', () => {
    expect(recordLeakedVolumes([], ledger)).toEqual({ written: 0, path: ledger });
    expect(readVolumeLedger(ledger)).toEqual({ volumes: [] });
  });

  it('creates the config dir when it does not exist yet', () => {
    const nested = join(dir, 'sub', 'dir', 'leaked-volumes.json');
    recordLeakedVolumes([{ provider: 'hetzner', id: 5 }], nested);
    expect(JSON.parse(readFileSync(nested, 'utf-8')).volumes).toHaveLength(1);
  });
});

describe('readVolumeLedger — never wedges the caller', () => {
  it('returns an empty ledger for a missing file', () => {
    expect(readVolumeLedger(join(dir, 'nope.json'))).toEqual({ volumes: [] });
  });

  it('returns an empty ledger for a corrupt file rather than throwing on the teardown path', () => {
    writeFileSync(ledger, '{ this is not json');
    expect(readVolumeLedger(ledger)).toEqual({ volumes: [] });
  });

  it('returns an empty ledger for a valid JSON file of the wrong shape', () => {
    writeFileSync(ledger, JSON.stringify({ volumes: 'not-an-array' }));
    expect(readVolumeLedger(ledger)).toEqual({ volumes: [] });
  });
});

describe('pruneVolumeLedger', () => {
  it('removes only the resolved entries', () => {
    recordLeakedVolumes(
      [
        { provider: 'hetzner', id: 1 },
        { provider: 'hetzner', id: 2 },
        { provider: 'hetzner', id: 3 },
      ],
      ledger,
    );

    const { remaining } = pruneVolumeLedger(
      [
        { provider: 'hetzner', id: 1 },
        { provider: 'hetzner', id: 3 },
      ],
      ledger,
    );

    expect(remaining).toBe(1);
    expect(readVolumeLedger(ledger).volumes.map((v) => v.id)).toEqual(['2']);
  });

  it('matches numeric and string ids as the same entry', () => {
    recordLeakedVolumes([{ provider: 'hetzner', id: '100604631' }], ledger);
    pruneVolumeLedger([{ provider: 'hetzner', id: 100604631 }], ledger);
    expect(readVolumeLedger(ledger).volumes).toEqual([]);
  });

  it('does not prune the same id under a different provider', () => {
    recordLeakedVolumes([{ provider: 'digitalocean', id: '7' }], ledger);
    pruneVolumeLedger([{ provider: 'hetzner', id: '7' }], ledger);
    expect(readVolumeLedger(ledger).volumes).toHaveLength(1);
  });
});

describe('defaultLedgerPath', () => {
  it('lives beside the rest of the global config so it survives the project dir', () => {
    // destroy deletes .vibecarbon/<env> state in the project; a ledger there
    // would be erased by the very command that writes it.
    expect(defaultLedgerPath('/home/someone/.vibecarbon')).toBe(
      '/home/someone/.vibecarbon/leaked-volumes.json',
    );
  });
});
