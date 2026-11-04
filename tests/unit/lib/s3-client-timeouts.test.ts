/**
 * Every S3 client the CLI builds has a connect and a request timeout.
 *
 * The AWS SDK's Node handler has none by default, so an endpoint that accepts
 * the connection and then goes quiet holds the call, and the command, forever.
 * A k8s-ha restore on DigitalOcean Spaces (2026-11-04) hung 9 minutes in the
 * TLS snapshot upload with one ESTABLISHED socket to sfo3 and no timeout to
 * end it: createS3Client was the one factory that set none.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { S3_HTTP_TIMEOUTS } from '../../../src/lib/s3-timeouts.js';
import { createS3Client } from '../../../src/lib/walg/restore-base.js';

const SRC = join(import.meta.dirname, '../../../src');
const CFG = {
  region: 'sfo3',
  endpoint: 'https://sfo3.digitaloceanspaces.com',
  accessKey: 'AKIAEXAMPLE',
  secretKey: 'secret-example',
};

/** The handler config a built client will use (the SDK keeps it as a provider). */
async function handlerConfig(client: { config: { requestHandler: unknown } }) {
  const handler = client.config.requestHandler as {
    configProvider?: Promise<Record<string, unknown>>;
    config?: Record<string, unknown>;
  };
  return (await handler.configProvider) ?? handler.config ?? {};
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

describe('S3 client timeouts', () => {
  it('the shared bounds are 10s to connect and 60s per request', () => {
    expect(S3_HTTP_TIMEOUTS).toEqual({ connectionTimeout: 10_000, requestTimeout: 60_000 });
  });

  it('createS3Client applies them when the caller passes no options', async () => {
    const config = await handlerConfig((await createS3Client(CFG)) as never);
    expect(config).toMatchObject(S3_HTTP_TIMEOUTS);
  });

  it("a caller's own handler bounds win (the failover read uses tighter ones)", async () => {
    const config = await handlerConfig(
      (await createS3Client(CFG, {
        requestHandler: { connectionTimeout: 5_000, requestTimeout: 7_000 },
      })) as never,
    );
    expect(config).toMatchObject({ connectionTimeout: 5_000, requestTimeout: 7_000 });
  });

  it('every `new S3Client(` in src/ passes a requestHandler', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf-8');
      for (const m of text.matchAll(/new S3Client\(\{/g)) {
        seen += 1;
        // The constructor's argument object: up to its matching close.
        let depth = 0;
        let end = m.index + 'new S3Client('.length;
        for (; end < text.length; end++) {
          if (text[end] === '{') depth++;
          else if (text[end] === '}' && --depth === 0) break;
        }
        // Code only: a comment that merely mentions the option proves nothing.
        const arg = text
          .slice(m.index, end)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        if (!/\brequestHandler\s*:/.test(arg)) {
          offenders.push(
            `${file.slice(SRC.length + 1)}:${text.slice(0, m.index).split('\n').length}`,
          );
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });
});
