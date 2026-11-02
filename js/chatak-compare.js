// chatak-compare.js — Compare's reasoning, no UI.
//
// Pure functions over plain rows shaped like the chatak_cmp_* tables, so the
// same code runs on the sample set and on live data, and in Node for tests.
// Nothing here scores or ranks options overall: it aligns facts, marks the
// best value per field only where the person said which direction is better,
// and states differences without adjectives.
//
// Classic script: registers window.ChatakCompare. In Node: module.exports.

(function (root) {
  'use strict';

  const yen = (n) => '¥' + Math.round(n).toLocaleString('en-US');
  // Matches the database's generated price_incl: tax added, rounded down.
  const inclOf = (p) => (p.tax_basis === 'incl' ? p.price : Math.floor(p.price * (100 + Number(p.tax_rate || 10)) / 100));
  const shopKey = (p) => (p.store_id != null ? 'store:' + p.store_id : p.cost_shop_id != null ? 'cost:' + p.cost_shop_id : 'name:' + (p.shop_name || ''));
  const has = (v) => v !== undefined && v !== null && v !== '';

  // The latest price per (shop, kind): older sightings are history, not offers.
  function currentPrices(prices) {
    const latest = new Map();
    for (const p of prices) {
      const k = shopKey(p) + '|' + p.price_kind;
      const prev = latest.get(k);
      if (!prev || p.seen_on > prev.seen_on || (p.seen_on === prev.seen_on && (p.id || 0) > (prev.id || 0))) latest.set(k, p);
    }
    return [...latest.values()].map((p) => ({ ...p, price_incl: p.price_incl != null ? p.price_incl : inclOf(p) }));
  }

  // lead = cheapest current price anyone can pay (shelf, sale, online);
  // member = cheapest member price, shown beside it, never instead of it.
  function priceSummary(prices) {
    const cur = currentPrices(prices);
    const pick = (list) => list.reduce((a, b) => (!a || b.price_incl < a.price_incl ? b : a), null);
    return {
      lead: pick(cur.filter((p) => p.price_kind !== 'member')),
      member: pick(cur.filter((p) => p.price_kind === 'member')),
      shops: new Set(cur.map(shopKey)).size,
      current: cur
    };
  }

  // Per-field winners. Only fields with a stated direction, only when at
  // least two options have a value and they are not all the same.
  function bestInColumn(fields, rows) {
    const out = {};
    for (const f of fields) {
      if (f.better === 'none' || !f.better) continue;
      const vals = rows.map((r) => ({ id: r.id, v: r.specs ? r.specs[f.key] : undefined })).filter((x) => has(x.v));
      if (vals.length < 2) continue;
      const nums = vals.map((x) => (f.kind === 'bool' ? (x.v ? 1 : 0) : Number(x.v)));
      if (nums.every((n) => n === nums[0])) continue;
      const target = f.better === 'higher' ? Math.max(...nums) : Math.min(...nums);
      out[f.key] = new Set(vals.filter((_, i) => nums[i] === target).map((x) => x.id));
    }
    return out;
  }

  const fmtVal = (f, v) => {
    if (!has(v)) return '—';
    if (f.kind === 'bool') return v ? 'Yes' : 'No';
    if (f.kind === 'number') return (Number.isInteger(Number(v)) ? String(v) : Number(v).toFixed(1)) + (f.unit ? ' ' + f.unit : '');
    return String(v);
  };

  // "Pay more, get what": each option against the cheapest one. Lists the
  // fields where both have a value and they differ; says nothing about which
  // is better. Options without a price are left out (nothing to pay more for).
  function payMore(fields, rows) {
    const priced = rows.filter((r) => r.lead);
    if (priced.length < 2) return { base: null, lines: {} };
    const base = priced.reduce((a, b) => (b.lead.price_incl < a.lead.price_incl ? b : a));
    const lines = {};
    for (const r of priced) {
      if (r.id === base.id) continue;
      const diffs = [];
      for (const f of fields) {
        const a = base.specs ? base.specs[f.key] : undefined, b = r.specs ? r.specs[f.key] : undefined;
        if (!has(a) || !has(b) || a === b) continue;
        if (f.kind === 'number') {
          const d = Number(b) - Number(a);
          diffs.push(f.label + ' ' + (d > 0 ? '+' : '−') + fmtVal({ kind: 'number', unit: f.unit }, Math.abs(d)));
        } else if (f.kind === 'bool') {
          diffs.push(f.label + (b ? ' (has it)' : ' (does not have it)'));
        } else {
          diffs.push(f.label + ': ' + b + ' instead of ' + a);
        }
      }
      const delta = r.lead.price_incl - base.lead.price_incl;
      lines[r.id] = {
        delta,
        text: (delta >= 0 ? '+' : '−') + yen(Math.abs(delta)) + ' vs ' + base.name,
        diffs,
        note: diffs.length ? null : 'Only the price differs so far: no spec is recorded for both.'
      };
    }
    return { base, lines };
  }

  // ¥ per 100 g / 100 ml / 1 m etc. Only when every compared option shares
  // the unit; otherwise null, and the view says "different units".
  const PER = { g: [100, 'g'], kg: [1, 'kg'], ml: [100, 'ml'], L: [1, 'L'], cm: [100, 'cm'], m: [1, 'm'], sheet: [1, 'sheet'], roll: [1, 'roll'] };
  function perUnit(rows) {
    const units = new Set(rows.filter((r) => r.lead).map((r) => r.pack_unit));
    if (units.size !== 1) return { unit: null, mixed: units.size > 1, values: {} };
    const u = [...units][0], per = PER[u];
    if (!per) return { unit: null, mixed: false, values: {} };
    const values = {};
    for (const r of rows) if (r.lead) values[r.id] = r.lead.price_incl / Number(r.pack_qty) * per[0];
    return { unit: per[0] + ' ' + per[1], mixed: false, values };
  }

  // sort: 'price' or a field key; values missing always sink to the bottom.
  function sortRows(rows, fields, key, dir) {
    const f = fields.find((x) => x.key === key);
    const val = (r) => (key === 'price' ? (r.lead ? r.lead.price_incl : null)
      : f && f.kind === 'bool' ? (r.specs && has(r.specs[key]) ? (r.specs[key] ? 1 : 0) : null)
      : f && f.kind === 'number' ? (r.specs && has(r.specs[key]) ? Number(r.specs[key]) : null)
      : r.specs && has(r.specs[key]) ? String(r.specs[key]).toLowerCase() : null);
    const s = dir === 'desc' ? -1 : 1;
    return rows.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === null && y === null) return a.name.localeCompare(b.name);
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * s || a.name.localeCompare(b.name);
    });
  }

  // filters: { maxPrice, statuses:[...], source:'all'|'shop'|'online', mustHave:[boolKeys], min:{key:n} }
  function filterRows(rows, filters) {
    const F = filters || {};
    return rows.filter((r) => {
      if (F.maxPrice > 0 && (!r.lead || r.lead.price_incl > F.maxPrice)) return false;
      if (F.statuses && F.statuses.length && !F.statuses.includes(r.status)) return false;
      if (F.source && F.source !== 'all' && r.source_kind !== F.source) return false;
      for (const k of F.mustHave || []) if (!(r.specs && r.specs[k] === true)) return false;
      for (const [k, n] of Object.entries(F.min || {})) {
        if (!(n > 0)) continue;
        if (!(r.specs && has(r.specs[k]) && Number(r.specs[k]) >= n)) return false;
      }
      return true;
    });
  }

  // Everything the comparison screen needs for one category, in one call.
  function compareCategory(cat, fields, options, prices, opts) {
    const o = opts || {};
    const myFields = fields.filter((f) => f.category_id === cat.id).sort((a, b) => a.sort_order - b.sort_order);
    const rows = options.filter((x) => x.category_id === cat.id).map((x) => {
      const ps = priceSummary(prices.filter((p) => p.option_id === x.id));
      return { ...x, lead: ps.lead, member: ps.member, shopCount: ps.shops, current: ps.current };
    });
    const shown = sortRows(filterRows(rows, o.filters), myFields, o.sort || 'price', o.dir || 'asc');
    return {
      fields: myFields, all: rows, rows: shown,
      best: bestInColumn(myFields, shown),
      pay: payMore(myFields, shown),
      per: perUnit(shown),
      hidden: rows.length - shown.length
    };
  }

  // Turn a typed label into a field key the database accepts.
  const keyOf = (label) => {
    const k = String(label || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return /^[a-z]/.test(k) ? k : k ? 'f_' + k.slice(0, 38) : '';
  };

  // ── sample set: the six folding tables from the brief, as given ──
  // Unknown specs stay empty; nothing is invented to fill the grid.
  function sample() {
    const fields = (cat, list) => list.map((f, i) => ({ id: cat + ':' + f[0], category_id: cat, key: f[0], label: f[1], kind: f[2], unit: f[3] || null, better: f[4] || 'none', choices: f[5] || null, sort_order: i }));
    const categories = [
      { id: 'c-table', name: 'Folding bed table', tax_rate: 10, sort_order: 0 },
      { id: 'c-slicer', name: 'Slicer', tax_rate: 10, sort_order: 1 },
      { id: 'c-blender', name: 'Blender', tax_rate: 10, sort_order: 2 }
    ];
    const F = [].concat(
      fields('c-table', [['width', 'Width', 'number', 'cm', 'higher'], ['depth', 'Depth', 'number', 'cm', 'higher'], ['height', 'Height', 'number', 'cm'],
        ['weight', 'Weight', 'number', 'kg', 'lower'], ['load', 'Load capacity', 'number', 'kg', 'higher'],
        ['material', 'Top material', 'choice', null, 'none', ['Wood', 'MDF', 'Bamboo', 'Plastic', 'Metal']],
        ['adjustable', 'Adjustable height', 'bool', null, 'higher'], ['tablet_slot', 'Tablet slot', 'bool', null, 'higher'], ['cup_holder', 'Cup holder', 'bool', null, 'higher']]),
      fields('c-slicer', [['type', 'Type', 'choice', null, 'none', ['Mandoline', 'Rotary', 'Electric']], ['blades', 'Blades included', 'number', null, 'higher'],
        ['thickness', 'Thickness settings', 'number', null, 'higher'], ['hand_guard', 'Hand guard', 'bool', null, 'higher'], ['dishwasher', 'Dishwasher safe', 'bool', null, 'higher'], ['weight', 'Weight', 'number', 'g', 'lower']]),
      fields('c-blender', [['power', 'Power', 'number', 'W', 'higher'], ['jar', 'Jar capacity', 'number', 'L', 'higher'], ['speeds', 'Speeds', 'number', null, 'higher'],
        ['ice', 'Crushes ice', 'bool', null, 'higher'], ['noise', 'Noise', 'number', 'dB', 'lower'], ['weight', 'Weight', 'number', 'kg', 'lower'], ['warranty', 'Warranty', 'number', 'years', 'higher']])
    );
    const amazon = (q) => 'https://www.amazon.co.jp/s?k=' + encodeURIComponent(q);
    const unverified = 'Price from a review article, not verified.';
    const options = [
      { id: 'o-myspace', category_id: 'c-table', name: 'MY space table', brand: 'Donki', source_kind: 'shop', shop_name: 'Donki', pack_qty: 1, pack_unit: 'pc', specs: {}, status: 'considering', notes: 'Size is not in the sample; check the shelf photo.' },
      { id: 'o-mism', category_id: 'c-table', name: 'MISM folding table', brand: 'MISM', model_code: 'CTY-6045NA', source_kind: 'shop', shop_name: 'Shop not recorded', pack_qty: 1, pack_unit: 'pc', size_label: '60x45 cm', specs: { width: 60, depth: 45 }, status: 'considering', notes: 'Tax basis not recorded in the sample; treated as tax included.' },
      { id: 'o-fuhai', category_id: 'c-table', name: 'Lap desk', brand: 'FUHAI', source_kind: 'online', store_id: 2, url: amazon('FUHAI lap desk'), pack_qty: 1, pack_unit: 'pc', specs: {}, status: 'considering', notes: unverified },
      { id: 'o-eternal', category_id: 'c-table', name: 'Bed table 60x40x28', brand: 'Eternal Wings', source_kind: 'online', store_id: 2, url: amazon('Eternal Wings bed table'), pack_qty: 1, pack_unit: 'pc', size_label: '60x40x28 cm', specs: { width: 60, depth: 40, height: 28 }, status: 'considering', notes: unverified },
      { id: 'o-vecelo', category_id: 'c-table', name: 'Bed table 70x48x30', brand: 'VECELO', source_kind: 'online', store_id: 2, url: amazon('VECELO bed table'), pack_qty: 1, pack_unit: 'pc', size_label: '70x48x30 cm', specs: { width: 70, depth: 48, height: 30 }, status: 'considering', notes: unverified },
      { id: 'o-yamazen', category_id: 'c-table', name: 'Folding mini table', brand: 'Yamazen', model_code: 'FMT5535OK', source_kind: 'online', store_id: 2, url: amazon('Yamazen FMT5535OK'), pack_qty: 1, pack_unit: 'pc', specs: { load: 5 }, status: 'considering', notes: unverified }
    ];
    let id = 0;
    const P = (option_id, price, basis, kind, extra) => ({ id: ++id, option_id, price, tax_basis: basis, tax_rate: 10, price_kind: kind, seen_on: '2026-10-24', ...extra });
    const prices = [
      P('o-myspace', 1639, 'excl', 'shelf', { shop_name: 'Donki' }),
      P('o-myspace', 1419, 'excl', 'member', { shop_name: 'Donki', member_program: 'majica' }),
      P('o-mism', 3168, 'incl', 'shelf', { shop_name: 'Shop not recorded' }),
      P('o-fuhai', 2490, 'incl', 'online', { store_id: 2 }),
      P('o-eternal', 2950, 'incl', 'online', { store_id: 2 }),
      P('o-vecelo', 2999, 'incl', 'online', { store_id: 2 }),
      P('o-yamazen', 3799, 'incl', 'online', { store_id: 2 })
    ];
    return { categories, fields: F, options, prices, photos: [] };
  }

  // A maker's model number in a name: "MC-AA01-HA cover, grey" → "MC-AA01-HA",
  // "Sanwa SKB-BT25BK (US layout)" → "SKB-BT25BK". Starts with a letter, has a
  // digit, at least 4 characters; the longest wins. null when there is none.
  // Shop searches match every word, so this is what finds a listing.
  function modelCodeOf(text) {
    const hits = String(text || '').match(/[A-Za-z][A-Za-z0-9]*(?:[-‐][A-Za-z0-9]+)*/g) || [];
    const codes = hits.filter((t) => /\d/.test(t) && t.replace(/[-‐]/g, '').length >= 4 && !/^[xX\d.]+$/.test(t));  // not "x48x30"
    return codes.sort((a, b) => b.length - a.length)[0] || null;
  }

  const api = { modelCodeOf, yen, inclOf, currentPrices, priceSummary, bestInColumn, payMore, perUnit, sortRows, filterRows, compareCategory, fmtVal, keyOf, sample };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatakCompare = api;
})(typeof window !== 'undefined' ? window : globalThis);
