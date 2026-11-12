/**
 * upStack emits `[perf]` timing lines only when perf tracing is on AND the caller
 * named its timer (`perfStem`); the `onEvent` handler itself is always passed
 * (the droplet plan recorder needs it), and `<stem>.prepare` is emitted.
 * The handler pairs real engine events into `[perf] <stem>.resource.*` lines.
 */
import { describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  process.env.VIBECARBON_PERF = '1';
});
void env;

const selectStack = vi.fn();
vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...a: unknown[]) => selectStack(...a),
    createStack: () => {
      throw new Error('no create');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));
vi.mock('../../../src/lib/cli/progress.js', () => ({ progressLog: vi.fn() }));

function fakeStack(onUp: (opts: { onEvent?: (e: unknown) => void }) => void) {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    exportStack: vi
      .fn()
      .mockResolvedValue({ deployment: { resources: [{ type: 'pulumi:pulumi:Stack' }] } }),
    refresh: vi.fn().mockResolvedValue(undefined),
    up: vi.fn(async (opts) => {
      onUp(opts);
      return { outputs: {}, summary: { result: 'succeeded' } };
    }),
    outputs: vi.fn().mockResolvedValue({}),
  };
}

describe('upStack resource timing', () => {
  it('passes onEvent with a perfStem and writes the resource and prepare lines', async () => {
    const urn = 'urn:pulumi:e1::proj::hcloud:index/server:Server::web';
    const stack = fakeStack((opts) => {
      opts.onEvent?.({ resourcePreEvent: { metadata: { op: 'create', urn, type: 'x:y:Server' } } });
      opts.onEvent?.({ resOutputsEvent: { metadata: { op: 'create', urn, type: 'x:y:Server' } } });
    });
    selectStack.mockResolvedValue(stack);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let out = '';
    try {
      const { upStack } = await import('../../../src/lib/iac/index.js');
      await upStack('e1', () => ({}), { projectName: 'p', perfStem: 'deploy.iac.upStack' });
      out = write.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      write.mockRestore();
    }
    expect(out).toMatch(/\[perf\] deploy\.iac\.upStack\.prepare \d+ms/);
    expect(out).toMatch(/\[perf\] deploy\.iac\.upStack\.resource\.firstEvent \d+ms/);
    expect(out).toMatch(/\[perf\] deploy\.iac\.upStack\.resource\.Server\.web \d+ms/);
  });

  it('without a perfStem the handler (kept for droplet plans) writes no timing lines', async () => {
    const urn = 'urn:pulumi:e1::proj::hcloud:index/server:Server::web';
    const stack = fakeStack((opts) => {
      opts.onEvent?.({ resourcePreEvent: { metadata: { op: 'create', urn, type: 'x:y:Server' } } });
      opts.onEvent?.({ resOutputsEvent: { metadata: { op: 'create', urn, type: 'x:y:Server' } } });
    });
    selectStack.mockResolvedValue(stack);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let out = '';
    try {
      const { upStack } = await import('../../../src/lib/iac/index.js');
      await upStack('e1', () => ({}), { projectName: 'p' });
      out = write.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      write.mockRestore();
    }
    expect(out).not.toMatch(/\[perf\]/);
  });
});
