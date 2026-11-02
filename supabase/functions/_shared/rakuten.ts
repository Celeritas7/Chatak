// _shared/rakuten.ts — the only place that talks to Rakuten.
//
// Two rules live here so no caller has to remember them:
//   1. ~1 request/second per application id. Every call goes through one
//      serialized queue with a 1.1s floor, so N concurrent callers still
//      produce a legal request rate.
//   2. No affiliateId, ever. Passing it swaps itemUrl for a tracked
//      affiliateUrl in the response, and those URLs would end up stored in
//      chatak_offers.url. Monetisation is a product decision, not a side
//      effect of a collector. If that decision is ever made, add it here
//      explicitly and migrate the stored urls on purpose.
//
// formatVersion is pinned to 1 — the nested Items[].Item shape. Do not
// "upgrade" to 2 without changing every parser below; v2 flattens it.

// Two generations of Rakuten app:
//   - legacy (webservice.rakuten.co.jp, before 2025): applicationId only, on
//     app.rakuten.co.jp.
//   - current portal: applicationId AND accessKey, on openapi.rakuten.co.jp,
//     and the request must name one of the app's "allowed websites" (Origin /
//     Referer), or Rakuten answers 403. Chatak's app is a Web Application with
//     celeritas7.github.io allowed; RAKUTEN_SITE overrides it.
// Which one is used follows from the secrets: RAKUTEN_ACCESS_KEY set → current.
const LEGACY_ENDPOINT = 'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601';
// 20220601 was retired in 2026: calling it now answers 400 "API Configuration not found".
const ENDPOINT = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';
const DEFAULT_SITE = 'https://celeritas7.github.io/';
const MIN_INTERVAL_MS = 1100;

let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

/** Serializes every Rakuten request and spaces them ≥1.1s apart. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => {}); // a failure must not break the queue
  return run;
}

export type RakutenItem = {
  itemCode: string;
  itemName: string;
  itemPrice: number;
  itemPriceBaseField: number | null;
  pointRate: number;
  availability: number;
  itemUrl: string;
  mediumImageUrls: { imageUrl: string }[];
  shopName: string;
  janCode?: string;
};

export class RakutenError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'RakutenError';
  }
}

/** Raw search. params are merged into the query string. One retry on 429. */
export async function search(
  params: Record<string, string | number>
): Promise<RakutenItem[]> {
  const appId = Deno.env.get('RAKUTEN_APP_ID');
  if (!appId) throw new RakutenError(0, 'RAKUTEN_APP_ID is not set');
  const accessKey = Deno.env.get('RAKUTEN_ACCESS_KEY') || '';
  const site = Deno.env.get('RAKUTEN_SITE') || DEFAULT_SITE;

  const qs = new URLSearchParams({
    applicationId: appId,
    ...(accessKey ? { accessKey } : {}),
    format: 'json',
    formatVersion: '1',
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  });

  // Origin is the site without a trailing slash; Referer the page. Rakuten's
  // check is reported against either, so both are sent.
  const headers: Record<string, string> = accessKey
    ? { Origin: site.replace(/\/+$/, ''), Referer: site.endsWith('/') ? site : site + '/' }
    : {};
  const call = () => fetch((accessKey ? ENDPOINT : LEGACY_ENDPOINT) + '?' + qs.toString(), { headers });

  let r = await throttled(call);
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, 2000));
    r = await throttled(call);
  }
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200);
    const hint = r.status === 403 ? ' Check that the app lists ' + site + ' under allowed websites.'
      : r.status === 401 || /accessKey|access_key/i.test(body) ? ' Check RAKUTEN_APP_ID and RAKUTEN_ACCESS_KEY.' : '';
    throw new RakutenError(r.status, 'Rakuten returned ' + r.status + ': ' + body + hint);
  }
  const j = await r.json();
  return (j.Items ?? []).map((w: any) => {
    const it = w.Item as RakutenItem;
    return { ...it, itemUrl: cleanUrl(it.itemUrl) };
  });
}

/** The plain item page: the 2026 API appends a tracking parameter (rafcid). */
export function cleanUrl(raw: string): string {
  try { const u = new URL(raw); u.search = ''; u.hash = ''; return u.toString(); } catch { return raw; }
}

/**
 * item.rakuten.co.jp/{shop}/{itemcode}/ → "shop:itemcode".
 * Since the 2026 API, Rakuten's own itemCode can be a numeric id that differs
 * from the code in the link; prefer the itemCode a search returned, and use
 * this only for a pasted link.
 * Returns null for anything that is not a recognisable Ichiba item URL.
 */
export function itemCodeFromUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!/(^|\.)rakuten\.co\.jp$/.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.hostname === 'item.rakuten.co.jp' && parts.length >= 2) {
    return parts[0] + ':' + parts[1];
  }
  // https://www.rakuten.co.jp/{shop}/{...}/{itemcode}/ — shop-site form
  if (parts.length >= 2) return parts[0] + ':' + parts[parts.length - 1];
  return null;
}

/** One item by its "shop:itemcode". */
export async function byItemCode(itemCode: string): Promise<RakutenItem | null> {
  const items = await search({ itemCode, hits: 1 });
  return items[0] ?? null;
}

/** Keyword search for the add-product picker. */
export async function byKeyword(keyword: string, hits = 10): Promise<RakutenItem[]> {
  return search({ keyword, hits, sort: '+itemPrice' });
}

export type Quote = {
  price: number;
  reference_price: number | null;
  in_stock: boolean;
  points_back: number;
};

export function toQuote(it: RakutenItem): Quote {
  return {
    price: it.itemPrice,
    // itemPriceBaseField is the shop's own "was" price — the fake-discount input.
    reference_price: it.itemPriceBaseField ?? null,
    points_back: Math.round((it.itemPrice * (it.pointRate ?? 1)) / 100),
    in_stock: it.availability === 1
  };
}
