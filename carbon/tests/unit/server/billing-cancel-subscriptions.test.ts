import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each provider's cancelActiveSubscriptions: the calls it makes to its own
// API, read from the provider's API reference (see each provider file).

const { stripeMock } = vi.hoisted(() => ({
  stripeMock: {
    subscriptions: {
      list: vi.fn(),
      cancel: vi.fn(),
    },
  },
}));

vi.mock('@server/lib/env', () => ({
  env: {
    // `test_`-prefixed so the repo secret-scanner reads them as fixtures.
    PADDLE_API_KEY: 'test_pdl_api_key',
    PADDLE_ENVIRONMENT: 'sandbox',
    POLAR_ACCESS_TOKEN: 'test_polar_token',
  },
}));
vi.mock('@server/lib/stripe', () => ({
  getStripe: () => stripeMock,
  isStripeConfigured: () => true,
  verifyWebhookSignature: vi.fn(),
}));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { StripeProvider } = await import('@server/billing/providers/stripe');
const { PaddleProvider } = await import('@server/billing/providers/paddle');
const { PolarProvider } = await import('@server/billing/providers/polar');

const fetchMock = vi.fn();

/** A JSON response the way the provider APIs answer. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The calls fetch saw, as `METHOD url` plus the parsed body when one was sent. */
function calls() {
  return fetchMock.mock.calls.map(([url, init]: [string, RequestInit]) => ({
    request: `${init.method} ${url}`,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  stripeMock.subscriptions.list.mockReset();
  stripeMock.subscriptions.cancel.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StripeProvider.cancelActiveSubscriptions', () => {
  it("lists the customer's active subscriptions and cancels each one", async () => {
    stripeMock.subscriptions.list.mockResolvedValue({ data: [{ id: 'sub_a' }, { id: 'sub_b' }] });

    await new StripeProvider().cancelActiveSubscriptions('cus_1');

    expect(stripeMock.subscriptions.list).toHaveBeenCalledWith({
      customer: 'cus_1',
      status: 'active',
    });
    expect(stripeMock.subscriptions.cancel.mock.calls).toEqual([['sub_a'], ['sub_b']]);
  });
});

describe('PaddleProvider.cancelActiveSubscriptions', () => {
  it('lists active subscriptions for the customer and cancels each immediately', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ id: 'sub_01a' }, { id: 'sub_01b' }], meta: {} }))
      .mockResolvedValueOnce(json({ data: { id: 'sub_01a', status: 'canceled' } }))
      .mockResolvedValueOnce(json({ data: { id: 'sub_01b', status: 'canceled' } }));

    await new PaddleProvider().cancelActiveSubscriptions('ctm_01');

    expect(calls()).toEqual([
      {
        request:
          'GET https://sandbox-api.paddle.com/subscriptions?customer_id=ctm_01&status=active&per_page=200',
        body: undefined,
      },
      {
        request: 'POST https://sandbox-api.paddle.com/subscriptions/sub_01a/cancel',
        body: { effective_from: 'immediately' },
      },
      {
        request: 'POST https://sandbox-api.paddle.com/subscriptions/sub_01b/cancel',
        body: { effective_from: 'immediately' },
      },
    ]);
  });

  it('cancels nothing when the customer has no active subscription', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [], meta: {} }));

    await new PaddleProvider().cancelActiveSubscriptions('ctm_01');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when Paddle refuses the listing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    await expect(new PaddleProvider().cancelActiveSubscriptions('ctm_01')).rejects.toThrow(
      /Paddle API error \(403\)/,
    );
  });
});

describe('PolarProvider.cancelActiveSubscriptions', () => {
  it('lists active subscriptions for the customer and revokes each one', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ items: [{ id: 'a1' }, { id: 'b2' }], pagination: { total_count: 2, max_page: 1 } }),
      )
      .mockResolvedValueOnce(json({ id: 'a1', status: 'canceled' }))
      .mockResolvedValueOnce(json({ id: 'b2', status: 'canceled' }));

    await new PolarProvider().cancelActiveSubscriptions('cust-1');

    expect(calls()).toEqual([
      {
        request: 'GET https://api.polar.sh/v1/subscriptions/?customer_id=cust-1&status=active&limit=100',
        body: undefined,
      },
      { request: 'DELETE https://api.polar.sh/v1/subscriptions/a1', body: undefined },
      { request: 'DELETE https://api.polar.sh/v1/subscriptions/b2', body: undefined },
    ]);
  });

  it('cancels nothing when the customer has no active subscription', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [], pagination: { total_count: 0, max_page: 0 } }),
    );

    await new PolarProvider().cancelActiveSubscriptions('cust-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when Polar refuses a revoke', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [{ id: 'a1' }], pagination: {} }))
      .mockResolvedValueOnce(new Response('locked', { status: 409 }));

    await expect(new PolarProvider().cancelActiveSubscriptions('cust-1')).rejects.toThrow(
      /Polar API error \(409\)/,
    );
  });
});
