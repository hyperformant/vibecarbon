/**
 * final-review Criticals #2/#3 + Important #4/#5: several call sites
 * hardcoded the 'hetzner' literal as the provider id into
 * getObjectStorageProvider() / getProviderClass() (and the sibling
 * resolveS3RegionFor()) instead of resolving it from the in-scope envConfig
 * via providerIdFor()/providerFor(). On a DigitalOcean deploy this silently
 * routed S3/token dispatch back to Hetzner — e.g. orchestrator.js:279
 * (Critical #2, every DO deploy died at S3 setup) and
 * effects/index.js:70's upStack call missing `provider` entirely
 * (Critical #3, defaulted through buildEnv instead).
 *
 * This is a static-source recall test, not a runtime one: it greps the
 * actual source tree (excluding src/lib/providers/ itself, where the
 * 'hetzner' default IS the sanctioned implementation of providerFor() /
 * providerIdFor()) for the three hardcoding call shapes. The regex is
 * whitespace/newline-tolerant between the callee and the literal because
 * the offending call sites were multi-line:
 *
 *   getObjectStorageProvider(
 *     'hetzner',
 *     ...
 *   )
 *
 * A plain single-line regex would have missed exactly the bug this review
 * found — this test reads each file as one string (not line-by-line) so a
 * literal split across lines still matches.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');
const EXEMPT_DIR = join(SRC_ROOT, 'lib', 'providers') + sep;

const HARDCODE_PATTERN =
  /(getObjectStorageProvider|resolveS3RegionFor|getProviderClass)\(\s*'hetzner'/;

function walkJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkJsFiles(full));
    } else if (st.isFile() && full.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

describe("no hardcoded 'hetzner' provider-id literal at storage/token dispatch call sites", () => {
  it('no non-provider src/ file passes a hetzner literal into getObjectStorageProvider/resolveS3RegionFor/getProviderClass', () => {
    const files = walkJsFiles(SRC_ROOT).filter((f) => !f.startsWith(EXEMPT_DIR));
    expect(files.length).toBeGreaterThan(50); // sanity: the walk actually found the tree

    const offenders: Array<{ file: string; match: string }> = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const match = content.match(HARDCODE_PATTERN);
      if (match) {
        offenders.push({ file, match: match[0].replace(/\s+/g, ' ') });
      }
    }

    expect(offenders).toEqual([]);
  });

  // Positive control: proves HARDCODE_PATTERN actually catches the
  // multi-line shape the review found (not just a same-line one), so a
  // silently-broken regex can't make the assertion above pass vacuously.
  it('pattern control: matches both single-line and multi-line hardcoded calls', () => {
    const singleLine = "getObjectStorageProvider('hetzner', accessKey, secretKey, region)";
    const multiLine = `getObjectStorageProvider(\n    'hetzner',\n    accessKey,\n    secretKey,\n  )`;
    const notHardcoded =
      'getObjectStorageProvider(providerIdFor(envConfig), accessKey, secretKey, region)';

    expect(HARDCODE_PATTERN.test(singleLine)).toBe(true);
    expect(HARDCODE_PATTERN.test(multiLine)).toBe(true);
    expect(HARDCODE_PATTERN.test(notHardcoded)).toBe(false);
  });
});
