// supabase/functions/collect-prices/index.ts
// Deploy: supabase functions deploy collect-prices --no-verify-jwt
// Secrets: supabase secrets set RAKUTEN_APP_ID=... YAHOO_APP_ID=...
// (secrets merge — setting one does not clear the others)
//
// Runs once a day. For every active offer it asks that store's adapter for
// today's price AND the store's own reference ("was") price, then appends one
// immutable row to price_points. Nothing here ever updates a past row — that
// is the whole point of the product.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as rakutenApi from '../_shared/rakuten.ts';

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

type Quote = { price: number; reference_price: number | null; in_stock: boolean; points_back?: number };

// ── Rakuten — _shared/rakuten.ts owns the endpoint, the ~1 req/sec throttle,
// the 429 retry and the deliberate absence of affiliateId. The loop below can
// stay naive about pacing because that queue is global to the isolate.
async function rakuten(sku: string): Promise<Quote | null> {
  const it = await rakutenApi.byItemCode(sku);
  return it ? rakutenApi.toQuote(it) : null;
}

// ── Yahoo! Shopping ItemSearch — free, app id only ──
// https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html
async function yahoo(sku: string): Promise<Quote | null> {
  const url = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch'
    + '?appid=' + Deno.env.get('YAHOO_APP_ID') + '&jan_code=' + encodeURIComponent(sku);
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const it = j.hits?.[0];
  if (!it) return null;
  return {
    price: it.price,
    reference_price: it.priceLabel?.defaultPrice ?? null,
    in_stock: it.inStock !== false
  };
}

// ── Amazon JP: Product Advertising API v5 requires an approved affiliate
// account with qualifying sales. Until you have one, leave these offers
// inactive rather than scraping — Amazon blocks it and it is against their ToS.
async function paapi(_sku: string): Promise<Quote | null> { return null; }

// ── Yodobashi / Bic Camera / Mercari have no public API. Point this at your
// own scraping worker (Playwright on Fly.io / Cloud Run) and return the same
// shape. Respect robots.txt and keep it to one polite request per offer per day.
async function scrape(storeSlug: string, url: string): Promise<Quote | null> {
  const endpoint = Deno.env.get('SCRAPER_URL');
  if (!endpoint) return null;
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + Deno.env.get('SCRAPER_TOKEN') },
    body: JSON.stringify({ store: storeSlug, url })
  });
  return r.ok ? await r.json() : null;
}

Deno.serve(async () => {
  const { data: offers, error } = await db
    .from('chatak_offers')
    .select('id, store_sku, url, store:chatak_stores(slug, adapter)')
    .eq('active', true);
  if (error) return new Response(error.message, { status: 500 });

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // JST
  const rows: any[] = [];
  let failed = 0;

  for (const o of offers ?? []) {
    const s: any = o.store;
    let q: Quote | null = null;
    try {
      if (s.adapter === 'rakuten_api')      q = await rakuten(o.store_sku);
      else if (s.adapter === 'yahoo_api')   q = await yahoo(o.store_sku);
      else if (s.adapter === 'paapi')       q = await paapi(o.store_sku);
      else if (s.adapter === 'scrape')      q = await scrape(s.slug, o.url);
    } catch (err) {
      q = null;
      console.error('[' + s.adapter + '] offer ' + o.id + ': ' + ((err as Error).message ?? err));
    }

    if (!q) { failed++; continue; }
    rows.push({
      offer_id: o.id, captured_on: today, price: q.price,
      reference_price: q.reference_price, points_back: q.points_back ?? 0,
      in_stock: q.in_stock
    });
    // Rakuten paces itself inside _shared/rakuten.ts; everything else gets a
    // courtesy gap so a big watchlist never looks like a burst.
    if (s.adapter !== 'rakuten_api') await new Promise((r) => setTimeout(r, 250));
  }

  // upsert so a re-run on the same day corrects rather than duplicates
  if (rows.length) {
    const { error: e2 } = await db.from('chatak_price_points')
      .upsert(rows, { onConflict: 'offer_id,captured_on' });
    if (e2) return new Response(e2.message, { status: 500 });
  }

  // hand off to the alert evaluator
  await fetch(Deno.env.get('SUPABASE_URL') + '/functions/v1/evaluate-alerts', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') }
  });

  return Response.json({ captured: rows.length, failed, date: today });
});
