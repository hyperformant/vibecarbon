/**
 * Live Hetzner server-type prices for the e2e cost snapshot.
 *
 * `GET /v1/server_types` lists every type with a `prices[]` entry per
 * location (`price_hourly.net`, `price_monthly.net`). Reading it means a
 * type Hetzner adds or renames (cpx22 replaced cpx21) is priced the day it
 * appears, instead of the collector warning "No pricing data" until someone
 * edits a hand-kept list. A type is priced at its first listed location
 * (the EU one); the snapshot is an estimate, not an invoice.
 */

export type TypePrice = { hourly: number; monthly: number };

const HETZNER_SERVER_TYPES_URL = 'https://api.hetzner.cloud/v1/server_types?per_page=50';
const MAX_PAGES = 20;

interface ServerTypesBody {
  server_types?: Array<{
    name?: string;
    prices?: Array<{
      price_hourly?: { net?: string | number };
      price_monthly?: { net?: string | number };
    }>;
  }>;
  meta?: { pagination?: { next_page?: number | null } };
}

/** The name-to-price map from one or more `/server_types` pages. Pure. */
export function parseTypePrices(pages: ServerTypesBody[]): Map<string, TypePrice> {
  const out = new Map<string, TypePrice>();
  for (const page of pages) {
    for (const t of page.server_types ?? []) {
      const first = t.prices?.[0];
      const hourly = Number(first?.price_hourly?.net);
      const monthly = Number(first?.price_monthly?.net);
      if (!t.name || !Number.isFinite(hourly) || !Number.isFinite(monthly)) continue;
      out.set(t.name, { hourly, monthly });
    }
  }
  return out;
}

/** Walk the paginated catalog. Throws on a non-OK answer; the caller degrades. */
export async function fetchHetznerTypePrices(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, TypePrice>> {
  const pages: ServerTypesBody[] = [];
  let url: string | null = HETZNER_SERVER_TYPES_URL;
  for (let i = 0; url && i < MAX_PAGES; i++) {
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`server_types HTTP ${res.status}`);
    const body = (await res.json()) as ServerTypesBody;
    pages.push(body);
    const next = body.meta?.pagination?.next_page;
    url = next ? `${HETZNER_SERVER_TYPES_URL}&page=${next}` : null;
  }
  return parseTypePrices(pages);
}
