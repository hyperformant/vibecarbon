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
 * Rule under test: a `where: '.env'` entry (the SERVER reads the file) is
 * checked on the merged file values (`.env.local` over `.env`) AND the shell,
 * the file's problem first — a valid shell value never masks a bad file
 * value. A `where: '.env.local'` entry is checked on its EFFECTIVE runtime
 * value, shell over file (bootstrapOperatorEnv fills only keys the shell
 * lacks), so a stale file token a valid export overrides is not refused. A
 * `presence` ("is not set") problem only stands when the key is absent from
 * EVERY env it is checked in — a CI run that exports a provider token without
 * a `.env.local` must keep working. `operator shell` entries stay shell-only.
 *
 * Shape: `checkOperatorConfig(scopes, { env })` accepts, besides a plain bag,
 * an array of bags where each element may be `{ values, where }` to restrict
 * it to entries stored in those `where`s. `operatorCheckEnvs(cwd, env)`
 * (deploy/preflight.js) builds the canonical triple
 * `[fileEnv (.env keys), effectiveEnv (.env.local keys), shellEnv]`.
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

  // Fix round (controller ruling): file-wins is right ONLY for `where: '.env'`
  // keys — the server reads the file. For `where: '.env.local'` keys the
  // runtime value is shell-over-file (bootstrapOperatorEnv fills only keys
  // absent from the shell), so they are checked on that EFFECTIVE value.
  it('returns [file bag for .env keys, effective shell-over-file bag for .env.local keys, shell bag]', () => {
    const cwd = projectDir({
      '.env': 'ACME_CA_SERVER=from-env\nALLOWED_SSH_IPS=203.0.113.5\nHETZNER_API_TOKEN=from-env\n',
      '.env.local': 'ACME_CA_SERVER=from-local\nHETZNER_API_TOKEN=from-local\n',
    });
    const shell = { ACME_CA_SERVER: 'from-shell', HETZNER_API_TOKEN: 'from-shell' };
    const [file, effective, shellOut] = operatorCheckEnvs(cwd, shell);
    expect(file).toEqual({
      values: {
        ACME_CA_SERVER: 'from-local',
        ALLOWED_SSH_IPS: '203.0.113.5',
        HETZNER_API_TOKEN: 'from-local',
      },
      where: ['.env'],
    });
    expect(effective).toEqual({
      values: {
        ACME_CA_SERVER: 'from-shell',
        ALLOWED_SSH_IPS: '203.0.113.5',
        HETZNER_API_TOKEN: 'from-shell',
      },
      where: ['.env.local'],
    });
    expect(shellOut).toBe(shell);
  });

  it('a project with no env files yields empty file bags (fresh clone, CI checkout)', () => {
    const cwd = projectDir({});
    const [file, effective] = operatorCheckEnvs(cwd, { HETZNER_API_TOKEN: GOOD_HETZNER_TOKEN });
    expect(file).toEqual({ values: {}, where: ['.env'] });
    expect(effective).toEqual({
      values: { HETZNER_API_TOKEN: GOOD_HETZNER_TOKEN },
      where: ['.env.local'],
    });
  });

  it('an undefined shell entry does not blank a file value in the effective bag', () => {
    const cwd = projectDir({ '.env.local': `HETZNER_API_TOKEN=${GOOD_HETZNER_TOKEN}\n` });
    const [, effective] = operatorCheckEnvs(cwd, { HETZNER_API_TOKEN: undefined });
    expect(effective.values.HETZNER_API_TOKEN).toBe(GOOD_HETZNER_TOKEN);
  });

  it('a stale malformed HETZNER_API_TOKEN in .env.local is NOT a problem when a valid shell export overrides it', () => {
    const cwd = projectDir({ '.env.local': 'HETZNER_API_TOKEN=stale-short\n' });
    expect(() =>
      assertOperatorConfig(['provider:hetzner'], {
        presence: false,
        env: operatorCheckEnvs(cwd, { HETZNER_API_TOKEN: GOOD_HETZNER_TOKEN }),
      }),
    ).not.toThrow();
  });

  it('the same stale .env.local token WITHOUT a shell export is a problem (it is what bootstrapOperatorEnv would load)', () => {
    const cwd = projectDir({ '.env.local': 'HETZNER_API_TOKEN=stale-short\n' });
    expect(() =>
      assertOperatorConfig(['provider:hetzner'], {
        presence: false,
        env: operatorCheckEnvs(cwd, {}),
      }),
    ).toThrow(/HETZNER_API_TOKEN looks wrong/);
  });

  it('a malformed ACME_CA_SERVER in .env with a valid shell value is STILL a problem (.env keys: file wins)', () => {
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
