/**
 * Checksum utilities for file integrity tracking
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Compute SHA-256 hash of a string
 *
 * @param {string} content - Content to hash
 * @returns {string} - Hash in "sha256:<hex>" format
 */
export function hashContent(content) {
  const hex = createHash('sha256').update(content).digest('hex');
  return `sha256:${hex}`;
}

/**
 * Compute SHA-256 hash of a file's contents
 *
 * @param {string} filePath - Absolute path to file
 * @returns {string} - Hash in "sha256:<hex>" format
 */
export function hashFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  return hashContent(content);
}
