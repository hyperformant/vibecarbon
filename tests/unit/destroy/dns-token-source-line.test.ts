/**
 * Destroy's DNS-cleanup token line names where the token came from, the same
 * way the provider API token lines do: "environment variable" was printed
 * for a token loaded from the project's .env.local too.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dnsTokenSourceLine } from '../../../src/destroy.js';
import { DNS_PROVIDERS } from '../../../src/lib/dns-provider.js';
import { formatDotenvLine } from '../../../src/lib/dotenv.js';
import { bootstrapOperatorEnv } from '../../../src/lib/project.js';

let dir: string;
afterEach(() => {
  delete process.env.CLOUDFLARE_API_TOKEN;
  if (dir) rmSync(dir, { recursive: true, force: true });
  bootstrapOperatorEnv(tmpdir());
});

describe('dnsTokenSourceLine', () => {
  it("says .env.local when the project's file supplied the token", () => {
    dir = mkdtempSync(join(tmpdir(), 'vc-dnssrc-'));
    writeFileSync(
      join(dir, '.env.local'),
      `${formatDotenvLine('CLOUDFLARE_API_TOKEN', 'cf-token-sample-123')}\n`,
    );
    bootstrapOperatorEnv(dir);
    expect(dnsTokenSourceLine(DNS_PROVIDERS.cloudflare)).toBe(
      "✓ Using Cloudflare API token (CLOUDFLARE_API_TOKEN) from your project's .env.local",
    );
  });

  it('says shell environment when an export supplied it', () => {
    dir = mkdtempSync(join(tmpdir(), 'vc-dnssrc-'));
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token-sample-123';
    bootstrapOperatorEnv(dir);
    const line = dnsTokenSourceLine(DNS_PROVIDERS.cloudflare);
    expect(line).toBe(
      '✓ Using Cloudflare API token (CLOUDFLARE_API_TOKEN) from your shell environment',
    );
    expect(line).not.toContain('environment variable');
  });
});
