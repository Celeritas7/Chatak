// Browser checks for the Compare tab, on sample data.
//   npm i playwright@1.56 react@18.3.1 react-dom@18.3.1 @babel/standalone@7.29.0   (once, anywhere)
//   python scripts/serve-nocache.py 8765 &      then
//   NODE_PATH=<that node_modules> node tests/ui/compare.check.js
// React/Babel are served from local node_modules when present, so no CDN is needed.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = process.env.CHATAK_URL || 'http://localhost:8765/index.html';
const NM = (process.env.NODE_PATH || '').split(path.delimiter).find((p) => p && fs.existsSync(path.join(p, 'react'))) || '';
const OUT = process.env.SHOTS || '.';
let failed = 0;
const ok = (cond, label) => { console.log((cond ? 'ok  ' : 'FAIL') + '  ' + label); if (!cond) failed++; };

async function page(b, w, h) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  if (NM) {
    const map = (u) => path.join(NM, u.includes('react-dom@') ? 'react-dom/umd/react-dom.production.min.js' : u.includes('react@') ? 'react/umd/react.production.min.js' : '@babel/standalone/babel.min.js');
    await p.route('https://unpkg.com/**', (r) => r.fulfill({ path: map(r.request().url()), contentType: 'application/javascript' }));
  }
  await p.route('**/js/chatak-config.js', (r) => r.fulfill({ body: "window.CHATAK_CONFIG={signedOutView:'sample'};", contentType: 'application/javascript' }));
  p._errors = [];
  p.on('pageerror', (e) => p._errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/attribute .*Expected/.test(m.text())) p._errors.push(m.text()); });
  await p.goto(BASE + '#compare');
  await p.waitForSelector('text=Folding bed table', { timeout: 15000 });
  return p;
}
const cardPrices = (p) => p.$$eval('article', (as) => as.map((a) => a.querySelector("span[style*='font-size: 21px']").textContent.trim()));
const text = (p) => p.evaluate(() => document.body.innerText);

(async () => {
  const b = await chromium.launch();

  // ── phone ──
  const m = await page(b, 390, 844);
  let t = await text(m);
  ok(/Compare/.test(t) && /Folding bed table/.test(t) && /Slicer/.test(t) && /Blender/.test(t), 'needs list shows the three starters');
  ok(t.includes('6 options · 9 fields') && t.includes('¥1,802 – ¥3,799 incl. tax'), 'folding table card: 6 options, price range on one tax basis');
  ok(await m.locator('.ck-tab', { hasText: 'Compare' }).count() === 1, 'Compare is in the bottom tab bar');
  await m.getByText('Folding bed table').first().click();
  await m.waitForSelector('article');
  ok(JSON.stringify(await cardPrices(m)) === JSON.stringify(['¥1,802', '¥2,490', '¥2,950', '¥2,999', '¥3,168', '¥3,799']), 'phone opens cards, cheapest first, all incl. tax');
  t = await text(m);
  ok(t.includes('majica ¥1,560') && t.includes('tag ¥1,639 + tax'), 'MY space: shelf price leads, member price beside it, tag shown');
  ok(t.includes('+¥1,366 vs MY space table'), 'pay more, get what: MISM +¥1,366 vs the cheapest');
  const tinted = await m.$$eval('article', (as) => as.map((a) => [a.innerText, [...a.querySelectorAll('div')].filter((d) => getComputedStyle(d).backgroundColor === 'rgb(240, 248, 244)').map((d) => d.innerText.split('\n')[0])]));
  const vecelo = tinted.find(([n]) => /70x48x30/.test(n));
  ok(vecelo && vecelo[1].includes('Width') && vecelo[1].includes('Depth'), 'best in column: VECELO tinted for width and depth');
  ok(!tinted.some(([, f]) => f.includes('Load capacity')), 'load capacity not tinted (only one value known)');
  await m.screenshot({ path: path.join(OUT, 'compare-phone-cards.png'), fullPage: true });

  await m.getByRole('button', { name: 'Width', exact: true }).click();
  await m.getByRole('button', { name: 'Reverse order' }).click();
  ok((await m.$$eval('article', (a) => a.map((x) => x.innerText)))[0].includes('70x48x30'), 'sort by width, high to low: VECELO first');
  await m.getByRole('button', { name: 'Online', exact: true }).click();
  ok((await m.$$('article')).length === 4, 'filter Online: 4 options');
  ok((await text(m)).includes('2 options hidden by filters.'), 'hidden count is stated');
  await m.getByRole('button', { name: 'Clear filters' }).click();
  ok((await m.$$('article')).length === 6, 'clear filters: all 6 back');

  // add an option: validation first, then a real one
  await m.getByRole('button', { name: '+ Option' }).click();
  await m.getByRole('button', { name: 'Add option' }).click();
  ok((await text(m)).includes('Give it a name.'), 'saving without a name is refused with a reason');
  await m.getByPlaceholder('e.g. MY space table').fill('Wide table test');
  await m.getByRole('button', { name: 'Add option' }).click();
  ok((await text(m)).includes('Which shop?'), 'in-store option needs a shop');
  await m.getByPlaceholder('Shop, as named in Cost').fill('Nitori');
  await m.getByPlaceholder('cm').first().fill('65');
  await m.getByPlaceholder('Price on the tag').fill('2490');
  ok((await text(m)).includes('= ¥2,490 incl. 10% tax'), 'Nitori defaults to tax-included');
  await m.getByRole('button', { name: 'Add option' }).click();
  await m.waitForSelector('text=Added Wide table test.');
  ok((await m.$$('article')).length === 7, 'new option appears as a 7th card');
  t = await text(m);
  ok(t.includes('Not a Cost shop yet') === false, 'editor closed after saving');

  // shortlist toggle
  await m.locator('article', { hasText: 'Wide table test' }).getByRole('button', { name: '☆ Shortlist' }).click();
  ok(await m.locator('article', { hasText: 'Wide table test' }).getByText('Shortlisted', { exact: true }).count() === 1, 'shortlist marks the card');

  // photos: a big camera-sized JPEG is shrunk in the browser, then shown, viewed and deleted
  const big = await m.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 4000; c.height = 3000;
    const g = c.getContext('2d'), img = g.createImageData(4000, 3000);
    for (let i = 0; i < img.data.length; i += 4) { const px = i / 4, x = px % 4000, y = (px / 4000) | 0, n = (Math.random() * 24) | 0; img.data[i] = ((x / 16) & 255) ^ n; img.data[i + 1] = ((y / 12) & 255) + (n >> 1); img.data[i + 2] = ((x + y) / 28) & 255; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0);
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    const u = new Uint8Array(await b.arrayBuffer()); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return { b64: btoa(s), size: b.size };
  });
  ok(big.size > 1500000, 'test photo is camera-sized (' + Math.round(big.size / 1024) + ' KB)');
  const photoFile = { name: 'IMG20261024192355.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(big.b64, 'base64') };
  await m.locator('article', { hasText: 'Wide table test' }).getByRole('button', { name: 'Edit' }).click();
  await m.getByLabel('Add photos').setInputFiles(photoFile);
  await m.waitForSelector('text=Photo added.', { timeout: 20000 });
  ok(await m.locator('[aria-label="Photo 1 of 1"]').count() === 1, 'editor shows the new photo');
  await m.getByRole('button', { name: 'Cancel' }).click();
  const viewBtn = m.locator('article', { hasText: 'Wide table test' }).getByRole('button', { name: 'View photo' });
  ok(await viewBtn.count() === 1, 'card shows the photo with a View button');
  await viewBtn.click();
  await m.waitForSelector('[role=dialog] [role=img]');
  const shot = await m.evaluate(async () => {
    const src = document.querySelector('[role=dialog] [role=img]').dataset.src;
    const b = await (await fetch(src)).blob();
    const img = await createImageBitmap(b);
    return { w: img.width, h: img.height, bytes: b.size, type: b.type, caption: document.querySelector('[role=dialog]').innerText };
  });
  ok(shot.w === 1600 && shot.h === 1200, 'shrunk to 1600 x 1200 (got ' + shot.w + ' x ' + shot.h + ')');
  ok(shot.bytes <= 300000 && shot.type === 'image/jpeg', 'stored copy is a JPEG of at most 300 KB (got ' + Math.round(shot.bytes / 1024) + ' KB)');
  ok(shot.caption.includes('taken 24 Oct 2026, 19:23 JST') && shot.caption.includes('IMG20261024192355.jpg'), 'viewer gives the time taken, from the file name');
  await m.screenshot({ path: path.join(OUT, 'compare-phone-photo-viewer.png') });
  await m.keyboard.press('Escape');
  ok(await m.locator('[role=dialog]').count() === 0, 'Escape closes the viewer');
  await m.locator('article', { hasText: 'Wide table test' }).getByRole('button', { name: 'Edit' }).click();
  await m.getByRole('button', { name: 'Delete photo' }).click();
  ok(await m.getByRole('button', { name: 'Confirm: delete this photo' }).count() === 1, 'deleting a photo asks once more');
  await m.getByRole('button', { name: 'Confirm: delete this photo' }).click();
  await m.waitForSelector('text=Photo deleted.');
  ok(await m.locator('[aria-label="Photo 1 of 1"]').count() === 0, 'photo removed');
  await m.getByRole('button', { name: 'Cancel' }).click();

  // a photo chosen for a new option waits for the save
  await m.getByRole('button', { name: '+ Option' }).click();
  await m.getByPlaceholder('e.g. MY space table').fill('Photo first table');
  await m.getByPlaceholder('Shop, as named in Cost').fill('Nitori');
  await m.getByLabel('Add photos').setInputFiles(photoFile);
  await m.waitForSelector('text=1 photo uploads when you save.', { timeout: 20000 });
  await m.getByRole('button', { name: 'Add option' }).click();
  await m.waitForSelector('text=Added Photo first table.');
  ok(await m.locator('article', { hasText: 'Photo first table' }).getByRole('button', { name: 'View photo' }).count() === 1, 'new option saved with its photo');

  // online, at a seller with no store row, before its page is found
  await m.getByRole('button', { name: '+ Option' }).click();
  await m.getByPlaceholder('e.g. MY space table').fill('Bottle cover, blue');
  await m.getByRole('button', { name: 'Online', exact: true }).first().click();
  await m.getByRole('button', { name: 'Other seller' }).click();
  await m.getByRole('button', { name: 'Add option' }).click();
  ok((await text(m)).includes('Which seller?'), 'other seller needs a name');
  await m.getByPlaceholder("Seller, e.g. ANA Mall or the maker's site").fill('ANA Mall');
  await m.getByPlaceholder('Price on the tag').fill('1210');
  await m.getByRole('button', { name: 'Add option' }).click();
  await m.waitForSelector('text=Added Bottle cover, blue.');
  const blue = (await m.$$eval('article', (a) => a.map((x) => x.innerText))).find((t) => t.split('\n').includes('Bottle cover, blue')) || '';
  ok(blue.includes('Online · no link yet') && blue.includes('ANA Mall') && blue.includes('¥1,210'), 'saved without a link: seller and price shown');

  // watch price: link an online option to a tracked product; the pill must match Home's
  const card = (name) => m.locator('article').filter({ has: m.locator('span', { hasText: new RegExp('^' + name + '$') }) });
  ok(await card('MY space table').getByRole('button', { name: 'Watch price' }).count() === 0, 'in-shop options have no Watch price');
  await card('Bed table 70x48x30').getByRole('button', { name: 'Watch price' }).click();
  await m.waitForSelector('text=Watch price · Bed table 70x48x30');
  ok((await text(m)).includes('Amazon JP prices are not collected automatically'), 'Amazon option: the panel says Amazon is not collected');
  await m.getByRole('button', { name: 'Search Rakuten' }).click();
  ok((await text(m)).includes('Rakuten search needs the live app'), 'sample: search explains it needs the live app');
  await m.getByLabel('Rakuten item link').fill('https://www.amazon.co.jp/dp/B000');
  await m.getByRole('button', { name: 'Watch link' }).click();
  ok((await text(m)).includes('Paste a Rakuten item link'), 'a non-Rakuten link is refused with a reason');
  const first = await m.evaluate(() => {
    const btn = [...document.querySelectorAll('section button')].find((b) => b.textContent.trim() === 'Link');
    const row = btn.parentElement, spans = row.querySelectorAll(':scope > span');
    return { pill: spans[0].innerText.trim(), name: spans[1].firstElementChild.innerText.trim() };
  });
  const linkedName = first.name, linkedPill = first.pill;
  await m.getByRole('button', { name: 'Link', exact: true }).first().click();
  await m.waitForSelector('text=Watching ' + linkedName + '.');
  const watched = await card('Bed table 70x48x30').innerText();
  ok(watched.includes(linkedPill) && /Price history/.test(watched), 'card shows the product\'s pill (' + linkedPill + ') and a history link');
  ok(await card('Bed table 70x48x30').getByRole('button', { name: 'Watch price' }).count() === 0, 'a watched option offers Stop watching instead');
  await m.screenshot({ path: path.join(OUT, 'compare-phone-watch.png'), fullPage: true });
  await card('Bed table 70x48x30').getByRole('button', { name: 'Price history' }).click();
  await m.waitForTimeout(400);
  const productPage = await text(m);
  ok(productPage.includes(linkedName.replace('…', '').split(' ').pop()) && productPage.toUpperCase().includes(linkedPill.toUpperCase()), 'Price history opens the same product, with the same verdict');
  await m.locator('.ck-tab', { hasText: 'Compare' }).click();
  await m.waitForSelector('text=Bed table 70x48x30');
  await card('Bed table 70x48x30').getByRole('button', { name: 'Stop watching' }).click();
  await m.waitForSelector('text=Stopped watching from Compare.');
  ok(await card('Bed table 70x48x30').getByRole('button', { name: 'Watch price' }).count() === 1, 'stop watching: back to Watch price');

  // a tax-excluded tag at an unknown shop must be decided, not guessed
  await m.locator('article', { hasText: 'Wide table test' }).getByRole('button', { name: 'Edit' }).click();
  await m.getByPlaceholder('Shop, as named in Cost').fill('Corner shop');
  await m.getByPlaceholder('Price on the tag').fill('1000');
  ok((await text(m)).includes('Choose whether ¥1,000 includes tax.'), 'unknown shop: tax basis must be chosen');
  await m.getByRole('button', { name: 'Tax excluded' }).click();
  await m.getByRole('button', { name: 'Add price' }).click();
  await m.waitForTimeout(300);
  ok((await text(m)).includes('¥1,100 incl. tax'), 'added price shows as ¥1,100 incl. tax');
  await m.getByRole('button', { name: 'Cancel' }).click();

  // a new field
  await m.getByRole('button', { name: 'Fields' }).click();
  await m.getByPlaceholder('Label, e.g. Weight').fill('Colour');
  await m.getByRole('button', { name: 'Text', exact: true }).click();
  await m.getByRole('button', { name: 'Add field' }).click();
  await m.waitForSelector('text=Added Colour.');
  ok((await text(m)).includes('Colour'), 'new field listed');
  ok(await m.evaluate(() => document.documentElement.scrollWidth) === 390, 'phone: no sideways page scroll');
  ok(m._errors.length === 0, 'phone: no script errors' + (m._errors.length ? ' — ' + m._errors.join(' | ') : ''));

  // ── desktop ──
  const d = await page(b, 1320, 900);
  await d.getByText('Folding bed table').first().click();
  await d.waitForSelector('text=Price (incl. tax)');
  const rows = await d.$$eval("div[style*='grid-template-columns: 170px']", (r) => r.map((x) => x.innerText.split('\n')[0]));
  ok(rows.length === 14 && rows[0] === 'Option' && rows.includes('Load capacity (kg)'), 'desktop opens the table: 5 rows + 9 fields');
  const widthRow = await d.$$eval("div[style*='grid-template-columns: 170px']", (r) => {
    const row = r.find((x) => x.innerText.startsWith('Width'));
    return [...row.children].slice(1).map((c) => [c.innerText.trim(), getComputedStyle(c).backgroundColor]);
  });
  ok(widthRow.filter(([, bg]) => bg === 'rgb(240, 248, 244)').map(([v]) => v).join() === '70', 'table: only the 70 cm width cell is tinted');
  await d.screenshot({ path: path.join(OUT, 'compare-desktop-table.png') });
  // the other screens still render with Compare added
  for (const tab of ['Home', 'Price matrix', 'Deal feed', 'Season calendar', 'Alerts', 'Settings', 'Compare']) {
    await d.locator('aside button', { hasText: tab }).first().click();
    await d.waitForTimeout(250);
  }
  ok((await text(d)).includes('Folding bed table'), 'every tab opens and Compare comes back where it was');
  ok(d._errors.length === 0, 'desktop: no script errors' + (d._errors.length ? ' — ' + d._errors.join(' | ') : ''));

  await b.close();
  console.log(failed ? failed + ' FAILED' : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
