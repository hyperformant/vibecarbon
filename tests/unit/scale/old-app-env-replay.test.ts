/**
 * Scale replays the old server's `app.env` storage pair (security plan
 * 2026-10-20, Task 1). The read is its own step after the `.env` replay.
 * Task 4: an app.env the server says it does not have is told apart from a
 * read that failed; a failed read stops that server's scale rather than hand
 * the new app the `.env`'s infra pair.
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

const { NO_APP_ENV_MARKER, readOldAppEnv } = await import('../../../src/scale.js');

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

  it('a server that answers it has no app.env yields null (the .env pair is then carried)', async () => {
    const run = vi.fn(async () => `${NO_APP_ENV_MARKER}`);
    expect(await readOldAppEnv('1.2.3.4', '/k', 'proj', { run, log: silent })).toBeNull();
    const argv = run.mock.calls[0][2] as string[];
    expect(argv[2]).toContain(`else printf '%s' ${NO_APP_ENV_MARKER}`);
  });

  it('an empty app.env is an app with no storage keys, not a missing file', async () => {
    const run = vi.fn(async () => '');
    expect(await readOldAppEnv('1.2.3.4', '/k', 'proj', { run, log: silent })).toEqual({});
  });

  it('a failed read throws, so that server scale stops instead of falling back to the infra pair', async () => {
    const run = vi.fn(async () => {
      throw new Error('ssh: connect to host 1.2.3.4 port 22: Connection timed out');
    });
    await expect(readOldAppEnv('1.2.3.4', '/k', 'proj', { run, log: silent })).rejects.toThrow(
      /could not read app\.env on the old server 1\.2\.3\.4.*account-wide storage key/,
    );
  });
});

describe('scale keeps the .env replay when the app.env read fails', () => {
  it('a failed app.env read is thrown inside the per-server try, whose catch deletes the new server', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/scale.js'), 'utf-8');
    const tryStart = src.indexOf('let newIp;\n    try {');
    const appRead = src.indexOf('oldAppEnv = await readOldAppEnv(', tryStart);
    expect(tryStart).toBeGreaterThan(-1);
    expect(appRead).toBeGreaterThan(tryStart);
    // Not wrapped in its own catch that would swallow it.
    expect(src.slice(appRead - 200, appRead)).not.toMatch(/try\s*\{\s*$/);
  });

  it('reads app.env only after, and outside, the .env read', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/scale.js'), 'utf-8');
    const envRead = src.indexOf('oldEnv = dropUnportableEnv(parseDotenv(envText));');
    const catchAfter = src.indexOf("s.stop('Could not read old-server config", envRead);
    const appRead = src.indexOf('oldAppEnv = await readOldAppEnv(', envRead);
    expect(envRead).toBeGreaterThan(-1);
    // The app.env read sits after the .env try/catch closes, so its failure
    // cannot reach that catch.
    expect(appRead).toBeGreaterThan(catchAfter);
  });

  it('a failed old-server .env read stops that server scale instead of using the project .env', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/scale.js'), 'utf-8');
    const envRead = src.indexOf('oldEnv = dropUnportableEnv(parseDotenv(envText));');
    const nextStep = src.indexOf("s.start('Copying project files...');", envRead);
    const between = src.slice(envRead, nextStep);
    expect(between).toMatch(/throw new Error\(\s*`could not read \.env on the old server/);
    expect(between).not.toMatch(/falling back to project \.env/);
  });
});
