// Run: node --test tests/js/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../../js/chatak-import.js');

// Shopping_List_Oct2026.xlsx, as SheetJS reads it (header: 1).
const LIST = [
  ['Category', 'Item', 'Shop', 'Low (¥)', 'High (¥)', 'Notes', 'Status'],
  ['iPad 6 accessories', 'ProCase folio 9.7"', 'Amazon JP', 1099, 1099, 'Recommended case', null],
  [null, 'Tablet sleeve 11" (iPad + keyboard)', 'Amazon JP', 1000, 1800, 'Need internal 300x200mm min', null],
  ['Keyboards', 'Logicool K380s / Pebble Keys 2 (JIS)', 'Amazon JP / Logicool', 4400, 4700, '3-device Easy-Switch', null],
  [null, 'Keychron K3 / K8', 'TBC', 12000, 20000, 'Physical Win/Mac switch', null],
  ['Tablet replacement', 'iPad (A16) 11"', 'Various', 74800, 74800, 'Best value', null],
  [null, 'Galaxy Tab S11 128GB', 'Amazon / Rakuten', 112000, 193000, 'Price varies wildly', null],
  ['Zojirushi bottle', 'MC-AA01-AA cover, blue', 'ANA Mall', null, null, 'Matches Airy Blue', null],
  [null, 'MC-AA01 (any colour)', 'Zojirushi official', 1210, 1210, 'List price', null],
  [null, null, null, null, null, null, null],
  [null, 'Minimum sensible buy (ProCase + grey bottle cover)', null, 2126, null, null, null],
  [null, 'Prices gathered 2026-08 to 2026-11 from Amazon JP, Kakaku, Sofmap and maker sites. Blank = no verified price found. Verify before ordering.', null, null, null, null, null]
];

// The shelf sheet, by the columns described for Shopping_Price_Comparison.xlsx.
const SHELF = [
  ['Shop', 'Category', 'Product (EN)', 'Product (JP)', 'Brand', 'Price incl. tax', 'Price excl. tax', 'Tax basis', 'Size / unit', 'Notes', 'Photo filename', 'Flag'],
  ['Donki Musashi-Urawa', 'Folding table', 'MY space table', 'マイスペーステーブル', 'Donki', 1802, 1639, 'excl', '60x40 cm', '', 'IMG20261024192355.jpg', 'OK'],
  ['Nitori Ageo', 'Folding table', 'Side table', 'サイドテーブル', 'Nitori', 2490, 2264, 'incl', '1 pc', '', 'IMG20261025101500.jpg', 'Check photo'],
  ['Daiso Omiya', 'Kitchen', 'Kitchen paper', 'キッチンペーパー', '', null, 100, '', '2 rolls', '', '', 'OK'],
  ['Gyomu Kawaguchi', 'Drinks', 'Oolong tea', 'ウーロン茶', 'Suntory', 158, null, '', '2L', '', '', ''],
  ['Corner shop', 'Drinks', 'Green tea', '緑茶', '', null, null, '', '500ml', 'price not visible', '', 'Check photo'],
  ['Mystery store', 'Drinks', 'Barley tea', '麦茶', '', 98, null, '', '600 ml', '', '', '']
];

test('the shopping list: columns found by header, category carried down', () => {
  const p = I.parse(LIST, { today: '2026-11-02' });
  assert.equal(p.error, undefined);
  assert.deepEqual(p.categories.map((c) => [c.name, c.count]), [['iPad 6 accessories', 2], ['Keyboards', 2], ['Tablet replacement', 2], ['Zojirushi bottle', 2]]);
  assert.equal(p.rows.length, 8);
  assert.equal(p.skipped.length, 2, 'the total and the footnote are skipped');
  assert.match(p.skipped[0].why, /total/i);
});

test('the shopping list: online sellers, low price tax-included, range kept', () => {
  const p = I.parse(LIST, { today: '2026-11-02' });
  const by = (n) => p.rows.find((r) => r.name.startsWith(n));
  assert.deepEqual([by('ProCase').source_kind, by('ProCase').store_id, by('ProCase').price, by('ProCase').tax_basis], ['online', 2, 1099, 'incl']);
  assert.equal(by('Tablet sleeve').price_high, 1800);
  assert.equal(by('Logicool K380s').store_id, 2);
  assert.match(by('Logicool K380s').notes, /Also sold by Logicool\./);
  assert.match(by('Galaxy').notes, /Also sold by Rakuten\./);
  assert.deepEqual([by('Keychron').store_id, by('Keychron').shop_name], [null, 'Seller not decided']);
  assert.equal(by('iPad (A16)').shop_name, 'Various sellers');
  assert.deepEqual([by('MC-AA01-AA').source_kind, by('MC-AA01-AA').shop_name, by('MC-AA01-AA').price], ['online', 'ANA Mall', null]);
  assert.equal(by('MC-AA01 (any').shop_name, 'Zojirushi official');
  assert.ok(p.rows.every((r) => r.issues.length === 0), 'nothing left to decide');
  assert.ok(p.rows.every((r) => r.seen_on === '2026-11-02'));
});

test('the shelf sheet: the tag number by the shop convention, the stated basis wins', () => {
  const p = I.parse(SHELF, { today: '2026-11-02' });
  const by = (n) => p.rows.find((r) => r.name === n);
  assert.deepEqual([by('MY space table').price, by('MY space table').tax_basis], [1639, 'excl']);
  assert.equal(I.inclOf(1639, 'excl', 10), 1802, 'matches the sheet\'s incl column');
  assert.deepEqual([by('Side table').price, by('Side table').tax_basis], [2490, 'incl']);
  assert.deepEqual([by('Kitchen paper').price, by('Kitchen paper').tax_basis], [100, 'excl']);
  assert.deepEqual([by('Oolong tea').price, by('Oolong tea').tax_basis], [158, 'incl'], 'only an incl column filled: incl');
  assert.equal(by('MY space table').name_ja, 'マイスペーステーブル');
  assert.equal(by('MY space table').source_kind, 'shop');
});

test('the shelf sheet: pack sizes, photos, flags and days', () => {
  const p = I.parse(SHELF, { today: '2026-11-02' });
  const by = (n) => p.rows.find((r) => r.name === n);
  assert.deepEqual([by('MY space table').pack_qty, by('MY space table').pack_unit, by('MY space table').size_label], [1, 'pc', '60x40 cm']);
  assert.deepEqual([by('Kitchen paper').pack_qty, by('Kitchen paper').pack_unit], [2, 'roll']);
  assert.deepEqual([by('Oolong tea').pack_qty, by('Oolong tea').pack_unit], [2, 'L']);
  assert.deepEqual([by('Barley tea').pack_qty, by('Barley tea').pack_unit], [600, 'ml']);
  assert.equal(by('MY space table').seen_on, '2026-10-24', 'day from the photo name');
  assert.equal(by('Kitchen paper').seen_on, '2026-11-02', 'no photo: today');
  assert.equal(by('Side table').photo_check, true);
  assert.equal(by('MY space table').photo_check, false);
  assert.equal(by('Green tea').price, null, 'no price: an option without a price');
});

test('an unknown shop with a bare price column asks for the tax basis', () => {
  const sheet = [['Shop', 'Item', 'Price'], ['Corner shop', 'Barley tea', 98], ['Donki', 'Cup noodle', 198]];
  const p = I.parse(sheet, { today: '2026-11-02' });
  assert.deepEqual(p.rows[0].issues, ['tax']);
  assert.equal(p.rows[0].tax_basis, null);
  assert.equal(p.rows[1].tax_basis, 'excl', 'Donki tags are tax-excluded');
});

test('import keys are stable and a repeated row is marked, not added twice', () => {
  const a = I.parse(LIST, { today: '2026-11-02' }), b = I.parse(LIST, { today: '2026-12-01' });
  assert.deepEqual(a.rows.map((r) => r.import_key), b.rows.map((r) => r.import_key));
  assert.equal(new Set(a.rows.map((r) => r.import_key)).size, a.rows.length);
  const twice = I.parse([LIST[0], LIST[1], LIST[1]], {});
  assert.equal(twice.rows[1].duplicateOf, 2);
  assert.notEqual(I.priceKey(a.rows[0]), I.priceKey(b.rows[0]), 'a price on another day is a new price');
});

test('helpers', () => {
  assert.deepEqual(I.packOf('10-30kg'), { qty: 1, unit: 'pc', label: '10-30kg', assumed: false }, 'a range is a description, not a pack');
  assert.deepEqual(I.packOf('500〜750ml'), { qty: 1, unit: 'pc', label: '500〜750ml', assumed: false });
  assert.equal(I.yenOf('¥1,639'), 1639);
  assert.equal(I.yenOf('１６３９円'), 1639);
  assert.equal(I.yenOf(''), null);
  assert.equal(I.dayOf(46319), '2026-10-24', 'Excel serial date');
  assert.equal(I.dayOf('2026/10/5'), '2026-10-05');
  assert.equal(I.parse([['a', 'b'], [1, 2]]).error.slice(0, 19), 'No header row found');
});

test('shops round tax by their own rule; import agrees with Compare', () => {
  const C = require('../../js/chatak-compare.js');
  assert.equal(I.shopRounding('Donki Musashi-Urawa'), 'half_up');
  assert.equal(I.shopRounding('ドン・キホーテ'), 'half_up');
  assert.equal(I.shopRounding('Daiso'), 'down');
  assert.equal(I.shopRounding(''), 'down');
  assert.equal(I.inclOf(898, 'excl', 10, 'half_up'), 988);
  assert.equal(I.inclOf(898, 'excl', 10), 987);
  for (const r of ['down', 'half_up', 'up']) for (let price = 1; price < 3000; price += 7) for (const rate of [8, 10]) {
    assert.equal(I.inclOf(price, 'excl', rate, r), C.inclOf({ price, tax_basis: 'excl', tax_rate: rate, tax_rounding: r }));
  }
});

test('food categories take 8%, things used with food stay at 10%', () => {
  for (const c of ['Frozen food', 'Drinks', 'Snacks', 'Vegetables', 'Fresh fish', 'Seasoning', 'Spices', 'Sweets', 'Dairy', 'Canned food', 'Rice', 'Noodles', 'Fruit', 'Meat', 'Eggs', 'Bread', 'Coffee', 'Green tea', '野菜', '冷凍食品'])
    assert.equal(I.isFood(c), true, c);
  for (const c of ['Tea utensils', 'Kitchen', 'Fishing', 'Leggings', 'Waterproof', 'Coffee maker', 'Rice cooker', 'Juicer', 'Home fragrance', 'Essential oil', 'Pet food', 'Water bottle', 'Zojirushi bottle', 'Slicer', 'Blender', 'Cleaning', 'Craft supplies'])
    assert.equal(I.isFood(c), false, c);
});
