import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateEnvLocal, TEMPLATE_DIR } from '../../../src/create.js';

/**
 * Every `%VITE_*%` token in the client index.html must have a key in the
 * .env that `create` generates — Vite's html env hook warns on each token
 * whose key is absent from its env ("(!) %VITE_X% is not defined in env
 * variables found in /index.html. Is the variable mistyped?"), on every
 * `vibecarbon up` and inside every deploy's image build. The check is
 * `key in env`, so an EMPTY value is defined and silent; a missing key is
 * not. The Plausible pair was missing from the first public release
 * through 0.43.1: harmless (the inline tag guards on an empty domain) but
 * it told every new user their fresh project had a typo.
 */

const baseVariables = {
  PROJECT_DISPLAY_NAME: 'Token App',
  PROJECT_NAME: 'token-app',
  ANON_KEY: 'anon-key',
  SERVICE_ROLE_KEY: 'service-role-key',
  JWT_SECRET: 'jwt-secret',
  DB_PASSWORD: 'db-password',
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'admin-password',
};

function envKeys(env: string): Set<string> {
  return new Set(
    env
      .split('\n')
      .map((l) => l.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((k): k is string => Boolean(k)),
  );
}

describe('generated .env defines every %VITE_*% token index.html uses', () => {
  const html = readFileSync(join(TEMPLATE_DIR, 'src', 'client', 'index.html'), 'utf8');
  const tokens = [...new Set([...html.matchAll(/%(VITE_[A-Z0-9_]+)%/g)].map((m) => m[1]))];

  it('finds the tokens (regex drift guard)', () => {
    expect(tokens).toContain('VITE_PUBLIC_URL');
  });

  it.each(tokens)('%s is defined (possibly empty) in the generated .env', (token) => {
    const keys = envKeys(generateEnvLocal('token-app', baseVariables));
    expect(keys.has(token), `${token} missing from generateEnvLocal output`).toBe(true);
  });

  it('ships the Plausible pair at the .env.example defaults: off, Plausible Cloud script', () => {
    const env = generateEnvLocal('token-app', baseVariables);
    expect(env).toMatch(/^VITE_PLAUSIBLE_DOMAIN=""$/m);
    expect(env).toMatch(/^VITE_PLAUSIBLE_SCRIPT_URL="https:\/\/plausible\.io\/js\/script\.js"$/m);
  });
});
