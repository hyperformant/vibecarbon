import { describe, expect, it } from 'vitest';
import { parseWalgBackupList } from '../../../src/lib/walg-backups.js';

describe('parseWalgBackupList', () => {
  it('parses wal-g v2 --json output (backup_name + time), newest first', () => {
    const json = JSON.stringify([
      { backup_name: 'base_000000010000000000000003', time: '2026-06-22T06:00:00Z' },
      { backup_name: 'base_000000010000000000000009', time: '2026-06-23T01:53:29Z' },
      { backup_name: 'base_000000010000000000000006', time: '2026-06-22T18:00:00Z' },
    ]);
    const out = parseWalgBackupList(json);
    expect(out.map((b) => b.name)).toEqual([
      'base_000000010000000000000009',
      'base_000000010000000000000006',
      'base_000000010000000000000003',
    ]);
    expect(out[0].time).toBeInstanceOf(Date);
    expect(out[0].time.toISOString()).toBe('2026-06-23T01:53:29.000Z');
  });

  it('tolerates PascalCase / alternate field names (BackupName, StartTime)', () => {
    const json = JSON.stringify([
      { BackupName: 'base_A', StartTime: '2026-06-20T00:00:00Z' },
      { BackupName: 'base_B', FinishTime: '2026-06-21T00:00:00Z' },
    ]);
    const out = parseWalgBackupList(json);
    expect(out.map((b) => b.name)).toEqual(['base_B', 'base_A']);
  });

  it('drops entries missing a name or an unparseable time', () => {
    const json = JSON.stringify([
      { backup_name: 'base_ok', time: '2026-06-22T06:00:00Z' },
      { time: '2026-06-22T07:00:00Z' }, // no name
      { backup_name: 'base_bad_time', time: 'not-a-date' },
    ]);
    const out = parseWalgBackupList(json);
    expect(out.map((b) => b.name)).toEqual(['base_ok']);
  });

  it('returns [] for empty, non-array, or invalid JSON', () => {
    expect(parseWalgBackupList('[]')).toEqual([]);
    expect(parseWalgBackupList('{}')).toEqual([]);
    expect(parseWalgBackupList('not json')).toEqual([]);
    expect(parseWalgBackupList('')).toEqual([]);
  });
});
