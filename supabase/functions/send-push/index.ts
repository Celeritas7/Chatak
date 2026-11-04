// supabase/functions/send-push/index.ts
// Deploy: supabase functions deploy send-push --no-verify-jwt   (callers checked in code: the service — evaluate-alerts —
//         or a signed-in user.  Verify JWT is off because the new secret key is not a JWT.)
// Secrets: supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
//          (APP_URL, already set for evaluate-alerts, is where a tapped notification opens)
//
// Delivers every alert event that has not been pushed yet to each of its
// owner's devices. The event row is the inbox entry and already exists; this
// only adds the phone notification. Called by evaluate-alerts after the daily
// run and by the app right after a matrix price is saved. Idempotent: events
// are claimed (pushed_at stamped) before sending, so overlapping calls never
// double-notify.
//
// POST {}            → deliver pending events
// POST {test: true}  → send a test notification to the caller's own devices

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

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

const PUB = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const PRIV = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const APP_URL = (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '');
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-akatsuki-app'
};
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });

if (PUB && PRIV) webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:alerts@example.com', PUB, PRIV);

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

// Send to every device; forget devices the push service says are gone.
async function deliver(subs: Sub[], message: Record<string, unknown>) {
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(message),
        { TTL: 60 * 60 * 24, urgency: 'high' }
      );
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('chatak_push_subscriptions').delete().eq('id', s.id);
      else console.error('push failed', code, (e as Error).message);
    }
  }
  return ok;
}

const openUrl = (screen: string) => (APP_URL ? APP_URL + '/' : './') + '#' + screen;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (!PUB || !PRIV) return json({ error: 'Push is not configured: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.' }, 501);
  const body = await req.json().catch(() => ({}));
  // The service (evaluate-alerts) or a signed-in user; the bare public key is refused.
  const service = await isService(req);
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: u } = service || !token || token.startsWith('sb_') ? { data: null } : await db.auth.getUser(token);
  if (!service && !u?.user) return json({ error: 'Sign in first.' }, 401);

  if (body?.test) {
    if (!u?.user) return json({ error: 'Sign in first.' }, 401);
    const { data: subs } = await db.from('chatak_push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', u.user.id);
    if (!subs?.length) return json({ error: 'This account has no device switched on for push.' }, 404);
    const ok = await deliver(subs, { title: 'Chatak notifications are on', body: 'This is how a price alert will look.', url: openUrl('alerts'), tag: 'chatak-test' });
    return json({ devices: subs.length, delivered: ok });
  }

  // Claim first: one UPDATE stamps every pending event and returns them, so a
  // second call running at the same moment gets none of these.
  const since = new Date(Date.now() - 48 * 3600000).toISOString();
  const { data: events, error } = await db.from('chatak_alert_events')
    .update({ pushed_at: new Date().toISOString() })
    .is('pushed_at', null).gte('sent_at', since)
    .select('id, user_id, title, body, payload, channels');
  if (error) return json({ error: error.message }, 500);
  if (!events?.length) return json({ pending: 0, delivered: 0 });

  const users = [...new Set(events.map((e) => e.user_id))];
  const [{ data: profs }, { data: subs }] = await Promise.all([
    db.from('chatak_profiles').select('id, notify_push').in('id', users),
    db.from('chatak_push_subscriptions').select('id, user_id, endpoint, p256dh, auth').in('user_id', users)
  ]);
  const pushOff = new Set((profs ?? []).filter((p) => p.notify_push === false).map((p) => p.id));

  let delivered = 0;
  for (const e of events) {
    // A price you typed yourself goes to your inbox, not your pocket.
    if (e.payload?.self || pushOff.has(e.user_id)) continue;
    const mine = (subs ?? []).filter((s) => s.user_id === e.user_id);
    if (!mine.length) continue;
    const ok = await deliver(mine, { title: e.title, body: e.body, url: openUrl(e.payload?.screen ?? 'alerts'), tag: 'chatak-' + e.id });
    if (ok) {
      delivered++;
      await db.from('chatak_alert_events').update({ channels: [...new Set([...(e.channels ?? []), 'push'])] }).eq('id', e.id);
    }
  }
  return json({ pending: events.length, delivered });
});
