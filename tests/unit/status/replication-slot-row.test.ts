/**
 * `vibecarbon status` shows the primary's replication slot (HA-correctness
 * Task 7, H5): its wal_status and how much WAL it holds. The slot's WAL is
 * capped (max_slot_wal_keep_size), so a standby that stays away long enough
 * loses its slot: `lost` is an error that says how to recover.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { REPLICATION_SLOT_HEALTH_SQL } from '../../../src/lib/deploy/replication-slot.js';
import {
  checkReplication,
  parseReplicationSlotRow,
  replicationSlotRow,
} from '../../../src/status.js';

const MiB = 1024 ** 2;

describe('replicationSlotRow', () => {
  it('a healthy slot: its wal_status and the WAL it retains', () => {
    expect(replicationSlotRow({ walStatus: 'reserved', retainedBytes: 12 * MiB }, 'prod')).toEqual({
      level: 'ok',
      text: 'reserved, 12 MB retained',
    });
  });

  it('lost is an error that names the deploy that reseeds', () => {
    const row = replicationSlotRow({ walStatus: 'lost', retainedBytes: 0 }, 'prod');
    expect(row?.level).toBe('error');
    expect(row?.text).toMatch(/^lost, 0 MB retained: /);
    expect(row?.text).toContain('run vibecarbon deploy prod to reseed');
  });

  it('unreserved (past the cap, not yet lost) warns', () => {
    const row = replicationSlotRow({ walStatus: 'unreserved', retainedBytes: 4200 * MiB }, 'prod');
    expect(row?.level).toBe('warn');
    expect(row?.text).toMatch(/^unreserved, 4200 MB retained: /);
  });

  it('no slot on the primary warns with the deploy that creates it', () => {
    const row = replicationSlotRow('none', 'prod');
    expect(row?.level).toBe('warn');
    expect(row?.text).toContain('run vibecarbon deploy prod');
  });

  it('an unreadable slot renders no row', () => {
    expect(replicationSlotRow(null, 'prod')).toBeNull();
  });
});

describe('parseReplicationSlotRow', () => {
  it('reads wal_status|retained bytes', () => {
    expect(parseReplicationSlotRow('extended|5242880\n')).toEqual({
      walStatus: 'extended',
      retainedBytes: 5 * MiB,
    });
  });
  it('an empty answer is no slot', () => {
    expect(parseReplicationSlotRow('')).toBe('none');
  });
  it('a slot no standby has used yet has no wal_status', () => {
    expect(parseReplicationSlotRow('|0')).toEqual({ walStatus: 'unused', retainedBytes: 0 });
  });
});

describe('checkReplication reads the slot on the primary', () => {
  it('threads the slot row into the result', async () => {
    const sshKubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      const sql = argv[argv.length - 1];
      if (sql === REPLICATION_SLOT_HEALTH_SQL) return 'lost|0';
      if (sql.includes('pg_stat_replication')) return '';
      return '';
    });
    const result = await checkReplication(
      'prod',
      {
        deployMode: 'kubernetes',
        ha: { enabled: true },
        servers: [{ name: 'primary', ip: '10.1.2.2' }],
      },
      'myproj',
      {
        getPostgresPod: vi.fn(async () => 'db-0'),
        sshKubectl,
        sshRun: vi.fn(),
        getSSHKeyPath: vi.fn(() => fileURLToPath(import.meta.url)),
        timeoutMs: 5000,
      },
    );
    expect(result?.slot).toEqual({ walStatus: 'lost', retainedBytes: 0 });
  });
});

// Final review I6: the query read the first non-temporary slot, which could be
// any other one (a reseed's, an operator's). It names the standby slot now, a
// string literal, so compose carries it base64 on stdin, never inside -tAc "...".
describe('the slot query names the standby slot and travels quoting-safe', () => {
  it('filters by slot_name', () => {
    expect(REPLICATION_SLOT_HEALTH_SQL).toContain("WHERE slot_name = 'vibecarbon_standby_slot'");
    expect(REPLICATION_SLOT_HEALTH_SQL).not.toMatch(/LIMIT 1|NOT temporary/);
  });

  it('compose sends it base64 on stdin', async () => {
    const commands: string[] = [];
    const sshRun = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      const cmd = argv[argv.length - 1];
      commands.push(cmd);
      const b64 = cmd.match(/echo (\S+) \| base64 -d/)?.[1];
      if (b64 && Buffer.from(b64, 'base64').toString() === REPLICATION_SLOT_HEALTH_SQL) {
        return 'extended|1024';
      }
      return '';
    });
    const result = await checkReplication(
      'prod',
      {
        deployMode: 'compose-ha',
        ha: { enabled: true },
        servers: [{ name: 'p', role: 'primary', ip: '10.0.0.1' }],
      },
      'myproj',
      {
        getPostgresPod: vi.fn(),
        sshKubectl: vi.fn(),
        sshRun,
        getSSHKeyPath: vi.fn(() => fileURLToPath(import.meta.url)),
        timeoutMs: 5000,
      },
    );
    expect(result?.slot).toEqual({ walStatus: 'extended', retainedBytes: 1024 });
    // The literal never rides a double-quoted -tAc.
    expect(commands.some((c) => c.includes("'vibecarbon_standby_slot'"))).toBe(false);
  });
});
