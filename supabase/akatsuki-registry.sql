-- Chatak's entries in the Akatsuki hub registry (shared project, other apps'
-- rows untouched). Safe to re-run: adds what is missing, removes nothing.
--
-- Compare phase 4, "Send to wishlist": Chatak publishes purchase_request to
-- Cost, the same kind and payload as Sukkiri and WF, and reads Cost's
-- purchase_reply on the same row (hub.replies).
--   payload { id, items: [{ name, yen, category }], totalYen, currency,
--             category, source: 'chatak', preferred_shop, note, requestedAt }
--   key     chatak:<id> — published once per request; a resend mints a new id.

update public.akatsuki_apps
   set emits   = (select array_agg(distinct x) from unnest(coalesce(emits, '{}') || array['purchase_request']) x),
       accepts = (select array_agg(distinct x) from unnest(coalesce(accepts, '{}') || array['purchase_reply']) x),
       updated_at = now()
 where id = 'chatak'
   and not (coalesce(emits, '{}') @> array['purchase_request'] and coalesce(accepts, '{}') @> array['purchase_reply']);

insert into public.akatsuki_routes (user_id, from_app, to_app, kind, access, state, note)
select r.user_id, 'chatak', 'cost', 'purchase_request', 'stream', 'live',
       'Chatak Compare "Send to wishlist" (phase 4). Same kind and payload as Sukkiri/WF; key chatak:<id>, once per request. Cost inbox reads all senders.'
  from public.akatsuki_routes r
 where r.from_app = 'wf' and r.to_app = 'cost' and r.kind = 'purchase_request'
   and not exists (select 1 from public.akatsuki_routes x where x.user_id = r.user_id and x.from_app = 'chatak' and x.to_app = 'cost' and x.kind = 'purchase_request');

insert into public.akatsuki_routes (user_id, from_app, to_app, kind, access, state, note)
select r.user_id, 'cost', 'chatak', 'purchase_reply', 'stream', 'live',
       'Rides the chatak purchase_request row: Cost purchaseResolved(row, …) → akatsuki_reply by src_addr {id}. Chatak reads hub.replies(''purchase_request'') on load.'
  from public.akatsuki_routes r
 where r.from_app = 'cost' and r.to_app = 'wf' and r.kind = 'purchase_reply'
   and not exists (select 1 from public.akatsuki_routes x where x.user_id = r.user_id and x.from_app = 'cost' and x.to_app = 'chatak' and x.kind = 'purchase_reply');
