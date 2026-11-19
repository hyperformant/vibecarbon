/**
 * Every compute provider's guided-setup credential flows, as one table.
 *
 * The rows are the provider registry (`PROVIDERS`), and each row goes
 * through the provider class's own statics, `promptApiToken` and
 * `promptObjectStorageCredentials`, the way deploy, scale, destroy and
 * backup reach the guided setups. A provider added to the registry gets
 * every case here without an edit; one whose credential differs in shape
 * needs a row in QUIRKS, and the first test refuses a quirk for a provider
 * the registry does not have.
 *
 * What only one provider does stays in its own file: the guide text, Vultr's
 * cluster prompt and key checks, Cloudflare's DNS token (it is not a compute
 * provider), Scaleway's domain onboarding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clackMock = await vi.hoisted(async () => {
  const { clackFake } = await import('../../_shared/clack-fake.js');
  return clackFake({
    fns: ['password', 'text', 'confirm', 'cancel', 'note'],
    log: ['info', 'warn', 'success'],
    with: { isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')) },
  });
});
vi.mock('@clack/prompts', () => clackMock);
// These cases drive the interactive flow, so the terminal is interactive.
// Off a TTY every prompt must throw instead: that is pinned in
// tests/unit/lib/cli/interactive-prompt-guard.test.ts.
vi.mock('../../../src/lib/cli/tty-guard.js', () => ({ assertInteractiveStdin: vi.fn() }));

const setEnvVarMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/project.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/project.js')>()),
  setEnvVar: setEnvVarMock,
  describeCredentialSource: (keys: string[]) => ({
    source: 'shell',
    label: `your shell environment (${keys.join(', ')})`,
    where: 'your shell environment',
  }),
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

import { PROVIDERS } from '../../../src/lib/providers/index.js';

/**
 * Where a provider's credential is not one token plus one plain key pair.
 * Prompts that follow the token, or the key pair, are text prompts in the
 * order listed here.
 */
interface Quirk {
  /** Values the token flow collects with the token, saved with it. */
  tokenCompanions?: Record<string, string>;
  /** A value the storage flow collects after the pair, saved with it. */
  storageExtras?: Record<string, string>;
  /** The storage keys are the compute credential: the storage flow runs the token flow. */
  storageRunsTokenFlow?: boolean;
}

const QUIRKS: Record<string, Quirk> = {
  // The secret key is the token; the access key and project id travel with it.
  scaleway: {
    tokenCompanions: {
      SCALEWAY_ACCESS_KEY: 'SCWABCDEFGHIJKLMNOPQ',
      SCALEWAY_DEFAULT_PROJECT_ID: '11111111-2222-4333-8444-555555555555',
    },
    storageRunsTokenFlow: true,
  },
  // Storage keys are minted per subscription, so the cluster comes with them.
  vultr: { storageExtras: { [PROVIDERS.vultr.S3_REGION_ENV]: 'sjc1' } },
};

const TOKEN = 'a'.repeat(64);
const ENV_PAIR = { accessKey: 'AK123456789', secretKey: 'SK987654321' };
const PASTED_PAIR = { accessKey: 'AK-fresh-1234', secretKey: 'SK-fresh-1234' };

const ROWS = Object.entries(PROVIDERS).map(([id, Provider]) => {
  const quirk = QUIRKS[id] ?? {};
  const [accessEnv, secretEnv] = Provider.OBJECT_STORAGE_ENV;
  const companions = quirk.tokenCompanions ?? {};
  // What the storage flow asks for after the access key, as text prompts.
  const storageTexts = quirk.storageRunsTokenFlow
    ? Object.values(companions).slice(1)
    : Object.values(quirk.storageExtras ?? {});
  // What the storage flow saves beside the pair.
  const storageSaves = quirk.storageRunsTokenFlow
    ? Object.fromEntries(Object.entries(companions).filter(([key]) => key !== accessEnv))
    : (quirk.storageExtras ?? {});
  return {
    id,
    tokenEnv: Provider.TOKEN_ENV,
    accessEnv,
    secretEnv,
    companions,
    storageTexts,
    storageSaves,
    // Scaleway's storage flow shows its own guide and then the token guide.
    storageNotes: quirk.storageRunsTokenFlow ? 2 : 1,
    touched: [
      Provider.TOKEN_ENV,
      accessEnv,
      secretEnv,
      ...Object.keys(companions),
      ...Object.keys(quirk.storageExtras ?? {}),
    ],
  };
});

type Row = (typeof ROWS)[number];

/**
 * The provider class from a fresh module graph. Each guided-setup module
 * keeps its "save keys?" answer for the life of the process, so one test's
 * answer would decide the next test's prompt without this.
 */
async function freshProvider(id: string) {
  vi.resetModules();
  const { PROVIDERS: fresh } = await import('../../../src/lib/providers/index.js');
  return fresh[id as keyof typeof fresh];
}

/**
 * The guide shown before the first prompt is `notes` note boxes and prints
 * no log.info line (p.log.info('') per line drew a gutter dot each, the
 * dot spam the note box replaced). Later lines, such as the quiet spinner's
 * "Verifying..." line, are not the guide's.
 */
function expectGuideIsNoteBoxes(notes: number) {
  const firstPrompt = Math.min(
    ...clackMock.text.mock.invocationCallOrder,
    ...clackMock.password.mock.invocationCallOrder,
  );
  expect(clackMock.note).toHaveBeenCalledTimes(notes);
  expect(clackMock.note.mock.invocationCallOrder.every((n) => n < firstPrompt)).toBe(true);
  expect(clackMock.log.info.mock.invocationCallOrder.filter((n) => n < firstPrompt)).toEqual([]);
}

/** Answer the token flow's prompts: the token, then any companions. */
function answerTokenPrompts(row: Row, save: boolean) {
  clackMock.password.mockResolvedValue(TOKEN);
  for (const value of Object.values(row.companions)) clackMock.text.mockResolvedValueOnce(value);
  clackMock.confirm.mockResolvedValue(save);
}

/** Answer the storage flow's prompts: the pair, then what follows it. */
function answerStoragePrompts(row: Row, save: boolean) {
  clackMock.text.mockResolvedValueOnce(PASTED_PAIR.accessKey);
  for (const value of row.storageTexts) clackMock.text.mockResolvedValueOnce(value);
  clackMock.password.mockResolvedValue(PASTED_PAIR.secretKey);
  clackMock.confirm.mockResolvedValue(save);
}

it('every quirk names a registered provider', () => {
  expect(Object.keys(QUIRKS).filter((id) => !(id in PROVIDERS))).toEqual([]);
});

describe.each(ROWS)('$id guided setup', (row) => {
  const ambient: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of row.touched) {
      ambient[key] = process.env[key];
      delete process.env[key];
    }
    for (const fn of [clackMock.password, clackMock.text, clackMock.confirm, clackMock.note]) {
      fn.mockReset();
    }
    for (const fn of Object.values(clackMock.log)) fn.mockReset();
    setEnvVarMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    for (const key of row.touched) {
      if (ambient[key] === undefined) delete process.env[key];
      else process.env[key] = ambient[key];
    }
  });

  /** Set the token and its companions, as a shell or .env.local would. */
  function exportToken() {
    process.env[row.tokenEnv] = TOKEN;
    Object.assign(process.env, row.companions);
  }

  function exportPair() {
    process.env[row.accessEnv] = ENV_PAIR.accessKey;
    process.env[row.secretEnv] = ENV_PAIR.secretKey;
  }

  describe('promptApiToken', () => {
    it('returns the env var verbatim when set and valid, never prompting', async () => {
      exportToken();
      const Provider = await freshProvider(row.id);

      expect(await Provider.promptApiToken('my-project')).toBe(TOKEN);
      expect(clackMock.password).not.toHaveBeenCalled();
    });

    it('falls through to the prompt when the env var is set but the API answers 401', async () => {
      exportToken();
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
      answerTokenPrompts(row, false);
      const Provider = await freshProvider(row.id);

      await Provider.promptApiToken('my-project', { save: false });

      expect(clackMock.log.warn).toHaveBeenCalledWith(
        expect.stringContaining(`${row.tokenEnv} from your shell environment is set but invalid`),
      );
      expect(clackMock.password).toHaveBeenCalledTimes(1);
    });

    it('force:true skips the env lookup and goes straight to the prompt', async () => {
      exportToken();
      answerTokenPrompts(row, false);
      const Provider = await freshProvider(row.id);

      const result = await Provider.promptApiToken('my-project', { force: true, save: false });

      expect(clackMock.password).toHaveBeenCalledTimes(1);
      expect(result).toBe(TOKEN);
    });

    it('shows its guide as note boxes before the first prompt, never as log.info lines', async () => {
      answerTokenPrompts(row, false);
      const Provider = await freshProvider(row.id);

      await Provider.promptApiToken('my-project', { force: true, save: false });

      expectGuideIsNoteBoxes(1);
    });

    it('treats an unreachable API as verified rather than stranding the operator', async () => {
      fetchMock.mockReset();
      fetchMock.mockRejectedValue(new Error('ENOTFOUND'));
      answerTokenPrompts(row, false);
      const Provider = await freshProvider(row.id);

      expect(await Provider.promptApiToken('my-project', { save: false })).toBe(TOKEN);
    });

    it('prompts when the env var is unset, then sets process.env for in-process coherence', async () => {
      answerTokenPrompts(row, false); // decline save
      const Provider = await freshProvider(row.id);

      expect(await Provider.promptApiToken('my-project')).toBe(TOKEN);
      expect(process.env[row.tokenEnv]).toBe(TOKEN);
      for (const [key, value] of Object.entries(row.companions)) {
        expect(process.env[key]).toBe(value);
      }
      expect(setEnvVarMock).not.toHaveBeenCalled();
    });

    it('save acceptance persists via setEnvVar with localOnly:true (never plain .env)', async () => {
      answerTokenPrompts(row, true); // accept save
      const Provider = await freshProvider(row.id);

      await Provider.promptApiToken('my-project');

      for (const [key, value] of Object.entries({ [row.tokenEnv]: TOKEN, ...row.companions })) {
        expect(setEnvVarMock).toHaveBeenCalledWith(key, value, expect.any(String), {
          localOnly: true,
        });
      }
    });
  });

  describe('promptObjectStorageCredentials', () => {
    it('returns env values verbatim when both are set, never prompting, and names where they came from', async () => {
      exportPair();
      const Provider = await freshProvider(row.id);

      const result = await Provider.promptObjectStorageCredentials('my-project');

      expect(result).toMatchObject(ENV_PAIR);
      // The line names WHERE the keys came from: a stale or other-project
      // export is the usual reason good-looking keys get rejected.
      expect(result?.source).toContain('shell environment');
      expect(clackMock.log.info).toHaveBeenCalledWith(
        expect.stringContaining(`from your shell environment (${row.accessEnv}, ${row.secretEnv})`),
      );
      expect(clackMock.text).not.toHaveBeenCalled();
      expect(clackMock.password).not.toHaveBeenCalled();
    });

    it('force:true skips the env lookup and goes straight to the prompt', async () => {
      exportPair();
      answerStoragePrompts(row, false);
      const Provider = await freshProvider(row.id);

      const result = await Provider.promptObjectStorageCredentials('my-project', {
        force: true,
        save: false,
      });

      expect(clackMock.text).toHaveBeenCalledTimes(1 + row.storageTexts.length);
      expect(result).toMatchObject(PASTED_PAIR);
    });

    it('shows its guide as note boxes before the first prompt, never as log.info lines', async () => {
      answerStoragePrompts(row, false);
      const Provider = await freshProvider(row.id);

      await Provider.promptObjectStorageCredentials('my-project', { force: true, save: false });

      expectGuideIsNoteBoxes(row.storageNotes);
    });

    it('sets what it collected in process.env even when save is declined', async () => {
      answerStoragePrompts(row, false);
      const Provider = await freshProvider(row.id);

      await Provider.promptObjectStorageCredentials('my-project');

      expect(process.env[row.accessEnv]).toBe(PASTED_PAIR.accessKey);
      expect(process.env[row.secretEnv]).toBe(PASTED_PAIR.secretKey);
      for (const [key, value] of Object.entries(row.storageSaves)) {
        expect(process.env[key]).toBe(value);
      }
      expect(setEnvVarMock).not.toHaveBeenCalled();
    });

    it('save acceptance persists every key via setEnvVar with localOnly:true', async () => {
      answerStoragePrompts(row, true);
      const Provider = await freshProvider(row.id);

      await Provider.promptObjectStorageCredentials('my-project');

      const saved = {
        [row.accessEnv]: PASTED_PAIR.accessKey,
        [row.secretEnv]: PASTED_PAIR.secretKey,
        ...row.storageSaves,
      };
      for (const [key, value] of Object.entries(saved)) {
        expect(setEnvVarMock).toHaveBeenCalledWith(key, value, expect.any(String), {
          localOnly: true,
        });
      }
    });

    // destroy's resolveDestroyS3Config passes skipPrompts:true off a TTY,
    // because clack's prompts never settle on a non-TTY stdin with no data.
    // This proves the branch returns BEFORE any clack call, not just that
    // the caller meant it to.
    it('skipPrompts:true returns null without prompting when env vars are missing', async () => {
      const Provider = await freshProvider(row.id);

      const result = await Provider.promptObjectStorageCredentials('my-project', {
        skipPrompts: true,
      });

      expect(result).toBeNull();
      expect(clackMock.text).not.toHaveBeenCalled();
      expect(clackMock.password).not.toHaveBeenCalled();
    });

    it('skipPrompts:true is ignored when env vars ARE present: still returns them, never prompting', async () => {
      exportPair();
      const Provider = await freshProvider(row.id);

      const result = await Provider.promptObjectStorageCredentials('my-project', {
        skipPrompts: true,
      });

      expect(result).toMatchObject(ENV_PAIR);
      expect(clackMock.text).not.toHaveBeenCalled();
    });
  });
});
