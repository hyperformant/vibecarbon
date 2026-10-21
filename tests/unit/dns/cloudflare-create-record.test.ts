/**
 * Cloudflare mutating calls check the response (HA-correctness Task 4, R5).
 *
 * createDNSRecord and createHealthCheck used to return `response.json()`
 * unconditionally: a 401/403 (or a 200 carrying `success: false`) came back as
 * if it had worked, and the callers printed "DNS updated".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stops: string[] = [];
vi.mock('../../../src/lib/cli/progress.js', () => ({
  spinner: () => ({
    start: () => {},
    stop: (msg: string) => stops.push(msg),
    message: () => {},
  }),
  progressLog: () => {},
}));

const fetchMock = vi.fn();
beforeEach(() => {
  stops.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const { createDNSRecord, readARecord, setupSimple, setupHA } = await import(
  '../../../src/lib/cloudflare-dns.js'
);

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const forbidden = () =>
  json(403, {
    success: false,
    errors: [{ code: 10000, message: 'Authentication error' }],
  });
const listEmpty = () => json(200, { success: true, result: [] });
const RECORD = { type: 'A', name: 'app.example.com', value: '203.0.113.9' };

describe('Cloudflare createDNSRecord', () => {
  it('rejects a 403 on create, naming the status and never the token', async () => {
    fetchMock.mockResolvedValueOnce(listEmpty()).mockResolvedValueOnce(forbidden());
    const err = await createDNSRecord('SECRET-TOKEN', 'zone', RECORD).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('403');
    expect(err.message).toContain('Authentication error');
    expect(err.message).not.toContain('SECRET-TOKEN');
  });

  it('rejects a 403 on update of an existing record', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(200, {
          success: true,
          result: [{ id: 'r1', name: RECORD.name, type: 'A', content: '198.51.100.1' }],
        }),
      )
      .mockResolvedValueOnce(forbidden());
    await expect(createDNSRecord('t', 'zone', RECORD)).rejects.toThrow(/403/);
  });

  it('rejects a 200 whose body says success: false', async () => {
    fetchMock
      .mockResolvedValueOnce(listEmpty())
      .mockResolvedValueOnce(json(200, { success: false, errors: [{ message: 'nope' }] }));
    await expect(createDNSRecord('t', 'zone', RECORD)).rejects.toThrow(/nope/);
  });

  it('rejects when the existence lookup itself is refused', async () => {
    fetchMock.mockResolvedValueOnce(forbidden());
    await expect(createDNSRecord('t', 'zone', RECORD)).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the API body on success', async () => {
    fetchMock
      .mockResolvedValueOnce(listEmpty())
      .mockResolvedValueOnce(json(200, { success: true, result: { id: 'new' } }));
    await expect(createDNSRecord('t', 'zone', RECORD)).resolves.toMatchObject({
      result: { id: 'new' },
    });
  });
});

describe('Cloudflare setup never reports success past a refused write', () => {
  it('setupSimple with a 403 fails and never prints "DNS records created"', async () => {
    fetchMock.mockResolvedValueOnce(listEmpty()).mockResolvedValueOnce(forbidden());
    const result = await setupSimple('t', 'zone', 'app.example.com', '203.0.113.9');
    expect(result.success).toBe(false);
    expect(stops.join('\n')).not.toMatch(/DNS records created/);
  });

  it('a refused health check fails setupHA instead of printing "Health check created"', async () => {
    fetchMock
      .mockResolvedValueOnce(listEmpty())
      .mockResolvedValueOnce(json(200, { success: true, result: { id: '1' } }))
      .mockResolvedValueOnce(listEmpty())
      .mockResolvedValueOnce(json(200, { success: true, result: { id: '2' } }))
      .mockResolvedValueOnce(forbidden());
    const result = await setupHA('t', 'zone', 'app.example.com', [
      { name: 'a', ip: '203.0.113.1' },
      { name: 'b', ip: '203.0.113.2' },
    ]);
    expect(result.success).toBe(false);
    expect(stops.join('\n')).not.toMatch(/Health check created/);
  });
});

describe('Cloudflare readARecord', () => {
  it('returns the A record target', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        success: true,
        result: [{ id: 'r1', name: 'app.example.com', type: 'A', content: '203.0.113.9' }],
      }),
    );
    await expect(readARecord('t', 'zone', 'app.example.com')).resolves.toBe('203.0.113.9');
  });

  it('returns null when there is no A record', async () => {
    fetchMock.mockResolvedValueOnce(listEmpty());
    await expect(readARecord('t', 'zone', 'app.example.com')).resolves.toBeNull();
  });

  it('throws when the read is refused', async () => {
    fetchMock.mockResolvedValueOnce(forbidden());
    await expect(readARecord('t', 'zone', 'app.example.com')).rejects.toThrow(/403/);
  });
});
