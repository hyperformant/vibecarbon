import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Every test file gets its own temp root, and os.tmpdir() points inside it
// (TMPDIR is read on every call, and CLI children inherit it), so whatever a
// test makes there is seen and removed when the file ends. A leftover fails
// the file (tempLeftovers, tests/_shared/temp-census.ts): tests had left
// hundreds of thousands of entries in this machine's /tmp before the census.
const realEnv = process.env;
const outerTmpdir = realEnv.TMPDIR;
const fileRoot = mkdtempSync(join(tmpdir(), 'vc-test-'));
const fileTmp = join(fileRoot, 'tmp');
mkdirSync(fileTmp);
process.env.TMPDIR = fileTmp;
// The census needs a fresh worker process per file. A reused one (vitest
// `isolate: false`) still has the last file's replaced process.env object, so
// the line above never reaches the real environment os.tmpdir() reads, and
// the census would inspect an empty dir and pass whatever a test leaves.
if (tmpdir() !== fileTmp) {
  rmSync(fileRoot, { recursive: true, force: true });
  throw new Error(
    `the temp census needs each test file in its own worker process, but os.tmpdir() is ` +
      `${tmpdir()} here, not this file's ${fileTmp}: the worker was reused (isolate: false), ` +
      "so a temp dir a test leaves would go unseen. Run with vitest's default isolation.",
  );
}

// Per-file uplink-lock dir: vitest workers are real processes, and the
// cross-process uplink lock (src/lib/deploy/uplink-lock.js) would otherwise
// serialize unrelated test files through one real home-dir lock, and leave
// lock residue behind on aborted runs. Isolation here, not fs mocking, per
// the unit-test-mocking house rule. Beside the census dir, not in it.
mkdirSync(join(fileRoot, 'uplink'));
process.env.VIBECARBON_UPLINK_LOCK_DIR = join(fileRoot, 'uplink', 'uplink-push.lock');

// The secret-fingerprint HMAC key (src/lib/deploy/secret-fingerprint.js) is
// minted under the home dir by default; tests get a per-file dir so no
// caller (digestEnvLocalSecrets, tokenFingerprint) touches the developer's
// real ~/.vibecarbon.
process.env.VIBECARBON_FINGERPRINT_KEY_DIR = join(fileRoot, 'fpkey');
mkdirSync(process.env.VIBECARBON_FINGERPRINT_KEY_DIR, { mode: 0o700 });

// Pulumi records each workspace's selected stack under PULUMI_HOME/workspaces,
// one file per throwaway project: one laptop's ~/.pulumi held 8,700 of them.
// Every file gets its own home, inside the census root so it is removed with
// it. The installed plugins and the CLI are shared by symlink, so nothing is
// downloaded again; only the two that exist are linked, and the real home is
// only read, never written.
const realPulumiHome = realEnv.PULUMI_HOME || join(homedir(), '.pulumi');
const fileDirPulumi = join(fileRoot, 'pulumi-home');
mkdirSync(fileDirPulumi);
for (const shared of ['plugins', 'bin']) {
  if (existsSync(join(realPulumiHome, shared))) {
    symlinkSync(join(realPulumiHome, shared), join(fileDirPulumi, shared));
  }
}
process.env.PULUMI_HOME = fileDirPulumi;

import { afterAll, afterEach, beforeAll } from 'vitest';
import { removeWorkspaceDirs } from '../../src/lib/iac/workspace-dir.js';
import { closeTempRoot } from '../_shared/temp-census.js';
import { cleanupAllTempDirs } from '../_shared/temp-dir.js';

// An in-process deploy reads the version channel at its start. No test reaches
// the real file: it would make a test's versions depend on the published list.
// A test that wants a channel stubs fetch itself.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  String(input).includes('/hyperformant/vibecarbon/channel/')
    ? Promise.reject(new Error('no version channel in tests'))
    : realFetch(input, init)) as typeof fetch;

// A test that reaches the real updateProjectConfig without its own cwd writes
// the repo's own .vibecarbon.json (and its lock or temp file). One that
// reaches the real ensureStatePassphrase (any getOrCreateStack caller) also
// writes a generated VIBECARBON_STATE_PASSPHRASE into the repo's .env.local.
// Record what is there now; a file that appears during this test file's run
// (or a parallel one's) fails it, and is removed so it cannot hide the next
// occurrence.
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CONFIG_RESIDUE = [
  '.vibecarbon.json',
  '.vibecarbon.json.lock',
  '.vibecarbon.json.lock.break',
  '.vibecarbon.json.tmp',
  '.env.local',
  '.env',
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
  // Remove the temp dirs this file's tests made. One that cannot be removed
  // (a test left a dir it locked) fails the file through `problems`, and the
  // census, the residue check and the TMPDIR restore below still run.
  let cleanupProblem: string | null = null;
  try {
    await cleanupAllTempDirs();
    // The Pulumi workspace directories this file's stack opens made, before
    // the census looks: a worker's exit hook would remove them only after it.
    removeWorkspaceDirs();
  } catch (err) {
    cleanupProblem = `the temp dirs this file's tests made could not all be removed (${(err as Error).message})`;
  }
  // A census that throws still fails the file, through `problems`, so the
  // residue check and the TMPDIR restore below always run.
  let tempProblem: string | null;
  try {
    tempProblem = closeTempRoot(fileRoot, fileTmp);
  } catch (err) {
    tempProblem = `the temp census could not finish (${(err as Error).message})`;
    try {
      rmSync(fileRoot, { recursive: true, force: true });
    } catch (rmErr) {
      tempProblem += `, and ${fileRoot} is still there (${(rmErr as Error).message})`;
    }
  }

  const appeared = CONFIG_RESIDUE.filter(
    (f) => !residueAtStart.has(f) && existsSync(join(REPO_ROOT, f)),
  );
  for (const f of appeared) rmSync(join(REPO_ROOT, f), { force: true });

  // Restore original environment, and the process's own TMPDIR (os.tmpdir()
  // reads the real environment, not a replaced process.env object).
  process.env = originalEnv;
  if (outerTmpdir === undefined) delete realEnv.TMPDIR;
  else realEnv.TMPDIR = outerTmpdir;

  const problems: string[] = [];
  if (appeared.length > 0) {
    problems.push(
      `a test wrote ${appeared.join(', ')} at the repo root (removed now): stub ` +
        'updateProjectConfig and ensureStatePassphrase, or point the test at a temp dir ' +
        '(vi.spyOn(process, "cwd"))',
    );
  }
  if (cleanupProblem) problems.push(cleanupProblem);
  if (tempProblem) problems.push(tempProblem);
  if (problems.length > 0) throw new Error(problems.join('. Also, '));
});
