/**
 * The per-project activate UX: the "already active" check keyed off which
 * SLOT the entered key targets (legacy vs project), and the post-activation
 * detail block.
 *
 * A v2 key carries no tier and no date, so activation can only report which
 * project the key is for and that the subscription is checked at deploy
 * time. Anything more would be the CLI guessing at billing state it has not
 * asked the server about.
 *
 * activateLicense/listStoredLicenses are mocked; the real validator/crypto
 * path is covered elsewhere (validator.test.ts,
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
      tier: null,
      tierName: 'Project license',
      isLifetime: false,
      format: 'v2',
      projectId: PROJECT_ID,
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
      tier: null,
      tierName: 'Project license',
      isLifetime: false,
      format: 'v2',
      projectId: PROJECT_ID,
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
  it('v1: shows Tier, Expires: Never, and this CLI version', async () => {
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

    expect(clackMock.note).toHaveBeenCalledTimes(1);
    const [details] = clackMock.note.mock.calls[0];
    expect(details).toContain('Tier: Vibecarbon Fullerene');
    expect(details).toContain('Expires: Never');
    expect(details).toContain(`This CLI: v${VERSION}`);
  });

  it('v2: shows the project and defers the subscription state to deploy time', async () => {
    licensingMock.activateLicense.mockReturnValue({
      success: true,
      tier: null,
      tierName: 'Project license',
      isLifetime: false,
      format: 'v2',
      projectId: PROJECT_ID,
      slot: 'project',
    });

    await runActivate([V2_KEY]);

    const [details] = clackMock.note.mock.calls[0];
    expect(details).toContain('Tier: Project license');
    expect(details).toContain(`Project: ${PROJECT_ID}`);
    expect(details).toContain('Subscription status is checked when you deploy.');
    expect(details).toContain(`This CLI: v${VERSION}`);
  });

  it('v2: never claims a paid-through date or a release the key does not cover', async () => {
    // The key no longer rotates and carries no date, so any such line would
    // be the CLI inventing billing state it has not asked the server about.
    licensingMock.activateLicense.mockReturnValue({
      success: true,
      tier: null,
      tierName: 'Project license',
      isLifetime: false,
      format: 'v2',
      projectId: PROJECT_ID,
      slot: 'project',
    });

    await runActivate([V2_KEY]);

    const [details] = clackMock.note.mock.calls[0];
    expect(details).not.toContain('Paid through');
    expect(details).not.toContain('does not cover this CLI release');
    expect(details).not.toContain('released');
  });
});

describe('activate: the retired -refresh flag', () => {
  it('-refresh is rejected as an unknown flag and exits 1', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(runActivate(['-refresh'])).rejects.toThrow('process.exit(1)');

    expect(licensingMock.activateLicense).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('the help text no longer advertises it', async () => {
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });

    await runActivate(['-h']);

    expect(logged.join('\n')).not.toMatch(/refresh/i);
    logSpy.mockRestore();
  });
});
