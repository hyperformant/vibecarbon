/**
 * destroyK8s logs a failed destroy in full: destroyStack's one-line summary
 * (what is left, and why) AND the raw Pulumi output it wraps as `cause`.
 * Logging only the cause dropped the summary that names the leftovers.
 */
import { describe, expect, it, vi } from 'vitest';

const logError = vi.fn();

vi.mock('@clack/prompts', () => ({ log: { error: (m: string) => logError(m) } }));
vi.mock('../../../src/lib/cli/progress.js', () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
}));
vi.mock('../../../src/lib/iac/index.js', () => ({
  destroyStack: vi.fn(async () => {
    throw new Error('pulumi destroy for stack "d4-standby" failed, 2 resource(s) remain', {
      cause: new Error('Destroying (d4-standby):\n  raw pulumi output'),
    });
  }),
}));

describe('destroyK8s error log', () => {
  it('logs the summary and the raw Pulumi output', async () => {
    const { destroyK8s } = await import('../../../src/lib/deploy/k8s/index.js');
    await expect(
      destroyK8s({ environment: 'd4-standby', provider: 'digitalocean', projectName: 'p' }),
    ).rejects.toThrow(/2 resource\(s\) remain/);

    const logged = logError.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toMatch(/2 resource\(s\) remain/);
    expect(logged).toMatch(/raw pulumi output/);
  });
});
