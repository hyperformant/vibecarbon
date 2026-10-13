/**
 * The deploy's "can the operator sign in?" gate (src/lib/deploy/admin-ready.js).
 *
 * The app creates its own super admin at startup from ADMIN_EMAIL /
 * ADMIN_PASSWORD and reports `adminReady` on GET /api/health. Every deploy
 * mode waits for that flag instead of provisioning an account through an
 * external auth API: compose and compose-ha over `docker compose exec`
 * (waitForAdminReady), k8s and k8s-ha over `kubectl exec` (awaitAppAdminReady).
 * Both run the same in-container probe script, pinned here by executing it
 * in-process against a real local HTTP server.
 */
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_PROBE_EXIT,
  adminReadyProbeScript,
  describeAdminProbeExit,
} from '../../../src/lib/deploy/admin-ready.js';
import { waitForAdminReady } from '../../../src/lib/deploy/compose/index.js';
import { awaitAppAdminReady } from '../../../src/lib/deploy/k8s/readiness.js';

const requireForScript = createRequire(import.meta.url);

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  server = null;
});

/** Serve one fixed response; resolve with the port. */
async function serve(status: number, body: string): Promise<number> {
  server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}

/** Run the probe script in-process against `port`; resolve with its exit code. */
function runProbe(port: number): Promise<number> {
  const script = adminReadyProbeScript()
    .replace("host:'localhost'", "host:'127.0.0.1'")
    .replace('port:3000', `port:${port}`);
  return new Promise((resolve) => {
    let done = false;
    const fakeProcess = {
      exit: (code: number) => {
        if (!done) {
          done = true;
          resolve(code);
        }
        // The real process would stop here; keep the callback from running on.
        throw new Error('__probe_exit__');
      },
    };
    const swallow = (fn: () => void) => () => {
      try {
        fn();
      } catch (err) {
        if ((err as Error).message !== '__probe_exit__') throw err;
      }
    };
    // Wrap every callback the script registers so the simulated exit unwinds
    // cleanly instead of surfacing as an uncaught error.
    const http = requireForScript('node:http');
    const wrappedRequire = (id: string) =>
      id === 'http'
        ? {
            get: (opts: object, cb: (res: NodeJS.EventEmitter) => void) => {
              // biome-ignore lint/suspicious/noExplicitAny: patching a live IncomingMessage
              const req = http.get(opts, (res: any) => {
                const on = res.on.bind(res);
                res.on = (ev: string, fn: (...a: unknown[]) => void) =>
                  on(ev, (...a: unknown[]) => swallow(() => fn(...a))());
                swallow(() => cb(res))();
              });
              const reqOn = req.on.bind(req);
              req.on = (ev: string, fn: (...a: unknown[]) => void) =>
                reqOn(ev, (...a: unknown[]) => swallow(() => fn(...a))());
              return req;
            },
          }
        : requireForScript(id);
    swallow(() => new Function('require', 'process', script)(wrappedRequire, fakeProcess))();
  });
}

describe('adminReadyProbeScript (runs inside the app container)', () => {
  it('exits READY only when /api/health says adminReady: true', async () => {
    const port = await serve(200, JSON.stringify({ status: 'ok', adminReady: true }));
    expect(await runProbe(port)).toBe(ADMIN_PROBE_EXIT.READY);
  });

  it('exits ADMIN_PENDING while the app serves but the admin is not ready', async () => {
    const port = await serve(200, JSON.stringify({ status: 'ok', adminReady: false }));
    expect(await runProbe(port)).toBe(ADMIN_PROBE_EXIT.ADMIN_PENDING);
  });

  it('treats a missing flag (an app image from before the flag) as not ready', async () => {
    const port = await serve(200, JSON.stringify({ status: 'ok' }));
    expect(await runProbe(port)).toBe(ADMIN_PROBE_EXIT.ADMIN_PENDING);
  });

  it('exits UNHEALTHY on a non-2xx or a non-JSON body', async () => {
    expect(await runProbe(await serve(503, '{}'))).toBe(ADMIN_PROBE_EXIT.UNHEALTHY);
    await new Promise<void>((r) => server?.close(() => r()));
    expect(await runProbe(await serve(200, '<html>'))).toBe(ADMIN_PROBE_EXIT.UNHEALTHY);
  });

  it('exits UNREACHABLE when nothing listens', async () => {
    const port = await serve(200, '{}');
    await new Promise<void>((r) => server?.close(() => r()));
    server = null;
    expect(await runProbe(port)).toBe(ADMIN_PROBE_EXIT.UNREACHABLE);
  });

  it('every probe exit code has an operator-facing reading', () => {
    for (const code of Object.values(ADMIN_PROBE_EXIT)) {
      expect(describeAdminProbeExit(code)).not.toMatch(/could not run/);
    }
    expect(describeAdminProbeExit(127)).toMatch(/exit 127/);
  });
});

describe('waitForAdminReady (compose, compose-ha)', () => {
  it('polls the app container until it reports the admin ready', async () => {
    const outputs = ['exit=2', 'exit=4', 'exit=0'];
    const sshRun = vi.fn(async () => outputs.shift() ?? 'exit=0');
    const result = await waitForAdminReady('1.2.3.4', '/key', 'proj', {
      sshRun,
      delayMs: 0,
    });
    expect(result.message).toMatch(/ready/i);
    expect(sshRun).toHaveBeenCalledTimes(3);
    const cmd = sshRun.mock.calls[0][2] as string;
    expect(cmd).toContain('cd /opt/proj');
    expect(cmd).toContain('docker compose exec -T app node -');
    // No tunnel, no published port.
    expect(cmd).not.toMatch(/ssh -L|localhost:8000/);
  });

  it('fails the deploy with the cause and the app log tail when the admin never appears', async () => {
    const sshRun = vi.fn(async (_ip: string, _key: string, cmd: string) =>
      cmd.includes('logs') ? 'An account with ADMIN_EMAIL (a@b.c) already exists' : 'exit=4',
    );
    await expect(
      waitForAdminReady('1.2.3.4', '/key', 'proj', { sshRun, delayMs: 0, attempts: 3 }),
    ).rejects.toThrow(
      /did not report its super admin ready after 3 probes[\s\S]*has not reported its super admin ready[\s\S]*ADMIN_EMAIL and ADMIN_PASSWORD[\s\S]*already exists/,
    );
  });
});

describe('awaitAppAdminReady (k8s, k8s-ha)', () => {
  const statusErr = (status: number) => Object.assign(new Error(`exit ${status}`), { status });

  it('execs the probe in the app pod and resolves once it exits 0', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(statusErr(ADMIN_PROBE_EXIT.ADMIN_PENDING))
      .mockResolvedValue('');
    await awaitAppAdminReady({ env: {}, exec, sleep: async () => {} });
    expect(exec).toHaveBeenCalledTimes(2);
    const argv = exec.mock.calls[0][0] as string[];
    expect(argv.slice(0, 8)).toEqual([
      'kubectl',
      '-n',
      'vibecarbon',
      'exec',
      'deploy/app',
      '-c',
      'app',
      '--',
    ]);
    expect(argv).not.toContain('port-forward');
  });

  it('throws naming what is missing and where to read the app log', async () => {
    let t = 0;
    const exec = vi.fn().mockRejectedValue(statusErr(ADMIN_PROBE_EXIT.ADMIN_PENDING));
    await expect(
      awaitAppAdminReady({
        env: {},
        exec,
        budgetMs: 5000,
        sleep: async () => {},
        nowFn: () => {
          t += 2000;
          return t;
        },
      }),
    ).rejects.toThrow(
      /has not reported its super admin ready[\s\S]*kubectl -n vibecarbon logs deploy\/app -c app/,
    );
  });
});
