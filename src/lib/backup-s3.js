/**
 * Shared S3 backup helpers.
 *
 * The legacy `backups/*_full.tar.gz` list/download helpers are gone: wal-g
 * environments keep base backups under `walg/` (listed by
 * src/lib/walg/restore-base.js listBaseBackups), and nothing wrote those
 * archives any more.
 */

/**
 * Format a byte count as a human-readable string.
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}
