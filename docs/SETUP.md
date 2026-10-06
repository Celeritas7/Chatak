# Chatak — backend setup

The prototype in `index.html` runs on generated sample data. These files turn it
into a real tracker. Nothing in the UI changes: the data layer swaps underneath.

## 0. What is actually obtainable

Be honest with yourself about sources before writing any code — this decides
what the app can promise.

| Store | Route | Effort |
|---|---|---|
| Rakuten | Ichiba Item Search API — free, register an app id | easy, works today |
| Yahoo Shopping | ItemSearch v3 — free, Yahoo! JAPAN Developer app id | easy, works today |
| Amazon JP | Product Advertising API v5 — needs an approved affiliate account **with qualifying sales** | blocked until you qualify |
| Yodobashi | no public API | own scraper |
| Bic Camera | no public API | own scraper |
| Mercari | no public API | own scraper |

Launch with Rakuten + Yahoo only. Two honest stores beat six flaky ones, and
the fake-discount thesis works with one store's reference price.

## 1. Create the project

1. supabase.com → New project (Tokyo region — your users and stores are there).
2. SQL Editor → paste `supabase/schema.sql` → Run.
3. Database → Extensions → enable `pg_cron` and `pg_net`.

## 2. Get API keys

- Rakuten: https://webservice.rakuten.co.jp/ → register an app → application id
- Yahoo: https://e.developer.yahoo.co.jp/register → Client ID (app id)

Rakuten hands you four things. Only one of them is wired into this codebase:

| What | Used here | Handling |
|---|---|---|
| **Application ID** | yes — `RAKUTEN_APP_ID` | Rides in the URL of every request, so semi-public, but still a credential: the rate limit is **~1 request/second per ID**, so a leaked one gets abused and throttles you. |
| **Access Key** | no | The real secret, and unused by Ichiba Item Search. Rakuten **cannot regenerate it** — recovering from a leak means deleting the app, which also invalidates the Application ID you *do* use. Password manager only. |
| **Affiliate ID** | no, deliberately | Passing it makes the API return a tracked `affiliateUrl` instead of `itemUrl`, which would end up stored in `chatak_offers.url`. Save it; keep it out of the code until monetisation is an actual decision. |
| **Application URL** | no | Just what you typed at registration. Nothing to protect. |

The 1 req/sec limit is enforced in one place: `functions/_shared/rakuten.ts`
runs every Rakuten call through a serialized queue with a 1.1s floor and one
retry on 429. Add new Rakuten calls through that module, not with bare
`fetch` — a second call site silently doubles your request rate.

## 3. Deploy the functions

```bash
npm i -g supabase
supabase login
supabase link --project-ref PROJECT_REF

# secrets merge — setting one key later does not clear the others
supabase secrets set RAKUTEN_APP_ID=xxx YAHOO_APP_ID=xxx RESEND_API_KEY=xxx

# or just: ./scripts/deploy.sh PROJECT_REF
supabase functions deploy collect-prices  --no-verify-jwt
supabase functions deploy evaluate-alerts --no-verify-jwt
supabase functions deploy add-product                       # keeps JWT: it writes on behalf of a user
```

Never `RAKUTEN_APP_ID` in the front-end, in the repo, or in a file you might
`git add` by reflex. The only key that legitimately reaches the browser is the
Supabase anon key (§6).

### Local development

`supabase secrets set` only affects **deployed** functions. `supabase functions
serve` reads `supabase/functions/.env` instead — copy `.env.example` to
`.env` and fill it in. That path is already in `.gitignore`, which was added
before there was anything in it to leak.

```bash
cp supabase/functions/.env.example supabase/functions/.env
supabase functions serve add-product --env-file supabase/functions/.env
```

### Check the ID works

Browser address bar (it encodes the Japanese for you):

```
https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601?applicationId=YOUR_ID&keyword=オリエントスター&hits=5
```

From a terminal the keyword must be percent-encoded, or Rakuten returns
`wrong_parameter`:

```bash
curl -G https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601 \
  --data-urlencode "applicationId=YOUR_ID" \
  --data-urlencode "keyword=オリエントスター" \
  --data-urlencode "hits=5"
```

JSON back means you are through setup. Note the response shape: this codebase
pins `formatVersion=1`, the nested `Items[].Item` form. `formatVersion=2`
flattens it to `Items[]` and would break every parser in
`_shared/rakuten.ts` — don't switch one without the other.

## 4. Schedule the daily capture

Uncomment the `cron.schedule` block at the bottom of `supabase/schema.sql`, fill in your
project ref and service role key, and run it. It fires at 06:05 JST.

Run it once by hand first:

```bash
curl -X POST https://PROJECT_REF.supabase.co/functions/v1/collect-prices \
  -H "Authorization: Bearer SERVICE_ROLE_KEY"
```

## 5. Add a product

Two ways, both through the `add-product` function:

```js
await addByUrl('https://item.rakuten.co.jp/shopname/itemcode/');  // paste-a-URL
await searchRakuten('オリエントスター');                            // pick from results
```

It resolves the URL to a `shop:itemcode`, creates the product and offer, writes
**today's** price point, and watchlists it for the signed-in caller. It returns
`history_days: 1` — say that in the UI rather than drawing an empty 90-day frame.

Or seed by hand:

```sql
with p as (
  insert into chatak_products (name, subtitle, model_code, msrp)
  values ('Seiko Prospex Alpinist SPB507J1', '"ClassicPine" green dial · 39.5mm', 'SPB507J1', 143000)
  returning id
)
insert into chatak_offers (product_id, store_id, store_sku, url)
select p.id, 1, 'shopname:itemcode', 'https://item.rakuten.co.jp/shopname/itemcode/' from p;
```

## 6. Point the UI at it

Edit `js/chatak-config.js` — the only front-end file you touch:

```js
window.CHATAK_CONFIG = {
  url: 'https://PROJECT_REF.supabase.co',
  anonKey: 'eyJ...',   // anon key — safe in the browser, RLS does the protecting
  historyDays: 365
};
```

Reload. The strip under the header goes from amber "Sample data" to blue
"Loading", then to your real watchlist (or a red error naming the missing step).

The anon key is *meant* to be public. Every table has row-level security: catalog
and price history are world-readable, everything user-owned is locked to
`auth.uid()`. The service role key must never appear in the browser — it lives
only in Supabase secrets.

## 7. The one thing that takes time

**You cannot backfill price history.** Every graph starts empty on day one and
fills in a row a day. A 90-day median needs 90 days. Start collecting now, even
while the UI is unfinished — the data is the asset, the interface is replaceable.

## Cost at small scale

Supabase free tier covers this comfortably: one price row per offer per day is
~2,000 rows/month for 60 offers. Resend's free tier is 3,000 emails/month.
The daily function run takes seconds.
