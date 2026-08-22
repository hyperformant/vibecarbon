import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Per-WORKER uplink-lock dir: vitest workers are real processes, and the
// cross-process uplink lock (src/lib/deploy/uplink-lock.js) would otherwise
// serialize unrelated test files through one real home-dir lock — and leave
// lock residue behind on aborted runs. Isolation here, not fs mocking, per
// the unit-test-mocking house rule.
process.env.VIBECARBON_UPLINK_LOCK_DIR = join(
  mkdtempSync(join(tmpdir(), 'vc-test-uplink-')),
  'uplink-push.lock',
);

import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanupAllTempDirs } from '../_shared/temp-dir.js';

// Store original environment variables
const originalEnv = { ...process.env };

beforeAll(() => {
  // Set test environment defaults
  process.env.CI = process.env.CI || 'true';
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  // Reset environment variables after each test
  process.env = { ...originalEnv };
  process.env.CI = 'true';
  process.env.NODE_ENV = 'test';
});

afterAll(async () => {
  // Clean up any remaining temp directories
  await cleanupAllTempDirs();

  // Restore original environment
  process.env = originalEnv;
});
