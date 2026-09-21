/**
 * Final review L3 (2026-09-21): `genericGetApiToken` (configure-providers.js),
 * the token-only fallback for a compute provider with no guided module,
 * validated the NORMALIZED paste but returned the RAW one — a quote-wrapped
 * paste passed the prompt and then hit `setEnvVar`'s refusal, the exact
 * after-every-prompt throw the branch removed. It now saves the normalized
 * token, as every guided setup does. Currently unreachable in production
 * (every listed provider has a guided module), pinned so it stays correct
 * when a provider is added token-only. Fixture values only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clackMock = vi.hoisted(() => ({
  password: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn() },
}));
vi.mock('@clack/prompts', () => clackMock);
vi.mock('../../../src/lib/project.js', () => ({ getBootstrappedKeys: () => new Set() }));

import { genericGetApiToken } from '../../../src/lib/configure-providers.js';

const TOKEN = 'a'.repeat(64);
const Provider = { NAME: 'Example Cloud', TOKEN_ENV: 'HETZNER_API_TOKEN' };

describe('genericGetApiToken', () => {
  let ambient: string | undefined;
  beforeEach(() => {
    ambient = process.env.HETZNER_API_TOKEN;
    delete process.env.HETZNER_API_TOKEN;
    clackMock.password.mockReset();
  });
  afterEach(() => {
    if (ambient === undefined) delete process.env.HETZNER_API_TOKEN;
    else process.env.HETZNER_API_TOKEN = ambient;
  });

  it('a quote-wrapped paste passes validate and is stored stripped', async () => {
    clackMock.password.mockResolvedValue(`"${TOKEN}"\n`);
    const token = await genericGetApiToken(Provider, 'my-project', { force: true });
    const { validate } = clackMock.password.mock.calls[0][0];
    expect(validate(`"${TOKEN}"\n`)).toBeUndefined();
    expect(token).toBe(TOKEN);
    expect(process.env.HETZNER_API_TOKEN).toBe(TOKEN);
  });

  it('a clean paste is returned as-is', async () => {
    clackMock.password.mockResolvedValue(TOKEN);
    expect(await genericGetApiToken(Provider, 'my-project', { force: true })).toBe(TOKEN);
  });

  it('a key with no registry entry is passed through untouched', async () => {
    const raw = ' x'.repeat(8);
    clackMock.password.mockResolvedValue(raw);
    const NoEntry = { NAME: 'Example Cloud', TOKEN_ENV: 'EXAMPLE_CLOUD_TOKEN' };
    expect(await genericGetApiToken(NoEntry, 'my-project', { force: true })).toBe(raw);
    delete process.env.EXAMPLE_CLOUD_TOKEN;
  });
});
