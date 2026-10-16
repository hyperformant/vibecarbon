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
      supabaseType: 'cpx31',
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
});
