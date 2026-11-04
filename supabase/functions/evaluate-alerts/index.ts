// supabase/functions/evaluate-alerts/index.ts
// Deploy: supabase functions deploy evaluate-alerts --no-verify-jwt   (caller checked in code: isService — collect-prices sends the secret key)
// Secrets: supabase secrets set RESEND_API_KEY=... APP_URL=https://you.github.io/chatak
//
// Runs straight after collection. Evaluates every active rule against the
// freshly written prices and records at most one alert per rule per day. The
// alert row is the in-app inbox entry; send-push then delivers it to phones.
// Email is sent too when RESEND_API_KEY is set (optional).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Keys (2026-10-28 key migration, done by the Akatsuki hub after its audit): prefer the new secret key,
// fall back to the legacy service_role key.  Server-to-server callers are checked in code (isService).
const SECRET_KEYS: string[] = (() => { try { return Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')).map(String); } catch { return []; } })();
const ADMIN_KEY = (() => { try { return JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default; } catch { return null; } })() || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(Deno.env.get('SUPABASE_URL')!, ADMIN_KEY, { auth: { persistSession: false } });

// A server caller: the project secret key (apikey or bearer), or a legacy service_role JWT the admin API accepts.
async function isService(req: Request): Promise<boolean> {
  const apikey = (req.headers.get('apikey') || '').trim();
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if ((apikey && SECRET_KEYS.includes(apikey)) || (bearer && SECRET_KEYS.includes(bearer))) return true;
  if (!bearer || bearer.startsWith('sb_')) return false;
  try {
    const t = bearer.split('.')[1];
    if (JSON.parse(atob(t.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(t.length / 4) * 4, '='))).role !== 'service_role') return false;
  } catch { return false; }
  const { error } = await createClient(Deno.env.get('SUPABASE_URL')!, bearer, { auth: { persistSession: false } }).auth.admin.listUsers({ page: 1, perPage: 1 });
  return !error;
}
// Calling the next function in the chain: the secret key on apikey (and as bearer, which a legacy key needs).
const SERVICE_HEADERS = { apikey: ADMIN_KEY, Authorization: 'Bearer ' + ADMIN_KEY, 'Content-Type': 'application/json' };

const yen = (n: number) => '¥' + n.toLocaleString('en-US');
// chatak_product_stats takes the last 90 recorded days, so a young product has a
// shorter median than 90 days. Never claim a span the record cannot support.
const medianLabel = (s: any) => {
  const d = Number(s?.history_days ?? 0);
  return d >= 90 ? '90-day median' : d + '-day median';
};

async function sendEmail(to: string, subject: string, html: string) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Chatak <alerts@yourdomain.jp>', to, subject, html })
  });
}

Deno.serve(async (req) => {
  if (!(await isService(req))) return new Response('service only', { status: 401 });
  const { data: rules } = await db
    .from('chatak_alert_rules')
    .select('id, user_id, product_id, kind, target_price, product:chatak_products(name)')
    .eq('active', true);

  // chatak_alert_rules.user_id references auth.users, not chatak_profiles, so
  // PostgREST cannot embed the profile — fetch them once and index by id.
  const userIds = [...new Set((rules ?? []).map((r) => r.user_id).filter(Boolean))];
  let profileRows: any[] = [];
  if (userIds.length) {
    const r = await db.from('chatak_profiles').select('id, email, notify_email, notify_push, muted_kinds').in('id', userIds);
    // muted_kinds arrives with the notifier section of schema.sql; before that, read without it.
    profileRows = r.error
      ? ((await db.from('chatak_profiles').select('id, email, notify_email, notify_push').in('id', userIds)).data ?? [])
      : (r.data ?? []);
  }
  const profiles = new Map((profileRows ?? []).map((p: any) => [p.id, p]));

  const sent: any[] = [];

  for (const r of rules ?? []) {
    if (!r.product_id) continue;
    // Switched off on the Alerts screen: no event, so no inbox entry and no push.
    if ((profiles.get(r.user_id) as any)?.muted_kinds?.includes(r.kind)) continue;
    const { data: st } = await db.rpc('chatak_product_stats', { p_product: r.product_id, p_days: 90 });
    const s = st?.[0];
    if (!s?.current_price) continue;

    const name = (r.product as any)?.name ?? 'Your product';
    let title = '', body = '';

    if (r.kind === 'target' && r.target_price && s.current_price <= r.target_price) {
      title = name + ' hit your ' + yen(r.target_price) + ' target';
      body = 'Now ' + yen(s.current_price) + ' at ' + s.best_store + ', ' + s.pct_vs_median + '% vs the ' + medianLabel(s) + '.';
    } else if (r.kind === 'lowest_ever' && s.is_record_low) {
      title = name + ' is at its lowest recorded price';
      body = yen(s.current_price) + ' at ' + s.best_store + ' — below every price in our ' + (s.history_days ?? 0) + '-day record.';
    } else if (r.kind === 'fake_discount') {
      const { data: flags } = await db.rpc('chatak_fake_discount_flags', { p_product: r.product_id });
      const f = flags?.[0];
      if (f && new Date(f.raised_on).getTime() > Date.now() - 3 * 86400000) {
        title = 'Fake discount: ' + name + ' at ' + f.store;
        body = 'Reference price raised ' + yen(f.ref_before) + ' → ' + yen(f.ref_after)
             + ' (advertised ' + f.advertised_pct + '% off, real change ' + f.real_pct + '% vs the ' + medianLabel(s) + ').';
      }
    } else if (r.kind === 'event_soon') {
      const { data: ev } = await db.from('chatak_sale_events').select('name, starts_on')
        .gte('starts_on', new Date().toISOString().slice(0, 10))
        .lte('starts_on', new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10))
        .limit(1);
      if (ev?.[0]) {
        title = ev[0].name + ' starts in 3 days';
        body = 'We are watching ' + name + ' across the event window.';
      }
    }

    if (!title) continue;

    // one message per rule per day
    const { count } = await db.from('chatak_alert_events').select('id', { count: 'exact', head: true })
      .eq('rule_id', r.id).gte('sent_at', new Date(Date.now() - 20 * 3600000).toISOString());
    if (count) continue;

    const prof: any = profiles.get(r.user_id);
    const channels: string[] = ['inbox'];
    if (prof?.notify_email && prof?.email && Deno.env.get('RESEND_API_KEY')) { await sendEmail(prof.email, title, '<p>' + body + '</p>'); channels.push('email'); }

    await db.from('chatak_alert_events').insert({
      rule_id: r.id, user_id: r.user_id, product_id: r.product_id,
      kind: r.kind, title, body, channels,
      payload: { screen: 'alerts', product_id: r.product_id, price: s.current_price }
    });
    sent.push(title);
  }

  // Phone notifications for everything recorded above (and anything missed).
  let push: unknown = null;
  try {
    const res = await fetch(Deno.env.get('SUPABASE_URL') + '/functions/v1/send-push', {
      method: 'POST',
      headers: SERVICE_HEADERS,
      body: '{}'
    });
    push = await res.json().catch(() => res.status);
  } catch (e) { push = String(e); }

  return Response.json({ sent: sent.length, titles: sent, push });
});
