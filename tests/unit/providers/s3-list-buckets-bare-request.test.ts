/**
 * Every Linode E0 and E1 cluster refuses `GET /?x-id=ListBuckets` with
 * SignatureDoesNotMatch and answers `GET /`; E3 answers both (11 clusters,
 * independent signer, 2026-11-05). The AWS SDK adds that query, so a good key
 * read as a wrong one and stopped every deploy on those clusters. The server
 * here checks a real SigV4 signature the same way, leaving x-id at the root out
 * of what it verifies, so dropping the query after signing fails here too.
 */
import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it } from 'vitest';
import { getProviderClass, listProviders } from '../../../src/lib/providers/index.js';

const SECRET = 'the-secret-this-server-holds';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const hmac = (key: string | Buffer, text: string) =>
  createHmac('sha256', key).update(text).digest();

function signatureHolds(req: IncomingMessage) {
  const auth = req.headers.authorization ?? '';
  const [, day, region] = /Credential=[^/]+\/(\d{8})\/([^/]+)\//.exec(auth) ?? [];
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? '';
  const sent = /Signature=([0-9a-f]+)/.exec(auth)?.[1];
  const [path, query = ''] = (req.url ?? '').split('?');
  const canonicalQuery = query
    .split('&')
    .filter((pair) => pair && !(path === '/' && pair.startsWith('x-id=')))
    .sort()
    .join('&');
  const headers = signedHeaders
    .split(';')
    .map((name) => `${name}:${String(req.headers[name]).trim()}\n`)
    .join('');
  const payload = String(req.headers['x-amz-content-sha256']);
  const request = [req.method, path, canonicalQuery, headers, signedHeaders, payload].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = [
    'AWS4-HMAC-SHA256',
    String(req.headers['x-amz-date']),
    scope,
    sha256(request),
  ].join('\n');
  let key: string | Buffer = `AWS4${SECRET}`;
  for (const part of [day, region, 's3', 'aws4_request']) key = hmac(key, part);
  return hmac(key, toSign).toString('hex') === sent;
}

const LISTING = `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>o</ID></Owner><Buckets><Bucket><Name>one</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>`;
const REFUSED = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code></Error>`;

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

async function refusingCluster() {
  const urls: string[] = [];
  server = createServer((req, res) => {
    urls.push(req.url ?? '');
    req.resume();
    if (!signatureHolds(req)) {
      res.writeHead(403, { 'content-type': 'application/xml' }).end(REFUSED);
    } else if (req.method === 'DELETE') {
      res.writeHead(204).end();
    } else {
      res.writeHead(200, { 'content-type': 'application/xml' }).end(LISTING);
    }
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { urls, endpoint: `http://127.0.0.1:${port}` };
}

type Provider = {
  endpoint: string;
  validateCredentials: () => Promise<{ valid: boolean; rejected?: boolean }>;
  listBuckets: (opts?: unknown) => Promise<Array<{ name: string }>>;
  _send: (cmd: unknown, opts?: unknown) => Promise<unknown>;
};

async function providerFor(id: string, endpoint: string, secret = SECRET) {
  const S3Class = await getProviderClass(id).getObjectStorageProviderClass();
  const region = Object.keys(S3Class.ENDPOINTS)[0];
  const provider = new S3Class('AKTEST', secret, region) as unknown as Provider;
  provider.endpoint = endpoint;
  return provider;
}

const ids = (listProviders() as Array<{ id: string }>).map((p) => p.id);

describe('ListBuckets goes out as the bare GET / AWS documents', () => {
  it('covers every provider', () => {
    expect(ids).toEqual(
      expect.arrayContaining(['hetzner', 'digitalocean', 'linode', 'vultr', 'scaleway']),
    );
  });

  it.each(ids)('%s: a good key passes the credential check', async (id) => {
    const { urls, endpoint } = await refusingCluster();
    const provider = await providerFor(id, endpoint);
    await expect(provider.validateCredentials()).resolves.toEqual({ valid: true });
    expect(urls).toEqual(['/']);
  });

  it('the listing itself works, for the code that reads it', async () => {
    const { endpoint } = await refusingCluster();
    const provider = await providerFor('linode', endpoint);
    const buckets = await provider.listBuckets({ maxAttempts: 1 });
    expect(buckets.map((b) => b.name)).toEqual(['one']);
  });

  it('a key the store really rejects still reads as rejected', async () => {
    const { endpoint } = await refusingCluster();
    const provider = await providerFor('linode', endpoint, 'a-different-secret');
    await expect(provider.validateCredentials()).resolves.toMatchObject({
      valid: false,
      rejected: true,
    });
  });

  it('other calls keep the query the SDK gave them', async () => {
    const { urls, endpoint } = await refusingCluster();
    const provider = await providerFor('linode', endpoint);
    await provider._send(new DeleteObjectCommand({ Bucket: 'b', Key: 'k' }), { maxAttempts: 1 });
    expect(urls).toEqual(['/b/k?x-id=DeleteObject']);
  });
});
