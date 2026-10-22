/**
 * Credential prompt order in the new-environment deploy wizard.
 *
 * The provider API token and the object-storage keys are made in the same
 * console visit (Hetzner: project, then Security, then API tokens / S3
 * credentials), so the wizard asks for them back to back: S3 keys right
 * after the token, before the DNS provider pick and its zone lookup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const events: string[] = [];

const clackMock = vi.hoisted(() => ({
  select: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(async () => true),
  password: vi.fn(),
  note: vi.fn(),
  intro: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: {
    step: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock('@clack/prompts', () => clackMock);

vi.mock('../../../src/lib/config.js', () => ({
  loadProjectConfig: () => ({ projectName: 'orderapp', bucketSalt: 'abc123', environments: {} }),
}));
vi.mock('../../../src/lib/licensing/index.js', () => ({
  requireDeployEntitlement: vi.fn(async () => undefined),
}));
vi.mock('../../../src/lib/telemetry/update-check.js', () => ({ printUpdateNotice: vi.fn() }));
vi.mock('../../../src/lib/deploy/delta.js', () => ({
  collectDeployDelta: () => ({}),
  formatDeployDeltaLines: () => [],
}));
vi.mock('../../../src/lib/deploy/preflight.js', () => ({ assertOperatorConfig: vi.fn() }));
vi.mock('../../../src/lib/ci-setup.js', () => ({ ciAvailable: () => false }));

import { gatherDeploymentConfig } from '../../../src/lib/deploy/prompts.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { S3CompatibleProvider } from '../../../src/lib/providers/s3-base.js';

describe('deploy wizard credential order', () => {
  beforeEach(() => {
    events.length = 0;
    vi.spyOn(console, 'clear').mockImplementation(() => {});
    vi.spyOn(HetznerProvider, 'promptApiToken').mockImplementation(async () => {
      events.push('api-token');
      return 'a'.repeat(64);
    });
    vi.spyOn(HetznerProvider, 'fetchServerTypes').mockResolvedValue(undefined as never);
    vi.spyOn(HetznerProvider, 'getRegionDefaults').mockReturnValue({
      composeType: 'cpx31',
      dbType: 'cpx31',
      masterType: 'cpx31',
      workerType: 'cpx31',
    } as never);
    vi.spyOn(HetznerProvider, 'assertAmd64ServerType').mockImplementation(() => {});
    vi.spyOn(HetznerProvider, 'promptObjectStorageCredentials').mockImplementation(async () => {
      events.push('s3-credentials');
      return { accessKey: 'ABCDEFGHIJ0123456789', secretKey: 'x'.repeat(40), source: 'prompt' };
    });
    vi.spyOn(S3CompatibleProvider.prototype, 'validateCredentials').mockResolvedValue({
      valid: true,
    });
    clackMock.select.mockImplementation(async ({ message }: { message: string }) => {
      if (message === 'DNS provider:') {
        events.push('dns-provider');
        return 'manual';
      }
      throw new Error(`unexpected select: ${message}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clackMock.select.mockReset();
    clackMock.log.warn.mockClear();
    clackMock.log.error.mockClear();
  });

  it('asks for the S3 keys right after the API token, before the DNS provider', async () => {
    await gatherDeploymentConfig({
      env: 'prod',
      provider: 'hetzner',
      compose: true,
      region: 'hil',
    });
    expect(events).toEqual(['api-token', 's3-credentials', 'dns-provider']);
  });

  it('verifies the S3 keys right away, naming where they came from, and asks again when S3 rejects them', async () => {
    const prompt = vi.mocked(HetznerProvider.promptObjectStorageCredentials);
    prompt.mockReset();
    prompt
      .mockResolvedValueOnce({
        accessKey: 'STALEKEY000000000000',
        secretKey: 'y'.repeat(40),
        source: "your project's .env.local",
      } as never)
      .mockResolvedValueOnce({
        accessKey: 'ABCDEFGHIJ0123456789',
        secretKey: 'x'.repeat(40),
        source: 'what you pasted',
      } as never);
    const validate = vi.mocked(S3CompatibleProvider.prototype.validateCredentials);
    validate
      .mockResolvedValueOnce({
        valid: false,
        rejected: true,
        error: "the access key isn't recognized (InvalidAccessKeyId)",
      } as never)
      .mockResolvedValueOnce({ valid: true });

    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    let result: Awaited<ReturnType<typeof gatherDeploymentConfig>>;
    try {
      result = await gatherDeploymentConfig({
        env: 'prod',
        provider: 'hetzner',
        compose: true,
        region: 'hil',
      });
    } finally {
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1][1]).toMatchObject({ force: true });
    const warned = clackMock.log.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain("your project's .env.local");
    expect(warned).toContain('InvalidAccessKeyId');
    expect(result.s3Config.accessKey).toBe('ABCDEFGHIJ0123456789');
  });

  it('stops with the reason under -y instead of deploying with rejected keys', async () => {
    vi.mocked(S3CompatibleProvider.prototype.validateCredentials).mockResolvedValue({
      valid: false,
      rejected: true,
      error: "the secret key doesn't match the access key (SignatureDoesNotMatch)",
    } as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    await expect(
      gatherDeploymentConfig({
        env: 'prod',
        provider: 'hetzner',
        compose: true,
        region: 'hil',
        yes: true,
      }),
    ).rejects.toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledWith(1);
    const errors = clackMock.log.error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errors).toContain('SignatureDoesNotMatch');
  });

  it('carries on when the endpoint cannot be reached, since that is not a key problem', async () => {
    vi.mocked(S3CompatibleProvider.prototype.validateCredentials).mockResolvedValue({
      valid: false,
      rejected: false,
      error: 'no answer from https://fsn1.your-objectstorage.com (TimeoutError)',
    } as never);
    const result = await gatherDeploymentConfig({
      env: 'prod',
      provider: 'hetzner',
      compose: true,
      region: 'hil',
    });
    expect(result.s3Config.accessKey).toBe('ABCDEFGHIJ0123456789');
    expect(vi.mocked(HetznerProvider.promptObjectStorageCredentials)).toHaveBeenCalledTimes(1);
  });

  it('saves pasted keys only after S3 accepts them, never the rejected pair', async () => {
    const badSave = vi.fn(async () => {});
    const goodSave = vi.fn(async () => {});
    const prompt = vi.mocked(HetznerProvider.promptObjectStorageCredentials);
    prompt.mockReset();
    prompt
      .mockResolvedValueOnce({
        accessKey: 'WRONGKEY000000000000',
        secretKey: 'y'.repeat(40),
        source: 'what you pasted',
        save: badSave,
      } as never)
      .mockResolvedValueOnce({
        accessKey: 'ABCDEFGHIJ0123456789',
        secretKey: 'x'.repeat(40),
        source: 'what you pasted',
        save: goodSave,
      } as never);
    const validate = vi.mocked(S3CompatibleProvider.prototype.validateCredentials);
    validate
      .mockImplementationOnce(async () => {
        // Nothing may be saved while the keys are still unchecked.
        expect(badSave).not.toHaveBeenCalled();
        return { valid: false, rejected: true, error: 'x (SignatureDoesNotMatch)' } as never;
      })
      .mockResolvedValueOnce({ valid: true });

    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await gatherDeploymentConfig({
        env: 'prod',
        provider: 'hetzner',
        compose: true,
        region: 'hil',
      });
    } finally {
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }

    expect(prompt.mock.calls[0][1]).toMatchObject({ deferSave: true });
    expect(prompt.mock.calls[1][1]).toMatchObject({ deferSave: true, force: true });
    expect(badSave).not.toHaveBeenCalled();
    expect(goodSave).toHaveBeenCalledTimes(1);
  });

  it('still saves when the endpoint cannot be reached (unverified, not rejected)', async () => {
    const save = vi.fn(async () => {});
    vi.mocked(HetznerProvider.promptObjectStorageCredentials).mockResolvedValue({
      accessKey: 'ABCDEFGHIJ0123456789',
      secretKey: 'x'.repeat(40),
      source: 'what you pasted',
      save,
    } as never);
    vi.mocked(S3CompatibleProvider.prototype.validateCredentials).mockResolvedValue({
      valid: false,
      rejected: false,
      error: 'no answer (TimeoutError)',
    } as never);
    await gatherDeploymentConfig({
      env: 'prod',
      provider: 'hetzner',
      compose: true,
      region: 'hil',
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
