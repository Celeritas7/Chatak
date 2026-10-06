// chatak-engine.js — all price reasoning, no UI.
//
// Everything in here is pure: given price series it produces the verdict, the
// confidence score and the narrative the screens display. The same analyse()
// runs on generated fixtures and on real Supabase rows, so a demo product and
// a product added a minute ago are described by identical code.
//
// Loaded as a classic script; registers window.ChatakEngine.
// create(yen) binds the currency formatter and returns the engine.

(function () {
  'use strict';

  const TODAY = new Date(2026, 8, 19);
  const D = 365;

  // ── the sample dataset ───────────────────────────────────────────────────
  // Only reachable when no Supabase credentials are configured.

  const STORES = [
    // live: a collector exists (functions/_shared/rakuten.ts + the Yahoo adapter).
    // Planned stores still draw on the chart to show the comparison, but they
    // never define "best price" and are labelled as planned wherever they appear.
    { name: 'Rakuten', color: '#B4413A', f: 1.005, live: true },
    { name: 'Yahoo Shopping', color: '#5A8F52', f: 1.012, live: true },
    { name: 'Amazon JP', color: '#C98A17', f: 0.988, live: false },
    { name: 'Yodobashi', color: '#3E7BB6', f: 0.978, live: false },
    { name: 'Bic Camera', color: '#8B5FA8', f: 0.996, live: false }
  ];

  const USED_STORE = { name: 'Mercari (used)', color: '#6F6A62', f: 0.80, used: true, live: false };

  const EVENT_DEFS = [
    { label: 'Late-November sales', store: 'Amazon JP', from: '2025-11-28', to: '2025-12-01', depth: 0.10, fake: false },
    { label: 'Rakuten Super Sale', store: 'Rakuten', from: '2025-12-04', to: '2025-12-11', depth: 0.02, fake: true },
    { label: 'New Year', store: 'Yodobashi', from: '2026-01-01', to: '2026-01-05', depth: 0.07, fake: false },
    { label: 'Rakuten Super Sale', store: 'Rakuten', from: '2026-03-04', to: '2026-03-11', depth: 0.06, fake: false },
    { label: 'Golden Week', store: 'All', from: '2026-04-29', to: '2026-05-06', depth: 0.04, fake: false },
    { label: 'Mid-July sale week', store: 'Amazon JP', from: '2026-07-14', to: '2026-07-16', depth: 0.12, fake: false },
    { label: 'Rakuten Super Sale', store: 'Rakuten', from: '2026-09-04', to: '2026-09-11', depth: 0.02, fake: true }
  ];

  // Published sale calendar, not our own record — labelled as such in the copy.
  const UPCOMING_DEFS = [
    { on: '2026-11-27', label: 'Late-November sales', dates: '27–30 Nov', drop: -0.12, bad: false },
    { on: '2026-12-04', label: 'Rakuten Super Sale', dates: '4–11 Dec', drop: -0.02, bad: true },
    { on: '2026-12-26', label: 'Year-end clearance', dates: '26–31 Dec', drop: -0.06, bad: false },
    { on: '2027-01-01', label: 'New Year sale', dates: '1–5 Jan', drop: -0.07, bad: false },
    { on: '2027-03-04', label: 'Rakuten Super Sale', dates: '4–11 Mar', drop: -0.06, bad: false },
    { on: '2027-04-29', label: 'Golden Week', dates: '29 Apr–6 May', drop: -0.04, bad: false },
    { on: '2027-06-04', label: 'Rakuten Super Sale', dates: '4–11 Jun', drop: -0.05, bad: false },
    { on: '2027-07-14', label: 'Mid-July sale week', dates: '14–16 Jul', drop: -0.12, bad: false }
  ];

  const PRODUCT_DEFS = [
    // inflatesRef: this shop games its reference price before fake events. Only
    // this fixture does; the other four must stay clean or the flag is meaningless.
    // tail: where today's price should land relative to the median (or the low).
    { id: 'seiko', name: 'Seiko Prospex Alpinist SPB507J1', short: 'Seiko Alpinist SPB507J1', sub: '"ClassicPine" green dial · 39.5mm · 6R55 automatic', shot: 'product shot — watch on strap, 1:1', msrp: 143000, base: 111500, seed: 1171, inflatesRef: true, tail: { mode: 'delta', v: 0.041 } },
    { id: 'orient', name: 'Orient Star Contemporary RE-AV0B02Y00B', short: 'Orient Star RE-AV0B02Y00B', sub: 'Semi-skeleton · 41mm · 70-hour power reserve', shot: 'product shot — watch, 1:1', msrp: 88000, base: 66900, seed: 2213, tail: { mode: 'belowLow', v: 0.008 } },
    { id: 'citizen', name: 'Citizen Attesa AT8181-63E', short: 'Citizen Attesa AT8181-63E', sub: 'Eco-Drive radio-controlled · titanium', shot: 'product shot — watch, 1:1', msrp: 110000, base: 82000, seed: 3319, tail: { mode: 'delta', v: 0.016 } },
    { id: 'gshock', name: 'Casio G-Shock GMW-B5000D-1JF', short: 'G-Shock GMW-B5000D', sub: 'Full metal square · Bluetooth · solar', shot: 'product shot — watch, 1:1', msrp: 88000, base: 69400, seed: 4423, tail: { mode: 'delta', v: -0.031 } },
    { id: 'sony', name: 'Sony WH-1000XM6', short: 'Sony WH-1000XM6', sub: 'Wireless noise-cancelling headphones', shot: 'product shot — headphones, 1:1', msrp: 59400, base: 47300, seed: 5531, tail: { mode: 'delta', v: -0.021 } }
  ];

  // ── helpers ─────────────────────────────────────────────────────────────

  const median90 = (arr) => {
    const s = arr.slice(-90).slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const pct = (v) => (Math.round(Math.abs(v) * 1000) / 10) + '%';
  const monthsText = (days) => {
    const m = Math.max(1, Math.round(days / 30.4));
    return days < 45 ? days + ' days' : m + (m === 1 ? ' month' : ' months');
  };
  const inflated = (msrp) => Math.round((msrp * 1.175) / 1000) * 1000;
  const rnd = (seed) => { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); };

  // Confidence is evidence strength, not a vibe: how many days we have actually
  // recorded, how many live stores quote it, and whether the signal is a hard
  // fact (record low, inflated reference) or a soft one (drift near median).
  const deriveConfidence = (q) => {
    const dayScore = Math.min(q.historyDays / 180, 1);
    const storeScore = Math.min(q.series.filter((s) => s.live).length / 2, 1);
    const hardSignal = (q.flagIdx >= 0 || q.current <= q.minBefore) ? 0.2 : 0;
    const spread = Math.min(Math.abs(q.delta) / 0.06, 1) * 0.15;
    // Ceiling by breadth: a median drawn from two shops cannot earn 95%, however
    // long the record. Three or more collected stores lifts the cap.
    const liveN = q.series.filter((s) => s.live).length;
    const breadthCap = liveN >= 4 ? 0.95 : liveN >= 3 ? 0.88 : 0.78;
    // …and by length: a hard signal on three days of record is still three days.
    const lengthCap = 0.2 + q.historyDays / 60;
    return Math.max(0.12, Math.min(breadthCap, lengthCap, 0.35 * dayScore + 0.3 * storeScore + hardSignal + spread));
  };

  const deriveVerdict = (q) => {
    if (q.historyDays < 14) return 'watch';
    if (q.flagIdx >= 0 && q.delta > -0.02) return 'wait';
    if (q.current <= q.minBefore || q.delta <= -0.05) return 'buy';
    if (q.delta > 0.02) return 'wait';
    return 'watch';
  };

  // ── engine ──────────────────────────────────────────────────────────────

  function create(yen) {
    const today = TODAY;
    const start = new Date(today.getTime() - (D - 1) * 86400000);
    const idx = (s) => Math.round((new Date(s + 'T00:00:00') - start) / 86400000);
    const dateAt = (i) => new Date(start.getTime() + i * 86400000);

    const events = EVENT_DEFS.map((e) => ({
      label: e.label, store: e.store, depth: e.depth, fake: e.fake,
      i0: idx(e.from), i1: idx(e.to)
    }));

    const upcoming = UPCOMING_DEFS.map((e) => ({
      ...e, daysAway: Math.round((new Date(e.on + 'T00:00:00') - today) / 86400000)
    }));

    // A product added today has a UUID and no editorial, so this generator is
    // the real path — there are no hand-written exceptions for the fixtures.
    const deriveCopy = (q) => {
      const recordLow = q.current <= q.minBefore;
      const thin = q.historyDays < 14;
      const liveN = q.series.filter((s) => s.live).length;
      const next = upcoming.filter((e) => !e.bad).sort((a, b) => a.daysAway - b.daysAway)[0];
      const deepestAhead = upcoming.filter((e) => !e.bad).slice().sort((a, b) => a.drop - b.drop)[0];
      // The year low: its store, its date, and the event it fell inside (if any).
      const qD = q.historyDays;
      const qDay = (i) => q.dateAt(i).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const lowEvent = q.events.find((e) => q.lowIdx >= e.i0 && q.lowIdx <= e.i1);
      const lowWhen = qDay(q.lowIdx) + (lowEvent ? ', during ' + lowEvent.label : '');
      const lowLine = 'The lowest we have recorded is ' + yen(q.low) + ' at ' + q.lowStore + ' (' + lowWhen + ').';

      let headline, reason, shortReason;
      if (thin) {
        headline = 'Watch — too early to call';
        reason = 'We have ' + q.historyDays + (q.historyDays === 1 ? ' day' : ' days') + ' of recorded prices for this item, which is not enough for a median. ' +
          q.bestStore + ' quotes ' + yen(q.current) + ' today. We will not tell you whether that is good until we have watched it for about two weeks.';
        shortReason = 'Tracking just started — no median yet.';
      } else if (q.flagIdx >= 0 && q.delta > -0.02) {
        headline = 'Wait — this sale is not a discount';
        reason = q.flagStore + ' raised its reference price from ' + yen(q.msrp) + ' to ' + yen(q.flagRef) +
          ', then advertised ' + q.flagAdvPct + '% off against that higher figure. What you would actually pay there, ' +
          yen(q.flagPrice) + ', is ' + q.flagPct + '% ' + (q.flagDelta >= 0 ? 'above' : 'below') +
          ' the ' + q.medianLabel + ' of ' + yen(q.median) + '.';
        shortReason = 'Reference price inflated ' + Math.round(((q.flagRef - q.msrp) / q.msrp) * 100) + '% before the sale.';
      } else if (recordLow) {
        headline = 'Buy — this is the lowest price on record';
        reason = q.bestStore + ' is at ' + yen(q.current) + ', ' + (Math.abs(q.delta) < 0.0005 ? 'on' : pct(q.delta) + ' under') + ' the ' + q.medianLabel + ' of ' +
          yen(q.median) + ' and at or below the previous low of ' + yen(q.minBefore) + ' across ' + monthsText(q.historyDays) + ' of our record.' +
          (q.flagIdx < 0 ? ' No reference-price games: the ' + yen(q.msrp) + ' list price has held.' : '');
        shortReason = 'A record low in ' + monthsText(q.historyDays) + ' of tracking.';
      } else if (q.delta <= -0.05) {
        headline = 'Buy — the discount is real';
        reason = q.bestStore + ' is ' + pct(q.delta) + ' under the ' + q.medianLabel + ' of ' + yen(q.median) +
          ', measured against its own recorded reference price rather than the sticker. ' + lowLine;
        shortReason = 'An honest ' + pct(q.delta) + ' off the median.';
      } else if (q.delta > 0.02) {
        headline = 'Wait — you would pay above the norm';
        reason = 'At ' + yen(q.current) + ', ' + q.bestStore + ' is ' + pct(q.delta) + ' above the ' + q.medianLabel + ' of ' +
          yen(q.median) + '. Nothing is inflated, but nothing is discounted either. ' + lowLine;
        shortReason = pct(q.delta) + ' above its own median.';
      } else {
        // This branch catches everything from -5% to +2%, so it must not claim
        // "within 2%" for a price that is 3% under. An app about false
        // percentages does not get to print one.
        const near = Math.abs(q.delta) <= 0.02;
        headline = near ? 'Watch — fair, but not a deal yet' : 'Watch — a real dip, but a shallow one';
        reason = near
          ? 'At ' + yen(q.current) + ' you are within 2% of the ' + q.medianLabel + ' of ' + yen(q.median) + '. ' + lowLine
          : 'At ' + yen(q.current) + ', ' + q.bestStore + ' is ' + pct(q.delta) + ' under the ' + q.medianLabel + ' of ' +
            yen(q.median) + ' — genuine, but shallow enough that an ordinary sale week should beat it. ' + lowLine;
        shortReason = near
          ? 'Sitting on its median. The record low is ' + pct((q.low - q.median) / q.median) + ' under it.'
          : pct(q.delta) + ' under the median — shallow for this item.';
      }
      if (liveN < 2) reason += ' Only ' + liveN + ' store is collected for this item, so the median is narrower than we would like.';

      const timeline = [{ when: 'Now · ' + qDay(qD - 1), label: thin ? 'Tracking started' : recordLow ? 'Record low' : 'Current', note: yen(q.current) + ' at ' + q.bestStore }];
      if (next) timeline.push({
        when: 'In ' + next.daysAway + ' days · ' + next.dates,
        label: next.label,
        note: 'Estimated ' + Math.round(next.drop * 100) + '% — from published sale history, not our own record'
      });
      if (deepestAhead && deepestAhead.label !== next.label) timeline.push({
        when: 'In ' + deepestAhead.daysAway + ' days · ' + deepestAhead.dates,
        label: deepestAhead.label,
        note: 'The deepest event ahead: estimated ' + Math.round(deepestAhead.drop * 100) + '%'
      });
      // Skip when the low IS today — the "Now" row already says it.
      if (!thin && q.lowIdx < qD - 3) timeline.push({
        when: 'Past · ' + qDay(q.lowIdx),
        label: lowEvent ? lowEvent.label : 'Record low',
        note: yen(q.low) + ' at ' + q.lowStore + ' — the lowest in our record'
      });

      return { headline, reason, shortReason, timeline };
    };

    // Everything after the raw series exist. Shared by the fixture generator and
    // by the live adapter, so a real product and a demo product are described
    // by exactly the same code.
    const analyse = (dd, series, used, refs, days, startDate) => {
      const n = days;
      const pStart = startDate || start;
      const pDateAt = (i) => new Date(pStart.getTime() + i * 86400000);
      // Fixture events are indexed on the fixture calendar; translate to this product's.
      const shift = Math.round((pStart - start) / 86400000);
      const pEvents = events.map((e) => ({ ...e, i0: e.i0 - shift, i1: e.i1 - shift })).filter((e) => e.i1 >= 0 && e.i0 <= n - 1);
      const liveSeries = series.filter((s) => s.live);
      const bestOf = () => { const b = []; for (let i = 0; i < n; i++) b.push(Math.min(...liveSeries.map((s) => s.values[i]))); return b; };
      const best = bestOf();
      // "Previous low" = every recorded day except today. (The fixture
      // generator's tuning window is its own business and must not leak in here.)
      const minBefore = n > 1 ? Math.min(...best.slice(0, n - 1)) : best[0];
      const median = median90(best);
      const cur = best[n - 1];
      const bestStore = liveSeries.reduce((a, b) => (b.values[n - 1] < a.values[n - 1] ? b : a));
      const pIdx = (s) => Math.round((new Date(s + 'T00:00:00') - pStart) / 86400000);
      const julyFrom = Math.max(0, pIdx('2026-07-14')), julyTo = Math.min(n - 1, pIdx('2026-07-16'));
      const julySlice = julyTo >= julyFrom ? best.slice(julyFrom, julyTo + 1) : [];
      const primeLow = julySlice.length ? Math.min(...julySlice) : null;
      const primeLowStore = julySlice.length ? liveSeries.reduce((a, b) =>
        Math.min(...b.values.slice(julyFrom, julyTo + 1)) < Math.min(...a.values.slice(julyFrom, julyTo + 1)) ? b : a
      ).name : null;
      let flagIdx = -1;
      for (let i = n - 1; i >= 0; i--) if (refs[i] > dd.msrp) { flagIdx = i; break; }
      if (flagIdx >= 0) while (flagIdx > 0 && refs[flagIdx - 1] > dd.msrp) flagIdx--;
      const flagEvent = flagIdx >= 0
        ? pEvents.filter((e) => e.fake && e.i1 >= flagIdx).sort((a, b) => a.i0 - b.i0)[0] || null
        : null;
      const prod = {
        ...dd, series, used, best, refs, median, minBefore, primeLow, primeLowStore,
        dateAt: pDateAt, events: pEvents,
        historyDays: n,
        // median90() takes the last 90 recorded days — on a 20-day record that is a
        // 20-day median. Never print "90-day" for a record that cannot support it.
        medianLabel: n >= 90 ? '90-day median' : n + '-day median',
        flagIdx, flagRef: flagIdx >= 0 ? refs[flagIdx] : null, flagEvent,
        flagStore: flagIdx >= 0 ? (dd.refStore || 'Rakuten') : null,
        current: cur, low: Math.min(...best), high: Math.max(...best),
        lowIdx: best.indexOf(Math.min(...best)),
        lowStore: liveSeries.reduce((a, b) => Math.min(...b.values) < Math.min(...a.values) ? b : a).name,
        bestStore: bestStore.name,
        delta: median ? (cur - median) / median : 0
      };
      if (prod.flagStore) {
        const fs = series.find((s) => s.name === prod.flagStore) || liveSeries[0];
        prod.flagPrice = fs.values[n - 1];
        prod.flagDelta = median ? (prod.flagPrice - median) / median : 0;
        prod.flagPct = Math.abs(prod.flagDelta * 100).toFixed(1);
        prod.flagAdvPct = Math.round((1 - prod.flagPrice / prod.flagRef) * 100);
      }
      prod.verdict = deriveVerdict(prod);
      prod.copy = { ...deriveCopy(prod), confidence: deriveConfidence(prod) };
      return prod;
    };

    const gen = (seed, base, f, storeName) => {
      const r = rnd(seed), out = [];
      let p = base * f;
      for (let i = 0; i < D; i++) {
        p += (base * f - p) * 0.03 + (r() - 0.5) * base * 0.007;
        let v = p;
        for (const e of events) {
          if (i >= e.i0 && i <= e.i1) {
            const m = (e.store === storeName || e.store === 'All') ? 1 : 0.35;
            v = p * (1 - e.depth * m);
          }
        }
        out.push(Math.round(v / 100) * 100);
      }
      return out;
    };

    // Generate series, tune the tail so each fixture demonstrates a distinct
    // verdict, derive the reference line, then analyse like any other product.
    const buildFixtures = () => {
      const products = PRODUCT_DEFS.map((dd) => {
        const series = STORES.map((s, k) => ({ name: s.name, color: s.color, live: s.live, values: gen(dd.seed + k * 97, dd.base, s.f, s.name) }));
        const used = { name: USED_STORE.name, color: USED_STORE.color, used: true, values: gen(dd.seed + 701, dd.base, USED_STORE.f, 'Mercari') };
        const liveSeries = series.filter((s) => s.live);
        const bestOf = () => { const b = []; for (let i = 0; i < D; i++) b.push(Math.min(...liveSeries.map((s) => s.values[i]))); return b; };
        let best = bestOf();
        const ramp = 18;
        const minBefore = Math.min(...best.slice(0, D - ramp));
        for (let pass = 0; pass < 5; pass++) {
          const med = median90(best);
          const want = dd.tail.mode === 'belowLow' ? minBefore * (1 - dd.tail.v) : med * (1 + dd.tail.v);
          const f = want / best[D - 1];
          if (Math.abs(f - 1) < 0.0004) break;
          for (const s of liveSeries) {
            for (let k = 0; k < ramp; k++) {
              const i = D - ramp + k, w = (k + 1) / ramp;
              s.values[i] = Math.round((s.values[i] * (1 + (f - 1) * w)) / 100) * 100;
            }
          }
          best = bestOf();
        }
        const refs = [];
        for (let i = 0; i < D; i++) {
          let r = dd.msrp;
          if (dd.inflatesRef) {
            for (const e of events) if (e.fake && i >= e.i0 - 8 && i <= e.i1 + 2) r = inflated(dd.msrp);
          }
          refs.push(r);
        }
        return analyse({ ...dd, refStore: dd.inflatesRef ? 'Rakuten' : null }, series, used, refs, D);
      });
      return { D, products, stores: STORES, events, upcoming, dateAt, idx, live: false };
    };

    // Raw rows produced by the Supabase adapter → the same product shape.
    // storeRows are the real chatak_stores rows. A store counts as collected once
    // it has actually quoted one of these products — the fixture list of six shops
    // has nothing to do with the user's project.
    const buildLive = (raw, storeRows) => {
      const products = raw.map((lp) => analyse(lp.dd, lp.series, lp.used, lp.refs, lp.D, lp.startDate));
      const collected = new Set(products.flatMap((q) => q.series.filter((s) => s.live).map((s) => s.name)));
      let stores = (storeRows || []).map((s) => ({ name: s.name, color: s.color || '#6F6A62', live: collected.has(s.name) }));
      if (!stores.length) stores = [...collected].map((nm) => ({ name: nm, color: '#6F6A62', live: true }));
      return { D, products, stores, events, upcoming, dateAt, idx, live: true };
    };

    return { D, today, start, dateAt, idx, events, upcoming, stores: STORES, analyse, buildFixtures, buildLive };
  }

  window.ChatakEngine = { create, TODAY, D, STORES, USED_STORE, PRODUCT_DEFS, median90, deriveVerdict, deriveConfidence };
})();
