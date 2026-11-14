/**
 * The held app health probe: one node program inside the app container that
 * asks /api/health every 200 ms and exits on the first 2xx, and verifyAppHealth
 * around it (one ssh, one exec, the outer loop only for a restarting container).
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, runCommandAsync: H.run };
});

const { appHealthProbeScript, APP_HEALTH_PROBE_BUDGET_MS, verifyAppHealth } = await import(
  '../../../src/lib/deploy/compose/index.js'
);

function runScript(script: string): Promise<{ code: number | null; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    child.on('exit', (code) => resolve({ code, ms: Date.now() - t0 }));
  });
}

// The script targets localhost:3000; swap the port so the test owns the server.
const forPort = (script: string, port: number) => script.replaceAll('3000', String(port));

let server: http.Server | undefined;
afterEach(() => {
  server?.closeAllConnections?.();
  server?.close();
  server = undefined;
});

const listen = (handler: http.RequestListener): Promise<number> =>
  new Promise((resolve) => {
    server = http.createServer(handler).listen(0, '127.0.0.1', () => {
      resolve((server?.address() as AddressInfo | null)?.port ?? 0);
    });
  });

describe('appHealthProbeScript', () => {
  it('exits 0 on the first 2xx, after 503s, without waiting out a ramp', async () => {
    let n = 0;
    const port = await listen((_req, res) => {
      res.statusCode = ++n <= 2 ? 503 : 200;
      res.end();
    });
    const r = await runScript(forPort(appHealthProbeScript('/api/health', 10_000), port));
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(2000);
  });

  it('exits 1 once the budget passes against a closed port', async () => {
    const port = await listen(() => {});
    server?.close();
    const r = await runScript(forPort(appHealthProbeScript('/api/health', 600), port));
    expect(r.code).toBe(1);
    expect(r.ms).toBeLessThan(3000);
  });

  it('exits 1 at the budget when the server never answers (one hung request cannot outlive it)', async () => {
    const port = await listen(() => {});
    const r = await runScript(forPort(appHealthProbeScript('/api/health', 2500), port));
    expect(r.code).toBe(1);
    expect(r.ms).toBeLessThan(4500);
  });
});

describe('verifyAppHealth', () => {
  afterEach(() => H.run.mockReset());
  const sshArgv = (call: unknown[]) => String((call[0] as string[]).at(-1));

  it('has a 3 minute default budget', () => {
    expect(APP_HEALTH_PROBE_BUDGET_MS).toBe(180_000);
  });

  it('is healthy after one probe ssh call when the probe prints 2xx', async () => {
    H.run.mockImplementation(async (argv: string[]) =>
      String(argv.at(-1)).includes('exec -T app node') ? '2xx\n' : 'app healthy\n',
    );
    const r = await verifyAppHealth('10.0.0.1', '/k', 'myapp', {});
    expect(r.healthy).toBe(true);
    const probes = H.run.mock.calls.filter((c) => sshArgv(c).includes('exec -T app node'));
    expect(probes).toHaveLength(1);
  });

  it('is unhealthy when the probe never succeeds, and still captures ps and the app log', async () => {
    H.run.mockImplementation(async (argv: string[]) =>
      String(argv.at(-1)).includes('exec -T app node') ? 'fail\n' : 'diag\n',
    );
    const r = await verifyAppHealth('10.0.0.1', '/k', 'myapp', { budgetMs: 1500 });
    expect(r.healthy).toBe(false);
    expect(r.details).toMatch(/Health probe failed after \d+ attempts/);
    const cmds = H.run.mock.calls.map(sshArgv);
    expect(cmds.some((c) => c.includes('ps -a'))).toBe(true);
    expect(cmds.some((c) => c.includes('logs --tail=40 app-migrate app'))).toBe(true);
  });

  it('does not retry inside one probe call: the outer loop retries with the remaining time', async () => {
    H.run.mockImplementation(async (argv: string[]) => {
      if (String(argv.at(-1)).includes('exec -T app node'))
        throw new Error('Connection reset by peer');
      return 'diag\n';
    });
    const t0 = Date.now();
    const r = await verifyAppHealth('10.0.0.1', '/k', 'myapp', { budgetMs: 1500 });
    expect(r.healthy).toBe(false);
    // retries 3 would sleep 5s between attempts inside one call, overshooting the 1.5s budget
    expect(Date.now() - t0).toBeLessThan(4000);
    const probes = H.run.mock.calls.filter((c) => sshArgv(c).includes('exec -T app node'));
    expect(probes.length).toBeLessThanOrEqual(2);
  });

  it('starts no probe after the budget when a timer fires a few ms early', async () => {
    // Node checks timers against a loop clock that can trail Date.now(), so a
    // pause can end a millisecond or two before Date.now() says it should.
    // Under parallel load this ran a third probe with about 1 ms left
    // (2026-11-14), and that probe's ssh may take 10 s more. Every timer here
    // fires 5 ms early, so the old deadline check fails every time.
    const realSetTimeout = globalThis.setTimeout;
    const early = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void, ms?: number) =>
        realSetTimeout(fn, Math.max(0, (ms ?? 0) - 5))) as typeof setTimeout);
    try {
      H.run.mockImplementation(async (argv: string[]) =>
        String(argv.at(-1)).includes('exec -T app node') ? 'fail\n' : 'diag\n',
      );
      const r = await verifyAppHealth('10.0.0.1', '/k', 'myapp', { budgetMs: 1500 });
      expect(r.healthy).toBe(false);
      const probes = H.run.mock.calls.filter((c) => sshArgv(c).includes('exec -T app node'));
      expect(probes).toHaveLength(2); // at 0 s and 1 s; none fits after the next 1 s pause
    } finally {
      early.mockRestore();
    }
  });

  it('gives up at once, not at the deadline, when no probe fits in what is left', async () => {
    // A first probe that uses 700 ms of a 1,500 ms budget leaves 800 ms, less
    // than the 1 s pause before the next one: there is nothing left to wait for.
    H.run.mockImplementation(async (argv: string[]) => {
      if (!String(argv.at(-1)).includes('exec -T app node')) return 'diag\n';
      await new Promise((r) => setTimeout(r, 700));
      return 'fail\n';
    });
    const t0 = Date.now();
    const r = await verifyAppHealth('10.0.0.1', '/k', 'myapp', { budgetMs: 1500 });
    expect(r.healthy).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(H.run.mock.calls.filter((c) => sshArgv(c).includes('exec -T app node'))).toHaveLength(1);
  });

  it('re-runs the held probe when exec fails once (container restarting)', async () => {
    let probes = 0;
    H.run.mockImplementation(async (argv: string[]) => {
      if (String(argv.at(-1)).includes('exec -T app node'))
        return ++probes === 1 ? 'fail\n' : '2xx\n';
      return 'app healthy\n';
    });
    const r = await verifyAppHealth('10.0.0.1', '/k', 'myapp', { budgetMs: 20_000 });
    expect(r.healthy).toBe(true);
    expect(probes).toBe(2);
  });
});
