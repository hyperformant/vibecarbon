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
