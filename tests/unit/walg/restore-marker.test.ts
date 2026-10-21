import { describe, expect, it } from 'vitest';
import { buildInfraSecretData } from '../../../src/lib/deploy/k8s/k3s.js';
import {
  RESTORE_MARKER_KEYS,
  restoreMarkerStringData,
} from '../../../src/lib/walg/restore-marker.js';

/**
 * One key list for the k8s restore marker, shared by `vibecarbon restore`'s
 * patch and the deploy's Secret writer (buildInfraSecretData), so the Secret
 * cannot drift from what the walg-restore init container reads.
 */
const MARKER = {
  backup: 'base_000000010000000000000002',
  target: 'latest',
  recoveryConf: '-restore_command\nrestore_command = \'wal-g wal-fetch "%f" "%p"\'',
  attempt: 'a1b2c3d4-0000-4000-8000-000000000001',
  origin: 'restore',
  lineage: '7699032860122738725',
};

describe('restore marker keys', () => {
  it('a set marker carries every key, a cleared one empties every key', () => {
    expect(Object.keys(restoreMarkerStringData(MARKER)).sort()).toEqual(
      [...RESTORE_MARKER_KEYS].sort(),
    );
    expect(restoreMarkerStringData(null)).toEqual(
      Object.fromEntries(RESTORE_MARKER_KEYS.map((k) => [k, ''])),
    );
  });

  it('a set marker names its attempt and who set it (Fix round 2, N1/N2)', () => {
    const data = restoreMarkerStringData(MARKER);
    expect(data.RESTORE_ATTEMPT).toBe(MARKER.attempt);
    expect(data.RESTORE_ORIGIN).toBe('restore');
    expect(() => restoreMarkerStringData({ ...MARKER, attempt: '' })).toThrow(/attempt/);
    expect(() => restoreMarkerStringData({ ...MARKER, attempt: 'two words' })).toThrow(/attempt/);
    expect(() => restoreMarkerStringData({ ...MARKER, origin: 'cron' })).toThrow(/origin/);
    expect(() => restoreMarkerStringData({ ...MARKER, lineage: '' })).toThrow(/lineage/);
    expect(() => restoreMarkerStringData({ ...MARKER, lineage: '1; rm -rf /' })).toThrow(/lineage/);
  });

  it('refuses a marker without a real backup name or config', () => {
    expect(() => restoreMarkerStringData({ ...MARKER, backup: 'LATEST' })).toThrow(
      /not a wal-g backup name/,
    );
    expect(() => restoreMarkerStringData({ ...MARKER, recoveryConf: '' })).toThrow(/required/);
  });

  it('buildInfraSecretData writes the marker keys only when asked', () => {
    const plain = buildInfraSecretData({ envLocal: {} });
    for (const k of RESTORE_MARKER_KEYS) expect(plain).not.toHaveProperty(k);
    const marked = buildInfraSecretData({ envLocal: {}, restore: MARKER });
    expect(marked.RESTORE_BACKUP).toBe(MARKER.backup);
    for (const k of RESTORE_MARKER_KEYS) expect(marked).toHaveProperty(k);
  });
});
