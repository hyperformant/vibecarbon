import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

// setupServer holds one ssh session for /var/lib/vibecarbon/ready and shows
// the boot log's latest stage in the spinner. spawn is faked; the spinner is
// captured.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

const H = vi.hoisted(() => ({
  messages: [] as string[],
  stops: [] as string[],
  animate: false,
}));
vi.mock('../../../src/lib/cli/progress.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/cli/progress.js')>()),
  shouldAnimateSpinner: () => H.animate,
  spinner: () => ({
    start: (m: string) => H.messages.push(m),
    message: (m: string) => H.messages.push(m),
    stop: (m: string) => H.stops.push(m),
  }),
}));

interface Fake {
  code?: number;
  chunks?: string[];
  stderr?: string;
  closeMs?: number;
}

function fakeChild({ code = 0, chunks = [], stderr = '', closeMs = 30 }: Fake = {}) {
  const child = {
    stdout: {
      on(event: string, cb: (d: string) => void) {
        if (event === 'data') for (const c of chunks) Promise.resolve().then(() => cb(c));
      },
    },
    stderr: {
      on(event: string, cb: (d: string) => void) {
        if (event === 'data' && stderr) Promise.resolve().then(() => cb(stderr));
      },
    },
    kill: vi.fn(),
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'close') setTimeout(() => cb(code), closeMs);
      return child;
    },
  };
  return child as unknown as ReturnType<typeof spawn>;
}

/** The held-session spawns (script contains the marker path), in order. */
function sessionScripts() {
  return vi
    .mocked(spawn)
    .mock.calls.map((c) => (c[1] as string[]).at(-1) as string)
    .filter((cmd) => cmd.includes('/var/lib/vibecarbon/ready'));
}

/** Sessions answer from `sessions` in order; anything else exits quietly. */
function route(sessions: Fake[], other: (cmd: string) => Fake = () => ({})) {
  let i = 0;
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(((_bin: string, argv: string[]) => {
    const cmd = argv.at(-1) as string;
    if (cmd.includes('/var/lib/vibecarbon/ready')) {
      return fakeChild(sessions[Math.min(i++, sessions.length - 1)]);
    }
    return fakeChild(other(cmd));
  }) as unknown as typeof spawn);
}

async function setup() {
  H.messages = [];
  H.stops = [];
  H.animate = false;
  return (await import('../../../src/lib/deploy/compose/index.js')).setupServer;
}

afterEach(() => vi.restoreAllMocks());

describe('setupServer stage labels', () => {
  it('shows the latest stage from real fractional-epoch boot marks', async () => {
    const setupServer = await setup();
    route([{ chunks: ['CONNECTED\nu 1762288000.123456789\n', 'READY\n'] }]);

    await setupServer('1.2.3.4', '/tmp/key', 60_000);

    const [bin, argv] = vi.mocked(spawn).mock.calls[0] as [string, string[]];
    expect(bin).toBe('ssh');
    expect(argv.join(' ')).toContain('/var/lib/vibecarbon/ready');
    expect(H.messages.some((m) => m.endsWith(': setting up the firewall'))).toBe(true);
    expect(H.stops).toEqual(['Server 1.2.3.4 ready (cloud-init complete)']);
  });

  it('does not walk the label backwards when a reconnect replays the whole log', async () => {
    const setupServer = await setup();
    route([
      // Hold expired (exit 124) after two marks; the reconnect replays from line 1.
      { code: 124, chunks: ['CONNECTED\nd 1762288000.5\nu 1762288010.5\n'] },
      { chunks: ['CONNECTED\nd 1762288000.5\nREADY\n'] },
    ]);

    await setupServer('1.2.3.4', '/tmp/key', 60_000);

    expect(H.messages.some((m) => m.endsWith(': setting up the firewall'))).toBe(true);
    const last = [...H.messages].reverse().find((m) => m.includes(': '));
    expect(last).toMatch(/setting up the firewall$/);
    const lastFirewall = H.messages.map((m) => m.endsWith('firewall')).lastIndexOf(true);
    expect(H.messages.slice(lastFirewall).some((m) => m.endsWith('starting Docker'))).toBe(false);
  });

  it('passes onStdoutLine: a streamed mark shows even when the session exits 124', async () => {
    const setupServer = await setup();
    route([{ code: 124, chunks: ['CONNECTED\nu 1762288000.1\n'] }]);

    await expect(setupServer('1.2.3.4', '/tmp/key', 100)).rejects.toThrow(/cloud-init/);
    expect(H.messages.some((m) => m.endsWith(': setting up the firewall'))).toBe(true);
  });
});

describe('setupServer spinner ticker', () => {
  const slowReady = { chunks: ['CONNECTED\n', 'READY\n'], closeMs: 1300 };

  it('ticks the elapsed time every second when the spinner animates', async () => {
    const setupServer = await setup();
    H.animate = true;
    route([slowReady]);
    await setupServer('1.2.3.4', '/tmp/key', 60_000);
    expect(H.messages.some((m) => m.includes('(1s)'))).toBe(true);
  });

  it('does not tick on quiet output, but still renders on connect and on a stage change', async () => {
    const setupServer = await setup();
    H.animate = false;
    route([{ chunks: ['CONNECTED\n', 'u 1762288000.1\n', 'READY\n'], closeMs: 1300 }]);
    await setupServer('1.2.3.4', '/tmp/key', 60_000);
    expect(H.messages.some((m) => m.includes('(1s)'))).toBe(false);
    expect(H.messages.length).toBe(3); // start, connected, stage label
  });

  it('leaves no timer running after the wait fails', async () => {
    const setupServer = await setup();
    H.animate = true;
    route([{ code: 255, stderr: 'Connection refused' }]);
    await expect(setupServer('1.2.3.4', '/tmp/key', 100)).rejects.toThrow();
    const seen = H.messages.length;
    await new Promise((r) => setTimeout(r, 1200));
    expect(H.messages.length).toBe(seen);
  });
});

describe('setupServer failure paths', () => {
  it('never connected: the SSH-unreachable error and no tail capture', async () => {
    const setupServer = await setup();
    route([{ code: 255, stderr: 'Connection refused' }]);
    await expect(setupServer('1.2.3.4', '/tmp/key', 100)).rejects.toThrow(
      /Could not SSH to 1\.2\.3\.4 within 0s; the server was created, but no SSH connection ever succeeded/,
    );
    expect(H.stops).toEqual(['Could not reach 1.2.3.4 over SSH']);
    const tails = vi
      .mocked(spawn)
      .mock.calls.filter((c) => (c[1] as string[]).at(-1)?.includes('cloud-init-output.log'));
    expect(tails).toHaveLength(0);
  });

  it('connected but the marker never appears: cloud-init error with the captured tail', async () => {
    const setupServer = await setup();
    route([{ code: 124, chunks: ['CONNECTED\n'] }], (cmd) =>
      cmd.includes('cloud-init-output.log') ? { chunks: ['apt-get failed: no space left\n'] } : {},
    );
    await expect(setupServer('1.2.3.4', '/tmp/key', 100)).rejects.toThrow(
      /cloud-init never reached the ready marker on 1\.2\.3\.4 within 0s\.\n--- last 50 lines of \/var\/log\/cloud-init-output\.log ---\napt-get failed: no space left\n--- end cloud-init tail ---/,
    );
    expect(H.stops).toEqual(['cloud-init did not finish on 1.2.3.4']);
  });
});

describe('setupServer ssh options', () => {
  it('bounds the session timeout by the remaining budget plus 5s', async () => {
    const setupServer = await setup();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    route([{ code: 255, stderr: 'Connection refused' }]);
    await expect(setupServer('1.2.3.4', '/tmp/key', 100)).rejects.toThrow();
    const delays = timers.mock.calls.map((c) => Number(c[1]));
    // min(30, ~0.1s) * 1000 + 5000: a real session timeout, never the 120s default.
    expect(delays.some((d) => d >= 5000 && d <= 5100)).toBe(true);
  });

  it('makes a single ssh attempt per session (retries: 1)', async () => {
    const setupServer = await setup();
    route([{ code: 255, stderr: 'Connection refused' }]);
    await expect(setupServer('1.2.3.4', '/tmp/key', 100)).rejects.toThrow();
    expect(sessionScripts()).toHaveLength(1);
  });
});
