/**
 * Census: every provider token validator treats a 5xx as the PROVIDER's
 * outage, never as an invalid credential.
 *
 * Live RCA 2026-09-01 (run 33557406486, vultr compose final-destroy): the
 * Vultr API answered 502 on the preflight `GET /v2/account`, the validator
 * fell through to `valid: false`, and the non-TTY destroy died in 0.4s
 * trying to PROMPT for a key that was fine. Every validator already gave a
 * NETWORK error the benefit of the doubt (`unreachable: true` in the
 * catch); a 5xx deserves exactly the same treatment — the operator's
 * credential cannot be judged by a server that is down.
 *
 * Source-shape census (the validators are file-local, not exported): each
 * guided-setup must carry the 5xx branch ABOVE its status fallthrough.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const VALIDATORS = [
  'src/lib/hetzner-guided-setup.js',
  'src/lib/digitalocean-guided-setup.js',
  'src/lib/linode-guided-setup.js',
  'src/lib/vultr-guided-setup.js',
  'src/lib/scaleway-guided-setup.js',
];

describe.each(VALIDATORS)('%s token validator', (rel) => {
  const src = readFileSync(join(ROOT, rel), 'utf-8');

  it('treats a 5xx as provider outage (unreachable), before the invalid fallthrough', () => {
    const fiveHundred = src.indexOf('res.status >= 500) return { valid: true, unreachable: true }');
    const fallthrough = src.search(/valid: false, error: `\w+ API returned status/);
    expect(fiveHundred, 'missing the 5xx-outage branch').toBeGreaterThan(-1);
    expect(fallthrough, 'missing the status fallthrough').toBeGreaterThan(-1);
    expect(fiveHundred).toBeLessThan(fallthrough);
  });

  it('still gives a network error the benefit of the doubt', () => {
    expect(src).toMatch(/valid: true, unreachable: true \};\s*\n\s*\}/);
  });
});
