/**
 * `vibecarbon activate -refresh`: asks vibecarbon.com for the current key
 * covering this project's stored v2 license and prints old/new paid-through,
 * or a clear reason it could not. All collaborators are mocked here —
 * refreshLicense itself is covered against real crypto in refresh.test.ts;
 * this file is purely about what activate.js DOES with its result.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clackMock = vi.hoisted(() => ({
  confirm: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  cancel: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('@clack/prompts', () => clackMock);

const licensingMock = vi.hoisted(() => ({
  getLicense: vi.fn(),
  activateLicense: vi.fn(),
  deactivateLicense: vi.fn(),
  listStoredLicenses: vi.fn(),
}));
vi.mock('../../../src/lib/licensing/index.js', () => licensingMock);

const refreshMock = vi.hoisted(() => ({ refreshLicense: vi.fn() }));
vi.mock('../../../src/lib/licensing/refresh.js', () => refreshMock);

const releaseDateMock = vi.hoisted(() => ({ getReleaseDate: vi.fn() }));
vi.mock('../../../src/lib/licensing/release-date.js', () => releaseDateMock);

const projectMock = vi.hoisted(() => ({ manifestExists: vi.fn() }));
vi.mock('../../../src/lib/project.js', () => projectMock);

vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: vi.fn() }));

import { runActivate } from '../../../src/activate.js';

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';

function exitThrows() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit(${code})`);
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  projectMock.manifestExists.mockReturnValue(true);
  licensingMock.listStoredLicenses.mockReturnValue([]);
  releaseDateMock.getReleaseDate.mockReturnValue('2026-01-01');
});

describe('activate -refresh — outside a project', () => {
  it('prints a clear message and exits 1 when there is no Vibecarbon project here', async () => {
    projectMock.manifestExists.mockReturnValue(false);
    const exit = exitThrows();

    await expect(runActivate(['-refresh'])).rejects.toThrow('exit(1)');

    expect(exit).toHaveBeenCalledWith(1);
    expect(refreshMock.refreshLicense).not.toHaveBeenCalled();
    const errors = clackMock.log.error.mock.calls.map((c) => c[0]);
    expect(errors.some((m) => /inside a Vibecarbon project/i.test(m))).toBe(true);
  });
});

describe('activate -refresh — no v2 key stored', () => {
  it('prints a clear message and exits 1 when no project-slot key exists', async () => {
    licensingMock.listStoredLicenses.mockReturnValue([]);
    const exit = exitThrows();

    await expect(runActivate(['-refresh'])).rejects.toThrow('exit(1)');

    expect(exit).toHaveBeenCalledWith(1);
    expect(refreshMock.refreshLicense).not.toHaveBeenCalled();
    const errors = clackMock.log.error.mock.calls.map((c) => c[0]);
    expect(errors.some((m) => /No project license key is stored/i.test(m))).toBe(true);
  });

  it('a legacy-only (v1) stash is treated the same as no v2 key', async () => {
    licensingMock.listStoredLicenses.mockReturnValue([
      { slot: 'legacy', valid: true, format: 'v1', tier: 'fullerene', customerId: 'legacycust' },
    ]);
    exitThrows();

    await expect(runActivate(['-refresh'])).rejects.toThrow('exit(1)');

    expect(refreshMock.refreshLicense).not.toHaveBeenCalled();
  });
});

describe('activate -refresh — success', () => {
  it('prints old and new paid-through using "to", no arrow, no em dash', async () => {
    licensingMock.listStoredLicenses.mockReturnValue([
      {
        slot: 'project',
        valid: true,
        format: 'v2',
        key: 'vc2-g-...',
        tier: 'graphene',
        customerId: 'a1b2c3d4',
        projectId: PROJECT_ID,
        paidThrough: '2026-06-01',
      },
    ]);
    licensingMock.getLicense.mockReturnValue({
      active: true,
      format: 'v2',
      tier: 'graphene',
      projectId: PROJECT_ID,
      paidThrough: '2026-06-01',
    });
    refreshMock.refreshLicense.mockResolvedValue({
      ok: true,
      updated: true,
      paidThrough: '2027-06-01',
      tier: 'graphene',
    });

    await runActivate(['-refresh']);

    expect(refreshMock.refreshLicense).toHaveBeenCalledTimes(1);
    const successMessages = clackMock.log.success.mock.calls.map((c) => c[0]);
    const paidThroughLine = successMessages.find((m) => /Paid through/.test(m));
    expect(paidThroughLine).toBe('Paid through: 2026-06-01 to 2027-06-01');
    expect(paidThroughLine).not.toContain('→');
    expect(paidThroughLine).not.toContain('—');
    expect(clackMock.outro).toHaveBeenCalled();
  });
});

describe('activate -refresh — failure reasons', () => {
  const CASES: Array<[string, RegExp]> = [
    ['not-renewed', /not been renewed/i],
    ['not-found', /does not recognize/i],
    ['invalid', /could not be verified/i],
    ['offline', /Could not reach vibecarbon\.com/i],
  ];

  for (const [reason, expected] of CASES) {
    it(`reason=${reason} prints a matching message and exits 1, no crash`, async () => {
      licensingMock.listStoredLicenses.mockReturnValue([
        { slot: 'project', valid: true, format: 'v2', key: 'vc2-g-...', paidThrough: '2026-06-01' },
      ]);
      licensingMock.getLicense.mockReturnValue({ paidThrough: '2026-06-01' });
      refreshMock.refreshLicense.mockResolvedValue({ ok: false, reason });
      const exit = exitThrows();

      await expect(runActivate(['-refresh'])).rejects.toThrow('exit(1)');

      expect(exit).toHaveBeenCalledWith(1);
      const errors = clackMock.log.error.mock.calls.map((c) => c[0]);
      expect(errors.some((m) => expected.test(m))).toBe(true);
      expect(clackMock.outro).not.toHaveBeenCalled();
    });
  }
});
