/**
 * `vibecarbon configure <feature> [provider]` subcommands.
 *
 * The admin UI advertises commands like `vibecarbon configure email resend`;
 * these tests pin that run()-routing + provider-preselect wiring in
 * src/configure.js. Two layers:
 *   1. Routing/preselect — spy the FEATURES promptFn and assert run() reaches
 *      the right feature with the right preselected provider, WITHOUT any real
 *      prompt interaction.
 *   2. promptSmtp presets — drive the REAL promptSmtp with @clack mocked to
 *      confirm the new Postmark / SendGrid presets (and the resend/custom
 *      branches) skip the provider select when a provider is preselected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clackMock = vi.hoisted(() => ({
  select: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
  },
}));
vi.mock('@clack/prompts', () => clackMock);

// Project/env/config side-effects are stubbed — these tests exercise routing,
// not disk I/O. loadEnvVariables returns {} so every isConfigured() is false
// (no overwrite gate) and no real .env is read.
const projectMock = vi.hoisted(() => ({
  loadEnvVariables: vi.fn(() => ({})),
  setEnvVar: vi.fn(),
  buildGitAddArgv: vi.fn(() => ['git', 'add', '-A']),
}));
vi.mock('../../../src/lib/project.js', () => projectMock);

const guardMock = vi.hoisted(() => ({
  assertInProjectDir: vi.fn(() => ({ projectName: 'test-project' })),
}));
vi.mock('../../../src/lib/project-guard.js', () => guardMock);

const configMock = vi.hoisted(() => ({
  loadProjectConfig: vi.fn(() => null),
  saveProjectConfig: vi.fn(),
}));
vi.mock('../../../src/lib/config.js', () => configMock);

const introMock = vi.hoisted(() => ({ introCommand: vi.fn() }));
vi.mock('../../../src/lib/cli/intro.js', () => introMock);

const progressMock = vi.hoisted(() => ({
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}));
vi.mock('../../../src/lib/cli/progress.js', () => progressMock);

import * as configure from '../../../src/configure.js';

type Feature = {
  value: string;
  label: string;
  promptFn: (...args: unknown[]) => Promise<unknown>;
};

function feature(value: string): Feature {
  const f = (configure.FEATURES as Feature[]).find((f) => f.value === value);
  if (!f) throw new Error(`no FEATURES entry for ${value}`);
  return f;
}

/** Spy a feature's promptFn so run() short-circuits into a clean no-op. */
function spyPrompt(value: string) {
  return vi.spyOn(feature(value), 'promptFn').mockResolvedValue(null);
}

beforeEach(() => {
  clackMock.select.mockReset();
  clackMock.confirm.mockReset();
  clackMock.password.mockReset();
  clackMock.text.mockReset();
  clackMock.note.mockReset();
  clackMock.outro.mockReset();
  clackMock.log.error.mockReset();
  projectMock.loadEnvVariables.mockReturnValue({});
  configMock.loadProjectConfig.mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('configure <feature> subcommand routing', () => {
  it('run(["email"]) invokes the smtp feature promptFn (no provider)', async () => {
    const spy = spyPrompt('smtp');
    await configure.run(['email']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toEqual({ provider: undefined });
    // Interactive feature menu is skipped on the direct path.
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('run(["email","resend"]) preselects the resend provider', async () => {
    const spy = spyPrompt('smtp');
    await configure.run(['email', 'resend']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toEqual({ provider: 'resend' });
  });

  it('run(["smtp","postmark"]) accepts the raw feature value + postmark', async () => {
    const spy = spyPrompt('smtp');
    await configure.run(['smtp', 'postmark']);
    expect(spy.mock.calls[0][2]).toEqual({ provider: 'postmark' });
  });

  it('run(["payments"]) routes to the billing feature', async () => {
    const billing = spyPrompt('billing');
    const smtp = spyPrompt('smtp');
    await configure.run(['payments']);
    expect(billing).toHaveBeenCalledTimes(1);
    expect(smtp).not.toHaveBeenCalled();
  });

  it('run(["payments","stripe"]) preselects stripe', async () => {
    const spy = spyPrompt('billing');
    await configure.run(['payments', 'stripe']);
    expect(spy.mock.calls[0][2]).toEqual({ provider: 'stripe' });
  });

  it('run(["analytics"]) routes to the plausible feature', async () => {
    const spy = spyPrompt('plausible');
    await configure.run(['analytics']);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('run(["analytics","plausible"]) ignores the provider (no provider choice)', async () => {
    const spy = spyPrompt('plausible');
    await configure.run(['analytics', 'plausible']);
    // Provider arg is dropped for a feature with no provider choice.
    expect(spy.mock.calls[0][2]).toEqual({ provider: undefined });
  });

  it('run(["oauth","google"]) preselects google', async () => {
    const spy = spyPrompt('oauth');
    await configure.run(['oauth', 'google']);
    expect(spy.mock.calls[0][2]).toEqual({ provider: 'google' });
  });

  it('run(["oauth","microsoft"]) preselects microsoft', async () => {
    const spy = spyPrompt('oauth');
    await configure.run(['oauth', 'microsoft']);
    expect(spy.mock.calls[0][2]).toEqual({ provider: 'microsoft' });
  });

  it('run(["providers"]) routes to the providers feature', async () => {
    const spy = spyPrompt('providers');
    await configure.run(['providers']);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('configure <feature> — unknown provider validation', () => {
  it('run(["email","bogus"]) errors listing valid providers and exits 1', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const smtp = spyPrompt('smtp');

    await expect(configure.run(['email', 'bogus'])).rejects.toThrow('exit:1');

    expect(smtp).not.toHaveBeenCalled();
    expect(clackMock.log.error).toHaveBeenCalledTimes(1);
    const msg = String(clackMock.log.error.mock.calls[0][0]);
    expect(msg).toContain('bogus');
    expect(msg).toContain('resend');
    expect(msg).toContain('postmark');
    expect(msg).toContain('sendgrid');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('run(["oauth","github"]) rejects an unsupported oauth provider', async () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const oauth = spyPrompt('oauth');
    await expect(configure.run(['oauth', 'github'])).rejects.toThrow('exit:1');
    expect(oauth).not.toHaveBeenCalled();
  });
});

describe('configure (no subcommand) still shows the interactive feature menu', () => {
  it('run([]) reaches the feature select menu', async () => {
    // Menu returns smtp; that feature's promptFn is spied to a no-op so the
    // run completes without touching disk.
    clackMock.select.mockResolvedValueOnce('smtp');
    spyPrompt('smtp');

    await configure.run([]);

    expect(clackMock.select).toHaveBeenCalledTimes(1);
    const call = clackMock.select.mock.calls[0][0];
    expect(String(call.message)).toMatch(/which feature/i);
  });
});

describe('promptSmtp presets (real function, @clack mocked)', () => {
  // env vars promptSmtp always prompts for after the provider branch.
  function primeSenderPrompts() {
    // adminEmail, then senderName — both go through promptText → p.text.
    clackMock.text.mockResolvedValue('support@example.com');
  }

  it('postmark preset: host smtp.postmarkapp.com, port 587, token as user AND pass; provider select skipped', async () => {
    primeSenderPrompts();
    clackMock.password.mockResolvedValueOnce('pm-server-token');

    const result = (await feature('smtp').promptFn({}, {}, { provider: 'postmark' })) as Record<
      string,
      string
    >;

    expect(clackMock.select).not.toHaveBeenCalled(); // provider prompt skipped
    expect(result.SMTP_HOST).toBe('smtp.postmarkapp.com');
    expect(result.SMTP_PORT).toBe('587');
    expect(result.SMTP_USER).toBe('pm-server-token');
    expect(result.SMTP_PASS).toBe('pm-server-token');
  });

  it('sendgrid preset: host smtp.sendgrid.net, port 587, user "apikey", pass = api key', async () => {
    primeSenderPrompts();
    clackMock.password.mockResolvedValueOnce('SG.secret-key');

    const result = (await feature('smtp').promptFn({}, {}, { provider: 'sendgrid' })) as Record<
      string,
      string
    >;

    expect(clackMock.select).not.toHaveBeenCalled();
    expect(result.SMTP_HOST).toBe('smtp.sendgrid.net');
    expect(result.SMTP_PORT).toBe('587');
    expect(result.SMTP_USER).toBe('apikey');
    expect(result.SMTP_PASS).toBe('SG.secret-key');
  });

  it('resend preselect: host smtp.resend.com, provider select skipped', async () => {
    primeSenderPrompts();
    clackMock.password.mockResolvedValueOnce('re_key');

    const result = (await feature('smtp').promptFn({}, {}, { provider: 'resend' })) as Record<
      string,
      string
    >;

    expect(clackMock.select).not.toHaveBeenCalled();
    expect(result.SMTP_HOST).toBe('smtp.resend.com');
    expect(result.SMTP_USER).toBe('resend');
  });

  it('no preselect: shows the Email provider select including postmark + sendgrid', async () => {
    primeSenderPrompts();
    clackMock.select.mockResolvedValueOnce('resend'); // pick resend at the prompt
    clackMock.password.mockResolvedValueOnce('re_key');

    await feature('smtp').promptFn({}, {});

    expect(clackMock.select).toHaveBeenCalledTimes(1);
    const call = clackMock.select.mock.calls[0][0];
    expect(String(call.message)).toMatch(/email provider/i);
    const values = call.options.map((o: { value: string }) => o.value);
    expect(values).toEqual(expect.arrayContaining(['resend', 'postmark', 'sendgrid', 'smtp']));
  });
});
