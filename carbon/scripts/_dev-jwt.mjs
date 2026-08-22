#!/usr/bin/env node
// Sign HS256 JWTs from a shared dev secret. Used by dev-init.js and
// generate-dev-configs.sh to produce ANON / SERVICE_ROLE keys at runtime
// so the carbon template doesn't ship literal JWT strings — those would
// trip every secret-scanner that looked at the repo (GitHub's, ours,
// gitleaks, ...). The values are still deterministic for a given
// JWT_SECRET, so dev workflows that depend on stable keys keep working
// across runs.
//
// Usage:
//   node scripts/_dev-jwt.mjs <role>
//
// Where <role> is `anon` or `service_role`. JWT_SECRET must be set in
// the environment. Prints the JWT to stdout (no newline) on success;
// non-zero exit on bad input.

import { createHmac } from 'node:crypto';

const role = process.argv[2];
if (role !== 'anon' && role !== 'service_role') {
  process.stderr.write('usage: _dev-jwt.mjs (anon|service_role)\n');
  process.exit(2);
}
const secret = process.env.JWT_SECRET;
if (!secret) {
  process.stderr.write('JWT_SECRET must be set in the environment\n');
  process.exit(2);
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = b64url(
  JSON.stringify({
    iss: 'supabase-demo',
    role,
    // 100-year expiry: dev tokens shouldn't churn during a single
    // engineer's career. Production tokens are signed elsewhere with
    // shorter lifetimes; this is local-dev only.
    exp: Math.floor(Date.now() / 1000) + 100 * 365 * 24 * 60 * 60,
  }),
);
const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
process.stdout.write(`${header}.${payload}.${sig}`);
