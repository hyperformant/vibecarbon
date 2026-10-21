import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

// The secret-fingerprint HMAC key (src/lib/deploy/secret-fingerprint.js) is
// minted under the home dir by default; tests get a per-worker temp dir so no
// caller (digestEnvLocalSecrets, tokenFingerprint) touches the developer's
// real ~/.vibecarbon.
process.env.VIBECARBON_FINGERPRINT_KEY_DIR = mkdtempSync(join(tmpdir(), 'vc-test-fpkey-'));

import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanupAllTempDirs } from '../_shared/temp-dir.js';

// A test that reaches the real updateProjectConfig without its own cwd writes
// the repo's own .vibecarbon.json (and its lock or temp file). Record what is
// there now; a file that appears during this test file's run (or a parallel
// one's) fails it, and is removed so it cannot hide the next occurrence.
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CONFIG_RESIDUE = [
  '.vibecarbon.json',
  '.vibecarbon.json.lock',
  '.vibecarbon.json.lock.break',
  '.vibecarbon.json.tmp',
];
const residueAtStart = new Set(CONFIG_RESIDUE.filter((f) => existsSync(join(REPO_ROOT, f))));

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

  const appeared = CONFIG_RESIDUE.filter(
    (f) => !residueAtStart.has(f) && existsSync(join(REPO_ROOT, f)),
  );
  for (const f of appeared) rmSync(join(REPO_ROOT, f), { force: true });
  if (appeared.length > 0) {
    throw new Error(
      `a test wrote ${appeared.join(', ')} at the repo root (removed now): stub ` +
        'updateProjectConfig or point the test at a temp dir (vi.spyOn(process, "cwd"))',
    );
  }

  // Restore original environment
  process.env = originalEnv;
});
