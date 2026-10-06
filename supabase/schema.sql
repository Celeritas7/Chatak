-- Chatak — Supabase schema (chatak_ prefixed tables)
-- Run in the Supabase SQL editor, top to bottom.

create extension if not exists pgcrypto;

-- ─────────────────────────────  reference data  ─────────────────────────────

create table if not exists public.chatak_stores (
  id          smallint primary key,
  slug        text unique not null,
  name        text not null,
  color       text not null,
  adapter     text not null,              -- 'rakuten_api' | 'yahoo_api' | 'paapi' | 'scrape' | 'manual'
  is_used     boolean not null default false
);

insert into public.chatak_stores (id, slug, name, color, adapter, is_used) values
  (1,'rakuten',   'Rakuten',        '#B4413A','rakuten_api',false),
  (2,'amazon_jp', 'Amazon JP',      '#C98A17','paapi',      false),
  (3,'yodobashi', 'Yodobashi',      '#3E7BB6','scrape',     false),
  (4,'bic',       'Bic Camera',     '#8B5FA8','scrape',     false),
  (5,'yahoo',     'Yahoo Shopping', '#5A8F52','yahoo_api',  false),
  (6,'mercari',   'Mercari (used)', '#8A837A','scrape',     true)
on conflict (id) do nothing;

create table if not exists public.chatak_sale_events (
  id         bigserial primary key,
  name       text not null,
  store_id   smallint references public.chatak_stores(id),
  starts_on  date not null,
  ends_on    date not null,
  notes      text
);
create index if not exists chatak_sale_events_range_idx
  on public.chatak_sale_events (starts_on, ends_on);

-- ─────────────────────────────  catalog  ─────────────────────────────

create table if not exists public.chatak_products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  subtitle    text,
  brand       text,
  model_code  text,
  jan_code    text unique,                -- barcode, for in-store scanning
  image_url   text,
  msrp        integer,                    -- manufacturer list price, yen
  created_at  timestamptz not null default now()
);
create index if not exists chatak_products_name_idx
  on public.chatak_products using gin (to_tsvector('simple', name));

-- one row per (product, store) listing we poll
create table if not exists public.chatak_offers (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.chatak_products(id) on delete cascade,
  store_id    smallint not null references public.chatak_stores(id),
  store_sku   text,                       -- itemCode / ASIN / product id at the store
  url         text not null,
  active      boolean not null default true,
  last_seen   timestamptz,
  unique (product_id, store_id, store_sku)
);

-- the append-only price record — one row per offer per day
create table if not exists public.chatak_price_points (
  id               bigserial primary key,
  offer_id         uuid not null references public.chatak_offers(id) on delete cascade,
  captured_on      date not null default (now() at time zone 'Asia/Tokyo')::date,
  price            integer not null,      -- what you actually pay, yen, incl. tax
  reference_price  integer,               -- the retailer's own "was" price — the number we police
  points_back      integer default 0,     -- yen-equivalent loyalty points, informational
  in_stock         boolean not null default true,
  unique (offer_id, captured_on)
);
create index if not exists chatak_price_points_offer_date
  on public.chatak_price_points (offer_id, captured_on desc);

-- ─────────────────────────────  user data  ─────────────────────────────

create table if not exists public.chatak_profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          text,
  locale         text not null default 'en',
  price_format   text not null default 'yen_symbol',
  default_range  smallint not null default 90,
  include_used   boolean not null default false,
  notify_email   boolean not null default true,
  notify_push    boolean not null default true,
  created_at     timestamptz not null default now()
);

create table if not exists public.chatak_watchlist (
  user_id     uuid not null references auth.users(id) on delete cascade,
  product_id  uuid not null references public.chatak_products(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, product_id)
);

do $$ begin
  create type chatak_alert_kind as enum ('target','fake_discount','lowest_ever','event_soon');
exception when duplicate_object then null;
end $$;

create table if not exists public.chatak_alert_rules (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  product_id    uuid references public.chatak_products(id) on delete cascade,
  kind          chatak_alert_kind not null,
  target_price  integer,                  -- only for kind = 'target'
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists chatak_alert_rules_active
  on public.chatak_alert_rules (active, kind);

create table if not exists public.chatak_alert_events (
  id          bigserial primary key,
  rule_id     uuid references public.chatak_alert_rules(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  product_id  uuid references public.chatak_products(id) on delete cascade,
  kind        chatak_alert_kind not null,
  title       text not null,
  body        text not null,
  payload     jsonb,
  sent_at     timestamptz not null default now(),
  channels    text[] not null default '{}'
);
create index if not exists chatak_alert_events_user
  on public.chatak_alert_events (user_id, sent_at desc);

create table if not exists public.chatak_push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────  analysis  ─────────────────────────────

-- Best (lowest) new-condition price per product per day. This is the series the graph draws.
create or replace view public.chatak_daily_best as
select
  o.product_id,
  pp.captured_on,
  min(pp.price)            as best_price,
  max(pp.reference_price)  as reference_price
from public.chatak_price_points pp
join public.chatak_offers o on o.id = pp.offer_id
join public.chatak_stores s on s.id = o.store_id
where s.is_used = false and pp.in_stock
group by o.product_id, pp.captured_on;

-- The single number the whole product rests on: what you normally pay.
create or replace function public.chatak_median_price(p_product uuid, p_days int default 90)
returns integer language sql stable as $$
  select (percentile_cont(0.5) within group (order by best_price))::int
  from public.chatak_daily_best
  where product_id = p_product
    and captured_on > ((now() at time zone 'Asia/Tokyo')::date - p_days);
$$;

-- history_days was added to the OUT columns, and Postgres will not change a
-- function's return type on replace. Drop first so re-running this file works on
-- a project where an earlier version was already applied.
drop function if exists public.chatak_product_stats(uuid, int);
create or replace function public.chatak_product_stats(p_product uuid, p_days int default 90)
returns table (
  current_price integer, median_price integer, low_price integer, high_price integer,
  pct_vs_median numeric, best_store text, is_record_low boolean,
  -- How many days we have actually recorded. Callers must label the median from
  -- this, never as "90-day" on a record too short to support it.
  history_days integer
) language sql stable as $$
  with win as (
    select * from public.chatak_daily_best
    where product_id = p_product
      and captured_on > ((now() at time zone 'Asia/Tokyo')::date - p_days)
  ),
  cur as (select best_price from win order by captured_on desc limit 1),
  yr as (
    select min(best_price) lo, max(best_price) hi from public.chatak_daily_best
    where product_id = p_product
      and captured_on > ((now() at time zone 'Asia/Tokyo')::date - 365)
  ),
  med as (select public.chatak_median_price(p_product, p_days) m),
  rec as (select count(*)::int n from public.chatak_daily_best where product_id = p_product),
  bs as (
    select s.name from public.chatak_price_points pp
    join public.chatak_offers o on o.id = pp.offer_id
    join public.chatak_stores s on s.id = o.store_id
    where o.product_id = p_product and s.is_used = false
      and pp.captured_on = (select max(captured_on) from win)
    order by pp.price asc limit 1
  )
  select
    (select best_price from cur),
    (select m from med),
    (select lo from yr),
    (select hi from yr),
    round(((select best_price from cur) - (select m from med))::numeric
          / nullif((select m from med),0) * 100, 1),
    (select name from bs),
    (select best_price from cur) <= (select lo from yr),
    (select n from rec);
$$;

-- The core claim of the product: was the reference price inflated before a sale?
-- Flags when a retailer's own "was" price rises >=10% within 30 days of a sale window.
create or replace function public.chatak_fake_discount_flags(p_product uuid)
returns table (
  store       text,
  raised_on   date,
  ref_before  integer,
  ref_after   integer,
  ref_jump    numeric,
  sale_event  text,
  advertised_pct numeric,
  real_pct    numeric
) language sql stable as $$
  with refs as (
    select s.name as store, pp.captured_on, pp.reference_price, pp.price,
           lag(pp.reference_price) over w as prev_ref
    from public.chatak_price_points pp
    join public.chatak_offers o on o.id = pp.offer_id
    join public.chatak_stores s on s.id = o.store_id
    where o.product_id = p_product and pp.reference_price is not null
    window w as (partition by o.id order by pp.captured_on)
  ),
  jumps as (
    select * from refs
    where prev_ref is not null
      and reference_price >= prev_ref * 1.10
      and captured_on > ((now() at time zone 'Asia/Tokyo')::date - 365)
  )
  select j.store, j.captured_on, j.prev_ref, j.reference_price,
         round((j.reference_price - j.prev_ref)::numeric / j.prev_ref * 100, 1),
         e.name,
         round((j.reference_price - j.price)::numeric / j.reference_price * 100, 1),
         round((j.price - public.chatak_median_price(p_product, 90))::numeric
               / nullif(public.chatak_median_price(p_product, 90),0) * 100, 1)
  from jumps j
  left join public.chatak_sale_events e
    on e.starts_on between j.captured_on and j.captured_on + 30
  order by j.captured_on desc;
$$;

-- ─────────────────────────────  row-level security  ─────────────────────────────

alter table public.chatak_profiles            enable row level security;
alter table public.chatak_watchlist           enable row level security;
alter table public.chatak_alert_rules         enable row level security;
alter table public.chatak_alert_events        enable row level security;
alter table public.chatak_push_subscriptions  enable row level security;
alter table public.chatak_products            enable row level security;
alter table public.chatak_offers              enable row level security;
alter table public.chatak_price_points        enable row level security;
alter table public.chatak_stores              enable row level security;
alter table public.chatak_sale_events         enable row level security;

-- Re-runnable: Postgres has no CREATE POLICY IF NOT EXISTS, so drop first.
drop policy if exists "chatak catalog readable" on public.chatak_products;
drop policy if exists "chatak offers readable"  on public.chatak_offers;
drop policy if exists "chatak prices readable"  on public.chatak_price_points;
drop policy if exists "chatak stores readable"  on public.chatak_stores;
drop policy if exists "chatak events readable"  on public.chatak_sale_events;
drop policy if exists "chatak own profile"      on public.chatak_profiles;
drop policy if exists "chatak own watchlist"    on public.chatak_watchlist;
drop policy if exists "chatak own rules"        on public.chatak_alert_rules;
drop policy if exists "chatak own events"       on public.chatak_alert_events;
drop policy if exists "chatak own push"         on public.chatak_push_subscriptions;

-- catalog + price history are public reads; only the service role writes them
create policy "chatak catalog readable" on public.chatak_products     for select using (true);
create policy "chatak offers readable"  on public.chatak_offers       for select using (true);
create policy "chatak prices readable"  on public.chatak_price_points for select using (true);
create policy "chatak stores readable"  on public.chatak_stores       for select using (true);
create policy "chatak events readable"  on public.chatak_sale_events  for select using (true);

-- user-owned rows
create policy "chatak own profile"   on public.chatak_profiles           for all    using (auth.uid() = id)      with check (auth.uid() = id);
create policy "chatak own watchlist" on public.chatak_watchlist          for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "chatak own rules"     on public.chatak_alert_rules        for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "chatak own events"    on public.chatak_alert_events       for select using (auth.uid() = user_id);
create policy "chatak own push"      on public.chatak_push_subscriptions for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- create a profile row on signup
create or replace function public.chatak_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.chatak_profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists chatak_on_auth_user_created on auth.users;
create trigger chatak_on_auth_user_created after insert on auth.users
  for each row execute function public.chatak_handle_new_user();

-- ─────────────────────────────  daily cron  ─────────────────────────────
-- Enable pg_cron and pg_net in Dashboard > Database > Extensions first,
-- then replace PROJECT_REF and SERVICE_ROLE_KEY below.

-- select cron.schedule('chatak-collect', '5 21 * * *', $cron$
--   select net.http_post(
--     url     := 'https://PROJECT_REF.supabase.co/functions/v1/collect-prices',
--     headers := '{"Authorization":"Bearer SERVICE_ROLE_KEY","Content-Type":"application/json"}'::jsonb
--   );
-- $cron$);
-- 21:05 UTC = 06:05 JST, after overnight price changes land.


-- ─────────────────────────────────────────────────────────────────────────────
-- Access control: authentication_mode_user_roles is the allow-list.
--
-- The site is published on GitHub Pages, so the sign-in form is reachable by
-- anyone. These two triggers are what actually restrict it: the browser never
-- decides who gets in.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Refuse the account unless the address is already listed. Raising here
--    aborts the auth.users insert, so no user row is created at all — and the
--    client is told only that sign-in failed, never why.
create or replace function public.chatak_enforce_allowlist()
returns trigger language plpgsql security definer as $$
begin
  if not exists (
    select 1 from public.authentication_mode_user_roles
    where lower(email) = lower(new.email)
  ) then
    raise exception 'not_allowed';
  end if;
  return new;
end;
$$;

drop trigger if exists chatak_allowlist_gate on auth.users;
create trigger chatak_allowlist_gate
  before insert on auth.users
  for each row execute function public.chatak_enforce_allowlist();

-- 2. Connect the new auth user to its allow-list row. auth_user_id is nullable
--    because the row is created by hand, before the person ever signs in.
--    Idempotent: re-running this file, or an existing trigger of your own,
--    cannot double-link anything.
create or replace function public.chatak_link_auth_user()
returns trigger language plpgsql security definer as $$
begin
  update public.authentication_mode_user_roles
     set auth_user_id = new.id, updated_at = now()
   where lower(email) = lower(new.email)
     and (auth_user_id is null or auth_user_id <> new.id);
  return new;
end;
$$;

drop trigger if exists chatak_link_auth_user on auth.users;
create trigger chatak_link_auth_user
  after insert on auth.users
  for each row execute function public.chatak_link_auth_user();

-- 3. Let a signed-in user read their own role row, and nobody else's.
alter table public.authentication_mode_user_roles enable row level security;

drop policy if exists chatak_roles_self_read on public.authentication_mode_user_roles;
create policy chatak_roles_self_read on public.authentication_mode_user_roles
  for select using (
    auth_user_id = auth.uid()
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Price matrix: shop × item, latest known price per cell.
--
-- Shops are NOT stored here. They come from Cost through the hub view
-- akatsuki_shops (already granted to authenticated). A price row carries the
-- shop's NAME, because that is what Cost puts on its events and what an
-- expense.recategorized {field:'shop'} rename re-keys. A name with prices but no
-- row in akatsuki_shops is a shop deleted in Cost: the UI keeps it, read-only.
-- ─────────────────────────────────────────────────────────────────────────────

-- The caller's role from the allow-list. security definer so policies can call
-- it without recursing through the roles table's own RLS.
create or replace function public.chatak_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.authentication_mode_user_roles
  where auth_user_id = auth.uid()
     or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  limit 1;
$$;

create table if not exists public.chatak_matrix_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  size        text,                          -- pack size, e.g. '1 L', '500 g'
  category    text not null default 'Other', -- Chatak's own list, not Cost's
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create unique index if not exists chatak_matrix_items_uniq
  on public.chatak_matrix_items (lower(name), lower(coalesce(size, '')));

-- Stars pin items to the front of the grid, per person.
create table if not exists public.chatak_matrix_stars (
  user_id  uuid not null references auth.users(id) on delete cascade,
  item_id  uuid not null references public.chatak_matrix_items(id) on delete cascade,
  primary key (user_id, item_id)
);

-- Append-only record. kind='confirm' re-states an unchanged price after review.
create table if not exists public.chatak_matrix_prices (
  id            bigserial primary key,
  shop_name     text not null,
  cost_shop_id  text,                        -- akatsuki_shops.id at entry time, informational
  item_id       uuid not null references public.chatak_matrix_items(id) on delete cascade,
  price         integer not null check (price > 0),
  currency      text not null default 'JPY', -- one app-wide currency until regions arrive
  shelf         boolean not null default false, -- seen on the shelf, not paid
  kind          text not null default 'entry' check (kind in ('entry', 'confirm')),
  entered_by    uuid references auth.users(id) on delete set null,
  entered_at    timestamptz not null default now()
);
create index if not exists chatak_matrix_prices_cell
  on public.chatak_matrix_prices (shop_name, item_id, entered_at desc);

create or replace view public.chatak_matrix_latest with (security_invoker = on) as
select distinct on (shop_name, item_id)
  shop_name, item_id, price, currency, shelf, kind, entered_at
from public.chatak_matrix_prices
order by shop_name, item_id, entered_at desc;

alter table public.chatak_matrix_items  enable row level security;
alter table public.chatak_matrix_stars  enable row level security;
alter table public.chatak_matrix_prices enable row level security;

drop policy if exists chatak_mx_items_read  on public.chatak_matrix_items;
drop policy if exists chatak_mx_items_add   on public.chatak_matrix_items;
drop policy if exists chatak_mx_items_admin on public.chatak_matrix_items;
drop policy if exists chatak_mx_items_del   on public.chatak_matrix_items;
drop policy if exists chatak_mx_stars_own   on public.chatak_matrix_stars;
drop policy if exists chatak_mx_prices_read on public.chatak_matrix_prices;
drop policy if exists chatak_mx_prices_add  on public.chatak_matrix_prices;

-- Anyone on the allow-list reads; editors and admins add; only admins rename or remove items.
create policy chatak_mx_items_read  on public.chatak_matrix_items for select using (public.chatak_role() is not null);
create policy chatak_mx_items_add   on public.chatak_matrix_items for insert with check (public.chatak_role() in ('editor', 'admin'));
create policy chatak_mx_items_admin on public.chatak_matrix_items for update using (public.chatak_role() = 'admin');
create policy chatak_mx_items_del   on public.chatak_matrix_items for delete using (public.chatak_role() = 'admin');
create policy chatak_mx_stars_own   on public.chatak_matrix_stars for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy chatak_mx_prices_read on public.chatak_matrix_prices for select using (public.chatak_role() is not null);
-- No update or delete policy: the record is append-only from the browser.
create policy chatak_mx_prices_add  on public.chatak_matrix_prices for insert
  with check (public.chatak_role() in ('editor', 'admin') and entered_by = auth.uid());

-- Cost renamed a shop (expense.recategorized {field:'shop', from, to}). Re-key
-- every row or the join to akatsuki_shops breaks silently. Called by the hub
-- consumer with the service role, never from the browser.
create or replace function public.chatak_matrix_rename_shop(p_from text, p_to text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.chatak_matrix_prices set shop_name = p_to where shop_name = p_from;
  get diagnostics n = row_count;
  return n;
end; $$;
revoke all on function public.chatak_matrix_rename_shop(text, text) from public, anon, authenticated;
grant execute on function public.chatak_matrix_rename_shop(text, text) to service_role;

-- 4. Only an admin may change who is allowed in. Uses chatak_role() (security
--    definer) — a subquery on this same table here would recurse through its RLS.
drop policy if exists chatak_roles_admin_write on public.authentication_mode_user_roles;
create policy chatak_roles_admin_write on public.authentication_mode_user_roles
  for all using (public.chatak_role() = 'admin')
  with check (public.chatak_role() = 'admin');
