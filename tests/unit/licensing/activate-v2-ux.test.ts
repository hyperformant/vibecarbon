/**
 * B4's per-project activate UX: the "already active" check keyed off which
 * SLOT the entered key targets (legacy vs project), and the post-activation
 * detail block (Project/Paid through for v2, the CLI's own release date,
 * and the "does not cover this release" warning).
 *
 * activateLicense/listStoredLicenses/getReleaseDate are mocked; the real
 * validator/crypto path is covered elsewhere (validator.test.ts,
 * signature-verification.test.ts, storage.test.ts). This file is purely
 * about what activate.js DOES with those results.
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

const releaseDateMock = vi.hoisted(() => ({ getReleaseDate: vi.fn() }));
vi.mock('../../../src/lib/licensing/release-date.js', () => releaseDateMock);

vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: vi.fn() }));

import { runActivate } from '../../../src/activate.js';
import { VERSION } from '../../../src/lib/version.js';

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
const V2_KEY = `vc2-g-a1b2c3d4-${'1'.repeat(32)}-20271231-${'a'.repeat(128)}`;
const V1_KEY = `vc-f-cafebabe-${'a'.repeat(128)}`;

function noStoredLicenses() {
  licensingMock.listStoredLicenses.mockReturnValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  noStoredLicenses();
  releaseDateMock.getReleaseDate.mockReturnValue('2026-01-01');
});

describe('activate — per-slot "already active" handling', () => {
  it('a v2 key entered with only a legacy key present does NOT ask Replace, and notes lifetime coverage', async () => {
    licensingMock.listStoredLicenses.mockReturnValue([
      {
        slot: 'legacy',
        valid: true,
        format: 'v1',
        tier: 'fullerene',
        customerId: 'legacycust',
      },
    ]);
    licensingMock.activateLicense.mockReturnValue({
      success: true,
      tier: 'graphene',
      tierName: 'Vibecarbon Graphene',
      features: ['kubernetes'],
      isLifetime: false,
      format: 'v2',
      projectId: PROJECT_ID,
      paidThrough: '2027-12-31',
      slot: 'project',
    });

    await runActivate([V2_KEY]);

    expect(clackMock.confirm).not.toHaveBeenCalled();
    expect(licensingMock.activateLicense).toHaveBeenCalledWith(V2_KEY);
    const infoMessages = clackMock.log.info.mock.calls.map((c) => c[0]);
    expect(infoMessages.some((m) => /lifetime license already covers every project/i.test(m))).toBe(
      true,
    );
  });

  it('a v2 key entered when this project already has a project-slot key DOES ask Replace', async () => {
    licensingMock.listStoredLicenses.mockReturnValue([
      {
        slot: 'project',
        valid: true,
        format: 'v2',
        tier: 'graphene',
        customerId: 'projcust',
        projectId: PROJECT_ID,
      },
    ]);
    clackMock.confirm.mockResolvedValue(true);
    licensingMock.activateLicense.mockReturnValue({
      success: true,
      tier: 'graphene',
      tierName: 'Vibecarbon Graphene',
      features: ['kubernetes'],
      isLifetime: false,
      format: 'v2',
      projectId: PROJECT_ID,
      paidThrough: '2027-12-31',
      slot: 'project',
    });

    await runActivate([V2_KEY]);

    expect(clackMock.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Replace with a new license key?' }),
    );
    expect(licensingMock.activateLicense).toHaveBeenCalledWith(V2_KEY);
  });

  it('a v1 key entered when only a project key exists targets a different slot: no Replace prompt', async () => {
    licensingMock.listStoredLicenses.mockReturnValue([
      {
        slot: 'project',
        valid: true,
        format: 'v2',
        tier: 'graphene',
        customerId: 'projcust',
        projectId: PROJECT_ID,
      },
    ]);
    licensingMock.activateLicense.mockReturnValue({
      success: true,
      tier: 'fullerene',
      tierName: 'Vibecarbon Fullerene',
      features: ['docker-compose'],
      isLifetime: true,
      format: 'v1',
      slot: 'legacy',
    });

    await runActivate([V1_KEY]);

    expect(clackMock.confirm).not.toHaveBeenCalled();
    expect(licensingMock.activateLicense).toHaveBeenCalledWith(V1_KEY);
  });

  it('a v1 key entered when a legacy key already exists DOES ask Replace (v1 over v1)', async () => {
    licensingMock.listStoredLicenses.mockReturnValue([
      { slot: 'legacy', valid: true, format: 'v1', tier: 'fullerene', customerId: 'legacycust' },
    ]);
    clackMock.confirm.mockResolvedValue(false);

    await runActivate([V1_KEY]);

    expect(clackMock.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Replace with a new license key?' }),
    );
    expect(clackMock.outro).toHaveBeenCalledWith('Keeping current license.');
    expect(licensingMock.activateLicense).not.toHaveBeenCalled();
  });
});

describe('activate — post-activation detail block', () => {
  it('v1: shows Tier, Expires: Never, and This CLI, no coverage warning', async () => {
    licensingMock.activateLicense.mockReturnValue({
      success: true,
      tier: 'fullerene',
      tierName: 'Vibecarbon Fullerene',
      features: ['docker-compose'],
      isLifetime: true,
      format: 'v1',
      slot: 'legacy',
    });
    releaseDateMock.getReleaseDate.mockReturnValue('2026-06-15');

    await runActivate([V1_KEY]);

    expect(clackMock.note).toHaveBeenCalledTimes(1);
    const [details] = clackMock.note.mock.calls[0];
    expect(details).toContain('Tier: Vibecarbon Fullerene');
    expect(details).toContain('Expires: Never');
    expect(details).toContain(`This CLI: v${VERSION} (released 2026-06-15)`);
    expect(details).not.toContain('does not cover this CLI release');
  });

  it('v2: shows Project, Paid through, and This CLI, with a coverage warning when the release is newer', async () => {
    licensingMock.activateLicense.mockReturnValue({
      success: true,
      tier: 'graphene',
      tierName: 'Vibecarbon Graphene',
      features: ['kubernetes'],
      isLifetime: false,
      format: 'v2',
      projectId: PROJECT_ID,
      paidThrough: '2026-01-01',
      slot: 'project',
    });
    releaseDateMock.getReleaseDate.mockReturnValue('2026-06-15');

    await runActivate([V2_KEY]);

    const [details] = clackMock.note.mock.calls[0];
    expect(details).toContain('Tier: Vibecarbon Graphene');
    expect(details).toContain(`Project: ${PROJECT_ID}`);
    expect(details).toContain('Paid through: 2026-01-01');
    expect(details).toContain(`This CLI: v${VERSION} (released 2026-06-15)`);
    expect(details).toContain(
      'This key does not cover this CLI release. Renew, or run the CLI version you paid for.',
    );
  });

  it('v2: no coverage warning when the release date is on or before paidThrough', async () => {
    licensingMock.activateLicense.mockReturnValue({
      success: true,
      tier: 'graphene',
      tierName: 'Vibecarbon Graphene',
      features: ['kubernetes'],
      isLifetime: false,
      format: 'v2',
      projectId: PROJECT_ID,
      paidThrough: '2027-01-01',
      slot: 'project',
    });
    releaseDateMock.getReleaseDate.mockReturnValue('2026-06-15');

    await runActivate([V2_KEY]);

    const [details] = clackMock.note.mock.calls[0];
    expect(details).not.toContain('does not cover this CLI release');
  });
});
