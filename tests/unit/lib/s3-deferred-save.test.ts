/**
 * Pasted object-storage keys are saved only after they pass the live check.
 *
 * excitingai (2026-10-16): the wrong pasted keys were written to .env.local
 * ("Saved to .env.local") before anything had used them, so the next run
 * picked the same bad pair back up. With `deferSave`, getS3Credentials hands
 * the save back as `save()` and the deploy calls it once the keys verify.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setEnvVarMock = vi.hoisted(() => vi.fn());
const clackMock = vi.hoisted(() => ({
  text: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock('@clack/prompts', () => clackMock);
vi.mock('../../../src/lib/project.js', () => ({
  setEnvVar: setEnvVarMock,
  describeCredentialSource: (keys: string[]) => ({
    source: 'shell',
    label: `your shell environment (${keys.join(', ')})`,
    where: 'your shell environment',
  }),
}));
vi.mock('../../../src/lib/cli/tty-guard.js', () => ({ assertInteractiveStdin: vi.fn() }));

const PROVIDERS = ['hetzner', 'digitalocean', 'linode', 'vultr'] as const;

describe.each(PROVIDERS)('%s getS3Credentials with deferSave', (provider) => {
  beforeEach(() => {
    vi.resetModules();
    setEnvVarMock.mockReset();
    clackMock.text.mockImplementation(async ({ message }: { message: string }) =>
      /region|cluster/i.test(message) ? 'ewr1' : 'ABCDEFGHIJ0123456789',
    );
    clackMock.password.mockResolvedValue('x'.repeat(40));
    clackMock.confirm.mockResolvedValue(true);
  });
  afterEach(() => vi.clearAllMocks());

  it('writes nothing until save() is called, then saves the pair', async () => {
    const mod = await import(`../../../src/lib/${provider}-guided-setup.js`);
    const creds = await mod.getS3Credentials('proj', { force: true, deferSave: true });

    expect(setEnvVarMock).not.toHaveBeenCalled();
    expect(typeof creds.save).toBe('function');

    await creds.save();
    const saved = setEnvVarMock.mock.calls.map((c) => c[0]);
    expect(saved).toEqual(expect.arrayContaining([expect.stringMatching(/_ACCESS_KEY$/)]));
    expect(saved).toEqual(expect.arrayContaining([expect.stringMatching(/_SECRET_KEY$/)]));
  });
});
