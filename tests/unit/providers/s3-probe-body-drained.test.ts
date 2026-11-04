/**
 * The visibility probe must read the GetObject Body (releasing its socket) and
 * treat a wrong body as "not ready". Live 2026-11-04: Linode kept the unread
 * streams open and the CLI never exited after deploy.
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';

type P = {
  bucketExists: (b: string) => Promise<boolean>;
  _send: (cmd: unknown, opts?: unknown) => Promise<unknown>;
  waitForBucketVisible: (b: string, o?: Record<string, unknown>) => Promise<boolean>;
};

function setup(content: string) {
  const p = new HetznerS3Provider('ak', 'sk', 'fsn1') as unknown as P;
  p.bucketExists = vi.fn(async () => true);
  const state = { consumed: false, gets: 0 };
  p._send = vi.fn(async (cmd: unknown) => {
    if ((cmd as object).constructor.name !== 'GetObjectCommand') return {};
    state.gets++;
    const body = Readable.from([Buffer.from(content)]) as Readable & {
      transformToString: () => Promise<string>;
    };
    body.on('end', () => {
      state.consumed = true;
    });
    body.on('close', () => {
      state.consumed = true;
    });
    body.transformToString = async () => {
      let s = '';
      for await (const c of body) s += c;
      return s;
    };
    return { Body: body };
  });
  return { p, state };
}

describe('waitForBucketVisible GetObject body', () => {
  it('consumes the body and succeeds when it equals probe', async () => {
    const { p, state } = setup('probe');
    await expect(p.waitForBucketVisible('b', { intervalMs: 0, budgetMs: 5000 })).resolves.toBe(
      true,
    );
    expect(state.consumed).toBe(true);
  });

  it('a body that is not probe is not ready (streak resets, budget exhausts)', async () => {
    const { p, state } = setup('garbage');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(p.waitForBucketVisible('b', { intervalMs: 5, budgetMs: 60 })).resolves.toBe(false);
    expect(state.gets).toBeGreaterThan(0);
  });

  it('a probe round-trip against a keep-alive server leaves no socket handle open', async () => {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'keep-alive' });
      res.end('probe');
    });
    server.keepAliveTimeout = 0; // never close idle connections
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: `http://127.0.0.1:${port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: 'a', secretAccessKey: 's' },
    });
    const sockets = () =>
      // biome-ignore lint/suspicious/noExplicitAny: diagnostic API
      (process as any)
        ._getActiveHandles()
        .filter((h: any) => h?.constructor?.name === 'Socket' && h.remotePort === port);
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
      expect(await res.Body?.transformToString()).toBe('probe');
      await new Promise((r) => setTimeout(r, 50));
      // Drained: the pooled keep-alive socket is unref'd by the agent, not holding the loop.
      expect(sockets().every((s: { hasRef?: () => boolean }) => s.hasRef?.() === false)).toBe(true);
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
