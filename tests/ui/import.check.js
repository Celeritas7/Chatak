// Browser checks for the spreadsheet import (Compare phase 3b), on sample data.
//   npm i playwright@1.56 react@18.3.1 react-dom@18.3.1 @babel/standalone@7.29.0 xlsx@0.18.5   (once, anywhere)
//   python scripts/serve-nocache.py 8765 &      then
//   NODE_PATH=<that node_modules> node tests/ui/import.check.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const BASE = process.env.CHATAK_URL || 'http://localhost:8765/index.html';
const NM = (process.env.NODE_PATH || '').split(path.delimiter).find((p) => p && fs.existsSync(path.join(p, 'react'))) || '';
const XL = (process.env.NODE_PATH || '').split(path.delimiter).map((p) => path.join(p, 'xlsx/dist/xlsx.full.min.js')).find((p) => fs.existsSync(p));
const OUT = process.env.SHOTS || '.';
let failed = 0;
const ok = (cond, label) => { console.log((cond ? 'ok  ' : 'FAIL') + '  ' + label); if (!cond) failed++; };

// The shelf sheet's shape, with the cases that matter.
const sheet = [
  ['Shop', 'Category', 'Product (EN)', 'Product (JP)', 'Brand', 'Price incl. tax', 'Price excl. tax', 'Tax basis', 'Size / unit', 'Notes', 'Photo filename', 'Flag'],
  ['Donki Musashi-Urawa', 'Folding table', 'MY space table', 'マイスペーステーブル', 'Donki', 1802, 1639, 'excl', '60x40 cm', '', 'IMG20261024192355.jpg', 'OK'],
  ['Nitori Ageo', 'Folding table', 'Side table', 'サイドテーブル', 'Nitori', 2490, 2264, 'incl', '1 pc', '', 'IMG20261025101500.jpg', 'Check photo'],
  ['Gyomu Kawaguchi', 'Drinks', 'Oolong tea', 'ウーロン茶', 'Suntory', 158, null, '', '2L', '', '', ''],
  ['Corner shop', 'Drinks', 'Barley tea', '麦茶', '', 98, null, '', '600 ml', '', '', ''],
  ['Daiso Omiya', 'Kitchen', 'Kitchen paper', 'キッチンペーパー', '', null, 100, '', '2 rolls', '', '', 'OK'],
  [null, null, 'Total for the trip', null, null, 4548, null, null, null, null, null, null]
];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), 'Prices');
const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

(async () => {
  const b = await chromium.launch();
  const m = await b.newPage({ viewport: { width: 390, height: 844 } });
  if (NM) {
    const map = (u) => path.join(NM, u.includes('react-dom@') ? 'react-dom/umd/react-dom.production.min.js' : u.includes('react@') ? 'react/umd/react.production.min.js' : '@babel/standalone/babel.min.js');
    await m.route('https://unpkg.com/**', (r) => r.fulfill({ path: map(r.request().url()), contentType: 'application/javascript' }));
  }
  if (XL) await m.route('https://cdnjs.cloudflare.com/ajax/libs/xlsx/**', (r) => r.fulfill({ path: XL, contentType: 'application/javascript' }));
  await m.route('**/js/chatak-public-config.js', (r) => r.fulfill({ body: '', contentType: 'application/javascript' }));  // stay on sample data
  await m.route('**/js/chatak-config.js', (r) => r.fulfill({ body: "window.CHATAK_CONFIG={signedOutView:'sample'};", contentType: 'application/javascript' }));
  const errors = [];
  m.on('pageerror', (e) => errors.push(e.message));
  m.on('console', (x) => { if (x.type() === 'error' && !/attribute .*Expected/.test(x.text())) errors.push(x.text()); });
  const text = () => m.evaluate(() => document.body.innerText);
  await m.goto(BASE + '#compare');
  await m.waitForSelector('text=Folding bed table', { timeout: 15000 });

  // a photo for the first row, camera-sized
  const photo = await m.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
    const g = c.getContext('2d'); g.fillStyle = '#c84'; g.fillRect(0, 0, 3000, 2000); g.fillStyle = '#248'; g.fillRect(400, 300, 1800, 1200);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    const u = new Uint8Array(await blob.arrayBuffer()); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  });

  await m.getByLabel('Import a spreadsheet').setInputFiles({ name: 'shelf.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsxBuf });
  await m.waitForSelector('text=Import · shelf.xlsx', { timeout: 15000 });
  let t = await text();
  ok(t.includes('5 items in 3 categories (sheet "Prices")'), 'review: 5 items in 3 categories');
  ok(t.includes('1 line was not read as items.'), 'the total line is not read as an item');
  ok(t.includes('Folding table') && t.includes('a new need'), 'a category becomes a new need');
  ok(!t.includes('Tax basis not in the sheet'), 'separate incl. and excl. columns: no tax question');

  // Drinks to the matrix; rows are visible on demand
  const drinks = m.locator('section div', { has: m.locator('span', { hasText: /^Drinks$/ }) }).filter({ has: m.getByRole('button', { name: 'Price matrix' }) }).last();
  await drinks.getByRole('button', { name: 'Price matrix' }).click();
  ok((await text()).includes('to the price matrix'), 'Drinks set to the price matrix');
  ok(await m.getByRole('button', { name: 'Price matrix' }).count() === 3, 'the matrix is offered for in-shop categories only (all three here)');
  const table = m.locator('section div', { has: m.locator('span', { hasText: /^Folding table$/ }) }).filter({ has: m.getByRole('button', { name: 'Show items' }) }).last();
  await table.getByRole('button', { name: 'Show items' }).click();
  t = await text();
  ok(t.includes('¥1,802 incl. tax (tag ¥1,639)') && t.includes('check photo'), 'item rows: tax-included price, the tag, the photo flag');

  await m.getByLabel('Photos for the import').setInputFiles({ name: 'IMG20261024192355.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(photo, 'base64') });
  ok((await text()).includes('1 of 2 named photos matched.'), 'photos matched by file name');
  await m.screenshot({ path: path.join(OUT, 'import-review-phone.png'), fullPage: true });
  ok(await m.evaluate(() => document.documentElement.scrollWidth) === 390, 'phone: no sideways page scroll');

  const label = await m.getByRole('button', { name: /^Import / }).innerText();
  ok(label === 'Import 3 options, 3 prices, 2 matrix prices, 1 photo', 'the button says what will be written (' + label + ')');
  await m.getByRole('button', { name: /^Import / }).click();
  await m.waitForSelector('text=Imported shelf.xlsx', { timeout: 20000 });
  t = await text();
  ok(t.includes('Imported shelf.xlsx: 2 new needs, 3 options, 3 prices, 1 photo, 2 matrix prices.'), 'summary of what was written');
  ok(t.includes('Folding table') && t.includes('Kitchen'), 'the new needs are listed');

  await m.getByText('Folding table', { exact: true }).first().click();
  await m.waitForSelector('article');
  const my = (await m.$$eval('article', (a) => a.map((x) => x.innerText))).find((x) => x.split('\n').includes('MY space table')) || '';
  ok(my.includes('¥1,802') && my.includes('tag ¥1,639 + tax') && my.includes('View photo') && my.includes('2026-10-24'), 'MY space table: price, tag, photo, the day from the photo name');
  await m.getByRole('button', { name: '← All needs' }).click();

  // the same file again adds nothing
  await m.getByLabel('Import a spreadsheet').setInputFiles({ name: 'shelf-renamed.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsxBuf });
  await m.waitForSelector('text=Import · shelf-renamed.xlsx');
  for (const cat of ['Drinks']) {
    const box = m.locator('section div', { has: m.locator('span', { hasText: new RegExp('^' + cat + '$') }) }).filter({ has: m.getByRole('button', { name: 'Skip' }) }).last();
    await box.getByRole('button', { name: 'Skip' }).click();
  }
  t = await text();
  ok(t.includes('3 already imported: left as they are.'), 'second run: the options are recognised');
  ok((await m.getByRole('button', { name: /^Import / }).innerText()) === 'Import 0 options, 0 prices', 'second run: nothing new to write');
  await m.getByRole('button', { name: 'Cancel' }).click();

  // a bare Price column at a shop with no known convention: asked once per shop
  const csv = 'Shop,Item,Price\nCorner shop,Barley rice,98\nCorner shop,Mugicha bags,198\nDonki,Cup noodle,198\n';
  await m.getByLabel('Import a spreadsheet').setInputFiles({ name: 'quick.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await m.waitForSelector('text=Import · quick.csv');
  t = await text();
  ok(t.includes('Corner shop: 2 prices. Were they with or without tax on the tag?'), 'unknown shop: one question for its prices');
  ok(!t.includes('Donki: '), 'Donki is not asked about: its tags are tax-excluded');
  await m.getByRole('button', { name: /^Import / }).click();
  ok((await text()).includes('Answer the tax question first'), 'import waits for the answer');
  await m.getByRole('button', { name: 'Tax excluded' }).click();
  await m.getByRole('button', { name: /^Import / }).click();
  await m.waitForSelector('text=Imported quick.csv');
  ok((await text()).includes('Imported quick.csv: 1 new need, 3 options, 3 prices.'), 'csv imported into one need ("Imported")');

  // the matrix has the drinks, tax-included
  await m.locator('.ck-tab', { hasText: 'Matrix' }).click();
  await m.waitForTimeout(500);
  t = await text();
  ok(t.includes('Oolong tea') && t.includes('Barley tea'), 'matrix: the imported items are there');
  ok(errors.length === 0, 'no script errors' + (errors.length ? ' — ' + errors.join(' | ') : ''));

  await b.close();
  console.log(failed ? failed + ' FAILED' : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
