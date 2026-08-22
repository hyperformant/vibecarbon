import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mirrors tests/unit/lib/digitalocean-guided-setup.test.ts. Vultr-specific
// coverage concentrates on the one place this module is NOT a copy of its
// siblings: object-storage keys are minted per subscription, so the cluster
// slug is collected as a third credential value (see the module doc and
// the vultr-provider-step0-audit plan).
const clackMock = vi.hoisted(() => ({
  password: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  cancel: vi.fn(),
  note: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
  },
}));
vi.mock('@clack/prompts', () => clackMock);
// This suite drives the INTERACTIVE prompt flow, so it declares an interactive
// terminal. The off-TTY behaviour (prompts must throw, never hang into a silent
// exit 0) is pinned in tests/unit/lib/cli/interactive-prompt-guard.test.ts.
vi.mock('../../../src/lib/cli/tty-guard.js', () => ({ assertInteractiveStdin: vi.fn() }));

const setEnvVarMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/project.js', () => ({ setEnvVar: setEnvVarMock }));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

import {
  displayApiTokenGuide,
  displayS3CredentialsGuide,
} from '../../../src/lib/vultr-guided-setup.js';

// getApiToken/getS3Credentials share a module-level `_savePreference` flag
// (see hetzner-guided-setup.test.ts's identical note) — fresh-import per
// test so one test's save answer can't leak into the next.
async function freshGuidedSetup() {
  vi.resetModules();
  return import('../../../src/lib/vultr-guided-setup.js');
}

// Matches vultr-guided-setup.js's TOKEN_FORMAT: 36 uppercase alphanumeric.
const VALID_TOKEN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function mockTokenValid() {
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
}

const strip = (s: unknown) => stripVTControlCharacters(String(s));

describe('vultr-guided-setup guides', () => {
  beforeEach(() => {
    clackMock.note.mockReset();
    clackMock.log.info.mockReset();
  });

  describe('displayApiTokenGuide', () => {
    it('renders exactly one note box with the API-key steps', () => {
      displayApiTokenGuide('my-project');

      expect(clackMock.note).toHaveBeenCalledTimes(1);
      const [body, title] = clackMock.note.mock.calls[0];
      expect(strip(title)).toContain('Vultr API Key');
      const text = strip(body);
      expect(text).toContain('https://my.vultr.com/settings/#settingsapi');
      expect(text).toContain('Enable API');
    });

    it('warns about the Access Control allowlist — the key-looks-broken gotcha', () => {
      displayApiTokenGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      expect(text).toContain('Access Control');
      expect(text).toContain('0.0.0.0/0');
    });

    it('does NOT recommend a per-project key — Vultr issues one key per account', () => {
      // The sibling guides all suggest a dedicated token per project. Vultr
      // cannot: separation is Sub-Accounts, and "create another key" would
      // silently mean "rotate the one you have".
      displayApiTokenGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      expect(text).not.toMatch(/dedicated API (token|key) per/i);
      expect(text).toContain('Sub-Accounts');
    });
  });

  describe('displayS3CredentialsGuide', () => {
    it('walks create-subscription → S3 Credentials, and names the three values to copy', () => {
      displayS3CredentialsGuide('my-project');

      expect(clackMock.note).toHaveBeenCalledTimes(1);
      const [body, title] = clackMock.note.mock.calls[0];
      expect(strip(title)).toContain('Vultr Object Storage');
      const text = strip(body);
      expect(text).toContain('https://my.vultr.com/objectstorage/');
      expect(text).toContain('Create Object Storage');
      expect(text).toContain('S3 Credentials');
      expect(text).toContain('access key');
      expect(text).toContain('secret key');
      expect(text).toContain('hostname');
      expect(text).toContain('my-project');
    });

    it('calls out the flat monthly subscription fee', () => {
      displayS3CredentialsGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      expect(text).toMatch(/FLAT monthly fee/i);
      expect(text).toContain('https://www.vultr.com/pricing/');
    });
  });
});

describe('getApiToken', () => {
  const ambientToken = process.env.VULTR_API_TOKEN;

  beforeEach(() => {
    delete process.env.VULTR_API_TOKEN;
    clackMock.password.mockReset();
    clackMock.confirm.mockReset();
    clackMock.log.info.mockReset();
    clackMock.log.warn.mockReset();
    setEnvVarMock.mockReset();
    fetchMock.mockReset();
  });

  afterEach(() => {
    if (ambientToken === undefined) delete process.env.VULTR_API_TOKEN;
    else process.env.VULTR_API_TOKEN = ambientToken;
  });

  it('returns the env var verbatim when set and valid, never prompting', async () => {
    process.env.VULTR_API_TOKEN = VALID_TOKEN;
    mockTokenValid();
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project');

    expect(result).toBe(VALID_TOKEN);
    expect(clackMock.password).not.toHaveBeenCalled();
  });

  it('verifies against GET /v2/account with a Bearer header', async () => {
    process.env.VULTR_API_TOKEN = VALID_TOKEN;
    mockTokenValid();
    const { getApiToken } = await freshGuidedSetup();

    await getApiToken('my-project');

    expect(fetchMock).toHaveBeenCalledWith('https://api.vultr.com/v2/account', {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
  });

  it('force:true skips the env lookup and goes straight to the prompt', async () => {
    process.env.VULTR_API_TOKEN = VALID_TOKEN;
    mockTokenValid();
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(false);
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project', { force: true, save: false });

    expect(clackMock.password).toHaveBeenCalledTimes(1);
    expect(result).toBe(VALID_TOKEN);
  });

  it('falls through to the prompt when the env var is set but 401s', async () => {
    process.env.VULTR_API_TOKEN = VALID_TOKEN;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(false);
    const { getApiToken } = await freshGuidedSetup();

    await getApiToken('my-project', { save: false });

    expect(clackMock.log.warn).toHaveBeenCalledWith(expect.stringContaining('VULTR_API_TOKEN'));
    expect(clackMock.password).toHaveBeenCalledTimes(1);
  });

  it('points a 403 at the Access Control allowlist rather than calling the key invalid', async () => {
    process.env.VULTR_API_TOKEN = VALID_TOKEN;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(false);
    const { getApiToken } = await freshGuidedSetup();

    await getApiToken('my-project', { save: false });

    expect(clackMock.log.warn).toHaveBeenCalledWith(expect.stringContaining('Access Control'));
  });

  it('warns on a malformed key but still accepts it (never blocks on a heuristic)', async () => {
    mockTokenValid();
    clackMock.password.mockResolvedValue('lowercase-and-too-short-but-valid');
    clackMock.confirm.mockResolvedValue(false);
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project', { save: false });

    expect(clackMock.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('36 uppercase alphanumeric'),
    );
    expect(result).toBe('lowercase-and-too-short-but-valid');
  });

  it('treats an unreachable API as verified rather than stranding the operator', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(false);
    const { getApiToken } = await freshGuidedSetup();

    expect(await getApiToken('my-project', { save: false })).toBe(VALID_TOKEN);
  });

  it('prompts when the env var is unset, then sets process.env for in-process coherence', async () => {
    mockTokenValid();
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(false); // decline save
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project');

    expect(result).toBe(VALID_TOKEN);
    expect(process.env.VULTR_API_TOKEN).toBe(VALID_TOKEN);
    expect(setEnvVarMock).not.toHaveBeenCalled();
  });

  it('save acceptance persists via setEnvVar with localOnly:true', async () => {
    mockTokenValid();
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(true); // accept save
    const { getApiToken } = await freshGuidedSetup();

    await getApiToken('my-project');

    expect(setEnvVarMock).toHaveBeenCalledWith('VULTR_API_TOKEN', VALID_TOKEN, expect.any(String), {
      localOnly: true,
    });
  });
});

describe('getS3Credentials (per-subscription keys + cluster)', () => {
  const ambient = {
    key: process.env.VULTR_ACCESS_KEY,
    secret: process.env.VULTR_SECRET_KEY,
    region: process.env.VULTR_STORAGE_REGION,
  };

  beforeEach(() => {
    delete process.env.VULTR_ACCESS_KEY;
    delete process.env.VULTR_SECRET_KEY;
    delete process.env.VULTR_STORAGE_REGION;
    clackMock.text.mockReset();
    clackMock.password.mockReset();
    clackMock.confirm.mockReset();
    clackMock.log.info.mockReset();
    clackMock.log.warn.mockReset();
    setEnvVarMock.mockReset();
  });

  afterEach(() => {
    for (const [key, value] of [
      ['VULTR_ACCESS_KEY', ambient.key],
      ['VULTR_SECRET_KEY', ambient.secret],
      ['VULTR_STORAGE_REGION', ambient.region],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // Drives the interactive path: access key (text) → secret (password) →
  // cluster (text).
  function mockFreshPrompts(accessKey = 'AK123456789', secret = 'SK987654321', cluster = 'sjc1') {
    clackMock.text.mockResolvedValueOnce(accessKey).mockResolvedValueOnce(cluster);
    clackMock.password.mockResolvedValue(secret);
  }

  it('returns env values verbatim when the pair and the cluster are set, never prompting', async () => {
    process.env.VULTR_ACCESS_KEY = 'AK123456789';
    process.env.VULTR_SECRET_KEY = 'SK987654321';
    process.env.VULTR_STORAGE_REGION = 'ewr1';
    const { getS3Credentials } = await freshGuidedSetup();

    const result = await getS3Credentials('my-project');

    expect(result).toEqual({ accessKey: 'AK123456789', secretKey: 'SK987654321', region: 'ewr1' });
    expect(clackMock.text).not.toHaveBeenCalled();
    expect(clackMock.log.warn).not.toHaveBeenCalled();
  });

  it('warns (but still returns) when the pair comes from env with no cluster set', async () => {
    // The keys only authenticate against their own subscription's cluster,
    // so an unset region leaves resolveS3Region guessing from the compute
    // region — which surfaces later as an opaque auth failure.
    process.env.VULTR_ACCESS_KEY = 'AK123456789';
    process.env.VULTR_SECRET_KEY = 'SK987654321';
    const { getS3Credentials } = await freshGuidedSetup();

    const result = await getS3Credentials('my-project');

    expect(result).toMatchObject({ accessKey: 'AK123456789', secretKey: 'SK987654321' });
    expect(clackMock.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('VULTR_STORAGE_REGION'),
    );
  });

  it('skipPrompts returns null instead of prompting when env is incomplete', async () => {
    const { getS3Credentials } = await freshGuidedSetup();

    expect(await getS3Credentials('my-project', { skipPrompts: true })).toBeNull();
    expect(clackMock.text).not.toHaveBeenCalled();
  });

  it('collects the cluster as a third value and returns it alongside the pair', async () => {
    mockFreshPrompts();
    clackMock.confirm.mockResolvedValue(false);
    const { getS3Credentials } = await freshGuidedSetup();

    const result = await getS3Credentials('my-project', { force: true, save: false });

    expect(result).toEqual({
      accessKey: 'AK123456789',
      secretKey: 'SK987654321',
      region: 'sjc1',
    });
    expect(clackMock.text).toHaveBeenCalledTimes(2);
  });

  it('sets all three env vars for in-process coherence even when save is declined', async () => {
    mockFreshPrompts();
    clackMock.confirm.mockResolvedValue(false);
    const { getS3Credentials } = await freshGuidedSetup();

    await getS3Credentials('my-project');

    expect(process.env.VULTR_ACCESS_KEY).toBe('AK123456789');
    expect(process.env.VULTR_SECRET_KEY).toBe('SK987654321');
    expect(process.env.VULTR_STORAGE_REGION).toBe('sjc1');
    expect(setEnvVarMock).not.toHaveBeenCalled();
  });

  it('save acceptance persists the cluster with the pair — all localOnly', async () => {
    mockFreshPrompts();
    clackMock.confirm.mockResolvedValue(true);
    const { getS3Credentials } = await freshGuidedSetup();

    await getS3Credentials('my-project');

    for (const [key, value] of [
      ['VULTR_ACCESS_KEY', 'AK123456789'],
      ['VULTR_SECRET_KEY', 'SK987654321'],
      ['VULTR_STORAGE_REGION', 'sjc1'],
    ]) {
      expect(setEnvVarMock).toHaveBeenCalledWith(key, value, expect.any(String), {
        localOnly: true,
      });
    }
  });

  describe('cluster validation', () => {
    async function clusterValidate() {
      mockFreshPrompts();
      clackMock.confirm.mockResolvedValue(false);
      const { getS3Credentials } = await freshGuidedSetup();
      await getS3Credentials('my-project', { force: true, save: false });
      // text call [0] is the access key, [1] is the cluster.
      return clackMock.text.mock.calls[1][0].validate as (v: string) => string | undefined;
    }

    it('accepts a bare cluster slug', async () => {
      const validate = await clusterValidate();
      expect(validate('ewr1')).toBeUndefined();
      expect(validate('chi3')).toBeUndefined();
    });

    it('rejects a pasted full hostname and says which part to keep', async () => {
      const validate = await clusterValidate();
      expect(validate('ewr1.vultrobjects.com')).toContain('ewr1.vultrobjects.com');
    });

    it('rejects empty and uppercase input', async () => {
      const validate = await clusterValidate();
      expect(validate('')).toBeTruthy();
      expect(validate('EWR1')).toBeTruthy();
    });
  });
});
