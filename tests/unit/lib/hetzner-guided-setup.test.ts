import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Guided-setup guides must render as a single bordered p.note() box —
// p.log.info('') draws a `●` gutter dot + spacer line per call in every
// @clack/prompts 1.x release, which turned the guides into dot spam.
//
// A3 sweep: getApiToken/getS3Credentials/saveIfWanted dropped the
// credentials-file leg entirely (env-only lookup) and saveIfWanted now
// persists via setEnvVar({localOnly:true}) instead of saveCredentials — see
// the describe blocks below the guide tests.
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
} from '../../../src/lib/hetzner-guided-setup.js';

// getApiToken/getS3Credentials share a module-level `_savePreference` flag
// (by design — one "Save keys for future deploys?" answer applies to every
// credential prompted in a single guided-setup session). That means the two
// functions can't be imported once at module scope for these describe
// blocks: an earlier test's answer would leak into a later test as a
// already-decided (non-null) preference and short-circuit its confirm
// prompt. vi.resetModules() + a fresh dynamic import per test isolates each
// test's `_savePreference` back to null — mirrors the freshImport() pattern
// in tests/unit/lib/github-environments.test.ts.
async function freshGuidedSetup() {
  vi.resetModules();
  return import('../../../src/lib/hetzner-guided-setup.js');
}

const strip = (s: unknown) => stripVTControlCharacters(String(s));

const VALID_TOKEN = 'a'.repeat(64);

function mockTokenValid() {
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
}

describe('hetzner-guided-setup guides', () => {
  beforeEach(() => {
    clackMock.note.mockReset();
    clackMock.log.info.mockReset();
  });

  describe('displayApiTokenGuide', () => {
    it('renders exactly one note box with the token steps', () => {
      displayApiTokenGuide('my-project');

      expect(clackMock.note).toHaveBeenCalledTimes(1);
      const [body, title] = clackMock.note.mock.calls[0];
      expect(strip(title)).toContain('Hetzner API Token');
      const text = strip(body);
      expect(text).toContain('https://console.hetzner.cloud/');
      expect(text).toContain('my-project');
      expect(text).toContain('Read & Write');
      expect(text).toContain('Copy the token immediately');
    });

    it('does not emit per-line log.info output (the ● dot-spam pattern)', () => {
      displayApiTokenGuide('my-project');
      expect(clackMock.log.info).not.toHaveBeenCalled();
    });

    it('falls back to placeholder names when projectName is missing', () => {
      displayApiTokenGuide(undefined);
      const text = strip(clackMock.note.mock.calls[0][0]);
      expect(text).toContain('your-project');
      expect(text).toContain('"vibecarbon-deploy"');
    });

    // B2a: every guide is pinned to at most 3 numbered steps, the exact
    // console.hetzner.cloud/projects deep link, and the dedicated-keys
    // practice line — mirrors cloudflare-guided-setup.test.ts's identical
    // pins (Cloudflare "already complies").
    it('has at most 3 numbered steps', () => {
      displayApiTokenGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      for (const n of [1, 2, 3]) expect(text).toContain(`${n}.`);
      expect(text).not.toContain('4.');
    });

    it('pins the exact console.hetzner.cloud/projects deep link', () => {
      displayApiTokenGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      expect(text).toContain('https://console.hetzner.cloud/projects');
    });

    it('ends with the dedicated-keys-per-project practice line', () => {
      displayApiTokenGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]).toLowerCase();
      expect(text).toContain('dedicated');
      expect(text).toContain('project');
    });
  });

  describe('displayS3CredentialsGuide', () => {
    it('renders exactly one note box including the Why-S3 rationale', () => {
      displayS3CredentialsGuide('my-project');

      expect(clackMock.note).toHaveBeenCalledTimes(1);
      const [body, title] = clackMock.note.mock.calls[0];
      expect(strip(title)).toContain('Object Storage');
      const text = strip(body);
      expect(text).toContain('S3 credentials');
      expect(text).toContain('"my-project-s3"');
      expect(text).toContain('Copy BOTH credentials immediately');
      expect(text).toContain('database backups and file uploads');
    });

    it('does not emit per-line log.info output (the ● dot-spam pattern)', () => {
      displayS3CredentialsGuide('my-project');
      expect(clackMock.log.info).not.toHaveBeenCalled();
    });

    it('has at most 3 numbered steps', () => {
      displayS3CredentialsGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      for (const n of [1, 2, 3]) expect(text).toContain(`${n}.`);
      expect(text).not.toContain('4.');
    });

    it('pins the exact console.hetzner.cloud/projects deep link', () => {
      displayS3CredentialsGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]);
      expect(text).toContain('https://console.hetzner.cloud/projects');
    });

    it('ends with the dedicated-keys-per-project practice line', () => {
      displayS3CredentialsGuide('my-project');
      const text = strip(clackMock.note.mock.calls[0][0]).toLowerCase();
      expect(text).toContain('dedicated');
      expect(text).toContain('project');
    });
  });
});

describe('getApiToken — env-only lookup (A3: credentials-file leg removed)', () => {
  const ambientToken = process.env.HETZNER_API_TOKEN;

  beforeEach(() => {
    delete process.env.HETZNER_API_TOKEN;
    clackMock.password.mockReset();
    clackMock.confirm.mockReset();
    clackMock.log.info.mockReset();
    clackMock.log.warn.mockReset();
    setEnvVarMock.mockReset();
    fetchMock.mockReset();
  });

  afterEach(() => {
    if (ambientToken === undefined) delete process.env.HETZNER_API_TOKEN;
    else process.env.HETZNER_API_TOKEN = ambientToken;
  });

  it('returns the env var verbatim when set and valid, never prompting', async () => {
    process.env.HETZNER_API_TOKEN = VALID_TOKEN;
    mockTokenValid();
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project');

    expect(result).toBe(VALID_TOKEN);
    expect(clackMock.password).not.toHaveBeenCalled();
  });

  it('force:true skips the env lookup and goes straight to the prompt', async () => {
    process.env.HETZNER_API_TOKEN = VALID_TOKEN;
    mockTokenValid();
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(false);
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project', { force: true, save: false });

    expect(clackMock.password).toHaveBeenCalledTimes(1);
    expect(result).toBe(VALID_TOKEN);
  });

  it('prompts when the env var is unset, then sets process.env for in-process coherence', async () => {
    mockTokenValid();
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(false); // decline save
    const { getApiToken } = await freshGuidedSetup();

    const result = await getApiToken('my-project');

    expect(result).toBe(VALID_TOKEN);
    expect(process.env.HETZNER_API_TOKEN).toBe(VALID_TOKEN);
    expect(setEnvVarMock).not.toHaveBeenCalled();
  });

  it('save acceptance persists via setEnvVar with localOnly:true (never plain .env)', async () => {
    mockTokenValid();
    clackMock.password.mockResolvedValue(VALID_TOKEN);
    clackMock.confirm.mockResolvedValue(true); // accept save
    const { getApiToken } = await freshGuidedSetup();

    await getApiToken('my-project');

    expect(setEnvVarMock).toHaveBeenCalledWith(
      'HETZNER_API_TOKEN',
      VALID_TOKEN,
      expect.any(String),
      { localOnly: true },
    );
  });
});

describe('getS3Credentials — env-only lookup (A3: credentials-file leg removed)', () => {
  const ambient = {
    key: process.env.HETZNER_ACCESS_KEY,
    secret: process.env.HETZNER_SECRET_KEY,
  };

  beforeEach(() => {
    delete process.env.HETZNER_ACCESS_KEY;
    delete process.env.HETZNER_SECRET_KEY;
    clackMock.text.mockReset();
    clackMock.password.mockReset();
    clackMock.confirm.mockReset();
    clackMock.log.info.mockReset();
    setEnvVarMock.mockReset();
  });

  afterEach(() => {
    if (ambient.key === undefined) delete process.env.HETZNER_ACCESS_KEY;
    else process.env.HETZNER_ACCESS_KEY = ambient.key;
    if (ambient.secret === undefined) delete process.env.HETZNER_SECRET_KEY;
    else process.env.HETZNER_SECRET_KEY = ambient.secret;
  });

  it('returns env values verbatim when both are set, never prompting', async () => {
    process.env.HETZNER_ACCESS_KEY = 'AK123456789';
    process.env.HETZNER_SECRET_KEY = 'SK987654321';
    const { getS3Credentials } = await freshGuidedSetup();

    const result = await getS3Credentials('my-project');

    expect(result).toEqual({ accessKey: 'AK123456789', secretKey: 'SK987654321' });
    expect(clackMock.text).not.toHaveBeenCalled();
  });

  it('force:true skips the env lookup and goes straight to the prompt', async () => {
    process.env.HETZNER_ACCESS_KEY = 'AK123456789';
    process.env.HETZNER_SECRET_KEY = 'SK987654321';
    clackMock.text.mockResolvedValue('AK-fresh-1234');
    clackMock.password.mockResolvedValue('SK-fresh-1234');
    clackMock.confirm.mockResolvedValue(false);
    const { getS3Credentials } = await freshGuidedSetup();

    const result = await getS3Credentials('my-project', { force: true, save: false });

    expect(clackMock.text).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ accessKey: 'AK-fresh-1234', secretKey: 'SK-fresh-1234' });
  });

  it('save acceptance persists both keys via setEnvVar with localOnly:true', async () => {
    clackMock.text.mockResolvedValue('AK-fresh-1234');
    clackMock.password.mockResolvedValue('SK-fresh-1234');
    clackMock.confirm.mockResolvedValue(true);
    const { getS3Credentials } = await freshGuidedSetup();

    await getS3Credentials('my-project');

    expect(setEnvVarMock).toHaveBeenCalledWith(
      'HETZNER_ACCESS_KEY',
      'AK-fresh-1234',
      expect.any(String),
      { localOnly: true },
    );
    expect(setEnvVarMock).toHaveBeenCalledWith(
      'HETZNER_SECRET_KEY',
      'SK-fresh-1234',
      expect.any(String),
      { localOnly: true },
    );
    expect(process.env.HETZNER_ACCESS_KEY).toBe('AK-fresh-1234');
    expect(process.env.HETZNER_SECRET_KEY).toBe('SK-fresh-1234');
  });

  // M3 Task 9g fix round 1: destroy's resolveDestroyS3Config passes
  // skipPrompts:true off a TTY, because clack's prompt primitives have no
  // isTTY/stdin-close handling of their own — on non-TTY stdin with no data
  // the prompt promise never resolves. This is the direct proof that the
  // skipPrompts branch actually short-circuits BEFORE any clack call, not
  // just that the caller intended it to.
  it('skipPrompts:true returns null without prompting when env vars are missing', async () => {
    const { getS3Credentials } = await freshGuidedSetup();

    const result = await getS3Credentials('my-project', { skipPrompts: true });

    expect(result).toBeNull();
    expect(clackMock.text).not.toHaveBeenCalled();
    expect(clackMock.password).not.toHaveBeenCalled();
  });

  it('skipPrompts:true is ignored when env vars ARE present — still returns them, never prompting', async () => {
    process.env.HETZNER_ACCESS_KEY = 'AK123456789';
    process.env.HETZNER_SECRET_KEY = 'SK987654321';
    const { getS3Credentials } = await freshGuidedSetup();

    const result = await getS3Credentials('my-project', { skipPrompts: true });

    expect(result).toEqual({ accessKey: 'AK123456789', secretKey: 'SK987654321' });
    expect(clackMock.text).not.toHaveBeenCalled();
  });
});
