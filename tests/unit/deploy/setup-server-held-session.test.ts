import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

// setupServer holds one ssh session for /var/lib/vibecarbon/ready and shows
// the boot log's latest stage in the spinner. spawn is faked; the spinner is
// captured.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

const H = vi.hoisted(() => ({ messages: [] as string[], stops: [] as string[] }));
vi.mock('../../../src/lib/cli/progress.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/cli/progress.js')>()),
  spinner: () => ({
    start: (m: string) => H.messages.push(m),
    message: (m: string) => H.messages.push(m),
    stop: (m: string) => H.stops.push(m),
  }),
}));

function fakeChild(code: number, chunks: string[]) {
  const child = {
    stdout: {
      on(event: string, cb: (d: string) => void) {
        if (event === 'data') for (const c of chunks) Promise.resolve().then(() => cb(c));
      },
    },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'close') setTimeout(() => cb(code), 30);
      return child;
    },
  };
  return child as unknown as ReturnType<typeof spawn>;
}

describe('setupServer', () => {
  it('returns on the streamed READY and shows the latest stage label', async () => {
    const { setupServer } = await import('../../../src/lib/deploy/compose/index.js');
    H.messages = [];
    H.stops = [];
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockReset();
    // Held session: connected, a boot mark, then ready. A later spawn (the
    // fire-and-forget boot pull note) just exits quietly.
    spawnMock.mockImplementationOnce(() =>
      fakeChild(0, ['CONNECTED\n1700000000 x\nu 1700000001\n', 'READY\n']),
    );
    spawnMock.mockImplementation(() => fakeChild(0, []));

    await setupServer('1.2.3.4', '/tmp/key', 60_000);

    const [bin, argv] = vi.mocked(spawn).mock.calls[0] as [string, string[]];
    expect(bin).toBe('ssh');
    expect(argv.join(' ')).toContain('/var/lib/vibecarbon/ready');
    expect(H.messages.some((m) => m.endsWith(': installing the firewall'))).toBe(true);
    expect(H.stops).toEqual(['Server 1.2.3.4 ready (cloud-init complete)']);
  });

  it('throws the unreachable error at the deadline and leaves no timer running', async () => {
    const { setupServer } = await import('../../../src/lib/deploy/compose/index.js');
    H.messages = [];
    H.stops = [];
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild(255, []));

    await expect(setupServer('1.2.3.4', '/tmp/key', 100)).rejects.toThrow(/1\.2\.3\.4/);
    expect(H.stops).toEqual(['Could not reach 1.2.3.4 over SSH']);
    const seen = H.messages.length;
    await new Promise((r) => setTimeout(r, 1200));
    expect(H.messages.length).toBe(seen);
  });
});
