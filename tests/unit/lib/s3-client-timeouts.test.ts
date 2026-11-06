/**
 * Every S3 client the CLI builds gives up on a silent connection.
 *
 * The AWS SDK's Node handler has no bound by default, so an endpoint that
 * accepts the connection and then goes quiet holds the call, and the command,
 * until the kernel gives up on the socket: about 15 minutes on Linux. A k8s-ha
 * restore on DigitalOcean Spaces (2026-11-04) hung 9 minutes in the TLS snapshot
 * upload with one ESTABLISHED socket to sfo3.
 *
 * The first fix set `requestTimeout`, and a test pinned that the option was
 * present. It does nothing here: the SDK only logs a warning unless
 * throwOnRequestTimeout is also set, so a 2026-11-05 settle gate lost about 16
 * of its 25 minutes to one silent HeadBucket. These tests therefore run the real
 * SDK against a real silent server, with the option names the CLI ships, so an
 * option that does not stop a call fails here whatever it is called.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DR_S3_CLIENT_OPTIONS } from '../../../src/lib/deploy/tls-snapshot.js';
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

/** The shipped handler options, same names, every duration cut to 300 ms. */
function shortened(handler: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(handler).map(([k, v]) => [k, typeof v === 'number' ? 300 : v]),
  );
}

describe('a server that accepts and then says nothing', () => {
  let server: net.Server;
  let port: number;

  beforeAll(async () => {
    server = net.createServer((socket) => socket.on('error', () => {}));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => server.close());

  async function outcome(requestHandler: Record<string, unknown>) {
    const client = new S3Client({
      region: 'test',
      endpoint: `http://127.0.0.1:${port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
      maxAttempts: 1,
      requestHandler: { ...requestHandler, logger: { warn() {} } as never },
    });
    try {
      return await Promise.race([
        client.send(new HeadBucketCommand({ Bucket: 'b' })).then(
          () => 'answered',
          (err: Error) => err.name,
        ),
        new Promise((resolve) => setTimeout(() => resolve('still hanging'), 2_000)),
      ]);
    } finally {
      client.destroy();
    }
  }

  it('the shared options end the call', async () => {
    expect(await outcome(shortened(S3_HTTP_TIMEOUTS))).toBe('TimeoutError');
  });

  it('the failover read ends the call, where waiting is outage', async () => {
    const { requestHandler } = DR_S3_CLIENT_OPTIONS;
    expect(await outcome(shortened(requestHandler))).toBe('TimeoutError');
  });

  it('requestTimeout alone does not, which is why it is not used', async () => {
    expect(await outcome({ connectionTimeout: 300, requestTimeout: 300 })).toBe('still hanging');
  });
});

describe('S3 client timeouts', () => {
  it('the shared bounds are 10 s to connect and 60 s of silence', () => {
    expect(S3_HTTP_TIMEOUTS).toEqual({ connectionTimeout: 10_000, socketTimeout: 60_000 });
  });

  it('no code in src/ relies on requestTimeout', () => {
    const offenders = walk(SRC).filter((file) =>
      /\brequestTimeout\b/.test(
        readFileSync(file, 'utf-8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, ''),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('createS3Client applies them when the caller passes no options', async () => {
    const config = await handlerConfig((await createS3Client(CFG)) as never);
    expect(config).toMatchObject(S3_HTTP_TIMEOUTS);
  });

  it("a caller's own handler bounds win (the failover read uses tighter ones)", async () => {
    const config = await handlerConfig(
      (await createS3Client(CFG, {
        requestHandler: { connectionTimeout: 5_000, socketTimeout: 7_000 },
      })) as never,
    );
    expect(config).toMatchObject({ connectionTimeout: 5_000, socketTimeout: 7_000 });
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
