/**
 * Tests for src/lib/billing/write-catalog.js::writeBillingCatalog.
 *
 * Verifies the writer emits a valid billing-catalog.ts module into a project's
 * src/shared dir, and skips gracefully (returns false, writes nothing) when
 * src/shared is absent — i.e. cwd is not an app project root.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBillingCatalog } from '../../../src/lib/billing/write-catalog.js';

let projectDir: string;

const SAMPLE = {
  provider: 'stripe',
  generatedAt: '2026-06-28T12:00:00.000Z',
  tiers: [
    {
      priceId: 'price_123',
      name: 'Startup',
      description: 'For small teams',
      features: ['Feature A', 'Feature B'],
      amount: 1900,
      currency: 'usd',
      interval: 'month',
      type: 'recurring',
    },
    {
      priceId: 'price_456',
      name: 'Pro',
      description: null,
      features: [],
      amount: 4900,
      currency: 'usd',
      interval: 'month',
      type: 'recurring',
    },
  ],
};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'vc-billing-catalog-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('writeBillingCatalog', () => {
  it('writes a valid billing-catalog.ts when src/shared exists', async () => {
    mkdirSync(join(projectDir, 'src', 'shared'), { recursive: true });

    const written = writeBillingCatalog(projectDir, SAMPLE);
    expect(written).toBe(true);

    const filePath = join(projectDir, 'src', 'shared', 'billing-catalog.ts');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf8');
    // Contract: import line + named export the app imports.
    expect(content).toContain("import type { BillingCatalog } from './billing-catalog.types';");
    expect(content).toContain('export const billingCatalog: BillingCatalog =');
    // biome-conformant TS literal: unquoted identifier keys + single-quoted
    // values (not JSON's double-quoted keys), so the generated file passes lint.
    expect(content).toContain("priceId: 'price_123',");
    expect(content).toContain('tiers: [');
    expect(content).toContain("provider: 'stripe',");

    // The generated module actually loads and its data round-trips to the input.
    // (The `import type` line is erased at runtime, so the missing sibling types
    // file is irrelevant here.) Each test uses a unique tmp dir, so no import cache hit.
    const mod = await import(pathToFileURL(filePath).href);
    expect(mod.billingCatalog).toEqual(SAMPLE);
  });

  it('skips gracefully (returns false, writes nothing) when src/shared is absent', () => {
    const written = writeBillingCatalog(projectDir, SAMPLE);
    expect(written).toBe(false);
    expect(existsSync(join(projectDir, 'src', 'shared', 'billing-catalog.ts'))).toBe(false);
  });
});
