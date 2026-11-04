// chatak-import.js — reads a price spreadsheet into Compare rows. No UI, no I/O.
//
// Input is the sheet as an array of rows (arrays of cells), as SheetJS gives
// it with { header: 1 }. Columns are found by their header text, so the shelf
// sheet (shop, category, product EN/JP, brand, price incl/excl, tax basis,
// size/unit, notes, photo, flag) and the online shopping list (Category,
// Item, Shop, Low, High, Notes, Status) both read without setup.
//
// Nothing is guessed silently: a row whose tax basis cannot be told from the
// sheet or the shop's tag convention is marked, and the review screen asks.
//
// Classic script: registers window.ChatakImport. In Node: module.exports.

(function (root) {
  'use strict';

  // Header text → field. First match wins; tested against a lower-cased,
  // space-collapsed header. Order matters: "price excl" before "price".
  const COLUMNS = [
    ['photo', /photo|image|写真|file ?name/],
    ['flag', /^flag$|check|確認/],
    ['category', /categor|カテゴリ|分類|^type$/],
    ['name_ja', /(product|item|name).*(jp|ja|japanese|和)|商品名|品名|日本語/],
    ['name', /(product|item|name)|^en$|英語/],
    ['brand', /brand|maker|メーカー|ブランド/],
    ['shop', /shop|store|seller|店/],
    ['price_excl', /excl|税抜|without tax|pre-?tax/],
    ['price_high', /high|max|上限|最高/],
    ['price_incl', /incl|税込|with tax|^low|^price|^min|価格|値段|円|¥/],
    ['tax_basis', /tax ?basis|^tax$|税区分|税/],
    ['unit', /^unit$|単位/],
    ['size', /size|容量|サイズ|qty|quantity|pack|入数/],
    ['notes', /note|memo|comment|備考|メモ/],
    ['status', /status|状態/],
    ['date', /date|seen|日付/]
  ];

  const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const lc = (v) => norm(v).toLowerCase();

  function mapHeader(row) {
    const map = {};
    row.forEach((cell, i) => {
      const h = lc(cell);
      if (!h) return;
      const hit = COLUMNS.find(([field, re]) => map[field] === undefined && re.test(h));
      if (hit) map[hit[0]] = i;
    });
    return map;
  }

  // The header is the first row, among the first ten, that names an item
  // column and a price or shop column.
  function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const m = mapHeader(rows[i] || []);
      if (m.name !== undefined && (m.price_incl !== undefined || m.price_excl !== undefined || m.shop !== undefined)) return { index: i, map: m };
    }
    return null;
  }

  function yenOf(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) && v > 0 ? Math.round(v) : null;
    const s = String(v).replace(/[,，\s¥￥円]/g, '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
    const m = /^(\d+(?:\.\d+)?)/.exec(s);
    const n = m ? Math.round(Number(m[1])) : NaN;
    return n > 0 ? n : null;
  }

  // Tag conventions, as on the shelf: Donki and Daiso print tax-excluded,
  // Nitori tax-included. Online shops show tax-included prices.
  function shopBasis(shop) {
    const n = lc(shop);
    if (/donki|don quijote|don kihote|ドン|キホーテ|daiso|ダイソー/.test(n)) return 'excl';
    if (/nitori|ニトリ/.test(n)) return 'incl';
    if (/amazon|rakuten|楽天|yahoo/.test(n)) return 'incl';
    return null;
  }

  // Food and drink take the reduced 8% rate; everything else 10%. Read from the
  // category name, so "Vegetables" or "Fresh fish" need no fixing in the
  // review. Things used with food (tea utensils, a coffee maker, pet food) are
  // not food for tax and stay at 10%. The review can still change either way.
  const FOOD = /food|drink|beverage|grocer|snack|sweets?\b|dessert|confection|candy|chocolate|biscuit|bread|bakery|\brice\b|noodle|pasta|flour|cereal|vegetable|\bveg\b|fruit|produce|\bfish(?!ing)|seafood|\bmeat|poultry|chicken|pork|beef|dairy|\bmilk|cheese|yog(h)?urt|\beggs?\b|tofu|spice|seasoning|sauce|condiment|\boils?\b|olive|canned|frozen|juice|\bwater\b|\btea\b|coffee|soup|curry|飲|食|菓子|調味|野菜|果物|魚|肉|乳|卵|米|麺|パン|冷凍|惣菜/i;
  const NOT_FOOD = /utensil|maker|machine|teapot|kettle|\bmugs?\b|appliance|tools?\b|cooker|juicer|grinder|ladle|whisk|drinkware|glassware|water bottle|\bpets?\b|dog food|cat food|essential oil|fragrance|diffuser|cleaning|detergent|食器|器具|ポット/i;
  const isFood = (category) => FOOD.test(String(category || '')) && !NOT_FOOD.test(String(category || ''));

  // How a shop rounds tax on its tax-included tag. Donki rounds half up
  // (898 → 988, 699 → 769, 1999 → 2199 on its tags); any other shop is
  // taken to round down, the common rule, until a tag shows otherwise.
  function shopRounding(shop) {
    return /donki|don quijote|don kihote|ドン|キホーテ/.test(lc(shop)) ? 'half_up' : 'down';
  }

  function basisWord(v) {
    const n = lc(v);
    if (!n) return null;
    if (/excl|税抜|without|pre/.test(n)) return 'excl';
    if (/incl|税込|with/.test(n)) return 'incl';
    return null;
  }

  // Where it is bought. Online: a known store (id as chatak_stores), or a
  // seller by name. Anything else is a shop you walk into.
  const STORES = [[/amazon/, 2, 'Amazon JP'], [/rakuten|楽天/, 1, 'Rakuten'], [/yahoo/, 5, 'Yahoo Shopping']];
  function sourceOf(shop) {
    const raw = norm(shop), n = raw.toLowerCase();
    for (const [re, id, name] of STORES) if (re.test(n)) {
      const also = raw.split(/\s*[\/／,、]\s*/).filter((x) => x && !re.test(x.toLowerCase()));
      return { source_kind: 'online', store_id: id, shop_name: null, label: name, also: also.length ? also.join(', ') : null };
    }
    if (!raw || /^(tbc|tbd|\?|-|—|未定)$/i.test(raw)) return { source_kind: 'online', store_id: null, shop_name: 'Seller not decided', label: 'Seller not decided', also: null, undecided: true };
    if (/^various$|^multiple$|^any$|色々|各店/i.test(raw)) return { source_kind: 'online', store_id: null, shop_name: 'Various sellers', label: 'Various sellers', also: null };
    if (/mall|official|online|公式|\.com|\.jp|通販|ec ?site|web/i.test(raw)) return { source_kind: 'online', store_id: null, shop_name: raw, label: raw, also: null };
    return { source_kind: 'shop', store_id: null, shop_name: raw, label: raw, also: null };
  }

  const UNITS = { pc: 'pc', pcs: 'pc', piece: 'pc', pieces: 'pc', '個': 'pc', '本': 'pc', '枚': 'sheet', sheet: 'sheet', sheets: 'sheet', set: 'set', sets: 'set', 'セット': 'set',
    pair: 'pair', pairs: 'pair', '足': 'pair', roll: 'roll', rolls: 'roll', '巻': 'roll', '個入': 'pc', '枚入': 'sheet', '本入': 'pc',
    g: 'g', gram: 'g', grams: 'g', kg: 'kg', ml: 'ml', mL: 'ml', l: 'L', L: 'L', cm: 'cm', m: 'm' };

  // "500ml", "1.5 L", "12枚入", "3 pcs" → { qty, unit }. Dimensions ("60x45 cm")
  // are a size label, not a pack size: one piece.
  function packOf(size, unit) {
    const s = norm(size), u = norm(unit);
    if (/\d\s*[x×*]\s*\d/i.test(s)) return { qty: 1, unit: 'pc', label: s + (u && !s.includes(u) ? ' ' + u : ''), assumed: false };
    // A range ("10-30kg", "S〜L") describes the product, not how many are in the pack.
    if (/\d\s*[-–~〜]\s*\d/.test(s)) return { qty: 1, unit: 'pc', label: s, assumed: false };
    const text = (s + (u && !/[a-zA-Z個枚本入]/.test(s) ? ' ' + u : '')).trim();
    const m = /(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+|個入|枚入|本入|個|枚|本|巻|足|セット)?/.exec(text);
    if (m) {
      const qty = Number(m[1].replace(',', '.'));
      const key = m[2] || (u || '');
      const unitKey = UNITS[key] || UNITS[key.toLowerCase()] || UNITS[(u || '').toLowerCase()];
      if (qty > 0 && unitKey) return { qty, unit: unitKey, label: s || null, assumed: false };
      if (qty > 0 && !key) return { qty, unit: 'pc', label: s || null, assumed: false };
    }
    return { qty: 1, unit: 'pc', label: s || null, assumed: true };
  }

  // A stable key for re-imports: the same row in the same or a renamed file
  // maps to the same option, so nothing is added twice.
  function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  const optionKey = (r) => 'xlsx:' + hash([lc(r.category), lc(r.name), lc(r.shopLabel)].join('|'));

  // Photo names carry the day: IMG20261024192355.jpg → 2026-10-24.
  function dayFromPhoto(name) {
    const m = /(20\d\d)[-_]?([01]\d)[-_]?([0-3]\d)/.exec(String(name || ''));
    return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
  }
  function dayOf(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
    if (typeof v === 'number' && v > 30000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);  // Excel serial
    const m = /(20\d\d)[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(String(v));
    return m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : null;
  }

  // Rows → { rows, categories, skipped, columns }. today = 'YYYY-MM-DD'.
  function parse(sheetRows, opts) {
    const o = Object.assign({ today: new Date().toISOString().slice(0, 10) }, opts || {});
    const head = findHeader(sheetRows || []);
    if (!head) return { error: 'No header row found. The first rows must name the columns, for example Shop, Product, Price.', rows: [], categories: [], skipped: [] };
    const M = head.map, cell = (r, f) => (M[f] === undefined ? null : r[M[f]]);
    const rows = [], skipped = [];
    let category = null;
    for (let i = head.index + 1; i < sheetRows.length; i++) {
      const r = sheetRows[i] || [], line = i + 1;
      if (!r.some((c) => norm(c))) continue;
      if (norm(cell(r, 'category'))) category = norm(cell(r, 'category'));
      const name = norm(cell(r, 'name')), nameJa = norm(cell(r, 'name_ja'));
      const shopRaw = norm(cell(r, 'shop'));
      const incl = yenOf(cell(r, 'price_incl')), excl = yenOf(cell(r, 'price_excl')), high = yenOf(cell(r, 'price_high'));
      if (!name && !nameJa) { skipped.push({ line, why: 'No product name' }); continue; }
      // Totals and footnotes: a name with no shop, and either no price or a sum.
      if (M.shop !== undefined && !shopRaw && (incl == null && excl == null || /total|合計|minimum|setup|sum/i.test(name) || name.length > 90)) {
        skipped.push({ line, why: incl != null ? 'A total, not an item' : 'A note, not an item', text: name.slice(0, 90) });
        continue;
      }
      const src = sourceOf(shopRaw);
      const issues = [];
      let price = null, basis = null;
      const stated = basisWord(cell(r, 'tax_basis'));
      if (stated === 'excl' && excl != null) { price = excl; basis = 'excl'; }
      else if (stated === 'incl' && incl != null) { price = incl; basis = 'incl'; }
      else if (M.price_excl !== undefined && M.price_incl !== undefined) {
        // Both columns: the tag's own number, by the shop's convention when known.
        const conv = stated || shopBasis(shopRaw);
        if (conv === 'excl' && excl != null) { price = excl; basis = 'excl'; }
        else if (incl != null) { price = incl; basis = 'incl'; }
        else if (excl != null) { price = excl; basis = 'excl'; }
      } else if (incl != null) {
        price = incl;
        basis = stated || (M.tax_basis === undefined && /incl|税込|low|min/.test(lc(sheetRows[head.index][M.price_incl])) ? 'incl' : null) || shopBasis(shopRaw) || (src.source_kind === 'online' ? 'incl' : null);
      } else if (excl != null) { price = excl; basis = 'excl'; }
      if (price != null && !basis) issues.push('tax');
      const pack = packOf(cell(r, 'size'), cell(r, 'unit'));
      const flag = lc(cell(r, 'flag'));
      const photo = norm(cell(r, 'photo')) || null;
      const notesParts = [norm(cell(r, 'notes'))];
      if (src.also) notesParts.push('Also sold by ' + src.also + '.');
      const row = {
        line, include: true, category: category || 'Imported', name: name || nameJa, name_ja: name && nameJa ? nameJa : null,
        brand: norm(cell(r, 'brand')) || null, shopRaw, shopLabel: src.label, source_kind: src.source_kind, store_id: src.store_id, shop_name: src.shop_name,
        price, price_high: high != null && price != null && high > price ? high : null, tax_basis: basis,
        pack_qty: pack.qty, pack_unit: pack.unit, size_label: pack.label, pack_assumed: pack.assumed,
        notes: notesParts.filter(Boolean).join(' ') || null, photo, photo_check: /check|確認|要/.test(flag),
        seen_on: dayOf(cell(r, 'date')) || dayFromPhoto(photo) || o.today, issues
      };
      row.import_key = optionKey(row);
      rows.push(row);
    }
    // One option per key: a repeated row in the sheet is the same item at another price.
    const seen = new Map();
    for (const r of rows) { if (seen.has(r.import_key)) r.duplicateOf = seen.get(r.import_key).line; else seen.set(r.import_key, r); }
    const cats = [];
    for (const r of rows) {
      let c = cats.find((x) => x.name === r.category);
      if (!c) cats.push(c = { name: r.category, count: 0, online: 0 });
      c.count++; if (r.source_kind === 'online') c.online++;
    }
    return { rows, categories: cats, skipped, columns: Object.keys(M) };
  }

  // Price key: one per option, price, basis, kind and day — re-importing the
  // same sheet adds nothing, a new price on a new day is a new row.
  const priceKey = (r) => r.import_key + ':' + r.price + r.tax_basis + ':' + r.seen_on;

  // What a price includes tax at, rounded as the shop rounds (see ChatakCompare.withTax).
  const inclOf = (price, basis, rate, rounding) => {
    if (basis === 'incl') return price;
    const n = Math.round(price * (100 + (rate || 10)));
    return rounding === 'half_up' ? Math.floor((n + 50) / 100) : rounding === 'up' ? Math.ceil(n / 100) : Math.floor(n / 100);
  };

  const api = { parse, mapHeader, findHeader, yenOf, sourceOf, packOf, shopBasis, shopRounding, isFood, dayFromPhoto, dayOf, priceKey, inclOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatakImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
