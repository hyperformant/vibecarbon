import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { featureSecretKeys } from '../../../src/lib/config-registry.js';

// Guards that the configure wizard derives its secret-masking set from the
// config-registry rather than carrying a parallel hand-maintained list. If a
// new feature secret is added to the registry but configure stops deriving
// from it, a secret could be echoed unmasked — this test fails first.
describe('configure ↔ config-registry', () => {
  const src = readFileSync(join(process.cwd(), 'src/configure.js'), 'utf-8');

  it('masking set is derived from featureSecretKeys() union operatorSecretKeys()', () => {
    expect(src).toMatch(
      /SECRET_ENV_KEYS\s*=\s*new Set\(\[\s*\.\.\.featureSecretKeys\(\),\s*\.\.\.operatorSecretKeys\(\)\s*\]\)/,
    );
  });

  it('does not re-enumerate a parallel secret list', () => {
    // The old shape was `new Set([ 'STRIPE_SECRET_KEY', ... ])`. Ensure the
    // declaration only spreads registry accessor calls — no quoted key
    // literals — so the masking set and the registry can't drift.
    const declLine = src.split('\n').find((line) => /SECRET_ENV_KEYS\s*=\s*new Set/.test(line));
    expect(declLine, 'SECRET_ENV_KEYS declaration not found').toBeDefined();
    expect(declLine).not.toMatch(/['"]/);
  });

  it('registry still classifies the SMTP password as a secret (canonical name)', () => {
    expect(featureSecretKeys()).toContain('SMTP_PASS');
  });

  // A4: operator-secret credentials (provider tokens) must never land in
  // .env — bundle.js uses it as the server-bundle baseline. The write loop
  // derives localOnly from the registry (isOperatorKey), not a hand-rolled
  // check, so a future operator-secret key added to CONFIG_KEYS is covered
  // automatically.
  it('write loop derives localOnly from isOperatorKey(key), not a hand-rolled check', () => {
    expect(src).toMatch(
      /setEnvVar\(key,\s*result\[key\],\s*cwd,\s*\{\s*localOnly:\s*isOperatorKey\(key\)\s*\}\)/,
    );
  });

  it('zero-writes outro is accurate when writtenKeys.length === 0', () => {
    // When a feature returns {}, no values are written. The outro should say
    // "No changes written" instead of claiming values were saved. This catches
    // bugs like Docker Hub informational row ({}) or provider rows with no
    // overwrite that accidentally print the always-positive message.
    expect(src).toMatch(/writtenKeys\.length\s*===\s*0/);
    expect(src).toMatch(/No changes written/);
  });
});
