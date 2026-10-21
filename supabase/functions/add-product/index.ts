// supabase/functions/add-product/index.ts
// Deploy: supabase functions deploy add-product
// Secrets: RAKUTEN_APP_ID
//
// Backs the paste-a-URL and search flows in the UI.
//   POST { url: "https://item.rakuten.co.jp/shop/code/" }  → resolve + create
//   POST { keyword: "オリエントスター" }                     → search, create nothing
//   POST { jan: "4954628249104" }                          → barcode search, creates nothing
//
// JAN goes through Rakuten's keyword field: the API has no dedicated JAN param,
// but Ichiba shop listings almost always carry the code in the item name or
// description, so a keyword search on the digits is the documented workaround.
// It is a search, not a lookup — it can return nothing or several shops, so the
// caller picks and then posts the chosen url back here.
//
// Creating a product also writes today's price point, so the graph has one
// honest dot instead of an empty frame. It cannot have more: there is no
// backfill, and pretending otherwise would be the same lie the app exists to
// expose.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as rakuten from '../_shared/rakuten.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  // x-akatsuki-app rides on every request from the app's shared Supabase client.
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-akatsuki-app',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const RAKUTEN_STORE_ID = 1;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  let body: { url?: string; keyword?: string; jan?: string };
  try { body = await req.json(); } catch { return json({ error: 'expected JSON body' }, 400); }

  try {
    // ── barcode: read-only search on the JAN digits ──
    if (body.jan) {
      const jan = body.jan.replace(/\D/g, '');
      if (jan.length !== 8 && jan.length !== 13) {
        return json({ error: 'A JAN code is 8 or 13 digits; got ' + jan.length + '.' }, 422);
      }
      const items = await rakuten.byKeyword(jan, 10);
      return json({
        jan,
        results: items.map((it) => ({
          itemCode: it.itemCode, name: it.itemName, price: it.itemPrice,
          shop: it.shopName, url: it.itemUrl,
          image: it.mediumImageUrls?.[0]?.imageUrl ?? null,
          jan_match: it.janCode === jan
        })),
        note: items.length === 0
          ? 'No Rakuten listing mentions that code. Try the product name instead.'
          : 'Matched by keyword, not by a JAN index — check the shop name before tracking.'
      });
    }

    // ── search: read-only, returns candidates for the picker ──
    if (body.keyword) {
      const items = await rakuten.byKeyword(body.keyword, 10);
      return json({
        results: items.map((it) => ({
          itemCode: it.itemCode,
          name: it.itemName,
          price: it.itemPrice,
          shop: it.shopName,
          url: it.itemUrl,
          image: it.mediumImageUrls?.[0]?.imageUrl ?? null
        }))
      });
    }

    if (!body.url) return json({ error: 'send a url, a keyword, or a jan' }, 400);

    const itemCode = rakuten.itemCodeFromUrl(body.url);
    if (!itemCode) {
      return json({ error: 'That is not a Rakuten Ichiba item URL. Rakuten and Yahoo are the only stores wired up today.' }, 422);
    }

    const it = await rakuten.byItemCode(itemCode);
    if (!it) return json({ error: 'Rakuten has no item at ' + itemCode + '. It may have been delisted.' }, 404);

    // Already tracking this exact offer?
    const { data: existing } = await admin
      .from('chatak_offers')
      .select('id, product:chatak_products(id, name, subtitle, msrp, image_url)')
      .eq('store_id', RAKUTEN_STORE_ID)
      .eq('store_sku', itemCode)
      .maybeSingle();

    let productId: string | number;
    if (existing?.product) {
      productId = (existing.product as any).id;
    } else {
      const { data: p, error: pe } = await admin
        .from('chatak_products')
        .insert({
          name: it.itemName.slice(0, 200),
          subtitle: it.shopName,
          msrp: it.itemPriceBaseField ?? null,
          image_url: it.mediumImageUrls?.[0]?.imageUrl ?? null,
          jan_code: it.janCode ?? null
        })
        .select('id')
        .single();
      if (pe) return json({ error: pe.message }, 500);
      productId = p.id;

      const { error: oe } = await admin.from('chatak_offers').insert({
        product_id: productId,
        store_id: RAKUTEN_STORE_ID,
        store_sku: itemCode,
        url: it.itemUrl,   // plain itemUrl — never an affiliateUrl
        active: true
      });
      if (oe) return json({ error: oe.message }, 500);
    }

    // First data point, today.
    const offerId = existing?.id ?? (
      await admin.from('chatak_offers').select('id')
        .eq('store_id', RAKUTEN_STORE_ID).eq('store_sku', itemCode).single()
    ).data?.id;

    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // JST
    const q = rakuten.toQuote(it);
    if (offerId) {
      await admin.from('chatak_price_points').upsert(
        { offer_id: offerId, captured_on: today, ...q },
        { onConflict: 'offer_id,captured_on' }
      );
    }

    // Watchlist it for the caller, if this request carries a user.
    const authHeader = req.headers.get('Authorization');
    if (authHeader) {
      const asUser = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user } } = await asUser.auth.getUser();
      if (user) {
        await admin.from('chatak_watchlist')
          .upsert({ user_id: user.id, product_id: productId }, { onConflict: 'user_id,product_id' });
      }
    }

    return json({
      product_id: productId,
      name: it.itemName,
      price: q.price,
      reference_price: q.reference_price,
      points_back: q.points_back,
      in_stock: q.in_stock,
      image: it.mediumImageUrls?.[0]?.imageUrl ?? null,
      url: it.itemUrl,
      history_days: 1,
      note: 'Tracking starts today. There is no back history to import — the first useful median is about two weeks away.'
    });
  } catch (e) {
    const status = e instanceof rakuten.RakutenError ? (e.status === 429 ? 429 : 502) : 500;
    return json({ error: String((e as Error).message ?? e) }, status);
  }
});
