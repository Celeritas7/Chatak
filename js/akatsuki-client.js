/* akatsuki-client.js — the whole contract an app implements.
 *
 *   const hub = Akatsuki(supabase, 'travel');
 *   await hub.publish({ to: 'cal', kind: 'trip.segment', addr: { trip_id, segment_id }, payload, clock: updated_at });
 *   await hub.consume({ 'trip.segment': async (r) => { const id = upsertEvent(r.payload); return { addr: { event_id: id } }; } });
 *
 * Two functions. Everything hard lives in the hub.
 * localStorage-first: publishes queue in an outbox when offline and flush on
 * reconnect, so the app never requires the cloud (ecosystem rule).
 * Load as a classic script; exposes window.Akatsuki.
 *
 * R017: errors carry error.code (AK1xx contract · AK2xx outcome · AK3xx client).
 * publish → { seq, status: pending|skipped|closed|queued, code, delivery, reply }.
 *   queued = will retry (AK301 offline · AK302 transient, retry:true).  Anything the hub REFUSED throws:
 *   e.contract (AK1xx — fix the call) or e.refused (auth/RLS — sign in, then publish again).  Never treat queued as sent.
 * A consume handler may return { defer: 'reason' } — the row stays pending, retried with back-off.
 * Works against pre-R017 SQL too (old messages still match; defer needs R017).
 * Sep 26: doc() merges a path held by two owners (calapp_sukkiri.cycles) instead of
 * keeping only the last; returns rows for per-owner reads. keys() lists my live rows.
 * R026 (data-loss review): flush() no longer overwrites publishes queued while it runs, runs
 * one at a time, and keeps refused rows (they succeed after sign-in). A handler that THROWS now
 * defers (retried) instead of rejecting for good; return { reject: 'reason' } to reject.
 */
(function () {
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  const stable = (o) => JSON.stringify(o, o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).sort() : undefined);
  const isContract = (e) => /^AK1\d\d$/.test(e.code || '') || /unknown kind|does not declare|no route|missing required/.test(e.message || '');
  // R022 (WF v98 ask): refusals a retry can't fix — not signed in, RLS, expired JWT.  Thrown, never queued.
  const isRefused = (e) => /^(42501|PGRST301|PGRST302|401|403)$/.test(String(e.code || '')) || /permission denied|JWT|not authenticated|row-level security/i.test(e.message || '');

  function Akatsuki(supabase, app, opts = {}) {
    if (!supabase || !app) throw new Error('Akatsuki(supabase, appId) — both required');
    const OUTBOX = 'akatsuki_outbox_' + app;
    const readBox = () => { try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch { return []; } };
    const writeBox = (rows) => localStorage.setItem(OUTBOX, JSON.stringify(rows));
    const log = opts.log || (() => {});
    let flushing = null;

    async function rpc(fn, args) {
      const { data, error } = await supabase.rpc(fn, args);
      if (error) throw Object.assign(new Error(error.message), { code: error.code, hint: error.hint, fn, contract: isContract(error) });
      return data;
    }

    const hub = {
      app,

      /** Publish one change. Idempotent: same addr + same payload = same key = one row. */
      async publish({ to, kind, addr, payload, clock, key }) {
        const p = { from_app: app, to_app: to, kind, src_addr: addr, src_clock: clock == null ? null : String(clock), payload,
                    idempotency_key: key || `${app}:${hash(stable(addr))}:${hash(stable(payload))}` };
        if (!navigator.onLine) { writeBox([...readBox(), p]); log('queued', p.idempotency_key); return { status: 'queued', code: 'AK301' }; }
        try {
          const rows = await rpc('akatsuki_publish', { p });
          const r = Array.isArray(rows) ? rows[0] : rows;
          log(r.status, r.seq); return r;
        } catch (e) {
          if (isContract(e)) { log('contract', e.code, e.message); throw Object.assign(e, { code: e.code || 'AK100', contract: true }); }   // hub refused the call (kind, route, payload): fix it, never queue
          if (isRefused(e)) { log('refused', e.code, e.message); throw Object.assign(e, { code: e.code || 'AK303', refused: true }); }   // hub said no: sign in, then re-publish
          writeBox([...readBox(), p]); log('queued after error', e.message); return { status: 'queued', code: 'AK302', error: e.message, retry: true };
        }
      },

      /** Flush the offline outbox. Called automatically on 'online'. */
      flush() {
        if (flushing) return flushing;
        flushing = (async () => {
          const box = readBox(); if (!box.length) return 0;
          const gone = new Set();   // sent, or refused for good (contract) — everything else stays
          for (const p of box) {
            try { await rpc('akatsuki_publish', { p }); gone.add(p.idempotency_key); }
            catch (e) {
              if (isContract(e)) { gone.add(p.idempotency_key); console.warn('[ak] dropped (contract)', e.code, e.message); }
              else if (isRefused(e)) { log('flush refused — kept until sign-in', e.code); break; }
            }
          }
          writeBox(readBox().filter(p => !gone.has(p.idempotency_key)));   // re-read: keeps rows queued during the flush
          return gone.size;
        })().finally(() => { flushing = null; });
        return flushing;
      },

      /** Read everything addressed to me past my cursor and hand each row to a handler by kind.
       *  Handler may return { addr } (the id it created, to record the pair) and/or { reply }. */
      async consume(handlers, limit = 100) {
        const rows = await rpc('akatsuki_consume', { p_app: app, p_limit: limit });
        let n = 0;
        for (const r of rows || []) {
          const h = handlers[r.kind];
          if (!h) { await hub.ack(r.seq, { status: 'skipped' }); continue; }
          let res;
          try { res = (await h(r)) || {}; }
          catch (e) { res = { defer: 'handler error: ' + (e && e.message || e) }; log('handler threw — deferred', r.seq, e && e.message); }
          if (res.reject) { await hub.ack(r.seq, { status: 'rejected' }); log('rejected', r.seq, res.reject); continue; }
          if (res.defer) {   // row stays pending; a failed defer call must not reject it
            try { await rpc('akatsuki_defer', { p_app: app, p_seq: r.seq, p_reason: String(res.defer) }); log('deferred', r.seq, res.defer); }
            catch (e) { log('defer failed (pre-R017?)', r.seq, e.message); }
            continue;
          }
          await hub.ack(r.seq, { addr: res.addr, reply: res.reply }); n++;
        }
        return n;
      },

      async ack(seq, { addr, reply, status = 'delivered' } = {}) {
        return rpc('akatsuki_ack', { p_app: app, p_seq: seq, p_b_addr: addr ?? null, p_reply: reply ?? null, p_status: status });
      },

      /** Reply later by the origin's address (R010) — e.g. WF tick: hub.reply('cost','request.created',{id},{status:'done',at}). */
      async reply(fromApp, kind, addr, reply) {
        return rpc('akatsuki_reply', { p_app: app, p_from_app: fromApp, p_kind: kind, p_src_addr: addr, p_reply: reply });
      },

      /** The origin's thing is gone or parked. Keep the link, mark it. */
      async orphan(addr) { return rpc('akatsuki_orphan', { p_a_app: app, p_a_addr: addr }); },

      /** Request / reply — read replies to things I published.
       *  Pages on reply_seq (R010), not seq: a late reply or an un-tick moves reply_seq only.
       *  Keep the max reply_seq you've seen and pass it back as sinceSeq. */
      async replies(kind, sinceSeq = 0) {
        // R017: same shape as consume. Needs R017 on the hub.
        return (await rpc('akatsuki_replies', { p_app: app, p_kind: kind || null, p_since: sinceSeq || 0 })) || [];
      },

      /** Document pattern — write only paths this app owns. The trigger rejects anything else. */
      async put(doc, path, itemKey, value) {
        const row = { doc, path, item_key: itemKey ?? '', owner_app: app, updated_by: app, value, deleted_at: null };
        const { error } = await supabase.from('akatsuki_state').upsert(row, { onConflict: 'user_id,doc,path,item_key' });
        if (error) throw new Error(error.message);
      },
      async remove(doc, path, itemKey) {
        const { error } = await supabase.from('akatsuki_state').update({ deleted_at: new Date().toISOString(), updated_by: app }).match({ doc, path, item_key: itemKey ?? '' });
        if (error) throw new Error(error.message);
      },
      /* ── Places (R023).  The hub owns the list; every app reads it and writes only through these. ── */
      /** Live places, in display order: [{ id, label, class, aliases, ord, lat, lng, radius_m }] */
      async places({ withRetired = false } = {}) {
        let q = supabase.from('akatsuki_places').select('id,label,class,aliases,ord,lat,lng,radius_m,retired_at,seq').order('ord').order('label');
        if (!withRetired) q = q.is('retired_at', null);
        const { data, error } = await q;
        if (error) throw Object.assign(new Error(error.message), { code: error.code });
        return data;
      },
      /** Find by id, label or alias (any spelling: 'Shin-Ōkubo', 'shin-okubo', '@home'). */
      matchPlace(list, word) {
        if (!word) return null;
        const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const w = slug(word);
        return list.find(p => p.id === word) || list.find(p => p.id === w || slug(p.label) === w || (p.aliases || []).some(a => slug(a) === w)) || null;
      },
      /** Add (or get the existing one).  → { id, label, class, status: 'created' | 'exists' } */
      async addPlace(label, cls = 'out') { const r = await rpc('akatsuki_place_add', { p_label: label, p_class: cls, p_app: app }); return r && r[0]; },
      /** Edit label / class / ord / aliases.  The id never changes. */
      editPlace(id, patch) { return rpc('akatsuki_place_edit', { p_id: id, p: patch, p_app: app }); },
      /** Retire (never deleted; old tasks still resolve). */
      retirePlace(id) { return rpc('akatsuki_place_retire', { p_id: id, p_app: app }); },

      /* ── Location (R018 · R033).  Read-only.  Visits only, never coordinates (the waist). ── */
      /** Where the user is now, newest first: [{ device, since, last_seen_at, place_id, place_label, anchor_label, class }].
       *  Empty when nothing is recording — that means "unknown", not "away". */
      async whereNow() {
        const { data, error } = await supabase.from('akatsuki_where_now').select('*').order('last_seen_at', { ascending: false });
        if (error) throw new Error(error.message);
        return data || [];
      },
      /** Visits in the last `days` (max 30), newest first: [{ since, until, end_reason, place_id, place_label, anchor_label, class, source_app }]. until = null → still there. */
      async visits({ days = 7 } = {}) {
        const from = new Date(Date.now() - Math.min(days, 30) * 864e5).toISOString();
        const { data, error } = await supabase.from('akatsuki_visits_recent').select('*').gte('since', from).order('since', { ascending: false });
        if (error) throw new Error(error.message);
        return data || [];
      },

      /** Read a whole doc re-grouped by path: { cycles: [...], away: [...], show: true } */
      async doc(doc) {
        const { data, error } = await supabase.from('akatsuki_docs').select('path,owner_app,items,scalar,seq').eq('doc', doc);
        if (error) throw new Error(error.message);
        const out = {}, owners = {};
        for (const r of data) {
          const v = r.items ?? r.scalar;
          if (owners[r.path] && Array.isArray(out[r.path]) && Array.isArray(v)) {
            out[r.path] = out[r.path].concat(v); owners[r.path] += ',' + r.owner_app;
          } else { out[r.path] = v; owners[r.path] = r.owner_app; }
        }
        return { value: out, owners, rows: data };
      },
      /** Live item keys this app owns in a doc, as 'path/item_key' — seeds a diff cache. */
      async keys(doc) {
        const { data, error } = await supabase.from('akatsuki_state').select('path,item_key')
          .match({ doc, owner_app: app }).is('deleted_at', null);
        if (error) throw new Error(error.message);
        return data.map(r => r.path + '/' + r.item_key);
      },

      /** Cached source data (one fetch, many consumers). */
      async cached(source, key) {
        const { data } = await supabase.from('akatsuki_cache').select('payload,fetched_at,expires_at').match({ source, key }).maybeSingle();
        return data && (!data.expires_at || new Date(data.expires_at) > new Date()) ? data.payload : null;
      },

      /** Poll helper: consume on an interval, on focus, and on reconnect. Returns stop(). */
      listen(handlers, ms = 15000) {
        let t = null; const run = () => hub.consume(handlers).catch(e => log('consume failed', e.message));
        const onl = () => { hub.flush().then(run); };
        const vis = () => { if (document.visibilityState === 'visible') run(); };
        window.addEventListener('online', onl); document.addEventListener('visibilitychange', vis);
        t = setInterval(run, ms); run();
        return () => { clearInterval(t); window.removeEventListener('online', onl); document.removeEventListener('visibilitychange', vis); };
      }
    };

    window.addEventListener('online', () => hub.flush().catch(() => {}));
    return hub;
  }

  window.Akatsuki = Akatsuki;
})();
