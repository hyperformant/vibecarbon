/**
 * `vibecarbon status` shows the side a failover retired (HA-correctness Task 6):
 * fenced or not, whether this run just fenced it, and its disk clock (pg_wal
 * grows while archiving is refused) with how long it has been retired.
 */
import { stripVTControlCharacters as strip } from 'node:util';
import { describe, expect, it } from 'vitest';
import { retiredFenceRow } from '../../../src/status.js';

const envConfig = { lastFailover: '2026-10-21T00:00:00.000Z' };
const now = Date.parse('2026-10-21T03:00:00.000Z');

describe('retiredFenceRow', () => {
  it('a side fenced earlier: refuses backups and writes, with pg_wal size and age', () => {
    const row = strip(
      retiredFenceRow(
        {
          fenced: ['10.0.0.1'],
          unreachable: [],
          nodes: [{ ip: '10.0.0.1', wrote: [], walBytes: 3 * 1024 ** 3 }],
        },
        envConfig,
        now,
      ),
    );
    expect(row).toBe(
      '10.0.0.1 fenced: refuses backups and writes (pg_wal 3.0 GiB, retired 3h ago)',
    );
  });

  it('says (fenced now) when this run wrote the fence', () => {
    const row = strip(
      retiredFenceRow(
        {
          fenced: ['10.0.0.1'],
          unreachable: [],
          nodes: [{ ip: '10.0.0.1', wrote: ['its database read-only'], walBytes: 1024 }],
        },
        envConfig,
        now,
      ),
    );
    expect(row).toMatch(/^10\.0\.0\.1 fenced \(fenced now\): /);
    expect(row).toContain('pg_wal 1.0 KiB');
  });

  it('a side that does not answer: not fenced yet, with its age', () => {
    const row = strip(
      retiredFenceRow({ fenced: [], unreachable: ['10.0.0.1'], nodes: [] }, envConfig, now),
    );
    expect(row).toBe('10.0.0.1 not fenced yet (it or its db does not answer, retired 3h ago)');
  });
});
