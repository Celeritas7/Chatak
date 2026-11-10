# Chatak · चातक

A Japanese price tracker that tells you whether a discount is real. Every
verdict is derived from recorded prices — never from the shop's own "was" price.

## Layout

```
index.html                     the app — open this in a browser
support.js                     runtime the page loads (generated; do not edit)
js/
  chatak-config.js             ← the only file you edit to go live (yours; gitignored, never shipped)
  chatak-config.example.js     template — run-chatak.bat copies it on first run
  chatak-engine.js             price reasoning: verdict, confidence, narrative
  chatak-api.js                Supabase reads/writes
supabase/
  schema.sql                   tables, RLS, the daily cron
  functions/                   collect-prices · evaluate-alerts · add-product
scripts/
  run-chatak.bat               double-click to serve the app locally
  deploy.sh                    ./scripts/deploy.sh <project-ref>
docs/SETUP.md                  backend setup, start to finish
```

## Running it

Double-click `scripts/run-chatak.bat`, or serve the repo root with anything
static and open http://localhost:PORT/. The app is plain HTML plus the files
in `js/` — no build step, no install.
With no credentials in `js/chatak-config.js` the app runs on generated sample
data and says so in an amber strip under the header.

## Install on mobile

Chatak is an installable Progressive Web App (PWA), not an APK or App Store app.
Open the published Chatak site over HTTPS using your phone:

- **Android (Chrome):** Open Chatak, tap **↓ Install** in the header, then
  **Install Chatak** if Chrome offers it. Alternatively choose
  **⋮ → Install app** or **Add to Home screen**.
- **iPhone / iPad (Safari):** Open Chatak in Safari, tap **Share**,
  choose **Add to Home Screen**, and tap **Add**.
- **Already installed:** Open Chatak from the Home Screen. The install
  control hides in standalone mode.

You can also see the installation guide in **Settings → Install Chatak**.
The browser controls whether its native installation prompt is available.
The app needs internet connectivity for live prices and Supabase data; it
does not provide offline data caching. The Chātaka bird icon is bundled in
`icons/icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, and
`apple-touch-icon.png`.

## Upgrading

Unzip the new package over the repo folder. It contains no `js/chatak-config.js`,
so your credentials survive. If a new release adds config keys, they are listed
in `js/chatak-config.example.js` — copy the new lines across; every key has a
safe default in the app, so nothing breaks if you don't.

## Going live

`docs/SETUP.md`, in order. The short version: create the Supabase project, run
`supabase/schema.sql`, set `RAKUTEN_APP_ID`, deploy the functions, then paste
your project URL and anon key into `js/chatak-config.js`.

One thing no amount of code fixes: **price history cannot be backfilled.** A
90-day median needs 90 days of collection. Start the cron early.

## Where the source lives

`index.html` is exported from the design workspace, where the same file is
edited under the name `Chatak Price Tracker.dc.html`. That source name is
gitignored on purpose: the repo carries one app file, the design tool carries
the other, and they are byte-identical.

## Where the app's styling lives

Inline, on the elements, by design — the app paints as it streams instead of
waiting for a stylesheet. There is no `css/` folder to look for; the only
global rules (fonts, body reset, selection colour) sit in the `<helmet>` block
at the top of the .dc.html file.

## Tests

`tests/db/run.sh` starts a throwaway Postgres (15+), stubs the parts of
Supabase the schema touches (auth, roles, storage), runs
`supabase/schema.sql` **twice** to prove it is safe to re-run, then every
`tests/db/test_*.sql`. Each check prints `ok  …` or stops the run with
`FAILED: …`. Pass a name fragment to run one file: `tests/db/run.sh compare`.
Nothing here touches the live project.

`node --test tests/js/*.test.js` checks Compare's arithmetic in
`js/chatak-compare.js` (tax basis, best in column, "pay more, get what",
sorting, filters) on the sample folding tables.
`tests/js/import.test.js` covers `js/chatak-import.js`, the spreadsheet
reader: header detection, tax basis by column or shop convention, pack sizes,
skipped totals and stable import keys. `tests/ui/import.check.js` runs the
import screen end to end (needs `xlsx@0.18.5` beside the other test packages).

`tests/js/photo.test.js` covers `js/chatak-photo.js`: the 1600 px resize
maths and reading when a photo was taken (EXIF, or names like
`IMG20261024192355.jpg`).

`tests/ui/compare.check.js` drives the Compare tab in a headless browser at
phone and desktop width on sample data; see the header of that file for the
one-time setup.
