/**
 * Scale replays the old server's `app.env` storage pair (security plan
 * 2026-10-20, Task 1). The read is its own step after the `.env` replay, so a
 * failed or empty app.env read never throws away the `.env` already read.
 * Sentinel values only.
 */
import { describe, expect, it, vi } from 'vitest';

// Same safety-mock recipe as apply-ca-bounds-to-config.test.ts: scale.js's
// module graph must resolve at import time, none of it is exercised here.
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: { info() {}, warn() {}, error() {}, step() {}, success() {} },
    note() {},
    outro() {},
  };
});
vi.mock('../../../src/lib/iac/converge-cluster.js', () => ({
  convergeClusterInfra: vi.fn(async () => ({ outputs: {} })),
}));
vi.mock('../../../src/lib/command.js', () => ({ runCommand: vi.fn(() => '') }));
vi.mock('../../../src/lib/config.js', () => ({ saveProjectConfig: vi.fn() }));

const { readOldAppEnv } = await import('../../../src/scale.js');

const silent = { warn: vi.fn() };

describe('readOldAppEnv', () => {
  it('parses the old app.env, reading it without failing on a missing file', async () => {
    const run = vi.fn(async () => 'S3_ACCESS_KEY=SENTINEL_OLD_APP_PAIR\nS3_BUCKET=old-bucket\n');
    const out = await readOldAppEnv('1.2.3.4', '/k', 'proj', { run, log: silent });
    expect(out).toEqual({ S3_ACCESS_KEY: 'SENTINEL_OLD_APP_PAIR', S3_BUCKET: 'old-bucket' });
    const argv = run.mock.calls[0][2] as string[];
    expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
    expect(argv[2]).toContain('if [ -f "$1" ]');
    expect(argv.at(-1)).toBe('/opt/proj/app.env');
  });

  it('a server without app.env yields null (the .env pair is then carried)', async () => {
    const run = vi.fn(async () => '');
    expect(await readOldAppEnv('1.2.3.4', '/k', 'proj', { run, log: silent })).toBeNull();
  });

  it('a failed read yields null with a warning, never a throw', async () => {
    const log = { warn: vi.fn() };
    const run = vi.fn(async () => {
      throw new Error('ssh: connect to host 1.2.3.4 port 22: Connection timed out');
    });
    expect(await readOldAppEnv('1.2.3.4', '/k', 'proj', { run, log })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/could not read app\.env/));
  });
});

describe('scale keeps the .env replay when the app.env read fails', () => {
  it('reads app.env only after, and outside, the .env read', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/scale.js'), 'utf-8');
    const envRead = src.indexOf('oldEnv = dropUnportableEnv(parseDotenv(envText));');
    const catchAfter = src.indexOf("s.stop('Could not read old-server config", envRead);
    const appRead = src.indexOf('oldAppEnv = await readOldAppEnv(', envRead);
    expect(envRead).toBeGreaterThan(-1);
    // The app.env read sits after the .env try/catch closes, so its failure
    // cannot reach that catch, and readOldAppEnv itself never throws.
    expect(appRead).toBeGreaterThan(catchAfter);
  });
});
