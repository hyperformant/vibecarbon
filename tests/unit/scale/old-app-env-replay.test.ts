/**
 * Scale replays the old server's `app.env` storage pair (security plan
 * 2026-10-20, Task 1). The read is its own step in the arm; the `.env` is read
 * once, in the preflight.
 * Task 4: an app.env the server says it does not have is told apart from a
 * read that failed; a failed read stops that server's scale rather than hand
 * the new app the `.env`'s infra pair.
 * Sentinel values only.
 */
import { describe, expect, it, vi } from 'vitest';
import { readRepoFile } from '../../_shared/source-files.js';

// Same safety-mock recipe as apply-ca-bounds-to-config.test.ts: scale.js's
// module graph must resolve at import time, none of it is exercised here.
vi.mock('@clack/prompts', async (orig) =>
  (await import('../../_shared/clack-fake.js')).quietClack(await orig(), {
    log: ['info', 'warn', 'error', 'step', 'success'],
    spinner: true,
    fns: ['note', 'outro'],
  }),
);
vi.mock('../../../src/lib/iac/converge-cluster.js', () => ({
  convergeClusterInfra: vi.fn(async () => ({ outputs: {} })),
}));
vi.mock('../../../src/lib/command.js', () => ({ runCommand: vi.fn(() => '') }));
vi.mock('../../../src/lib/config.js', () => ({ updateProjectConfig: vi.fn() }));

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
    const src = readRepoFile('src/scale.js');
    // The read lives in prepareReplacementServer, not in a catch of its own...
    const prepStart = src.indexOf('async function prepareReplacementServer(');
    const prepEnd = src.indexOf('\n}\n', prepStart);
    const appRead = src.indexOf('oldAppEnv = await readOldAppEnv(', prepStart);
    expect(prepStart).toBeGreaterThan(-1);
    expect(appRead).toBeGreaterThan(prepStart);
    expect(appRead).toBeLessThan(prepEnd);
    expect(src.slice(appRead - 200, appRead)).not.toMatch(/try\s*\{\s*$/);
    // ...and every arm calls it inside the try whose catch deletes the new server.
    const calls = [...src.matchAll(/newIp = await prepareReplacementServer\(/g)];
    expect(calls.length).toBe(2);
    for (const call of calls) {
      const before = src.slice(0, call.index);
      expect(before.lastIndexOf('try {')).toBeGreaterThan(
        before.lastIndexOf('createReplacementServer('),
      );
    }
  });

  /** The source of one top-level function of scale.js, up to its closing brace. */
  const fnSource = (src: string, name: string) => {
    const start = src.search(new RegExp(`\\n(?:export )?async function ${name}\\(`));
    expect(start, name).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\n}\n', start));
  };

  it('reads app.env in the arm, apart from the preflight .env read', async () => {
    const src = readRepoFile('src/scale.js');
    // The .env is read once, in the preflight, before any server is built.
    expect(fnSource(src, 'scalePreflight')).toContain('await readOldServerEnv(');
    expect(fnSource(src, 'scalePreflight')).not.toContain('readOldAppEnv(');
    // app.env in the arm, where no .env read's catch can take its failure.
    const arm = fnSource(src, 'prepareReplacementServer');
    expect(arm).toContain('const oldAppEnv = await readOldAppEnv(');
    expect(arm).not.toContain('readOldServerEnv(');
    expect(arm).not.toMatch(/\.env`\]/);
  });

  it('a failed old-server .env read stops the scale instead of using the project .env', async () => {
    // The behavior (nothing built, the message) is in
    // compose-scale-image-delta.test.ts; this pins that no fallback exists.
    const read = fnSource(readRepoFile('src/scale.js'), 'readOldServerEnv');
    expect(read).toMatch(/throw new Error\(\s*`could not read \.env on the old server/);
    expect(read).not.toMatch(/readEnvFiles|falling back to project \.env/);
  });
});
