// Run: node --test tests/js/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../js/chatak-compare.js');

const S = C.sample();
const table = S.categories.find((c) => c.name === 'Folding bed table');
const view = (opts) => C.compareCategory(table, S.fields, S.options, S.prices, opts);
const byId = (rows, id) => rows.find((r) => r.id === id);

test('prices are compared tax-included, rounded down like the tag', () => {
  assert.equal(C.inclOf({ price: 1639, tax_basis: 'excl', tax_rate: 10 }), 1802);
  assert.equal(C.inclOf({ price: 1419, tax_basis: 'excl', tax_rate: 10 }), 1560);
  assert.equal(C.inclOf({ price: 3168, tax_basis: 'incl', tax_rate: 10 }), 3168);
  assert.equal(C.inclOf({ price: 216, tax_basis: 'excl', tax_rate: 8 }), 233);
});

test('the shelf price leads; the member price sits beside it', () => {
  const r = byId(view().rows, 'o-myspace');
  assert.equal(r.lead.price_incl, 1802);
  assert.equal(r.lead.price_kind, 'shelf');
  assert.equal(r.member.price_incl, 1560);
  assert.equal(r.member.member_program, 'majica');
});

test('sorted by price: cheapest first, on one tax basis', () => {
  assert.deepEqual(view().rows.map((r) => r.lead.price_incl), [1802, 2490, 2950, 2999, 3168, 3799]);
  assert.deepEqual(view({ dir: 'desc' }).rows.map((r) => r.id)[0], 'o-yamazen');
});

test('sort by a field puts options without a value last', () => {
  const ids = view({ sort: 'width', dir: 'desc' }).rows.map((r) => r.id);
  assert.deepEqual(ids.slice(0, 3), ['o-vecelo', 'o-eternal', 'o-mism']);
  assert.deepEqual(ids.slice(3).sort(), ['o-fuhai', 'o-myspace', 'o-yamazen']);
});

test('best in column only where a direction is set and values differ', () => {
  const v = view();
  assert.deepEqual([...v.best.width], ['o-vecelo']);       // 70 vs 60, 60
  assert.deepEqual([...v.best.depth], ['o-vecelo']);       // 48 vs 45, 40
  assert.equal(v.best.height, undefined);                  // better = none
  assert.equal(v.best.load, undefined);                    // only Yamazen has a value
});

test('ties share the tint; identical values get none', () => {
  const f = [{ key: 'w', kind: 'number', better: 'higher' }, { key: 's', kind: 'bool', better: 'higher' }];
  const rows = [{ id: 'a', specs: { w: 70, s: true } }, { id: 'b', specs: { w: 70, s: true } }, { id: 'c', specs: { w: 60, s: true } }];
  const b = C.bestInColumn(f, rows);
  assert.deepEqual([...b.w].sort(), ['a', 'b']);
  assert.equal(b.s, undefined);
});

test('pay more, get what: against the cheapest, differences only', () => {
  const v = view();
  assert.equal(v.pay.base.id, 'o-myspace');
  const mism = v.pay.lines['o-mism'];
  assert.equal(mism.text, '+¥1,366 vs MY space table');   // 3,168 − 1,802, both incl
  assert.deepEqual(mism.diffs, []);                       // MY space has no specs recorded
  assert.ok(mism.note);
  const fields = [{ key: 'width', label: 'Width', kind: 'number', unit: 'cm' }, { key: 'slot', label: 'Tablet slot', kind: 'bool' },
    { key: 'mat', label: 'Top', kind: 'choice' }];
  const rows = [{ id: 'a', name: 'A', lead: { price_incl: 1000 }, specs: { width: 60, slot: false, mat: 'MDF' } },
    { id: 'b', name: 'B', lead: { price_incl: 1500 }, specs: { width: 70, slot: true, mat: 'Bamboo' } }];
  const p = C.payMore(fields, rows);
  assert.equal(p.lines.b.text, '+¥500 vs A');
  assert.deepEqual(p.lines.b.diffs, ['Width +10 cm', 'Tablet slot (has it)', 'Top: Bamboo instead of MDF']);
});

test('filters: price cap, source, must-have, minimum', () => {
  assert.equal(view({ filters: { maxPrice: 3000 } }).rows.length, 4);
  assert.deepEqual(view({ filters: { source: 'shop' } }).rows.map((r) => r.id), ['o-myspace', 'o-mism']);
  assert.equal(view({ filters: { mustHave: ['tablet_slot'] } }).rows.length, 0);
  assert.deepEqual(view({ filters: { min: { width: 65 } } }).rows.map((r) => r.id), ['o-vecelo']);
  assert.equal(view({ filters: { maxPrice: 3000 } }).hidden, 2);
});

test('the latest sighting per shop is the current price', () => {
  const cur = C.currentPrices([
    { id: 1, shop_name: 'Donki', price_kind: 'shelf', price: 1800, tax_basis: 'incl', seen_on: '2026-09-01' },
    { id: 2, shop_name: 'Donki', price_kind: 'shelf', price: 1700, tax_basis: 'incl', seen_on: '2026-10-01' },
    { id: 3, shop_name: 'Nitori', price_kind: 'shelf', price: 1750, tax_basis: 'incl', seen_on: '2026-08-01' }]);
  assert.deepEqual(cur.map((p) => p.price).sort(), [1700, 1750]);
});

test('per-unit price only when every option shares the unit', () => {
  const rows = [{ id: 'a', lead: { price_incl: 300 }, pack_qty: 500, pack_unit: 'g' }, { id: 'b', lead: { price_incl: 500 }, pack_qty: 1, pack_unit: 'kg' }];
  assert.equal(C.perUnit(rows).mixed, true);
  const same = C.perUnit([{ id: 'a', lead: { price_incl: 300 }, pack_qty: 500, pack_unit: 'g' }, { id: 'b', lead: { price_incl: 450 }, pack_qty: 1000, pack_unit: 'g' }]);
  assert.equal(same.unit, '100 g');
  assert.equal(same.values.a, 60);
  assert.equal(same.values.b, 45);
  assert.equal(C.perUnit(view().rows).unit, null);   // tables are 1 pc: no per-unit line
});

test('labels become keys the database accepts', () => {
  assert.equal(C.keyOf('Load capacity'), 'load_capacity');
  assert.equal(C.keyOf('10 speeds'), 'f_10_speeds');
  assert.match(C.keyOf('Width (cm)'), /^[a-z][a-z0-9_]{0,39}$/);
  assert.equal(C.keyOf('  '), '');
});

test('sample keys match the live starter fields', () => {
  const keys = S.fields.filter((f) => f.category_id === 'c-table').map((f) => f.key);
  assert.deepEqual(keys, ['width', 'depth', 'height', 'weight', 'load', 'material', 'adjustable', 'tablet_slot', 'cup_holder']);
  assert.equal(S.fields.length, 22);
});

test('model numbers are found in option names, for shop searches', () => {
  assert.equal(C.modelCodeOf('MC-AA01-HA cover, grey'), 'MC-AA01-HA');
  assert.equal(C.modelCodeOf('Sanwa SKB-BT25BK (US layout)'), 'SKB-BT25BK');
  assert.equal(C.modelCodeOf('Logicool MX Keys Mini for Mac KX700 (US)'), 'KX700');
  assert.equal(C.modelCodeOf('MC-AA01 (any colour)'), 'MC-AA01');
  assert.equal(C.modelCodeOf('Galaxy Tab S11 128GB'), null, 'S11 is too short; 128GB starts with a digit');
  assert.equal(C.modelCodeOf('ProCase folio 9.7"'), null);
  assert.equal(C.modelCodeOf('MY space table'), null);
  assert.equal(C.modelCodeOf('Bed table 70x48x30'), null, 'dimensions are not a model number');
  assert.equal(C.modelCodeOf('Yamazen FMT5535OK'), 'FMT5535OK');
});

test('a pasted link gives the store, and an Amazon name when the link has one', () => {
  const a = C.linkInfo('https://www.amazon.co.jp/SAIJI-%E3%83%99%E3%83%83%E3%83%89%E3%83%87%E3%82%B9%E3%82%AF-adjustable/dp/B0ABCDEF12/ref=sr_1_3?keywords=x');
  assert.deepEqual(a, { store_id: 2, name: 'SAIJI ベッドデスク adjustable', asin: 'B0ABCDEF12' });
  assert.deepEqual(C.linkInfo('https://www.amazon.co.jp/dp/B0ABCDEF12'), { store_id: 2, name: null, asin: 'B0ABCDEF12' });
  assert.deepEqual(C.linkInfo('https://amzn.asia/d/abc123'), { store_id: 2, name: null, asin: null });
  assert.equal(C.linkInfo('https://item.rakuten.co.jp/hanamaruryohin/20260831140721_240/').store_id, 1);
  assert.equal(C.linkInfo('https://store.shopping.yahoo.co.jp/shop/item.html').store_id, 5);
  assert.deepEqual(C.linkInfo('not a link'), { store_id: null, name: null, asin: null });
});
