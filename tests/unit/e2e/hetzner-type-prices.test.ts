import { describe, expect, it } from 'vitest';
import { fetchHetznerTypePrices, parseTypePrices } from '../../e2e/metrics/hetzner-prices.js';

const entry = (name: string, hourly: string, monthly: string) => ({
  name,
  prices: [
    { price_hourly: { net: hourly }, price_monthly: { net: monthly } },
    { price_hourly: { net: '9.9' }, price_monthly: { net: '99' } },
  ],
});

describe('Hetzner live type prices', () => {
  it('prices a current default type such as cpx22 from the catalog, not a hand list', () => {
    const prices = parseTypePrices([
      { server_types: [entry('cpx22', '0.0089', '5.99'), entry('cx33', '0.0079', '5.49')] },
    ]);
    expect(prices.get('cpx22')).toEqual({ hourly: 0.0089, monthly: 5.99 });
    expect(prices.get('cx33')).toEqual({ hourly: 0.0079, monthly: 5.49 });
  });

  it('skips a type with no usable price instead of inventing one', () => {
    const prices = parseTypePrices([{ server_types: [{ name: 'x', prices: [] }] }]);
    expect(prices.has('x')).toBe(false);
  });

  it('walks every page of the catalog', async () => {
    const pages = [
      { server_types: [entry('cpx22', '0.01', '6')], meta: { pagination: { next_page: 2 } } },
      { server_types: [entry('cx43', '0.02', '9')], meta: { pagination: { next_page: null } } },
    ];
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => pages[urls.length - 1] };
    }) as unknown as typeof fetch;
    const prices = await fetchHetznerTypePrices('t', fetchFn);
    expect([...prices.keys()]).toEqual(['cpx22', 'cx43']);
    expect(urls[1]).toContain('page=2');
  });
});
