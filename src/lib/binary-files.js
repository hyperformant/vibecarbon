/**
 * Binary / raw-asset file extensions shared by the template copy paths
 * (`create` scaffolding and `upgrade` reconciliation).
 *
 * Files with these extensions are copied byte-for-byte and never
 * placeholder-replaced: a UTF-8 read/write round-trip corrupts true
 * binaries, and none of these formats carry {{PLACEHOLDER}} tokens.
 * SVG is included deliberately — logo/icon assets should reach projects
 * untouched.
 */
export const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.zip',
  '.tar',
  '.gz',
]);

/**
 * Check if a file path has a binary extension
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isBinaryFile(filePath) {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}
