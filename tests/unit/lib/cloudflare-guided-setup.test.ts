import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mirrors hetzner-guided-setup.test.ts's structure exactly (see its header
// comment for the shared rationale): single bordered p.note() guide, env-only
// lookup (no credentials.json leg), saveIfWanted persists via
// setEnvVar({localOnly:true}). Cloudflare has only one credential (the API
// token) so there's no S3-equivalent describe block here.
const clackMock = vi.hoisted(() => ({
  password: vi.fn(),
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

const verifyTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/cloudflare-dns.js', () => ({ verifyToken: verifyTokenMock }));

import { displayApiTokenGuide } from '../../../src/lib/cloudflare-guided-setup.js';

// getApiToken shares a module-level `_savePreference` flag with any future
// credential this module might prompt for (same contract as
// hetzner/digitalocean-guided-setup.js). vi.resetModules() + a fresh dynamic
// import per test isolates each test's `_savePreference` back to null.
async function freshGuidedSetup() {
  vi.resetModules();
  return import('../../../src/lib/cloudflare-guided-setup.js');
}

const strip = (s: unknown) => stripVTControlCharacters(String(s));

const VALID_TOKEN = 'a'.repeat(40);

describe('cloudflare-guided-setup guide', () => {
  beforeEach(() => {
    clackMock.note.mockReset();
    clackMock.log.info.mockReset();
  });

  it('renders exactly one note box with the token steps', () => {
    displayApiTokenGuide('my-project');

    expect(clackMock.note).toHaveBeenCalledTimes(1);
    const [body, title] = clackMock.note.mock.calls[0];
    expect(strip(title)).toContain('Cloudflare API Token');
    const text = strip(body);
    expect(text).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(text).toContain('Edit zone DNS');
    expect(text).toContain('my-project');
  });

  it('has at most 3 numbered steps', () => {
    displayApiTokenGuide('my-project');
    const text = strip(clackMock.note.mock.calls[0][0]);
    for (const n of [1, 2, 3]) expect(text).toContain(`${n}.`);
    expect(text).not.toContain('4.');
  });

  it('ends with the dedicated-keys-per-project practice line', () => {
    displayApiTokenGuide('my-project');
    const text = strip(clackMock.note.mock.calls[0][0]);
    expect(text.toLowerCase()).toContain('dedicated');
    expect(text.toLowerCase()).toContain('project');
  });

  it('does not emit per-line log.info output (the ● dot-spam pattern)', () => {
    displayApiTokenGuide('my-project');
    expect(clackMock.log.info).not.toHaveBeenCalled();
  });

  it('falls back to a placeholder name when projectName is missing', () => {
    displayApiTokenGuide(undefined);
    const text = strip(clackMock.note.mock.calls[0][0]);
    expect(text).toContain('vibecarbon');
  });
});

describe('getApiToken — env-only lookup', () => {
  const ambientToken = process.env.CLOUDFLARE_API_TOKEN;

  beforeEach(() => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    clackMock.password.mockReset();
    clackMock.confirm.mockReset();
    clackMock.log.info.mockReset();
    clackMock.log.warn.mockReset();
    setEnvVarMock.mockReset();
    verifyTokenMock.mockReset();
  });

  afterEach(() => {
    if (ambientToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = ambientToken;
  });

  it('returns the env var verbatim when set and valid, never prompting', async () => {
    process.env.CLOUDFLARE_API_TOKEN = VALID_TOKEN;
    verifyTokenMock.mockResolvedValue({ valid: true });
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project');

    expect(result).toBe(VALID_TOKEN);
    expect(clackMock.password).not.toHaveBeenCalled();
  });

  it('env var set but invalid falls through to the interactive prompt', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'stale-token';
    verifyTokenMock
      .mockResolvedValueOnce({ valid: false, error: 'Invalid API Token' })
      .mockResolvedValueOnce({ valid: true });
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(false);
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project');

    expect(clackMock.log.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid API Token'));
    expect(clackMock.password).toHaveBeenCalledTimes(1);
    expect(result).toBe(VALID_TOKEN);
  });

  it('env var unreachable proceeds with a warning instead of re-prompting', async () => {
    process.env.CLOUDFLARE_API_TOKEN = VALID_TOKEN;
    verifyTokenMock.mockResolvedValue({ valid: true, unreachable: true });
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project');

    expect(result).toBe(VALID_TOKEN);
    expect(clackMock.password).not.toHaveBeenCalled();
    expect(clackMock.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not reach Cloudflare API'),
    );
  });

  it('force:true skips the env lookup and goes straight to the prompt', async () => {
    process.env.CLOUDFLARE_API_TOKEN = VALID_TOKEN;
    verifyTokenMock.mockResolvedValue({ valid: true });
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(false);
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project', { force: true, save: false });

    expect(clackMock.password).toHaveBeenCalledTimes(1);
    expect(result).toBe(VALID_TOKEN);
  });

  it('interactive prompt retries on an invalid token before succeeding', async () => {
    verifyTokenMock
      .mockResolvedValueOnce({ valid: false, error: 'Invalid API Token' })
      .mockResolvedValueOnce({ valid: true });
    clackMock.password.mockResolvedValueOnce('bad').mockResolvedValueOnce(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(false);
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project');

    expect(clackMock.password).toHaveBeenCalledTimes(2);
    expect(result).toBe(VALID_TOKEN);
  });

  it('interactive prompt proceeds with a warning when verification is unreachable', async () => {
    verifyTokenMock.mockResolvedValue({ valid: true, unreachable: true });
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(false);
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project');

    expect(result).toBe(VALID_TOKEN);
  });

  it('prompts when the env var is unset, then sets process.env for in-process coherence', async () => {
    verifyTokenMock.mockResolvedValue({ valid: true });
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(false); // decline save
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project');

    expect(result).toBe(VALID_TOKEN);
    expect(process.env.CLOUDFLARE_API_TOKEN).toBe(VALID_TOKEN);
    expect(setEnvVarMock).not.toHaveBeenCalled();
  });

  it('save acceptance persists via setEnvVar with localOnly:true (never plain .env)', async () => {
    verifyTokenMock.mockResolvedValue({ valid: true });
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(true); // accept save
    const { getApiToken } = await freshGuidedSetup();

    await getApiToken('my-project');

    expect(setEnvVarMock).toHaveBeenCalledWith(
      'CLOUDFLARE_API_TOKEN',
      VALID_TOKEN,
      expect.any(String),
      { localOnly: true },
    );
  });

  it('save:false never calls setEnvVar even if the user would have accepted', async () => {
    verifyTokenMock.mockResolvedValue({ valid: true });
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    const { getApiToken } = await freshGuidedSetup();

    await getApiToken('my-project', { force: true, save: false });

    expect(clackMock.confirm).not.toHaveBeenCalled();
    expect(setEnvVarMock).not.toHaveBeenCalled();
  });
});
