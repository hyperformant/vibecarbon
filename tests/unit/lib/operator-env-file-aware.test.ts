/**
 * File-aware operator-config checks (review residual, PR #112).
 *
 * `ACME_CA_SERVER` and `ALLOWED_SSH_IPS` are `where: '.env'` — the value the
 * deployed SERVER reads lives in the project's env file, and
 * `bootstrapOperatorEnv` never folds runtime-config keys into process.env.
 * Until this change Gate 1 (deploy.js), the orchestrator gate and `status`'s
 * base pass checked access/tls/state against `process.env` ONLY, so the one
 * copy that ships was the one copy never validated.
 *
 * Rule under test: for a registry entry whose `where` is `.env` or
 * `.env.local`, check BOTH the merged file values (`.env.local` over `.env`)
 * and the shell; merge problems by key, the file's problem first (the file is
 * what ships). A `presence` ("is not set") problem only stands when the key is
 * absent from EVERY env it is checked in — a CI run that exports a provider
 * token without a `.env.local` must keep working. `operator shell` entries
 * stay shell-only.
 *
 * Shape: `checkOperatorConfig(scopes, { env })` accepts, besides a plain bag,
 * an array of bags where each element may be `{ values, where }` to restrict
 * it to entries stored in those `where`s. `operatorCheckEnvs(cwd, env)`
 * (deploy/preflight.js) builds the canonical pair `[fileEnv, shellEnv]`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertOperatorConfig, operatorCheckEnvs } from '../../../src/lib/deploy/preflight.js';
import { checkOperatorConfig } from '../../../src/lib/operator-env.js';

const GOOD_HETZNER_TOKEN = 'a'.repeat(64);
const FILE_WHERE = ['.env', '.env.local'] as const;
const fileEnv = (values: Record<string, string>) => ({ values, where: [...FILE_WHERE] });

describe('checkOperatorConfig — an array of envs', () => {
  it('a bad value in the file is reported even when the shell value is valid (the file is what ships)', () => {
    const r = checkOperatorConfig(['tls'], {
      presence: false,
      env: [
        fileEnv({ ACME_CA_SERVER: 'not-a-url' }),
        { ACME_CA_SERVER: 'https://acme-staging-v02.api.letsencrypt.org/directory' },
      ],
    });
    expect(r.problems).toEqual([
      'ACME_CA_SERVER looks wrong: expected an https:// ACME directory URL, got 9 characters',
    ]);
  });

  it('a bad value in the shell is still reported when the file has no value (the CLI reads the shell)', () => {
    const r = checkOperatorConfig(['tls'], {
      presence: false,
      env: [fileEnv({}), { ACME_CA_SERVER: 'not-a-url' }],
    });
    expect(r.problems).toEqual([
      'ACME_CA_SERVER looks wrong: expected an https:// ACME directory URL, got 9 characters',
    ]);
  });

  it('both malformed: exactly one problem per key, and it is the file’s', () => {
    const r = checkOperatorConfig(['tls'], {
      presence: false,
      env: [fileEnv({ ACME_CA_SERVER: 'file-bad' }), { ACME_CA_SERVER: 'shell-bad-longer' }],
    });
    expect(r.problems).toEqual([
      'ACME_CA_SERVER looks wrong: expected an https:// ACME directory URL, got 8 characters',
    ]);
    expect(r.checked.filter((k) => k === 'ACME_CA_SERVER')).toHaveLength(1);
  });

  it('valid in the file, absent in the shell: no problem', () => {
    const r = checkOperatorConfig(['tls', 'access'], {
      presence: false,
      env: [
        fileEnv({
          ACME_CA_SERVER: 'https://acme-staging-v02.api.letsencrypt.org/directory',
          ALLOWED_SSH_IPS: '203.0.113.0/24',
        }),
        {},
      ],
    });
    expect(r.problems).toEqual([]);
  });

  it('presence: a required .env.local key absent from the FILE but exported in the shell is not "not set" (CI)', () => {
    const r = checkOperatorConfig(['provider:hetzner'], {
      presence: true,
      env: [
        fileEnv({}),
        {
          HETZNER_API_TOKEN: GOOD_HETZNER_TOKEN,
          HETZNER_ACCESS_KEY: 'access-key-id',
          HETZNER_SECRET_KEY: 'a-secret-key-long-enough',
        },
      ],
    });
    expect(r.problems).toEqual([]);
  });

  it('presence: a required key absent from EVERY env is "not set" exactly once', () => {
    const r = checkOperatorConfig(['provider:hetzner'], {
      presence: true,
      env: [fileEnv({}), {}],
    });
    expect(r.problems.filter((p) => p.startsWith('HETZNER_API_TOKEN'))).toEqual([
      'HETZNER_API_TOKEN is not set',
    ]);
  });

  it('presence: a malformed file value beats a missing shell value (shape, not "not set")', () => {
    const r = checkOperatorConfig(['provider:hetzner'], {
      presence: true,
      env: [
        fileEnv({
          HETZNER_API_TOKEN: 'short',
          HETZNER_ACCESS_KEY: 'access-key-id',
          HETZNER_SECRET_KEY: 'a-secret-key-long-enough',
        }),
        {},
      ],
    });
    expect(r.problems).toEqual([
      'HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 5 characters',
    ]);
  });

  it('an `operator shell` entry is never checked against the file env', () => {
    // DOCKER_HUB_TOKEN is `where: 'operator shell'` — a stray copy in .env
    // is not what deploy reads, so it must not be reported from there…
    const fromFile = checkOperatorConfig(['registry'], {
      presence: false,
      env: [fileEnv({ DOCKER_HUB_TOKEN: 'abc' }), {}],
    });
    expect(fromFile.problems).toEqual([]);
    // …while the same bad value in the shell still is.
    const fromShell = checkOperatorConfig(['registry'], {
      presence: false,
      env: [fileEnv({}), { DOCKER_HUB_TOKEN: 'abc' }],
    });
    expect(fromShell.problems).toEqual([
      'DOCKER_HUB_TOKEN looks wrong: expected a Docker Hub access token or password, got 3 characters',
    ]);
    expect(fromShell.checked).toContain('DOCKER_HUB_TOKEN');
  });

  it('a plain bag in the array applies to every entry (no `where` = unrestricted)', () => {
    const r = checkOperatorConfig(['registry'], {
      presence: false,
      env: [{ DOCKER_HUB_TOKEN: 'abc' }],
    });
    expect(r.problems).toHaveLength(1);
  });

  it('a single plain bag behaves exactly as before (one env, no scoping)', () => {
    const single = checkOperatorConfig(['tls', 'provider:hetzner'], {
      presence: false,
      env: { ACME_CA_SERVER: 'not-a-url', HETZNER_API_TOKEN: 'short' },
    });
    const wrapped = checkOperatorConfig(['tls', 'provider:hetzner'], {
      presence: false,
      env: [{ ACME_CA_SERVER: 'not-a-url', HETZNER_API_TOKEN: 'short' }],
    });
    expect(wrapped).toEqual(single);
    expect(single.problems).toHaveLength(2);
  });
});

describe('operatorCheckEnvs + assertOperatorConfig — the project files are checked too', () => {
  const dirs: string[] = [];
  function projectDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'vc-file-aware-'));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns [fileEnv scoped to .env/.env.local, shellEnv] with .env.local layered over .env', () => {
    const cwd = projectDir({
      '.env': 'ACME_CA_SERVER=from-env\nALLOWED_SSH_IPS=203.0.113.5\n',
      '.env.local': 'ACME_CA_SERVER=from-local\n',
    });
    const shell = { ACME_CA_SERVER: 'from-shell' };
    const [file, shellOut] = operatorCheckEnvs(cwd, shell);
    expect(file).toEqual({
      values: { ACME_CA_SERVER: 'from-local', ALLOWED_SSH_IPS: '203.0.113.5' },
      where: ['.env', '.env.local'],
    });
    expect(shellOut).toBe(shell);
  });

  it('a project with no env files yields an empty file env (fresh clone, CI checkout)', () => {
    const cwd = projectDir({});
    const [file] = operatorCheckEnvs(cwd, {});
    expect(file).toEqual({ values: {}, where: ['.env', '.env.local'] });
  });

  it('assertOperatorConfig refuses a bad ACME_CA_SERVER stored in .env while the shell has none', () => {
    const cwd = projectDir({ '.env': 'ACME_CA_SERVER=not-a-url\n' });
    expect(() =>
      assertOperatorConfig(['tls', 'access', 'state'], {
        presence: false,
        env: operatorCheckEnvs(cwd, {}),
      }),
    ).toThrow(
      /^Configuration problems \(nothing was provisioned\):\n {2}- ACME_CA_SERVER looks wrong/,
    );
  });

  it('a valid shell value does not mask the bad file value', () => {
    const cwd = projectDir({ '.env': 'ACME_CA_SERVER=not-a-url\n' });
    expect(() =>
      assertOperatorConfig(['tls'], {
        presence: false,
        env: operatorCheckEnvs(cwd, {
          ACME_CA_SERVER: 'https://acme-staging-v02.api.letsencrypt.org/directory',
        }),
      }),
    ).toThrow(/ACME_CA_SERVER looks wrong/);
  });

  it('a good .env.local override of a bad .env value is fine (the app precedence)', () => {
    const cwd = projectDir({
      '.env': 'ACME_CA_SERVER=not-a-url\n',
      '.env.local': 'ACME_CA_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory\n',
    });
    expect(() =>
      assertOperatorConfig(['tls'], { presence: false, env: operatorCheckEnvs(cwd, {}) }),
    ).not.toThrow();
  });

  it('a stray DOCKER_HUB_TOKEN in .env is ignored — operator shell keys stay shell-only', () => {
    const cwd = projectDir({ '.env': 'DOCKER_HUB_TOKEN=abc\n' });
    expect(() =>
      assertOperatorConfig(['registry'], { presence: false, env: operatorCheckEnvs(cwd, {}) }),
    ).not.toThrow();
  });

  it('never echoes the stored value in the refusal', () => {
    const cwd = projectDir({ '.env': 'ALLOWED_SSH_IPS=not-an-address-at-all\n' });
    let message = '';
    try {
      assertOperatorConfig(['access'], { presence: false, env: operatorCheckEnvs(cwd, {}) });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/ALLOWED_SSH_IPS looks wrong/);
    expect(message).not.toContain('not-an-address-at-all');
  });
});
