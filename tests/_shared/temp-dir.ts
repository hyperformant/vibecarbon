import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Track all created temp directories for cleanup
const tempDirs: Set<string> = new Set();

/**
 * Create a temporary directory with an optional prefix
 */
export function createTempDir(prefix = 'vibecarbon-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

/**
 * Clean up a specific temporary directory
 */
export function cleanupTempDir(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    tempDirs.delete(path);
  }
}

/**
 * Clean up all tracked temporary directories
 */
export async function cleanupAllTempDirs(): Promise<void> {
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
  tempDirs.clear();
}
