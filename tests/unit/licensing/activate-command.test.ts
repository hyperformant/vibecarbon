import { beforeEach, describe, expect, it, vi } from 'vitest';

const activateLicense = vi.fn();
const deactivateLicense = vi.fn();
const removeLicenseFile = vi.fn();
const hasStoredLicense = vi.fn();
const getLicense = vi.fn();
vi.mock('../../../src/lib/licensing/index.js', () => ({
  activateLicense: (...a: unknown[]) => activateLicense(...a),
  deactivateLicense: (...a: unknown[]) => deactivateLicense(...a),
  removeLicenseFile: (...a: unknown[]) => removeLicenseFile(...a),
  hasStoredLicense: (...a: unknown[]) => hasStoredLicense(...a),
  getLicense: (...a: unknown[]) => getLicense(...a),
}));
const logs: string[] = [];
vi.mock('@clack/prompts', () => ({
  log: {
    info: (m: string) => logs.push(m),
    success: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
  },
  note: (m: string) => logs.push(m),
  outro: (m: string) => logs.push(m),
  intro: () => {},
  text: vi.fn(),
  confirm: vi.fn(async () => true),
  isCancel: () => false,
}));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));
vi.mock('../../../src/lib/cli/progress.js', () => ({ spinner: () => ({ start() {}, stop() {} }) }));

const _exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`exit ${code}`);
}) as never);
const { runActivate, runDeactivate } = await import('../../../src/activate.js');
const KEY = `vc-0123456789abcdef-${'a'.repeat(128)}`;

beforeEach(() => {
  logs.length = 0;
  vi.clearAllMocks();
});

describe('activate', () => {
  it('prints the binding on success', async () => {
    activateLicense.mockResolvedValue({
      success: true,
      projectId: 'p',
      tier: 'graphene',
      status: 'active',
      periodEnd: '2026-10-15T00:00:00.000Z',
      path: '/x/.vibecarbon.license',
    });
    await runActivate([KEY]);
    expect(activateLicense).toHaveBeenCalledWith(KEY);
    expect(logs.join('\n')).toMatch(/Graphene/);
    expect(logs.join('\n')).toContain('Project: p');
    expect(logs.join('\n')).toContain('commit');
    // Graphene does not cover HA. The outro used to promise it to everyone.
    expect(logs.join('\n')).toContain('You can now deploy to Kubernetes environments.');
    expect(logs.join('\n')).not.toContain('and HA environments');
  });

  it('promises HA only to Fullerene, and nothing specific to an unknown tier', async () => {
    const success = (tier: string) => ({
      success: true,
      projectId: 'p',
      tier,
      status: 'active',
      periodEnd: '2026-10-15T00:00:00.000Z',
      path: '/x/.vibecarbon.license',
    });

    activateLicense.mockResolvedValue(success('fullerene'));
    await runActivate([KEY]);
    expect(logs.join('\n')).toContain('You can now deploy to Kubernetes and HA environments.');

    // A tier this CLI has never heard of (a newer plan on the server): say
    // that it worked, claim nothing about what it covers.
    logs.length = 0;
    activateLicense.mockResolvedValue(success('diamond'));
    await runActivate([KEY]);
    expect(logs.join('\n')).toContain('License activated.');
    expect(logs.join('\n')).not.toContain('You can now deploy');
  });
  it('exits 1 with the server reason on refusal, and hints /license on switchPlan', async () => {
    activateLicense.mockResolvedValue({
      success: false,
      reason: 'project_already_licensed',
      error: 'already',
      switchPlan: true,
    });
    await expect(runActivate([KEY])).rejects.toThrow('exit 1');
    expect(logs.join('\n')).toContain('already');
    expect(logs.join('\n')).toContain('https://vibecarbon.com/license');
  });
  it('exits 1 offline and says nothing changed', async () => {
    activateLicense.mockResolvedValue({
      success: false,
      reason: 'unreachable',
      error: 'Activation needs a connection to vibecarbon.com (timeout). Nothing was changed.',
    });
    await expect(runActivate([KEY])).rejects.toThrow('exit 1');
    expect(logs.join('\n')).toContain('Nothing was changed');
  });
  it('rejects the retired -refresh flag', async () => {
    await expect(runActivate(['-refresh'])).rejects.toThrow(/exit/);
  });
});

describe('deactivate', () => {
  it('-y requests the release and tells the user to check their email; file stays', async () => {
    hasStoredLicense.mockReturnValue(true);
    deactivateLicense.mockResolvedValue({ success: true, sent: true });
    await runDeactivate(['-y']);
    expect(deactivateLicense).toHaveBeenCalledWith({ key: undefined });
    expect(removeLicenseFile).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/check your email/i);
    expect(logs.join('\n')).toMatch(/within an hour/i);
  });
  it('accepts a positional key with no file', async () => {
    hasStoredLicense.mockReturnValue(false);
    deactivateLicense.mockResolvedValue({ success: true, sent: true });
    await runDeactivate([KEY, '-y']);
    expect(deactivateLicense).toHaveBeenCalledWith({ key: KEY });
  });
  it('-rm removes the local file without a request', async () => {
    hasStoredLicense.mockReturnValue(true);
    removeLicenseFile.mockReturnValue({ success: true, removed: ['/x/.vibecarbon.license'] });
    await runDeactivate(['-rm', '-y']);
    expect(deactivateLicense).not.toHaveBeenCalled();
    expect(removeLicenseFile).toHaveBeenCalled();
  });
  it('exits 1 when unreachable, without removing the file', async () => {
    hasStoredLicense.mockReturnValue(true);
    deactivateLicense.mockResolvedValue({
      success: false,
      reason: 'unreachable',
      error: 'Could not reach vibecarbon.com (timeout); the key is still bound.',
    });
    await expect(runDeactivate(['-y'])).rejects.toThrow('exit 1');
    expect(removeLicenseFile).not.toHaveBeenCalled();
  });
  it('-all is gone', async () => {
    await expect(runDeactivate(['-all'])).rejects.toThrow(/exit/);
  });
});
