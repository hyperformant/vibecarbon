import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Behavioural tests for carbon/scripts/dev.js port pre-flight + lifecycle.
 *
 * The reproduced bug: an orphan dev:server squatting the API port caused
 * `tsx watch` to swallow EADDRINUSE while Vite kept serving on its own port.
 * `/api/*` requests then returned 502 with empty bodies, surfacing in the UI
 * as "Unexpected end of JSON input". The fix is two-fold:
 *
 *   1. dev.js does a pre-flight port check and exits 1 with a clear message
 *      before spawning anything when the API/Vite port is already taken.
 *   2. If either child exits unexpectedly later, dev.js shuts down the rest
 *      and exits non-zero rather than leaving Vite serving a dead app.
 *
 * These tests exercise (1) end-to-end against the real dev.js script. They
 * deliberately drive the script with hand-crafted .env files in a temp dir
 * rather than mocking; the goal is to verify the actual port-check logic.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const DEV_JS = join(REPO_ROOT, 'carbon', 'scripts', 'dev.js');

/** Bind a TCP port so the next test sees it as "in use". */
function squatPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(port, '0.0.0.0', () => resolve(srv));
  });
}

/** Pick a port that is currently free. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '0.0.0.0', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('no address'));
      }
    });
  });
}

/** Run dev.js in a temp project dir; capture exit + stderr. */
function runDevJs(cwd: string): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DEV_JS], { cwd, stdio: 'pipe' });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });
    child.stdout.on('data', (b) => {
      stdout += b.toString();
    });
    child.on('exit', (code) => resolve({ code, stderr, stdout }));
    // Safety: if pre-flight passes and dev.js tries to spawn tsx/vite, kill
    // it quickly so a stray child doesn't outlive the test.
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
    }, 4000);
  });
}

describe('carbon/scripts/dev.js port pre-flight', () => {
  let tmpDir: string;
  let squatters: Server[] = [];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vibecarbon-dev-test-'));
    await writeFile(join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-app' }));
  });

  afterEach(async () => {
    for (const s of squatters) {
      await new Promise<void>((r) => s.close(() => r()));
    }
    squatters = [];
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('exits 1 with a clear message when the API port is already in use', async () => {
    const apiPort = await freePort();
    const vitePort = await freePort();
    await writeFile(
      join(tmpDir, '.env.local'),
      `DEV_API_PORT="${apiPort}"\nDEV_VITE_PORT="${vitePort}"\n`,
    );

    // Squat the API port AFTER writing the env so dev.js sees it as taken.
    squatters.push(await squatPort(apiPort));

    const result = await runDevJs(tmpDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/port conflict/i);
    expect(result.stderr).toContain(String(apiPort));
    // Recovery hint should be present so the user knows what to do.
    expect(result.stderr).toMatch(/pkill -f "scripts\/dev\.js"/);
  });

  it('exits 1 when the Vite port is already in use', async () => {
    const apiPort = await freePort();
    const vitePort = await freePort();
    await writeFile(
      join(tmpDir, '.env.local'),
      `DEV_API_PORT="${apiPort}"\nDEV_VITE_PORT="${vitePort}"\n`,
    );
    squatters.push(await squatPort(vitePort));

    const result = await runDevJs(tmpDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/port conflict/i);
    expect(result.stderr).toContain(String(vitePort));
  });

  it('reports BOTH ports when both are taken', async () => {
    const apiPort = await freePort();
    const vitePort = await freePort();
    await writeFile(
      join(tmpDir, '.env.local'),
      `DEV_API_PORT="${apiPort}"\nDEV_VITE_PORT="${vitePort}"\n`,
    );
    squatters.push(await squatPort(apiPort));
    squatters.push(await squatPort(vitePort));

    const result = await runDevJs(tmpDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(String(apiPort));
    expect(result.stderr).toContain(String(vitePort));
  });

  it('passes pre-flight when both ports are free (proceeds to spawn)', async () => {
    const apiPort = await freePort();
    const vitePort = await freePort();
    await writeFile(
      join(tmpDir, '.env.local'),
      `DEV_API_PORT="${apiPort}"\nDEV_VITE_PORT="${vitePort}"\n`,
    );

    const result = await runDevJs(tmpDir);

    // Pre-flight passed → dev.js proceeded to spawn tsx/vite. Those will
    // fail in the temp dir (no src/), but the point is: NO "port conflict"
    // message in stderr, and the script did not exit with code 1 because
    // of pre-flight. The safety timeout kills it after 4s.
    expect(result.stderr).not.toMatch(/port conflict/i);
  });
});
