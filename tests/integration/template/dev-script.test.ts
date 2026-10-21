import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

/**
 * Shutdown ordering: on Ctrl+C dev.js SIGTERMs its child process groups and
 * must WAIT for them to exit before exiting itself. Exiting first hands the
 * shell prompt back while the API is still mid-graceful-shutdown, so its last
 * log lines ("Shutting down gracefully..." / "All connections closed") land on
 * top of the prompt — which reads as a hung process and invites a second ^C.
 *
 * The test swaps in a fake `npx` on PATH so the children are scripts we
 * control: they announce when they start, and on SIGTERM take a beat before
 * printing `child-done` and exiting (mimicking the API's server.close()).
 */
describe('carbon/scripts/dev.js shutdown ordering', () => {
  let tmpDir: string;
  let childPids: number[] = [];

  /** Install a fake `npx` in tmpDir/bin that runs the given child script. */
  async function installFakeNpx(childSource: string): Promise<string> {
    const binDir = join(tmpDir, 'bin');
    await mkdir(binDir);
    const childJs = join(tmpDir, 'fake-child.js');
    await writeFile(childJs, childSource);
    const npx = join(binDir, 'npx');
    await writeFile(npx, `#!/bin/sh\nexec "${process.execPath}" "${childJs}" "$@"\n`);
    await chmod(npx, 0o755);
    return binDir;
  }

  /**
   * Start dev.js, wait until both children have announced themselves, send
   * SIGINT, and report whether `child-done` had been seen by the moment
   * dev.js itself exited.
   */
  function runShutdown(
    binDir: string,
    opts: { secondInterruptAfterMs?: number } = {},
  ): Promise<{ doneBeforeExit: boolean; stdout: string; exitAfterMs: number }> {
    return new Promise((resolve, reject) => {
      let interruptedAt = 0;
      const child = spawn(process.execPath, [DEV_JS], {
        cwd: tmpDir,
        stdio: 'pipe',
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      });
      let stdout = '';
      let interrupted = false;
      child.stdout.on('data', (b) => {
        stdout += b.toString();
        for (const m of stdout.matchAll(/child-started (\d+)/g)) {
          const pid = Number(m[1]);
          if (!childPids.includes(pid)) childPids.push(pid);
        }
        if (!interrupted && childPids.length >= 2) {
          interrupted = true;
          interruptedAt = Date.now();
          child.kill('SIGINT');
          if (opts.secondInterruptAfterMs !== undefined) {
            setTimeout(() => child.kill('SIGINT'), opts.secondInterruptAfterMs);
          }
        }
      });
      child.stderr.on('data', (b) => {
        stdout += b.toString();
      });
      child.on('exit', () => {
        const doneCount = (stdout.match(/child-done/g) ?? []).length;
        resolve({
          doneBeforeExit: doneCount === 2,
          stdout,
          exitAfterMs: Date.now() - interruptedAt,
        });
      });
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          reject(new Error(`dev.js did not exit\n${stdout}`));
        }
      }, 12_000);
    });
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vibecarbon-dev-shutdown-'));
    await writeFile(join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-app' }));
    const apiPort = await freePort();
    const vitePort = await freePort();
    await writeFile(
      join(tmpDir, '.env.local'),
      // APP_DB_PASSWORD: dev.js hands it to the API server as app_service's
      // password and refuses to start without it.
      `DEV_API_PORT="${apiPort}"\nDEV_VITE_PORT="${vitePort}"\nAPP_DB_PASSWORD="SENTINEL_APP_DB_PASSWORD"\n`,
    );
  });

  afterEach(async () => {
    // Belt and braces: never leak a fake child past the test.
    for (const pid of childPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone — the expected case
      }
    }
    childPids = [];
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('waits for children to finish their graceful shutdown before exiting', async () => {
    const binDir = await installFakeNpx(`
      process.on('SIGTERM', () => {
        setTimeout(() => { process.stdout.write('child-done\\n'); process.exit(0); }, 500);
      });
      process.stdout.write('child-started ' + process.pid + '\\n');
      setInterval(() => {}, 1000);
    `);

    const result = await runShutdown(binDir);

    expect(result.stdout).toContain('Shutting down...');
    expect(result.doneBeforeExit).toBe(true);
  }, 15_000);

  it('force-kills a child that ignores SIGTERM and still exits', async () => {
    const binDir = await installFakeNpx(`
      process.on('SIGTERM', () => {});
      process.stdout.write('child-started ' + process.pid + '\\n');
      setInterval(() => {}, 1000);
    `);

    const result = await runShutdown(binDir);

    // Say what happened, and to whom, so a slow exit never reads as a hang.
    expect(result.stdout).toMatch(/Waiting for (API|Vite) to exit/);
    expect(result.stdout).toMatch(/(API|Vite) did not exit in time, force-killing/);

    // Give the kernel a tick to reap, then every child must be gone.
    await new Promise((r) => setTimeout(r, 100));
    for (const pid of childPids) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 15_000);

  it('a second Ctrl+C during shutdown force-kills immediately instead of being ignored', async () => {
    const binDir = await installFakeNpx(`
      process.on('SIGTERM', () => {});
      process.stdout.write('child-started ' + process.pid + '\\n');
      setInterval(() => {}, 1000);
    `);

    // Second press lands after the "Waiting for…" notice (1s), i.e. once the
    // user has been told we are waiting and has chosen to stop waiting.
    const result = await runShutdown(binDir, { secondInterruptAfterMs: 1500 });

    // Well under the 5s grace period: the second ^C did the killing.
    expect(result.exitAfterMs).toBeLessThan(3000);
    expect(result.stdout).toMatch(/force-killing/);
    await new Promise((r) => setTimeout(r, 100));
    for (const pid of childPids) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 15_000);

  it('an immediately-relayed duplicate SIGINT (npm run) does not skip graceful shutdown', async () => {
    // `npm run dev` forwards SIGINT to its child, so one Ctrl+C reaches dev.js
    // twice within a few ms. That must not count as "press again to force".
    const binDir = await installFakeNpx(`
      process.on('SIGTERM', () => {
        setTimeout(() => { process.stdout.write('child-done\\n'); process.exit(0); }, 500);
      });
      process.stdout.write('child-started ' + process.pid + '\\n');
      setInterval(() => {}, 1000);
    `);

    const result = await runShutdown(binDir, { secondInterruptAfterMs: 20 });

    expect(result.stdout).not.toMatch(/force-killing/);
    expect(result.doneBeforeExit).toBe(true);
  }, 15_000);
});

/**
 * `npm run dev:server` once ran `tsx --env-file=.env.local` directly, so the
 * API connected as the owner (.env.local's DB_PASSWORD). It now goes through
 * dev.js --server-only, which hands the API the same app_service env as
 * `npm run dev` and starts no Vite.
 */
describe('carbon dev:server runs the API as app_service', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vibecarbon-dev-server-'));
    await writeFile(join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-app' }));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('the package script routes through dev.js --server-only', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'carbon', 'package.json'), 'utf-8'));
    expect(pkg.scripts['dev:server']).toBe('node scripts/dev.js --server-only');
  });

  it('spawns only the API, with DB_USER=app_service and the app password', async () => {
    const apiPort = await freePort();
    await writeFile(
      join(tmpDir, '.env.local'),
      `DEV_API_PORT="${apiPort}"\nDB_PASSWORD="SENTINEL_OWNER"\nAPP_DB_PASSWORD="SENTINEL_APP"\n`,
    );
    const binDir = join(tmpDir, 'bin');
    await mkdir(binDir);
    const childJs = join(tmpDir, 'fake-child.js');
    await writeFile(
      childJs,
      // Stays up a beat, so a Vite child spawned beside it would report too.
      "process.stdout.write('spawned ' + process.argv.slice(2).join(' ') + ' user=' + process.env.DB_USER + ' pw=' + process.env.DB_PASSWORD + '\\n'); setTimeout(() => process.exit(0), 1000);",
    );
    await writeFile(
      join(binDir, 'npx'),
      `#!/bin/sh\nexec "${process.execPath}" "${childJs}" "$@"\n`,
    );
    await chmod(join(binDir, 'npx'), 0o755);
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [DEV_JS, '--server-only'], {
        cwd: tmpDir,
        stdio: 'pipe',
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      });
      let buf = '';
      child.stdout.on('data', (b) => {
        buf += b.toString();
      });
      child.stderr.on('data', (b) => {
        buf += b.toString();
      });
      child.on('exit', () => resolve(buf));
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 8000);
    });
    const spawned = out.split('\n').filter((l) => l.startsWith('spawned '));
    expect(spawned, out).toHaveLength(1);
    expect(spawned[0]).toContain('tsx watch --env-file=.env.local src/server/index.ts');
    expect(spawned[0]).toContain('user=app_service pw=SENTINEL_APP');
  }, 15_000);
});
