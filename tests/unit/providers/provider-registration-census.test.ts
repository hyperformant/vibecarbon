/**
 * Provider-registration census (2026-08-07 test-architecture audit).
 *
 * src/lib/providers/ is deliberately EXEMPT from the src-wide literal sweeps
 * (it is where sanctioned provider literals live), which made it the least-
 * swept directory in the repo: nothing asserted that a provider module
 * dropped in here is actually REGISTERED. An implemented-but-unregistered
 * provider class is invisible to the entire registry-driven suite —
 * provider-contract, tier↔scenario coverage, S3 contract, EXPECTED pins —
 * all of it silently skips a class that never joins PROVIDERS.
 *
 * This census imports every module in the directory and asserts:
 *   - every exported class extending BaseProvider is a PROVIDERS value;
 *   - every exported class extending S3CompatibleProvider is reachable via
 *     some registered compute provider's getObjectStorageProviderClass().
 * Helper modules (pagination, s3-base) export no such classes and pass
 * through untouched.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BaseProvider } from '../../../src/lib/providers/base.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { S3CompatibleProvider } from '../../../src/lib/providers/s3-base.js';

const PROVIDERS_DIR = join(process.cwd(), 'src', 'lib', 'providers');

const moduleEntries: Array<[string, Record<string, unknown>]> = await Promise.all(
  readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith('.js'))
    .map(
      async (f) =>
        [
          f,
          (await import(pathToFileURL(join(PROVIDERS_DIR, f)).href)) as Record<string, unknown>,
        ] as [string, Record<string, unknown>],
    ),
);

const registeredCompute = new Set<unknown>(Object.values(PROVIDERS));
const registeredS3 = new Set<unknown>(
  await Promise.all(Object.values(PROVIDERS).map((P) => P.getObjectStorageProviderClass())),
);

function isSubclassOf(value: unknown, Base: unknown): boolean {
  return (
    typeof value === 'function' &&
    value !== Base &&
    Object.prototype.isPrototypeOf.call(Base as object, value)
  );
}

const exportedCompute: Array<{ file: string; name: string; cls: unknown }> = [];
const exportedS3: Array<{ file: string; name: string; cls: unknown }> = [];
for (const [file, mod] of moduleEntries) {
  for (const [name, value] of Object.entries(mod)) {
    if (isSubclassOf(value, BaseProvider)) exportedCompute.push({ file, name, cls: value });
    else if (isSubclassOf(value, S3CompatibleProvider)) exportedS3.push({ file, name, cls: value });
  }
}

describe('provider-registration census', () => {
  it('the directory walk still sees the provider population (not vacuously green)', () => {
    expect(moduleEntries.length).toBeGreaterThanOrEqual(6);
    expect(exportedCompute.length).toBeGreaterThanOrEqual(2);
    expect(exportedS3.length).toBeGreaterThanOrEqual(2);
  });

  it('every compute provider class in the directory is registered in PROVIDERS', () => {
    const unregistered = exportedCompute.filter(({ cls }) => !registeredCompute.has(cls));
    expect(
      unregistered.map(({ file, name }) => `${file}: ${name}`),
      'An implemented-but-unregistered provider is invisible to the ENTIRE registry-driven ' +
        'suite (contract, tiers, scenarios, EXPECTED pins). Register it in ' +
        'src/lib/providers/index.js — the registration itself then forces the EXPECTED row, ' +
        'scenario mappings, and capacity prefs via the existing censuses.',
    ).toEqual([]);
  });

  it('every S3 provider class in the directory is reachable from a registered compute provider', () => {
    const orphaned = exportedS3.filter(({ cls }) => !registeredS3.has(cls));
    expect(
      orphaned.map(({ file, name }) => `${file}: ${name}`),
      'An object-storage class no compute provider resolves via ' +
        'getObjectStorageProviderClass() is dead code the S3 contract suite never sees.',
    ).toEqual([]);
  });

  it('the subclass detector flags an unregistered provider (positive control)', () => {
    class GhostProvider extends BaseProvider {}
    class GhostSpaces extends S3CompatibleProvider {}
    expect(isSubclassOf(GhostProvider, BaseProvider)).toBe(true);
    expect(registeredCompute.has(GhostProvider)).toBe(false);
    expect(isSubclassOf(GhostSpaces, S3CompatibleProvider)).toBe(true);
    expect(registeredS3.has(GhostSpaces)).toBe(false);
    // The bases themselves are not their own subclasses (base.js / s3-base.js
    // must not be flagged as unregistered providers).
    expect(isSubclassOf(BaseProvider, BaseProvider)).toBe(false);
    expect(isSubclassOf(S3CompatibleProvider, S3CompatibleProvider)).toBe(false);
  });
});
