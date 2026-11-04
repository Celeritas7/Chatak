// supabase/functions/add-product/index.ts
// Deploy: supabase functions deploy add-product --no-verify-jwt   (the signed-in user is checked in code; since the
//         2026-10-28 audit every path needs one — before, the public key alone could search and create products)
// Secrets: RAKUTEN_APP_ID
//
// Backs the paste-a-URL and search flows in the UI.
//   POST { url: "https://item.rakuten.co.jp/shop/code/" }  → resolve + create
//        (+ itemCode from a search result: Rakuten's own id, used first)
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
// Keys (2026-10-28 key migration, done by the Akatsuki hub after its audit): prefer the new secret key,
// fall back to the legacy service_role key.
const ADMIN_KEY = (() => { try { return JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default; } catch { return null; } })() || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, ADMIN_KEY, { auth: { persistSession: false } });

  // Signed-in users only: searches spend Rakuten quota and a URL creates shared products.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const { data: who } = !token || token.startsWith('sb_') ? { data: null } : await admin.auth.getUser(token);
  const user = who?.user;
  if (!user) return json({ error: 'Sign in to search or add products.' }, 401);

  let body: { url?: string; keyword?: string; jan?: string; itemCode?: string };
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

    const fromSearch = typeof body.itemCode === 'string' && /^[\w-]+:[\w-]+$/.test(body.itemCode) ? body.itemCode : null;
    const linkCode = rakuten.itemCodeFromUrl(body.url);
    if (!fromSearch && !linkCode) {
      return json({ error: 'That is not a Rakuten Ichiba item URL. Rakuten and Yahoo are the only stores wired up today.' }, 422);
    }

    let it = fromSearch ? await rakuten.byItemCode(fromSearch) : null;
    if (!it && linkCode) it = await rakuten.byItemCode(linkCode);
    if (!it) {
      return json({ error: 'Rakuten did not find that item from its link. Search for it by name and pick it from the results instead.' }, 404);
    }
    // The offer is keyed by Rakuten's own itemCode, so a search and a pasted
    // link for the same listing land on one offer.
    const itemCode = it.itemCode;

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

    // Watchlist it for the caller.
    await admin.from('chatak_watchlist')
      .upsert({ user_id: user.id, product_id: productId }, { onConflict: 'user_id,product_id' });

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
