import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every place the installed Better Auth creates a session, classified.
 *
 * The pre-hijacking defence (src/server/auth/account-linking.ts) deletes a
 * session issued on the strength of a password that the social-link
 * cleanup has just removed. Better Auth does not record how a session was
 * authenticated, so the defence keys on endpoint paths
 * (PASSWORD_SESSION_PATHS and SECOND_FACTOR_SESSION_PATHS). This census
 * fails when a Better Auth upgrade adds, moves or removes a session-creating
 * call, so the lists are revisited instead of silently missing a new
 * password-backed path.
 *
 * The installed version is pinned too: the auth code leans on Better Auth
 * internals beyond these calls (hook order, `ctx.context.newSession` and
 * `ctx.context.session` in hooks, the twoFactor verify flow, the magic-link
 * cleanup in revoke-unproven-account-access). Any upgrade is a re-review of
 * src/server/auth/, then a bump of PINNED_VERSION.
 */

const PINNED_VERSION = '1.7.7';

const ROOT = join(__dirname, '..', '..');
const DIST = join(ROOT, 'node_modules', 'better-auth', 'dist');

type Site = { count: number; credentialPaths: string[]; why: string };

/** dist file (relative) -> its createSession calls and how they authenticate. */
const CLASSIFIED: Record<string, Site> = {
  'api/routes/sign-in.mjs': {
    count: 1,
    credentialPaths: ['/sign-in/email'],
    why: 'email + password sign-in',
  },
  'api/routes/sign-up.mjs': {
    count: 1,
    credentialPaths: ['/sign-up/email'],
    why: 'sign-up with a password, then auto sign-in',
  },
  'api/routes/update-user.mjs': {
    count: 1,
    credentialPaths: ['/change-password'],
    why: 'change-password re-issues the session after checking the current password',
  },
  'api/routes/email-verification.mjs': {
    count: 3,
    credentialPaths: [],
    why: '/verify-email: proves the email by a mailed token, not the password',
  },
  'oauth2/link-account.mjs': {
    count: 1,
    credentialPaths: [],
    why: 'social sign-in (the callback)',
  },
  'plugins/admin/routes.mjs': {
    count: 1,
    credentialPaths: [],
    why: 'impersonation by a super admin',
  },
  'plugins/magic-link/index.mjs': {
    count: 1,
    credentialPaths: [],
    why: 'magic link: proves the email by a mailed token',
  },
  'plugins/two-factor/index.mjs': {
    count: 3,
    credentialPaths: ['/two-factor/enable', '/two-factor/disable'],
    why: 'enable/disable re-issue the current session (password checked when the account has one)',
  },
  'plugins/two-factor/totp/index.mjs': {
    count: 1,
    credentialPaths: ['/two-factor/verify-totp'],
    why: 'verify-totp re-issues the current session when it confirms an enrollment',
  },
  'plugins/two-factor/otp/index.mjs': {
    count: 1,
    credentialPaths: ['/two-factor/verify-otp'],
    why: 'verify-otp re-issues an existing session (path disabled; classified anyway)',
  },
  'plugins/two-factor/verify-two-factor.mjs': {
    count: 1,
    credentialPaths: [
      '/two-factor/verify-totp',
      '/two-factor/verify-otp',
      '/two-factor/verify-backup-code',
    ],
    why: 'completes a password sign-in that owed a second factor',
  },
  // Plugins this app does not install (never reachable): listed so an
  // upgrade that changes them is still noticed.
  'plugins/device-authorization/routes.mjs': { count: 1, credentialPaths: [], why: 'not installed' },
  'plugins/anonymous/index.mjs': { count: 1, credentialPaths: [], why: 'not installed' },
  'plugins/siwe/index.mjs': { count: 1, credentialPaths: [], why: 'not installed' },
  'plugins/username/index.mjs': { count: 1, credentialPaths: [], why: 'not installed' },
  'plugins/email-otp/routes.mjs': { count: 3, credentialPaths: [], why: 'not installed' },
  'plugins/phone-number/routes.mjs': { count: 2, credentialPaths: [], why: 'not installed' },
  'plugins/test-utils/auth-helpers.mjs': { count: 1, credentialPaths: [], why: 'test helper' },
};

function distFiles(dir = DIST): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...distFiles(path));
    else if (name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

const CALL = /internalAdapter\.createSession\(/g;

describe('Better Auth session-creating calls are all classified', () => {
  it(`the installed Better Auth is ${PINNED_VERSION} (an upgrade is a re-review)`, () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, 'node_modules', 'better-auth', 'package.json'), 'utf8')
    ) as { version: string };
    expect(
      pkg.version,
      'Better Auth was upgraded. Re-review src/server/auth/ against the new version (hooks, ' +
        'twoFactor verify flow, session creation), then update PINNED_VERSION here.'
    ).toBe(PINNED_VERSION);
  });

  it('the installed dist has exactly the classified createSession calls', () => {
    const found: Record<string, number> = {};
    for (const path of distFiles()) {
      const count = readFileSync(path, 'utf8').match(CALL)?.length ?? 0;
      if (count) found[relative(DIST, path).split('\\').join('/')] = count;
    }
    const expected = Object.fromEntries(
      Object.entries(CLASSIFIED).map(([file, site]) => [file, site.count])
    );
    expect(
      found,
      'Better Auth changed where it creates sessions. Classify each new or moved call in ' +
        'CLASSIFIED, and add any password-backed endpoint to PASSWORD_SESSION_PATHS (or ' +
        'SECOND_FACTOR_SESSION_PATHS) in src/server/auth/account-linking.ts.'
    ).toEqual(expected);
  });

  it('every password-backed path is in PASSWORD_SESSION_PATHS or SECOND_FACTOR_SESSION_PATHS', () => {
    const src = readFileSync(join(ROOT, 'src/server/auth/account-linking.ts'), 'utf8');
    const listed = new Set<string>();
    for (const name of ['PASSWORD_SESSION_PATHS', 'SECOND_FACTOR_SESSION_PATHS']) {
      const pattern = new RegExp(`${name}[^=]*= new Set\\(\\[([\\s\\S]*?)\\]\\)`);
      const block = src.match(pattern)?.[1];
      expect(block, `${name} not found`).toBeDefined();
      for (const m of (block ?? '').matchAll(/'([^']+)'/g)) listed.add(m[1]);
    }
    const required = new Set(Object.values(CLASSIFIED).flatMap((s) => s.credentialPaths));
    expect([...required].filter((p) => !listed.has(p))).toEqual([]);
  });
});
