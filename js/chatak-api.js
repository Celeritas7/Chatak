// chatak-api.js — browser data layer for the Chatak prototype.
// Drop your project URL + anon key in CHATAK_CONFIG (or window.CHATAK_CONFIG)
// and the app switches from generated sample data to live Supabase data.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const CHATAK_CONFIG = (typeof window !== 'undefined' && window.CHATAK_CONFIG) || {
  url: '',      // https://PROJECT_REF.supabase.co
  anonKey: ''   // the anon/publishable key — safe in the browser, RLS protects the rest
};

export const isConfigured = () => Boolean(CHATAK_CONFIG.url && CHATAK_CONFIG.anonKey);

export const db = isConfigured()
  ? createClient(CHATAK_CONFIG.url, CHATAK_CONFIG.anonKey, { global: { headers: { 'x-akatsuki-app': 'chatak' } } })
  : null;

// Akatsuki hub — same project, same client, no second session (AKATSUKI.md).
// js/akatsuki-client.js is a classic script loaded by index.html before this module.
export const hub = db && typeof window !== 'undefined' && window.Akatsuki ? window.Akatsuki(db, 'chatak') : null;
if (typeof window !== 'undefined' && db) window.chatak = { supabase: db, hub };

// ── auth ──
// Both paths are gated server-side by the allow-list trigger on
// authentication_mode_user_roles: an address that is not listed cannot become a
// user, whichever method it arrives through.
// Where the user should land after following a link or finishing consent: the
// page they started from. A hardcoded destination sends someone signing in on
// localhost to the deployed copy, which is a different build of the app.
// CHATAK_CONFIG.oauthRedirect is honoured only when it points at this origin.
const returnHere = () => {
  const here = window.location.origin + window.location.pathname;
  const configured = CHATAK_CONFIG.oauthRedirect;
  if (configured && configured.indexOf(window.location.origin) === 0) return configured;
  return here;
};

export const signIn = (email) => db.auth.signInWithOtp({
  email,
  options: { emailRedirectTo: returnHere() }
});

export const signInWithGoogle = () => db.auth.signInWithOAuth({
  provider: 'google',
  options: {
    redirectTo: returnHere(),
    // Ask Google to keep the session so the user is not re-prompted every visit.
    queryParams: { access_type: 'offline', prompt: 'select_account' }
  }
});

export const signOut = () => db.auth.signOut();
export const session = async () => (await db.auth.getSession()).data.session;

// The signed-in user's row in the allow-list table. Returns null when the user
// somehow has a session but no row — the caller must treat that as no access.
export async function getRole() {
  const s = await session();
  if (!s) return null;
  const { data } = await db.from('authentication_mode_user_roles')
    .select('email, role, name, timezone')
    .or('auth_user_id.eq.' + s.user.id + ',email.eq.' + s.user.email)
    .limit(1);
  const row = data?.[0] ?? null;
  // Shared allow-list: the Akatsuki apps' 'operator' is an editor in Chatak
  // (the database's chatak_role() maps it the same way).
  return row && row.role === 'operator' ? { ...row, role: 'editor' } : row;
}

// ── reads ──
export async function getStores() {
  const { data } = await db.from('chatak_stores').select('*').order('id');
  return data ?? [];
}

export async function getWatchlist() {
  const { data } = await db.from('chatak_watchlist')
    .select('product_id, product:chatak_products(id, name, subtitle, msrp, image_url)')
    .order('created_at');
  const rows = data ?? [];
  return Promise.all(rows.map(async (w) => ({ ...w.product, stats: await getStats(w.product_id) })));
}

export async function getStats(productId, days = 90) {
  const { data } = await db.rpc('chatak_product_stats', { p_product: productId, p_days: days });
  return data?.[0] ?? null;
}

// One series per store, plus the retailer reference line — exactly what the graph draws.
export async function getHistory(productId, days = 90) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const { data } = await db.from('chatak_price_points')
    .select('captured_on, price, reference_price, offer:chatak_offers!inner(product_id, store:chatak_stores(slug, name, color, is_used))')
    .eq('offer.product_id', productId)
    .gte('captured_on', since)
    .order('captured_on');

  const byStore = new Map();
  for (const p of data ?? []) {
    const s = p.offer.store;
    if (!byStore.has(s.slug)) byStore.set(s.slug, { name: s.name, color: s.color, used: s.is_used, points: [] });
    byStore.get(s.slug).points.push({ d: p.captured_on, p: p.price, ref: p.reference_price });
  }
  return [...byStore.values()];
}

export async function getFlags(productId) {
  const { data } = await db.rpc('chatak_fake_discount_flags', { p_product: productId });
  return data ?? [];
}

export async function getSaleEvents(fromISO, toISO) {
  const { data } = await db.from('chatak_sale_events').select('*')
    .gte('starts_on', fromISO).lte('starts_on', toISO).order('starts_on');
  return data ?? [];
}

export async function getAlerts() {
  const { data } = await db.from('chatak_alert_rules')
    .select('id, kind, target_price, active, product:chatak_products(id, name)').eq('active', true);
  return data ?? [];
}

export async function getAlertLog(limit = 10) {
  const { data } = await db.from('chatak_alert_events')
    .select('title, body, kind, sent_at').order('sent_at', { ascending: false }).limit(limit);
  return data ?? [];
}

// ── writes ──
export async function track(productId) {
  const uid = (await session())?.user?.id;
  return db.from('chatak_watchlist').insert({ user_id: uid, product_id: productId });
}

// One rule per (person, product, kind) — chatak_alert_rules_one makes upsert safe.
export async function setTarget(productId, targetPrice) {
  const uid = (await session())?.user?.id;
  const { error } = await db.from('chatak_alert_rules')
    .upsert({ user_id: uid, product_id: productId, kind: 'target', target_price: targetPrice, active: true },
            { onConflict: 'user_id,product_id,kind' });
  if (error) throw error;
}

export async function setRule(productId, kind, active = true) {
  const uid = (await session())?.user?.id;
  const { error } = await db.from('chatak_alert_rules')
    .upsert({ user_id: uid, product_id: productId, kind, active }, { onConflict: 'user_id,product_id,kind' });
  if (error) throw error;
}

export async function removeRule(ruleId) {
  const { error } = await db.from('chatak_alert_rules').delete().eq('id', ruleId);
  if (error) throw error;
}

// ── price notifier ──
// Everything the Alerts screen needs in one read. ready=false means the
// notifier section of schema.sql has not been run yet, and says which part.
export async function getNotifier(limit = 40) {
  const uid = (await session())?.user?.id;
  const [rules, mx, events, prof] = await Promise.all([
    db.from('chatak_alert_rules').select('id, kind, target_price, active, product_id, product:chatak_products(id, name)').eq('active', true),
    db.from('chatak_matrix_alerts').select('id, item_id, target_price, active').eq('active', true),
    db.from('chatak_alert_events').select('id, kind, title, body, payload, channels, sent_at, read_at, product_id, matrix_alert_id, shop_name')
      .order('sent_at', { ascending: false }).limit(limit),
    db.from('chatak_profiles').select('notify_push, muted_kinds').eq('id', uid).maybeSingle()
  ]);
  const missing = [mx, events, prof].find((r) => r.error && ['42P01', 'PGRST205', '42703', 'PGRST204'].includes(r.error.code));
  if (missing) return { ready: false, reason: missing.error.message };
  for (const r of [rules, mx, events, prof]) if (r.error) throw r.error;
  return {
    ready: true, rules: rules.data ?? [], matrix: mx.data ?? [], events: events.data ?? [],
    notifyPush: prof.data?.notify_push ?? true, muted: prof.data?.muted_kinds ?? []
  };
}

export async function setMatrixAlert(itemId, targetPrice) {
  const uid = (await session())?.user?.id;
  const { error } = await db.from('chatak_matrix_alerts')
    .upsert({ user_id: uid, item_id: itemId, target_price: targetPrice, active: true }, { onConflict: 'user_id,item_id' });
  if (error) throw error;
}

export async function removeMatrixAlert(itemId) {
  const uid = (await session())?.user?.id;
  const { error } = await db.from('chatak_matrix_alerts').delete().eq('user_id', uid).eq('item_id', itemId);
  if (error) throw error;
}

// ids omitted = everything unread.
export async function markAlertsRead(ids) {
  let q = db.from('chatak_alert_events').update({ read_at: new Date().toISOString() }).is('read_at', null);
  if (ids) q = q.in('id', ids);
  const { error } = await q;
  if (error) throw error;
}

export async function setMutedKinds(kinds) {
  const uid = (await session())?.user?.id;
  const { error } = await db.from('chatak_profiles').update({ muted_kinds: kinds }).eq('id', uid);
  if (error) throw error;
}

export async function setNotifyPush(on) {
  const uid = (await session())?.user?.id;
  const { error } = await db.from('chatak_profiles').update({ notify_push: on }).eq('id', uid);
  if (error) throw error;
}

// A PushSubscription.toJSON() from this browser. The endpoint is unique, so a
// re-subscribe on the same device replaces its row.
export async function savePushSubscription(sub) {
  const uid = (await session())?.user?.id;
  const { error } = await db.from('chatak_push_subscriptions').upsert(
    { user_id: uid, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    { onConflict: 'endpoint' });
  if (error) throw error;
}

export async function deletePushSubscription(endpoint) {
  const { error } = await db.from('chatak_push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) throw error;
}

// Deliver anything pending now (a matrix save may just have created alerts).
// Fire-and-forget from the caller: failure only delays the push to the next run.
export async function sendPushNow() {
  const { data, error } = await db.functions.invoke('send-push', { body: {} });
  if (error) throw new Error(data?.error ?? error.message);
  return data;
}

export async function testPush() {
  const { data, error } = await db.functions.invoke('send-push', { body: { test: true } });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return data;
}

// Paste-a-URL flow: the add-product edge function resolves the Rakuten item
// code, creates product + offer, and writes today's price. It cannot backfill —
// `history_days` comes back as 1 and the UI should say so rather than draw an
// empty 90-day frame.
export async function addByUrl(url) {
  const { data, error } = await db.functions.invoke('add-product', { body: { url } });
  if (error) throw new Error(data?.error ?? error.message);
  return data;
}

// Local catalog first (instant, free); fall back to live Rakuten search when we
// have nothing yet. Rakuten results carry `itemCode` and no `id` — pass one
// back through addByUrl(result.url) to start tracking it.
export async function searchCatalog(q) {
  const { data } = await db.from('chatak_products')
    .select('id, name, subtitle, msrp').ilike('name', '%' + q + '%').limit(10);
  if (data?.length) return data.map((r) => ({ ...r, source: 'catalog' }));
  return searchRakuten(q);
}

// Barcode scan → candidate listings. Returns [] when nothing mentions the code;
// the caller should then fall back to a name search rather than claim a match.
export async function searchByJan(jan) {
  const { data, error } = await db.functions.invoke('add-product', { body: { jan } });
  if (error) throw new Error(data?.error ?? error.message);
  return { results: data.results ?? [], note: data.note };
}

export async function searchRakuten(keyword) {
  const { data, error } = await db.functions.invoke('add-product', { body: { keyword } });
  if (error) throw new Error(data?.error ?? error.message);
  return (data.results ?? []).map((r) => ({
    id: null, itemCode: r.itemCode, name: r.name, subtitle: r.shop,
    msrp: null, current: r.price, url: r.url, image: r.image, source: 'rakuten'
  }));
}

// ── price matrix ──
// Shops are read from Cost's hub view. New ones are written to Cost itself
// (addCostShop) — Chatak never keeps a shop list of its own.
export async function getMatrixShops() {
  const { data, error } = await db.from('akatsuki_shops').select('*').order('name');
  if (error) throw error;
  return data ?? [];
}

// Items (shared list), the latest price per (shop, item), this user's stars and
// the shops this user chose to show. picks is null when chatak_matrix_shop_picks
// does not exist yet (schema.sql not re-run): the caller then shows every shop.
export async function getMatrix() {
  const missingCol = (e) => e && (e.code === '42703' || e.code === 'PGRST204');
  let [items, latest, stars, picks] = await Promise.all([
    db.from('chatak_matrix_items').select('id, name, size, category').order('name'),
    db.from('chatak_matrix_latest').select('cost_shop_id, shop_name, item_id, price, currency, shelf, entered_at'),
    db.from('chatak_matrix_stars').select('item_id'),
    db.from('chatak_matrix_shop_picks').select('shop_name, cost_shop_id')
  ]);
  // schema.sql not re-run yet: read the old shape (names only).
  if (missingCol(latest.error)) latest = await db.from('chatak_matrix_latest').select('shop_name, item_id, price, currency, shelf, entered_at');
  if (missingCol(picks.error)) picks = await db.from('chatak_matrix_shop_picks').select('shop_name');
  for (const r of [items, latest, stars]) if (r.error) throw r.error;
  const noPicksTable = picks.error && (picks.error.code === '42P01' || picks.error.code === 'PGRST205');
  if (picks.error && !noPicksTable) throw picks.error;
  return {
    items: items.data ?? [], latest: latest.data ?? [], stars: (stars.data ?? []).map((s) => s.item_id),
    picks: noPicksTable ? null : (picks.data ?? []).map((p) => ({ name: p.shop_name, id: p.cost_shop_id ?? null }))
  };
}

// Show or hide shops in this user's matrix: [{ name, id }]. Several at once so
// "Show all" is one request. Keyed by Cost's shop id; the name is kept for rows
// written before ids.
export async function setMatrixShopPicks(shops, on) {
  if (!shops.length) return;
  const uid = (await session())?.user?.id;
  const ids = shops.map((s) => (s.id != null ? String(s.id) : null)).filter(Boolean);
  if (on) {
    let { error } = await db.from('chatak_matrix_shop_picks').upsert(shops.map((s) => ({ user_id: uid, shop_name: s.name, cost_shop_id: s.id != null ? String(s.id) : null })));
    if (error && (error.code === '42703' || error.code === 'PGRST204')) ({ error } = await db.from('chatak_matrix_shop_picks').upsert(shops.map((s) => ({ user_id: uid, shop_name: s.name }))));
    if (error) throw error;
    return;
  }
  const byName = await db.from('chatak_matrix_shop_picks').delete().eq('user_id', uid).in('shop_name', shops.map((s) => s.name));
  if (byName.error) throw byName.error;
  if (ids.length) await db.from('chatak_matrix_shop_picks').delete().eq('user_id', uid).in('cost_shop_id', ids);
}

// Append-only: every save is a new row, the view picks the latest.
export async function saveMatrixRow(shop, entries, { shelf = false, currency = 'JPY' } = {}) {
  const uid = (await session())?.user?.id;
  const rows = entries.map((e) => ({
    shop_name: shop.name, cost_shop_id: shop.id != null ? String(shop.id) : null,
    item_id: e.itemId, price: e.price, currency, shelf, kind: 'entry', entered_by: uid
  }));
  const { error } = await db.from('chatak_matrix_prices').insert(rows);
  if (error) throw error;
}

export async function confirmMatrixPrice(shop, itemId, price, shelf, currency = 'JPY') {
  const uid = (await session())?.user?.id;
  const { error } = await db.from('chatak_matrix_prices').insert({
    shop_name: shop.name, cost_shop_id: shop.id != null ? String(shop.id) : null,
    item_id: itemId, price, currency, shelf, kind: 'confirm', entered_by: uid
  });
  if (error) throw error;
}

// Areas live in the Akatsuki hub; Cost reads them through akatsuki_cost_areas.
// null = the view is not there (or not readable): the area field hides.
export async function getCostAreas() {
  const { data, error } = await db.from('akatsuki_cost_areas').select('*').order('name');
  if (error) return null;
  const num = (v) => (v == null || v === '' ? null : Number(v));
  return (data ?? []).map((a) => ({ id: String(a.id), name: a.name, lat: num(a.lat), lng: num(a.lng), region: a.region || null }));
}

// Which area each Cost shop is in — the hub view akatsuki_cost_shop_areas
// (user_id, shop_id, area_id; area_id matches akatsuki_cost_areas.id).
// null = view not readable: area tabs show no counts.
export async function getCostShopAreas() {
  const { data, error } = await db.from('akatsuki_cost_shop_areas').select('shop_id, area_id');
  if (error || !Array.isArray(data)) return null;
  return data.map((r) => ({ shop_id: r.shop_id != null ? String(r.shop_id) : null, area_id: r.area_id != null ? String(r.area_id) : null }));
}

export async function addMatrixItem({ name, size, category }) {
  const uid = (await session())?.user?.id;
  const { data, error } = await db.from('chatak_matrix_items')
    .insert({ name, size: size || null, category: category || 'Other', created_by: uid }).select().single();
  if (error) throw error;
  return data;
}

export async function setMatrixStar(itemId, on) {
  const uid = (await session())?.user?.id;
  const q = on
    ? db.from('chatak_matrix_stars').upsert({ user_id: uid, item_id: itemId })
    : db.from('chatak_matrix_stars').delete().eq('user_id', uid).eq('item_id', itemId);
  const { error } = await q;
  if (error) throw error;
}

export async function findByBarcode(jan) {
  const { data } = await db.from('chatak_products').select('id, name, subtitle, msrp').eq('jan_code', jan).maybeSingle();
  return data;
}
