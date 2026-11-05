import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommandAsync } from '../../../src/lib/command.js';
import { markerWaitScript, waitForRemoteMarker } from '../../../src/lib/deploy/remote-marker.js';

function runScript(script: string): Promise<{ out: string; code: number | null; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', script]);
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('close', (code) => resolve({ out, code, ms: Date.now() - t0 }));
  });
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('markerWaitScript', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'marker dir '));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns READY at once when the marker exists, leaving no tail behind', async () => {
    const marker = join(dir, 'ready');
    const log = join(dir, 'boot log');
    writeFileSync(marker, '');
    writeFileSync(log, 'x\n');
    const r = await runScript(markerWaitScript(marker, { holdS: 30, logPath: log }));
    expect(r.out.split('\n')).toContain('READY');
    expect(r.out.split('\n')[0]).toBe('CONNECTED');
    expect(r.ms).toBeLessThan(1000);
    const ps = await runScript(`pgrep -f '[t]ail -n .*${dir}' || true`);
    expect(ps.out.trim()).toBe('');
  });

  it('returns READY within 1.5s of the marker appearing and streams the log', async () => {
    const marker = join(dir, 'ready');
    const log = join(dir, 'boot.log');
    writeFileSync(log, 'before\n');
    const p = runScript(markerWaitScript(marker, { holdS: 30, logPath: log }));
    await sleepMs(250);
    appendFileSync(log, 'during\n');
    await sleepMs(250);
    writeFileSync(marker, '');
    const r = await p;
    const lines = r.out.split('\n');
    expect(lines).toContain('before');
    expect(lines).toContain('during');
    expect(lines).toContain('READY');
    expect(r.ms).toBeLessThan(1500);
    const ps = await runScript(`pgrep -f '[t]ail -n .*${dir}' || true`);
    expect(ps.out.trim()).toBe('');
  });

  it('works without a log path', async () => {
    const marker = join(dir, 'ready');
    const p = runScript(markerWaitScript(marker, { holdS: 30 }));
    await sleepMs(300);
    writeFileSync(marker, '');
    const r = await p;
    expect(r.out.split('\n')).toContain('READY');
  });

  it('ends itself after holdS with no READY and a non-zero exit', async () => {
    const r = await runScript(
      markerWaitScript(join(dir, 'never'), { holdS: 1, logPath: join(dir, 'l.log') }),
    );
    expect(r.out).not.toContain('READY');
    expect(r.code).not.toBe(0);
    expect(r.ms).toBeLessThan(2500);
  });
});

describe('waitForRemoteMarker', () => {
  // A regression that stops the loop from ending must fail, not hang the suite.
  const wait = (args: Parameters<typeof waitForRemoteMarker>[0]) => {
    let calls = 0;
    return waitForRemoteMarker({
      ...args,
      run: (...a) => {
        if (++calls > 50) throw new Error('run called more than 50 times: loop never ended');
        return args.run(...a);
      },
    });
  };

  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  it('reconnects after a dropped session and finishes ready', async () => {
    const c = clock();
    const outs = [null, 'CONNECTED\n', 'CONNECTED\nREADY\n'];
    let n = 0;
    let connectedCalls = 0;
    const res = await wait({
      run: async () => outs[n++],
      markerPath: '/m',
      deadlineMs: 600_000,
      now: c.now,
      sleep: c.sleep,
      onConnected: () => connectedCalls++,
    });
    expect(res).toEqual({ ready: true, connected: true });
    expect(n).toBe(3);
    expect(connectedCalls).toBe(1);
  });

  it('keeps connected when the held session printed CONNECTED then died (null result)', async () => {
    const c = clock();
    const res = await wait({
      run: async (_s, { onLine }) => {
        onLine('CONNECTED');
        c.advance(30_000);
        return null;
      },
      markerPath: '/m',
      deadlineMs: 60_000,
      now: c.now,
      sleep: c.sleep,
    });
    expect(res).toEqual({ ready: false, connected: true });
  });

  it('is ready from a streamed READY even when the result is null', async () => {
    const res = await wait({
      run: async (_s, { onLine }) => {
        onLine('CONNECTED');
        onLine('READY');
        return null;
      },
      markerPath: '/m',
      deadlineMs: 60_000,
      now: () => 0,
      sleep: async () => {},
    });
    expect(res).toEqual({ ready: true, connected: true });
  });

  it('returns not ready, connected at the deadline when only CONNECTED ever arrives', async () => {
    const c = clock();
    const res = await wait({
      run: async () => {
        c.advance(30_000);
        return 'CONNECTED\n';
      },
      markerPath: '/m',
      deadlineMs: 100_000,
      now: c.now,
      sleep: c.sleep,
    });
    expect(res).toEqual({ ready: false, connected: true });
  });

  it('returns not connected when nothing ever answers', async () => {
    const c = clock();
    const res = await wait({
      run: async () => null,
      markerPath: '/m',
      deadlineMs: 10_000,
      now: c.now,
      sleep: c.sleep,
    });
    expect(res).toEqual({ ready: false, connected: false });
  });

  it('passes log lines to onLine, never the sentinels, and bounds timeoutMs', async () => {
    const c = clock();
    const seen: string[] = [];
    const timeouts: number[] = [];
    await wait({
      run: async (_s, { onLine, timeoutMs }) => {
        timeouts.push(timeoutMs);
        onLine('CONNECTED');
        onLine('1700000000 line');
        c.advance(30_000);
        return 'CONNECTED\n1700000000 line\n';
      },
      markerPath: '/m',
      deadlineMs: 45_000,
      now: c.now,
      sleep: c.sleep,
      onLine: (l) => seen.push(l),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['1700000000 line']));
    expect(timeouts[0]).toBe(35_000);
    expect(timeouts[1]).toBeLessThanOrEqual(15_000 + 5000);
  });
});

describe('waitForRemoteMarker sentinel matching', () => {
  it('counts only a whole READY line, and keeps look-alikes as log lines', async () => {
    let t = 0;
    const seen: string[] = [];
    const res = await waitForRemoteMarker({
      run: async (_s, { onLine }) => {
        onLine('CONNECTED');
        onLine('NOT_READY');
        onLine('u 1.2 READY');
        t += 60_000;
        return null;
      },
      markerPath: '/m',
      deadlineMs: 30_000,
      now: () => t,
      sleep: async () => {},
      onLine: (l) => seen.push(l),
    });
    expect(res).toEqual({ ready: false, connected: true });
    expect(seen).toEqual(['NOT_READY', 'u 1.2 READY']);
  });

  it('does not treat look-alikes in the resolved stdout as READY either', async () => {
    let t = 0;
    const res = await waitForRemoteMarker({
      run: async () => {
        t += 60_000;
        return 'CONNECTED\nNOT_READY\nu 1.2 READY\n';
      },
      markerPath: '/m',
      deadlineMs: 30_000,
      now: () => t,
      sleep: async () => {},
    });
    expect(res.ready).toBe(false);
  });

  it('keeps a real READY line out of onLine', async () => {
    const seen: string[] = [];
    const res = await waitForRemoteMarker({
      run: async (_s, { onLine }) => {
        onLine('CONNECTED');
        onLine('d 1.5');
        onLine('READY');
        return null;
      },
      markerPath: '/m',
      deadlineMs: 30_000,
      now: () => 0,
      sleep: async () => {},
      onLine: (l) => seen.push(l),
    });
    expect(res).toEqual({ ready: true, connected: true });
    expect(seen).toEqual(['d 1.5']);
  });
});

describe('runCommandAsync onStdoutLine', () => {
  const script = 'printf "a\\nb"; sleep 0.2; printf "c\\n"';
  it('delivers lines as they complete and leaves the result unchanged', async () => {
    const lines: string[] = [];
    const withOpt = await runCommandAsync(['sh', '-c', script], {
      silent: true,
      onStdoutLine: (l: string) => lines.push(l),
    });
    const without = await runCommandAsync(['sh', '-c', script], { silent: true });
    expect(lines).toEqual(['a', 'bc']);
    expect(withOpt).toBe(without);
  });
});
